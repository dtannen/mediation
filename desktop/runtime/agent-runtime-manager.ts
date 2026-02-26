import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { type RawData } from 'ws';
import crypto from '../crypto';

const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const FORCE_KILL_WAIT_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MEDIATION_COMMAND_TIMEOUT_MS = 25_000;

type FrameDirection = 'client_to_agent' | 'agent_to_client';

export interface MediationDeviceIdentity {
  algorithm: 'ed25519';
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  publicKeyRawBase64: string;
}

export interface RuntimeLaunchConfig {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  ownerUid: string;
  ownerEmail: string;
  deviceId: string;
  deviceName: string;
  identity: MediationDeviceIdentity;
}

export interface RuntimeStatus {
  running: boolean;
  starting: boolean;
  ready: boolean;
  pid: number | null;
  deviceId: string | null;
  connectedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
}

interface RuntimeManagerDeps {
  homedir: string;
  defaultCwd: string;
  agentRoot?: string;
  emitLog?: (message: string) => void;
  onStatusChanged?: (status: RuntimeStatus) => void;
  onMediationCommandRequest?: (payload: Record<string, unknown>) => void;
  onMediationEventReceived?: (payload: Record<string, unknown>) => void;
  onGrantTerminated?: (input: {
    grantId: string;
    mode: 'revoke' | 'leave';
    raw: Record<string, unknown>;
  }) => void;
}

interface RuntimeSession {
  sessionId: string;
  handshakeId: string;
  conversationId: string | null;
  establishedAt: string;
  keys: {
    clientToAgent: Buffer;
    agentToClient: Buffer;
    control: Buffer;
  };
  nextIncomingSeq: number;
  nextOutgoingSeq: number;
}

interface PendingMediationRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function cloneStatus(status: RuntimeStatus): RuntimeStatus {
  return {
    running: status.running,
    starting: status.starting,
    ready: status.ready,
    pid: status.pid,
    deviceId: status.deviceId,
    connectedAt: status.connectedAt,
    lastError: status.lastError,
    lastEventAt: status.lastEventAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return 0;
  }
  return num;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

function rawDataToString(data: RawData): string {
  if (data instanceof Buffer) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString('utf8');
  }
  return String(data);
}

function toWsUrl(gatewayUrl: string, deviceId: string): string {
  const url = new URL(gatewayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/gateway/v1/agent/connect';
  url.search = '';
  url.searchParams.set('device_id', deviceId);
  return url.toString();
}

function parseMediationCommandPrompt(prompt: string): Record<string, unknown> | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record) {
    return null;
  }

  if (asString(record.type) !== 'mediation.command') {
    return null;
  }

  return record;
}

function parseMediationEventPrompt(prompt: string): Record<string, unknown> | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record) {
    return null;
  }

  if (asString(record.type) !== 'mediation.event') {
    return null;
  }

  return record;
}

function normalizeDirection(input: string): FrameDirection {
  const value = input.trim().toLowerCase();
  if (value === 'agent_to_client' || value === 'agent-to-client' || value === 'a2c') {
    return 'agent_to_client';
  }
  return 'client_to_agent';
}

function signTranscriptHash(identity: MediationDeviceIdentity, transcriptHashBase64: string): string {
  const privateKey = createPrivateKey({
    format: 'der',
    type: 'pkcs8',
    key: Buffer.from(identity.privateKeyDerBase64, 'base64'),
  });
  const signature = sign(null, Buffer.from(transcriptHashBase64, 'base64'), privateKey);
  return signature.toString('base64');
}

function requesterDisplayName(email: string, uid: string): string {
  if (email) {
    const at = email.indexOf('@');
    return at > 0 ? email.slice(0, at) : email;
  }
  return uid || 'unknown';
}

export default function createAgentRuntimeManager(deps: RuntimeManagerDeps) {
  let ws: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let runtimeAbortController: AbortController | null = null;
  let runtimeLoopPromise: Promise<void> | null = null;
  let activeLaunch: RuntimeLaunchConfig | null = null;
  let startDeferred: ReturnType<typeof createDeferred<{ ok: true }>> | null = null;
  let startTimer: NodeJS.Timeout | null = null;

  const sessions = new Map<string, RuntimeSession>();
  const pendingMediationRequests = new Map<string, PendingMediationRequest>();

  const status: RuntimeStatus = {
    running: false,
    starting: false,
    ready: false,
    pid: null,
    deviceId: null,
    connectedAt: null,
    lastError: null,
    lastEventAt: null,
  };

  function emitStatus(): void {
    status.lastEventAt = nowIso();
    deps.onStatusChanged?.(cloneStatus(status));
  }

  function emitLog(message: string): void {
    deps.emitLog?.(message);
  }

  function clearStartState(): void {
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    startDeferred = null;
  }

  function settleStartOk(): void {
    if (!startDeferred) {
      return;
    }
    startDeferred.resolve({ ok: true });
    clearStartState();
  }

  function settleStartErr(message: string): void {
    if (!startDeferred) {
      return;
    }
    startDeferred.reject(new Error(message));
    clearStartState();
  }

  function abortPendingStart(message: string): void {
    if (!startDeferred) {
      return;
    }
    startDeferred.reject(new Error(message));
    clearStartState();
  }

  function clearHeartbeat(): void {
    if (!heartbeatTimer) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearSessions(): void {
    for (const session of sessions.values()) {
      crypto.zeroKey(session.keys.clientToAgent);
      crypto.zeroKey(session.keys.agentToClient);
      crypto.zeroKey(session.keys.control);
    }
    sessions.clear();
  }

  function rejectPendingMediationRequests(reason: string): void {
    for (const [requestId, pending] of pendingMediationRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      pendingMediationRequests.delete(requestId);
    }
  }

  function sendJson(payload: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      emitLog(`[agent] websocket send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function postHandshakeAck(
    launch: RuntimeLaunchConfig,
    input: {
      sessionId: string;
      handshakeId: string;
      agentEphemeralPublicKey: string;
      agentIdentitySignature: string;
      transcriptHash: string;
    },
  ): Promise<void> {
    const response = await fetch(
      `${launch.gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(input.sessionId)}/handshake/agent-ack`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${launch.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          device_id: launch.deviceId,
          agent_ephemeral_public_key: input.agentEphemeralPublicKey,
          agent_identity_signature: input.agentIdentitySignature,
          transcript_hash: input.transcriptHash,
          handshake_id: input.handshakeId,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`handshake ack failed: HTTP ${response.status}${body ? ` ${body}` : ''}`);
    }
  }

  function sendSessionError(
    session: RuntimeSession | null,
    input: {
      sessionId: string;
      messageId: string;
      error: string;
      conversationId?: string | null;
      correlationId?: string | null;
      encrypted: boolean;
    },
  ): void {
    const conversationId = input.conversationId || null;
    const correlationId = input.correlationId || null;
    if (!session || !input.encrypted) {
      sendJson({
        type: 'session.error',
        session_id: input.sessionId,
        message_id: input.messageId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}),
        error: input.error,
      });
      return;
    }

    const seq = session.nextOutgoingSeq;
    const encrypted = crypto.encryptFrame(
      session.keys.agentToClient,
      'agent_to_client',
      seq,
      JSON.stringify({
        error: input.error,
        session_id: input.sessionId,
        message_id: input.messageId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}),
      }),
      input.sessionId,
      input.messageId,
    );
    session.nextOutgoingSeq += 1;

    sendJson({
      type: 'session.error',
      session_id: input.sessionId,
      message_id: input.messageId,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      encrypted: true,
      handshake_id: session.handshakeId,
      ...encrypted,
    });
  }

  function sendSessionProgress(
    session: RuntimeSession | null,
    input: {
      sessionId: string;
      messageId: string;
      conversationId?: string | null;
      correlationId?: string | null;
      encrypted: boolean;
    },
  ): void {
    const conversationId = input.conversationId || null;
    const correlationId = input.correlationId || null;
    if (!session || !input.encrypted) {
      sendJson({
        type: 'session.progress',
        session_id: input.sessionId,
        message_id: input.messageId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}),
        status: 'running',
      });
      return;
    }

    const seq = session.nextOutgoingSeq;
    const encrypted = crypto.encryptFrame(
      session.keys.agentToClient,
      'agent_to_client',
      seq,
      JSON.stringify({
        status: 'running',
        session_id: input.sessionId,
        message_id: input.messageId,
        ...(correlationId ? { correlation_id: correlationId } : {}),
      }),
      input.sessionId,
      input.messageId,
    );
    session.nextOutgoingSeq += 1;

    sendJson({
      type: 'session.progress',
      session_id: input.sessionId,
      message_id: input.messageId,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      encrypted: true,
      handshake_id: session.handshakeId,
      ...encrypted,
    });
  }

  function sendSessionResult(
    session: RuntimeSession | null,
    input: {
      sessionId: string;
      messageId: string;
      conversationId?: string | null;
      correlationId?: string | null;
      encrypted: boolean;
      result: Record<string, unknown>;
    },
  ): void {
    const conversationId = input.conversationId || null;
    const correlationId = input.correlationId || null;
    const resultText = JSON.stringify(input.result);
    if (!session || !input.encrypted) {
      sendJson({
        type: 'session.result',
        session_id: input.sessionId,
        message_id: input.messageId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}),
        result: resultText,
      });
      return;
    }

    const seq = session.nextOutgoingSeq;
    const encrypted = crypto.encryptFrame(
      session.keys.agentToClient,
      'agent_to_client',
      seq,
      JSON.stringify({
        result: resultText,
        session_id: input.sessionId,
        message_id: input.messageId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}),
      }),
      input.sessionId,
      input.messageId,
    );
    session.nextOutgoingSeq += 1;

    sendJson({
      type: 'session.result',
      session_id: input.sessionId,
      message_id: input.messageId,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
      encrypted: true,
      handshake_id: session.handshakeId,
      ...encrypted,
    });
  }

  async function waitForDesktopMediationResult(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!deps.onMediationCommandRequest) {
      throw new Error('mediation command handler is unavailable');
    }

    const requestId = asString(payload.request_id);
    if (!requestId) {
      throw new Error('mediation request_id is required');
    }

    const deferred = createDeferred<Record<string, unknown>>();
    const timer = setTimeout(() => {
      pendingMediationRequests.delete(requestId);
      deferred.reject(new Error(`desktop mediation command timed out after ${MEDIATION_COMMAND_TIMEOUT_MS}ms`));
    }, MEDIATION_COMMAND_TIMEOUT_MS);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    pendingMediationRequests.set(requestId, {
      resolve: deferred.resolve,
      reject: deferred.reject,
      timer,
    });

    try {
      deps.onMediationCommandRequest(payload);
    } catch (err) {
      pendingMediationRequests.delete(requestId);
      clearTimeout(timer);
      throw err instanceof Error ? err : new Error(String(err));
    }

    return deferred.promise;
  }

  async function handleHandshakeRequest(launch: RuntimeLaunchConfig, frame: Record<string, unknown>): Promise<void> {
    const sessionId = asString(frame.session_id ?? frame.sessionId);
    const handshakeId = asString(frame.handshake_id ?? frame.handshakeId);
    const conversationId = asString(frame.conversation_id ?? frame.conversationId) || null;
    const clientEphemeralPublicKey = asString(frame.client_ephemeral_public_key ?? frame.clientEphemeralPublicKey);
    const clientSessionNonce = asString(frame.client_session_nonce ?? frame.clientSessionNonce);

    if (!sessionId || !handshakeId || !clientEphemeralPublicKey || !clientSessionNonce) {
      sendJson({
        type: 'session.handshake.ack',
        status: 'error',
        session_id: sessionId,
        handshake_id: handshakeId,
        error: 'missing_handshake_fields',
      });
      return;
    }

    try {
      const ephemeral = crypto.generateEphemeralX25519();
      const transcriptHash = crypto.buildTranscriptHash(
        sessionId,
        handshakeId,
        clientEphemeralPublicKey,
        clientSessionNonce,
        ephemeral.publicKeyRawBase64,
      );
      const agentIdentitySignature = signTranscriptHash(launch.identity, transcriptHash);
      const sharedSecret = crypto.deriveSharedSecret(ephemeral.privateKey, clientEphemeralPublicKey);
      const keys = crypto.deriveSessionKeys(sharedSecret, transcriptHash);
      crypto.zeroKey(sharedSecret);

      await postHandshakeAck(launch, {
        sessionId,
        handshakeId,
        agentEphemeralPublicKey: ephemeral.publicKeyRawBase64,
        agentIdentitySignature,
        transcriptHash,
      });

      sessions.set(sessionId, {
        sessionId,
        handshakeId,
        conversationId,
        establishedAt: nowIso(),
        keys,
        nextIncomingSeq: 1,
        nextOutgoingSeq: 1,
      });

      sendJson({
        type: 'session.handshake.ack',
        status: 'ok',
        session_id: sessionId,
        handshake_id: handshakeId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        agent_ephemeral_public_key: ephemeral.publicKeyRawBase64,
        agent_identity_signature: agentIdentitySignature,
        transcript_hash: transcriptHash,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson({
        type: 'session.handshake.ack',
        status: 'error',
        session_id: sessionId,
        handshake_id: handshakeId,
        error: message,
      });
    }
  }

  async function handleSessionMessage(frame: Record<string, unknown>): Promise<void> {
    const sessionId = asString(frame.session_id ?? frame.sessionId);
    let messageId = asString(frame.message_id ?? frame.messageId) || 'unknown';

    if (!sessionId) {
      sendSessionError(null, {
        sessionId: 'unknown',
        messageId,
        error: 'missing_session_id',
        encrypted: false,
      });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      sendSessionError(null, {
        sessionId,
        messageId,
        error: 'handshake_not_established',
        encrypted: false,
      });
      return;
    }

    const hasEncryptedFields = (
      frame.encrypted === true
      || typeof frame.ciphertext === 'string'
      || typeof frame.nonce === 'string'
      || typeof frame.tag === 'string'
    );

    let encryptedRequest = false;
    let prompt = '';
    let conversationId = asString(frame.conversation_id ?? frame.conversationId) || session.conversationId;
    let correlationId = '';

    if (hasEncryptedFields) {
      encryptedRequest = true;
      const seq = asPositiveInt(frame.seq);
      if (!seq) {
        sendSessionError(session, {
          sessionId,
          messageId,
          conversationId,
          error: 'invalid_or_missing_seq',
          encrypted: true,
        });
        return;
      }

      if (seq !== session.nextIncomingSeq) {
        sendSessionError(session, {
          sessionId,
          messageId,
          conversationId,
          error: `unexpected_seq_expected_${session.nextIncomingSeq}_got_${seq}`,
          encrypted: true,
        });
        return;
      }

      const direction = normalizeDirection(asString(frame.direction));
      if (direction !== 'client_to_agent') {
        sendSessionError(session, {
          sessionId,
          messageId,
          conversationId,
          error: `invalid_direction_${direction}`,
          encrypted: true,
        });
        return;
      }

      const ciphertext = asString(frame.ciphertext);
      const nonce = asString(frame.nonce);
      const tag = asString(frame.tag ?? frame.auth_tag ?? frame.authTag);
      const aad = asString(frame.aad);

      if (!ciphertext || !nonce || !tag) {
        sendSessionError(session, {
          sessionId,
          messageId,
          conversationId,
          error: 'missing_encrypted_fields',
          encrypted: true,
        });
        return;
      }

      let decryptedText = '';
      try {
        decryptedText = crypto.decryptFrame(session.keys.clientToAgent, {
          alg: asString(frame.alg) || 'aes-256-gcm',
          direction: 'client_to_agent',
          seq,
          nonce,
          ciphertext,
          tag,
          aad,
        });
      } catch (err) {
        sendSessionError(session, {
          sessionId,
          messageId,
          conversationId,
          error: `decrypt_failed_${err instanceof Error ? err.message : String(err)}`,
          encrypted: true,
        });
        return;
      }

      const payload = asRecord((() => {
        try {
          return JSON.parse(decryptedText);
        } catch {
          return null;
        }
      })());

      if (!payload) {
        sendSessionError(session, {
          sessionId,
          messageId,
          conversationId,
          error: 'decrypted_payload_invalid_json',
          encrypted: true,
        });
        return;
      }

      const payloadMessageId = asString(payload.message_id ?? payload.messageId);
      if (payloadMessageId) {
        messageId = payloadMessageId;
      }

      const payloadConversationId = asString(payload.conversation_id ?? payload.conversationId);
      if (payloadConversationId) {
        conversationId = payloadConversationId;
      }

      correlationId = asString(payload.correlation_id ?? payload.correlationId);

      prompt = asString(payload.prompt ?? payload.text ?? payload.message);
      session.nextIncomingSeq += 1;
    } else {
      const payload = asRecord(frame.payload);
      prompt = asString(
        frame.prompt
        ?? frame.text
        ?? frame.message
        ?? payload?.prompt
        ?? payload?.text
        ?? payload?.message,
      );

      const payloadConversationId = asString(payload?.conversation_id ?? payload?.conversationId);
      if (payloadConversationId) {
        conversationId = payloadConversationId;
      }
      correlationId = asString(payload?.correlation_id ?? payload?.correlationId);
    }

    session.conversationId = conversationId || null;

    if (!prompt) {
      sendSessionError(session, {
        sessionId,
        messageId,
        conversationId,
        error: 'missing_prompt',
        encrypted: encryptedRequest,
      });
      return;
    }

    sendSessionProgress(session, {
      sessionId,
      messageId,
      conversationId,
      correlationId,
      encrypted: encryptedRequest,
    });

    // ── Extract transport-authenticated identity from the frame ──────────
    // This MUST happen before event/command branching so both paths have
    // access to the authenticated requester context from the gateway relay.
    const requesterRecord = asRecord(frame.requester);
    const requesterUid = asString(
      frame.requester_uid
      ?? frame.requesterUid
      ?? frame.user_id
      ?? frame.userId
      ?? requesterRecord?.uid,
    ) || 'unknown';
    const requesterEmail = asString(
      frame.requester_email
      ?? frame.requesterEmail
      ?? requesterRecord?.email,
    );
    const requesterDeviceId = asString(
      frame.requester_device_id
      ?? frame.requesterDeviceId
      ?? frame.device_id
      ?? frame.deviceId
      ?? requesterRecord?.device_id
      ?? requesterRecord?.deviceId,
    ) || 'unknown';
    const grantId = asString(
      frame.grant_id
      ?? frame.grantId
      ?? requesterRecord?.grant_id
      ?? requesterRecord?.grantId,
    );
    const roleRaw = asString(
      frame.requester_role
      ?? frame.requesterRole
      ?? frame.role
      ?? requesterRecord?.role,
    );
    const grantStatusRaw = asString(
      frame.grant_status
      ?? frame.grantStatus
      ?? requesterRecord?.grant_status
      ?? requesterRecord?.grantStatus,
    );

    // Fail closed: messages arriving via gateway WebSocket sessions are from remote
    // devices. If the gateway relay doesn't provide explicit role='owner', default to
    // 'collaborator'. The downstream router will reject collaborator requests missing
    // grantId, preventing unauthorized owner-privilege escalation.
    const role: 'owner' | 'collaborator' = roleRaw === 'owner'
      ? 'owner'
      : 'collaborator';
    const grantStatus = grantStatusRaw === 'revoked' ? 'revoked' : 'active';

    // ── Try parsing as a mediation event (push sync from owner device) ──
    // Events are fire-and-forget — we acknowledge receipt but don't send a
    // command result, so handle them before attempting command parsing.
    // Transport-authenticated identity fields are propagated so the
    // receiver can persist correct grant/device metadata.
    const mediationEvent = parseMediationEventPrompt(prompt);
    if (mediationEvent) {
      deps.onMediationEventReceived?.({
        ...mediationEvent,
        sessionId,
        messageId,
        requesterUid,
        requesterDeviceId,
        grantId,
        role,
        grantStatus,
      });
      // Acknowledge receipt so the sender doesn't see a timeout
      sendSessionResult(session, {
        sessionId,
        messageId,
        conversationId,
        correlationId,
        encrypted: encryptedRequest,
        result: { ok: true, type: 'mediation.event.ack' },
      });
      return;
    }

    const mediationCommand = parseMediationCommandPrompt(prompt);
    if (!mediationCommand) {
      sendSessionError(session, {
        sessionId,
        messageId,
        conversationId,
        correlationId,
        error: 'unsupported_prompt',
        encrypted: encryptedRequest,
      });
      return;
    }

    try {
      const result = await waitForDesktopMediationResult({
        type: 'mediation.command.request',
        request_id: `medcmd_${randomUUID()}`,
        sessionId,
        ...(conversationId ? { conversationId } : {}),
        messageId,
        requesterUid,
        requester_uid: requesterUid,
        requesterEmail: requesterEmail || null,
        requesterDisplayName: requesterDisplayName(requesterEmail, requesterUid),
        requesterDeviceId,
        requester_device_id: requesterDeviceId,
        grantId,
        grant_id: grantId,
        role,
        grantStatus,
        grant_status: grantStatus,
        command: mediationCommand,
      });

      sendSessionResult(session, {
        sessionId,
        messageId,
        conversationId,
        correlationId,
        encrypted: encryptedRequest,
        result,
      });
    } catch (err) {
      sendSessionError(session, {
        sessionId,
        messageId,
        conversationId,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
        encrypted: encryptedRequest,
      });
    }
  }

  async function handleIncomingFrame(launch: RuntimeLaunchConfig, frame: Record<string, unknown>): Promise<void> {
    const frameType = asString(frame.type || frame.event);
    if (!frameType || frameType === 'heartbeat') {
      return;
    }

    if (frameType === 'ping') {
      sendJson({
        type: 'heartbeat',
        device_id: launch.deviceId,
        at: nowIso(),
      });
      return;
    }

    if (frameType === 'session.handshake.request') {
      await handleHandshakeRequest(launch, frame);
      return;
    }

    if (frameType === 'session.message') {
      await handleSessionMessage(frame);
      return;
    }

    if (frameType === 'session.cancel') {
      const sessionId = asString(frame.session_id ?? frame.sessionId);
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          crypto.zeroKey(session.keys.clientToAgent);
          crypto.zeroKey(session.keys.agentToClient);
          crypto.zeroKey(session.keys.control);
          sessions.delete(sessionId);
        }
      }
      sendJson({
        type: 'session.cancelled',
        session_id: sessionId,
      });
      return;
    }

    if (frameType === 'grant.revoked' || frameType === 'grant.left') {
      const grantId = asString(frame.grant_id ?? frame.grantId);
      if (grantId) {
        deps.onGrantTerminated?.({
          grantId,
          mode: frameType === 'grant.revoked' ? 'revoke' : 'leave',
          raw: frame,
        });
      }
      return;
    }
  }

  async function connectOnce(launch: RuntimeLaunchConfig, signal: AbortSignal): Promise<void> {
    const wsUrl = toWsUrl(launch.gatewayUrl, launch.deviceId);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${launch.accessToken}`,
          'X-Device-Id': launch.deviceId,
        },
      });
      ws = socket;

      let settled = false;
      let opened = false;
      let forceCloseTimer: NodeJS.Timeout | null = null;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;

        if (forceCloseTimer) {
          clearTimeout(forceCloseTimer);
        }
        clearHeartbeat();
        if (ws === socket) {
          ws = null;
        }

        signal.removeEventListener('abort', onAbort);

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const onAbort = (): void => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try {
            socket.close(1000, 'shutdown');
          } catch {
            // no-op
          }

          forceCloseTimer = setTimeout(() => {
            try {
              if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.CLOSING) {
                socket.terminate();
              }
            } catch {
              // no-op
            }
            finish();
          }, FORCE_KILL_WAIT_MS);
          return;
        }

        finish();
      };

      signal.addEventListener('abort', onAbort, { once: true });

      socket.on('open', () => {
        opened = true;
        status.running = true;
        status.starting = false;
        status.ready = true;
        status.connectedAt = nowIso();
        status.lastError = null;
        status.pid = null;
        emitStatus();
        settleStartOk();

        sendJson({
          type: 'agent.hello',
          device_id: launch.deviceId,
          agent_version: 'mediation-desktop/1',
          capabilities: {
            plaintext_prompt_execution: false,
            handshake_ack_http: true,
            encrypted_frames: true,
            encrypted_algorithms: ['aes-256-gcm'],
            mediation_command_bridge: true,
          },
        });

        heartbeatTimer = setInterval(() => {
          sendJson({
            type: 'heartbeat',
            device_id: launch.deviceId,
            at: nowIso(),
          });
        }, HEARTBEAT_MS);
      });

      socket.on('message', (data: RawData) => {
        void (async () => {
          const text = rawDataToString(data);

          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            sendJson({
              type: 'agent.error',
              error: 'invalid_json',
            });
            return;
          }

          const record = asRecord(parsed);
          if (!record) {
            return;
          }

          await handleIncomingFrame(launch, record);
        })().catch((err) => {
          emitLog(`[agent] incoming frame handler error: ${err instanceof Error ? err.message : String(err)}`);
        });
      });

      socket.on('error', (err: Error) => {
        finish(err);
      });

      socket.on('close', (code: number, reasonBuf: Buffer) => {
        const reason = reasonBuf.toString('utf8');
        if (!signal.aborted) {
          emitLog(`[agent] socket closed code=${code} reason=${reason || 'none'}`);
        }

        clearSessions();
        rejectPendingMediationRequests('session_terminated');

        if (!opened && !signal.aborted) {
          finish(new Error(`runtime websocket closed before ready (code=${code}, reason=${reason || 'none'})`));
          return;
        }

        finish();
      });
    });
  }

  async function runRuntimeLoop(launch: RuntimeLaunchConfig, signal: AbortSignal): Promise<void> {
    let backoffMs = RECONNECT_BASE_MS;

    while (!signal.aborted) {
      try {
        await connectOnce(launch, signal);
        backoffMs = RECONNECT_BASE_MS;
      } catch (err) {
        if (signal.aborted) {
          break;
        }

        const message = err instanceof Error ? err.message : String(err);
        status.lastError = message;
        status.ready = false;
        emitStatus();
        emitLog(`[agent] runtime connection failed: ${message}`);

        if (status.starting) {
          settleStartErr(message);
        }
      }

      if (signal.aborted) {
        break;
      }

      status.ready = false;
      status.starting = false;
      emitStatus();

      const jitter = Math.floor(Math.random() * 300);
      await sleep(backoffMs + jitter, undefined, { signal }).catch(() => undefined);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    }
  }

  async function ensureStopped(): Promise<void> {
    abortPendingStart('runtime stopped');

    const abortController = runtimeAbortController;
    runtimeAbortController = null;

    const loopPromise = runtimeLoopPromise;
    runtimeLoopPromise = null;

    if (abortController) {
      abortController.abort();
    }

    const socket = ws;
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'stop');
        }
      } catch {
        // no-op
      }
    }

    if (loopPromise) {
      await Promise.race([
        loopPromise.catch(() => undefined),
        sleep(STOP_TIMEOUT_MS).then(() => {
          if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING)) {
            try {
              ws.terminate();
            } catch {
              // no-op
            }
          }
        }),
      ]);
    }

    clearHeartbeat();
    clearSessions();
    rejectPendingMediationRequests('runtime stopped');

    ws = null;
    activeLaunch = null;

    status.running = false;
    status.starting = false;
    status.ready = false;
    status.pid = null;
    status.deviceId = null;
    status.connectedAt = null;
    emitStatus();
  }

  async function ensureStarted(launch: RuntimeLaunchConfig): Promise<{ ok: true; status: RuntimeStatus }> {
    if (
      runtimeLoopPromise
      && activeLaunch
      && status.running
      && status.deviceId === launch.deviceId
      && (status.ready || status.starting)
    ) {
      if (startDeferred) {
        await startDeferred.promise;
      }
      return { ok: true, status: cloneStatus(status) };
    }

    if (runtimeLoopPromise) {
      await ensureStopped();
    }

    activeLaunch = launch;

    status.running = true;
    status.starting = true;
    status.ready = false;
    status.pid = null;
    status.deviceId = launch.deviceId;
    status.lastError = null;
    status.connectedAt = null;
    emitStatus();

    const abortController = new AbortController();
    runtimeAbortController = abortController;

    const deferred = createDeferred<{ ok: true }>();
    startDeferred = deferred;

    startTimer = setTimeout(() => {
      status.running = false;
      status.starting = false;
      status.ready = false;
      status.lastError = `runtime start timed out after ${START_TIMEOUT_MS}ms`;
      emitStatus();
      settleStartErr(status.lastError);
      void ensureStopped();
    }, START_TIMEOUT_MS);

    runtimeLoopPromise = runRuntimeLoop(launch, abortController.signal).catch((err) => {
      if (abortController.signal.aborted) {
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      status.running = false;
      status.starting = false;
      status.ready = false;
      status.lastError = message;
      emitStatus();
      settleStartErr(message);
    });

    await deferred.promise;
    return { ok: true, status: cloneStatus(status) };
  }

  function getStatus(): RuntimeStatus {
    return cloneStatus(status);
  }

  function sendControlFrame(frame: Record<string, unknown>): boolean {
    const type = asString(frame.type);
    if (type !== 'desktop.mediation.command.response') {
      return false;
    }

    const requestId = asString(frame.request_id);
    if (!requestId) {
      return false;
    }

    const pending = pendingMediationRequests.get(requestId);
    if (!pending) {
      return false;
    }

    pendingMediationRequests.delete(requestId);
    clearTimeout(pending.timer);

    const errorRecord = asRecord(frame.error);
    if (errorRecord) {
      const message = asString(errorRecord.message) || 'desktop mediation command failed';
      pending.reject(new Error(message));
      return true;
    }

    const resultRecord = asRecord(frame.result) || {};
    pending.resolve(resultRecord);
    return true;
  }

  return {
    ensureStarted,
    ensureStopped,
    getStatus,
    sendControlFrame,
  };
}
