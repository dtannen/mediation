import crypto from '../crypto';
import { sleepWithAbort } from '../lib/sleep-with-abort';

const MAX_SESSIONS = 20;
const HANDSHAKE_POLL_INTERVAL_MS = 500;
const HANDSHAKE_TIMEOUT_MS = 45_000;
const MAX_MESSAGE_LENGTH = 100_000;

interface GatewayClient {
  fetchIdentityKey: (gatewayUrl: string, deviceId: string) => Promise<Record<string, unknown>>;
  initHandshake: (
    gatewayUrl: string,
    sessionId: string,
    handshakeId: string,
    deviceId: string,
    clientEphemeralPubKey: string,
    clientSessionNonce: string,
    conversationId?: string | null,
  ) => Promise<Record<string, unknown>>;
  pollHandshake: (
    gatewayUrl: string,
    sessionId: string,
    handshakeId: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  sendMessage: (gatewayUrl: string, sessionId: string, encryptedFrame: Record<string, unknown>) => Promise<Record<string, unknown>>;
  subscribeSessionEvents: (
    gatewayUrl: string,
    sessionId: string,
    onEvent: (event: { event: string; data: string; id: string }) => void,
    signal: AbortSignal,
    lastEventId?: string | null,
  ) => Promise<{ lastEventId: string | null }>;
}

interface SessionManagerDeps {
  gateway: GatewayClient;
  emitToAllWindows: (channel: string, payload: Record<string, unknown>) => void;
}

type SessionStatus = 'handshaking' | 'ready' | 'ending' | 'ended' | 'error';

interface SessionState {
  deviceId: string;
  sessionId: string;
  handshakeId: string;
  conversationId: string;
  status: SessionStatus;
  keys: {
    clientToAgent: Buffer;
    agentToClient: Buffer;
    control: Buffer;
  } | null;
  nextOutgoingSeq: number;
  nextIncomingSeq: number;
  handshakeAbortController: AbortController | null;
  sseAbortController: AbortController | null;
  lastEventId: string | null;
  error: string | null;
}

function normalizeEncryptedFrame(payload: Record<string, unknown>): Record<string, unknown> | null {
  const nested = payload.encrypted;
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>;
  }

  if (payload.encrypted !== true) {
    return null;
  }

  // Support flattened encrypted frame shape where fields are top-level.
  if (
    typeof payload.ciphertext !== 'string'
    || typeof payload.nonce !== 'string'
    || (typeof payload.tag !== 'string' && typeof payload.auth_tag !== 'string')
  ) {
    return null;
  }

  return {
    alg: payload.alg,
    direction: payload.direction,
    seq: payload.seq,
    nonce: payload.nonce,
    ciphertext: payload.ciphertext,
    tag: typeof payload.tag === 'string' ? payload.tag : payload.auth_tag,
    aad: payload.aad,
  };
}

export default function createSessionManager(deps: SessionManagerDeps) {
  const sessions = new Map<string, SessionState>();
  const sendQueues = new Map<string, Promise<unknown>>();
  const deviceConversationIds = new Map<string, string>();
  const chatEventListeners = new Set<(payload: Record<string, unknown>) => void>();

  function emitChatEvent(payload: Record<string, unknown>): void {
    deps.emitToAllWindows('desktop:gateway-chat-event', payload);
    for (const listener of chatEventListeners) {
      try {
        listener(payload);
      } catch {
        // listener isolation
      }
    }
  }

  function onChatEvent(listener: (payload: Record<string, unknown>) => void): () => void {
    chatEventListeners.add(listener);
    return () => {
      chatEventListeners.delete(listener);
    };
  }

  function cleanupSessionResources(session: SessionState | undefined): void {
    if (!session) {
      return;
    }

    if (session.sseAbortController) {
      session.sseAbortController.abort();
      session.sseAbortController = null;
    }

    if (session.handshakeAbortController) {
      session.handshakeAbortController.abort();
      session.handshakeAbortController = null;
    }

    if (session.keys) {
      crypto.zeroKey(session.keys.clientToAgent);
      crypto.zeroKey(session.keys.agentToClient);
      crypto.zeroKey(session.keys.control);
      session.keys = null;
    }
  }

  function runSerializedSend(deviceId: string, task: () => Promise<unknown>): Promise<unknown> {
    const previous = sendQueues.get(deviceId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);

    let tracked: Promise<unknown>;
    tracked = run
      .catch(() => undefined)
      .finally(() => {
        if (sendQueues.get(deviceId) === tracked) {
          sendQueues.delete(deviceId);
        }
      });

    sendQueues.set(deviceId, tracked);
    return run;
  }

  function generateConversationId(): string {
    return `conv_${crypto.generateSessionId()}`;
  }

  async function startSession(gatewayUrl: string, deviceId: string): Promise<Record<string, unknown>> {
    if (sessions.has(deviceId)) {
      const existing = sessions.get(deviceId);
      if (existing && (existing.status === 'handshaking' || existing.status === 'ready')) {
        throw new Error(`Session already exists for device ${deviceId} (status: ${existing.status})`);
      }
      cleanupSessionResources(existing);
      sessions.delete(deviceId);
      sendQueues.delete(deviceId);
    }

    const activeSessions = [...sessions.values()].filter((session) => (
      session.status === 'handshaking' || session.status === 'ready'
    ));
    if (activeSessions.length >= MAX_SESSIONS) {
      throw new Error(`Max concurrent sessions (${MAX_SESSIONS}) reached`);
    }

    const sessionId = crypto.generateSessionId();
    const handshakeId = crypto.generateHandshakeId();
    const conversationId = deviceConversationIds.get(deviceId) || generateConversationId();
    const ephemeral = crypto.generateEphemeralX25519();
    const clientNonce = crypto.generateSessionNonce();

    const session: SessionState = {
      deviceId,
      sessionId,
      handshakeId,
      conversationId,
      status: 'handshaking',
      keys: null,
      nextOutgoingSeq: 1,
      nextIncomingSeq: 1,
      handshakeAbortController: null,
      sseAbortController: null,
      lastEventId: null,
      error: null,
    };

    sessions.set(deviceId, session);
    deviceConversationIds.set(deviceId, conversationId);

    emitChatEvent({ type: 'session.handshaking', deviceId, sessionId, conversationId });

    try {
      const identityKeyResult = await deps.gateway.fetchIdentityKey(gatewayUrl, deviceId);
      const agentIdentityPubBase64 = typeof identityKeyResult.public_key === 'string'
        ? identityKeyResult.public_key
        : '';
      if (!agentIdentityPubBase64) {
        throw new Error('Agent has no identity key registered');
      }

      const initResponse = await deps.gateway.initHandshake(
        gatewayUrl,
        sessionId,
        handshakeId,
        deviceId,
        ephemeral.publicKeyRawBase64,
        clientNonce,
        conversationId,
      );

      if (typeof initResponse.conversation_id === 'string' && initResponse.conversation_id.trim()) {
        session.conversationId = initResponse.conversation_id.trim();
        deviceConversationIds.set(deviceId, session.conversationId);
      }

      const startTime = Date.now();
      let ackData: Record<string, unknown> | null = null;
      session.handshakeAbortController = new AbortController();

      while (Date.now() - startTime < HANDSHAKE_TIMEOUT_MS) {
        if (session.status !== 'handshaking') {
          throw new Error('Handshake aborted - session status changed');
        }

        let poll: Record<string, unknown>;
        try {
          poll = await deps.gateway.pollHandshake(
            gatewayUrl,
            sessionId,
            handshakeId,
            session.handshakeAbortController.signal,
          );
        } catch (err) {
          if (session.status !== 'handshaking') {
            throw new Error('Handshake aborted - session status changed');
          }

          const message = err instanceof Error ? err.message : String(err);
          if (/timed out|abort/i.test(message)) {
            await sleepWithAbort(HANDSHAKE_POLL_INTERVAL_MS, session.handshakeAbortController?.signal);
            continue;
          }
          throw err;
        }

        if (poll.status === 'agent_acknowledged') {
          ackData = poll;
          break;
        }

        if (poll.status === 'agent_error') {
          const reason = typeof poll.last_error === 'string' && poll.last_error.trim()
            ? poll.last_error.trim()
            : 'unknown agent handshake error';
          throw new Error(`Handshake rejected by agent: ${reason}`);
        }

        await sleepWithAbort(HANDSHAKE_POLL_INTERVAL_MS, session.handshakeAbortController?.signal);
      }

      if (!ackData) {
        throw new Error('Handshake timed out - agent did not acknowledge');
      }

      if (typeof ackData.conversation_id === 'string' && ackData.conversation_id.trim()) {
        session.conversationId = ackData.conversation_id.trim();
        deviceConversationIds.set(deviceId, session.conversationId);
      }

      if (session.status !== 'handshaking') {
        throw new Error('Handshake aborted - session status changed');
      }

      const agentEphemeralPublicKey = typeof ackData.agent_ephemeral_public_key === 'string'
        ? ackData.agent_ephemeral_public_key
        : '';
      const transcriptHash = crypto.buildTranscriptHash(
        sessionId,
        handshakeId,
        ephemeral.publicKeyRawBase64,
        clientNonce,
        agentEphemeralPublicKey,
      );

      const agentSignature = typeof ackData.agent_identity_signature === 'string'
        ? ackData.agent_identity_signature
        : '';
      if (!agentSignature) {
        throw new Error('Agent handshake ack missing identity signature');
      }

      const signatureValid = crypto.verifyIdentitySignature(
        agentIdentityPubBase64,
        transcriptHash,
        agentSignature,
      );
      if (!signatureValid) {
        throw new Error('Agent identity signature verification failed - possible MITM');
      }

      const sharedSecret = crypto.deriveSharedSecret(ephemeral.privateKey, agentEphemeralPublicKey);
      let keys: { clientToAgent: Buffer; agentToClient: Buffer; control: Buffer };
      try {
        keys = crypto.deriveSessionKeys(sharedSecret, transcriptHash);
      } finally {
        crypto.zeroKey(sharedSecret);
      }

      session.keys = keys;
      session.status = 'ready';
      session.handshakeAbortController = null;

      const abortController = new AbortController();
      session.sseAbortController = abortController;

      deps.gateway.subscribeSessionEvents(
        gatewayUrl,
        sessionId,
        (sseEvent) => {
          if (sessions.get(deviceId) !== session) {
            return;
          }
          handleSseEvent(deviceId, sseEvent);
        },
        abortController.signal,
        null,
      ).catch((err) => {
        if (sessions.get(deviceId) !== session || session.status !== 'ready') {
          return;
        }

        cleanupSessionResources(session);
        session.status = 'error';
        session.error = err instanceof Error ? err.message : String(err);
        emitChatEvent({
          type: 'session.error',
          deviceId,
          error: session.error,
          conversationId: session.conversationId,
        });
      });

      emitChatEvent({
        type: 'session.ready',
        deviceId,
        sessionId,
        conversationId: session.conversationId,
      });

      return {
        ok: true,
        deviceId,
        sessionId,
        conversationId: session.conversationId,
      };
    } catch (err) {
      cleanupSessionResources(session);
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);
      emitChatEvent({
        type: 'session.error',
        deviceId,
        error: session.error,
        conversationId: session.conversationId,
      });
      throw err;
    }
  }

  function handleSseEvent(deviceId: string, sseEvent: { event: string; data: string; id: string }): void {
    const session = sessions.get(deviceId);
    if (!session || session.status !== 'ready' || !session.keys) {
      return;
    }

    if (!sseEvent?.data) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(sseEvent.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const encrypted = normalizeEncryptedFrame(payload);

    if (!encrypted) {
      emitChatEvent({
        type: payload.type || 'session.event',
        deviceId,
        payload,
      });
      return;
    }

    try {
      const seq = Number(encrypted.seq);
      if (!Number.isInteger(seq) || seq !== session.nextIncomingSeq) {
        throw new Error(`Invalid incoming sequence: expected ${session.nextIncomingSeq}, got ${encrypted.seq}`);
      }

      const plaintext = crypto.decryptFrame(session.keys.agentToClient, {
        alg: String(encrypted.alg || ''),
        direction: 'agent_to_client',
        seq,
        nonce: String(encrypted.nonce || ''),
        ciphertext: String(encrypted.ciphertext || ''),
        tag: String(encrypted.tag || ''),
        aad: String(encrypted.aad || ''),
      });

      session.nextIncomingSeq += 1;

      const decrypted = JSON.parse(plaintext) as Record<string, unknown>;
      emitChatEvent({
        type: 'session.event',
        deviceId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        payload: decrypted,
      });

      if (decrypted.result !== undefined || decrypted.error) {
        emitChatEvent({
          type: decrypted.error ? 'session.error' : 'session.result',
          deviceId,
          sessionId: session.sessionId,
          conversationId: session.conversationId,
          payload: decrypted,
        });
      }
    } catch (err) {
      emitChatEvent({
        type: 'session.decrypt_error',
        deviceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function sendMessage(
    gatewayUrl: string,
    deviceId: string,
    text: string,
    options: {
      correlationId?: string;
      authContext?: {
        requesterUid: string;
        requesterDeviceId: string;
        grantId: string;
        role?: 'owner' | 'collaborator';
        grantStatus?: 'active' | 'revoked';
      };
    } = {},
  ): Promise<Record<string, unknown>> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('message text cannot be empty');
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`message too long (max ${MAX_MESSAGE_LENGTH} chars)`);
    }

    const session = sessions.get(deviceId);
    if (!session || session.status !== 'ready' || !session.keys) {
      throw new Error(`No active ready session for device ${deviceId}`);
    }

    return runSerializedSend(deviceId, async () => {
      if (!session.keys) {
        throw new Error('session keys unavailable');
      }

      const messageId = crypto.generateSessionId();
      const rawAuthContext = (
        options.authContext
        && typeof options.authContext === 'object'
      ) ? options.authContext : null;
      const authContext = rawAuthContext
        && typeof rawAuthContext.requesterUid === 'string'
        && rawAuthContext.requesterUid.trim()
        && typeof rawAuthContext.requesterDeviceId === 'string'
        && rawAuthContext.requesterDeviceId.trim()
        && typeof rawAuthContext.grantId === 'string'
        && rawAuthContext.grantId.trim()
        ? {
          requester_uid: rawAuthContext.requesterUid.trim(),
          requester_device_id: rawAuthContext.requesterDeviceId.trim(),
          grant_id: rawAuthContext.grantId.trim(),
          role: rawAuthContext.role === 'owner' ? 'owner' : 'collaborator',
          grant_status: rawAuthContext.grantStatus === 'revoked' ? 'revoked' : 'active',
        }
        : null;
      const promptPayload = {
        session_id: session.sessionId,
        conversation_id: session.conversationId,
        message_id: messageId,
        prompt: trimmed,
        correlation_id: options.correlationId,
        hop_count: 0,
        ...(authContext ? { auth_context: authContext } : {}),
      };

      const seq = session.nextOutgoingSeq;
      const encrypted = crypto.encryptFrame(
        session.keys.clientToAgent,
        'client_to_agent',
        seq,
        JSON.stringify(promptPayload),
        session.sessionId,
        messageId,
      );

      const frame = {
        type: 'session.message',
        session_id: session.sessionId,
        conversation_id: session.conversationId,
        message_id: messageId,
        handshake_id: session.handshakeId,
        ...(authContext || {}),
        encrypted: true,
        alg: encrypted.alg,
        direction: encrypted.direction,
        seq: encrypted.seq,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        tag: encrypted.tag,
        aad: encrypted.aad,
      };

      await deps.gateway.sendMessage(gatewayUrl, session.sessionId, frame);

      session.nextOutgoingSeq += 1;
      emitChatEvent({
        type: 'session.message.sent',
        deviceId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        messageId,
        text: trimmed,
      });

      return {
        ok: true,
        deviceId,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        messageId,
      };
    }) as Promise<Record<string, unknown>>;
  }

  async function endSession(deviceId: string): Promise<Record<string, unknown>> {
    const session = sessions.get(deviceId);
    if (!session) {
      return { ok: true, alreadyEnded: true };
    }

    session.status = 'ending';
    cleanupSessionResources(session);
    session.status = 'ended';
    sessions.delete(deviceId);
    sendQueues.delete(deviceId);

    emitChatEvent({
      type: 'session.ended',
      deviceId,
      conversationId: session.conversationId,
    });

    return {
      ok: true,
      deviceId,
      sessionId: session.sessionId,
      conversationId: session.conversationId,
    };
  }

  function getSessionStatus(deviceId: string): Record<string, unknown> | null {
    const session = sessions.get(deviceId);
    if (!session) {
      return null;
    }

    return {
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      handshakeId: session.handshakeId,
      conversationId: session.conversationId,
      status: session.status,
      nextOutgoingSeq: session.nextOutgoingSeq,
      nextIncomingSeq: session.nextIncomingSeq,
      lastEventId: session.lastEventId,
      error: session.error,
    };
  }

  function listSessionStatuses(): Record<string, unknown>[] {
    return Array.from(sessions.values()).map((session) => ({
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      status: session.status,
      nextOutgoingSeq: session.nextOutgoingSeq,
      nextIncomingSeq: session.nextIncomingSeq,
      error: session.error,
    }));
  }

  return {
    startSession,
    sendMessage,
    endSession,
    getSessionStatus,
    listSessionStatuses,
    onChatEvent,
  };
}
