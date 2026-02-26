import { randomUUID } from 'node:crypto';
import { CH } from './channel-manifest';
import { normalizeGatewaySendError } from '../lib/errors';
import { SHARE_TOKEN_RE } from '../lib/validation';

const DEVICE_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const GRANT_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

interface IpcRegistry {
  handle: (
    ipcMain: unknown,
    channel: string,
    handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => void;
}

interface AuthService {
  getGatewayUrl: () => string;
  getStatus: () => Record<string, unknown>;
}

interface GatewayClient {
  fetchDevices: (gatewayUrl: string) => Promise<Record<string, unknown>>;
  createShareInvite: (
    gatewayUrl: string,
    payload: {
      deviceId: string;
      email: string;
      grantExpiresAt?: number;
      inviteTokenTtlSeconds?: number;
    },
  ) => Promise<Record<string, unknown>>;
  consumeShareInvite: (gatewayUrl: string, token: string) => Promise<Record<string, unknown>>;
  listShareGrants: (gatewayUrl: string, deviceId: string) => Promise<Record<string, unknown>>;
  revokeShareGrant: (gatewayUrl: string, grantId: string) => Promise<Record<string, unknown>>;
  leaveShareGrant: (gatewayUrl: string, grantId: string) => Promise<Record<string, unknown>>;
}

interface SessionManager {
  startSession: (gatewayUrl: string, deviceId: string) => Promise<Record<string, unknown>>;
  sendMessage: (
    gatewayUrl: string,
    deviceId: string,
    text: string,
    options?: {
      correlationId?: string;
      authContext?: {
        requesterUid: string;
        requesterDeviceId: string;
        grantId: string;
        role?: 'owner' | 'collaborator';
        grantStatus?: 'active' | 'revoked';
      };
    },
  ) => Promise<Record<string, unknown>>;
  endSession: (deviceId: string) => Promise<Record<string, unknown>>;
  getSessionStatus: (deviceId: string) => Record<string, unknown> | null;
  onChatEvent: (listener: (payload: Record<string, unknown>) => void) => () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureSessionReady(
  sessionManager: SessionManager,
  gatewayUrl: string,
  deviceId: string,
  timeoutMs = 45_000,
): Promise<void> {
  const current = sessionManager.getSessionStatus(deviceId);
  const currentStatus = typeof current?.status === 'string' ? current.status : '';

  if (!currentStatus || currentStatus === 'ended' || currentStatus === 'error') {
    await sessionManager.startSession(gatewayUrl, deviceId);
    return;
  }

  if (currentStatus === 'ready') {
    return;
  }

  if (currentStatus !== 'handshaking') {
    await sessionManager.startSession(gatewayUrl, deviceId);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = sessionManager.getSessionStatus(deviceId);
    const value = typeof status?.status === 'string' ? status.status : '';
    if (value === 'ready') {
      return;
    }
    if (value === 'error') {
      const details = typeof status?.error === 'string' && status.error.trim()
        ? `: ${status.error.trim()}`
        : '';
      throw new Error(`session handshake failed${details}`);
    }
    if (value !== 'handshaking') {
      break;
    }
    await sleep(200);
  }

  const latest = sessionManager.getSessionStatus(deviceId);
  const latestStatus = typeof latest?.status === 'string' && latest.status
    ? latest.status
    : 'none';
  if (latestStatus !== 'ready') {
    throw new Error(`session is not ready (status=${latestStatus})`);
  }
}

function invalidDeviceResponse(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'invalid_device_id',
      message: 'Invalid deviceId',
      recoverable: true,
    },
  };
}

function invalidGrantResponse(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'invalid_grant_id',
      message: 'Invalid grantId',
      recoverable: true,
    },
  };
}

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const deviceId = value.trim();
  if (!DEVICE_ID_RE.test(deviceId)) {
    return null;
  }
  return deviceId;
}

function normalizeGrantId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const grantId = value.trim();
  if (!GRANT_ID_RE.test(grantId)) {
    return null;
  }
  return grantId;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const email = value.trim();
  if (!email || email.length > 320 || !email.includes('@')) {
    return null;
  }
  return email;
}

function normalizeShareTokenInput(input: unknown): { ok: true; token: string } | { ok: false; error: string } {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Share link must be a string' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Share link is required' };
  }

  const parseTokenFromUrl = (urlString: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      return null;
    }

    const queryToken = parsed.searchParams.get('token');
    if (queryToken) {
      return queryToken;
    }

    const sharePrefix = '/share/';
    if (parsed.pathname && parsed.pathname.startsWith(sharePrefix)) {
      const tokenPart = parsed.pathname.slice(sharePrefix.length).split('/')[0];
      if (tokenPart) {
        return tokenPart;
      }
    }

    if (parsed.protocol === 'commands-desktop:' && parsed.hostname === 'share' && parsed.pathname.length > 1) {
      const tokenPart = parsed.pathname.slice(1).split('/')[0];
      if (tokenPart) {
        return tokenPart;
      }
    }

    return null;
  };

  const candidate = parseTokenFromUrl(trimmed) || trimmed;
  const token = String(candidate).trim();
  if (!SHARE_TOKEN_RE.test(token)) {
    return { ok: false, error: 'Invalid share link or token format' };
  }

  return { ok: true, token };
}

function isSignedIn(auth: AuthService): boolean {
  const status = auth.getStatus();
  return Boolean(status && typeof status === 'object' && status.signedIn === true);
}

function emitShareEvent(
  emitToAllWindows: ((channel: string, payload: Record<string, unknown>) => void) | undefined,
  payload: Record<string, unknown>,
): void {
  emitToAllWindows?.(CH.OUT_GATEWAY_SHARE_EVENT, payload);
}

function pickString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function extractCorrelationIdFromPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return '';
  }
  return pickString(payload, 'correlation_id') || pickString(payload, 'correlationId');
}

function invalidRemoteResultEnvelope(message: string): Record<string, unknown> {
  return {
    type: 'mediation.result',
    schema_version: 1,
    request_id: '',
    ok: false,
    error: {
      code: 'invalid_remote_result',
      message,
      recoverable: false,
    },
  };
}

function parseRecordOrJsonString(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return invalidRemoteResultEnvelope(trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed);
    }
  }
  return null;
}

function parseResultPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) {
    return null;
  }

  if (pickString(payload, 'type') === 'mediation.result' && typeof payload.ok === 'boolean') {
    return payload;
  }

  const direct = parseRecordOrJsonString(payload.result);
  if (direct) {
    return direct;
  }

  const response = parseRecordOrJsonString(payload.response);
  if (response) {
    return response;
  }

  const nestedMessage = payload.message;
  if (nestedMessage && typeof nestedMessage === 'object') {
    const nested = nestedMessage as Record<string, unknown>;
    const nestedDirect = parseRecordOrJsonString(nested.result);
    if (nestedDirect) {
      return nestedDirect;
    }
    const nestedResponse = parseRecordOrJsonString(nested.response);
    if (nestedResponse) {
      return nestedResponse;
    }
    if (pickString(nested, 'type') === 'mediation.result' && typeof nested.ok === 'boolean') {
      return nested;
    }
  }

  if (typeof payload.ok === 'boolean') {
    return payload;
  }

  const fallbackText = (
    pickString(payload, 'result')
    || pickString(payload, 'response')
    || pickString(payload, 'message')
    || pickString(payload, 'error')
  );
  if (fallbackText) {
    return invalidRemoteResultEnvelope(fallbackText.length > 1000 ? `${fallbackText.slice(0, 1000)}...` : fallbackText);
  }

  return null;
}

function parseEventError(payload: Record<string, unknown> | undefined, fallback = ''): string {
  if (!payload) {
    return fallback;
  }
  const nested = payload.error;
  if (nested && typeof nested === 'object') {
    const message = pickString(nested as Record<string, unknown>, 'message');
    if (message) {
      return message;
    }
  }
  return pickString(payload, 'message') || pickString(payload, 'error') || fallback;
}

function parseMediationTransportAuthContext(
  payload: Record<string, unknown> | undefined,
  authStatus: Record<string, unknown>,
): {
  requesterUid: string;
  requesterDeviceId: string;
  grantId: string;
  role: 'owner' | 'collaborator';
  grantStatus: 'active' | 'revoked';
} | null {
  const raw = (
    payload?.authContext
    && typeof payload.authContext === 'object'
  ) ? payload.authContext as Record<string, unknown> : {};

  const mediationDevice = (
    authStatus.mediationDevice
    && typeof authStatus.mediationDevice === 'object'
  ) ? authStatus.mediationDevice as Record<string, unknown> : {};

  const requesterUid = (
    pickString(raw, 'requesterUid')
    || pickString(raw, 'requester_uid')
    || pickString(authStatus, 'uid')
    || pickString(authStatus, 'userId')
  );
  const requesterDeviceId = (
    pickString(raw, 'requesterDeviceId')
    || pickString(raw, 'requester_device_id')
    || pickString(mediationDevice, 'id')
    || pickString(authStatus, 'mediationDeviceId')
  );
  const grantId = (
    pickString(raw, 'grantId')
    || pickString(raw, 'grant_id')
    || pickString(payload, 'grantId')
    || pickString(payload, 'grant_id')
  );

  if (!requesterUid || !requesterDeviceId || !grantId) {
    return null;
  }

  return {
    requesterUid,
    requesterDeviceId,
    grantId,
    // Messages to remote owner router are collaborator-scoped; never elevate
    // owner role from renderer-provided context.
    role: 'collaborator',
    grantStatus: 'active',
  };
}

function waitForMediationResult(
  sessionManager: SessionManager,
  deviceId: string,
  correlationId: string,
  timeoutMs: number,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      resolve({ ok: false, error: `remote response timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    const unsubscribe = sessionManager.onChatEvent((rawPayload) => {
      if (settled) {
        return;
      }

      const eventType = typeof rawPayload.type === 'string' ? rawPayload.type : '';
      if (pickString(rawPayload, 'deviceId') !== deviceId) {
        return;
      }

      const payload = rawPayload.payload && typeof rawPayload.payload === 'object'
        ? rawPayload.payload as Record<string, unknown>
        : undefined;
      const eventCorrelation = extractCorrelationIdFromPayload(payload);
      if (correlationId && eventCorrelation && eventCorrelation !== correlationId) {
        return;
      }

      if (eventType === 'session.error') {
        settled = true;
        clearTimeout(timeoutId);
        unsubscribe();
        resolve({
          ok: false,
          error: parseEventError(payload, pickString(rawPayload, 'error') || 'remote session error'),
        });
        return;
      }

      if (eventType !== 'session.result' && eventType !== 'session.event') {
        return;
      }

      const result = parseResultPayload(payload);
      if (!result) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      resolve({ ok: true, result });
    });
  });
}

function isRetryableSessionError(message: string): boolean {
  const normalized = message.toLowerCase();
  // Never retry explicit grant/session termination signals - these are terminal
  if (
    normalized.includes('grant_revoked')
    || normalized.includes('grant revoked')
    || normalized.includes('grant_expired')
    || normalized.includes('grant expired')
    || normalized.includes('session_terminated')
    || normalized.includes('session terminated')
  ) {
    return false;
  }
  return (
    normalized.includes('timeout')
    || normalized.includes('handshake')
    || normalized.includes('not ready')
    || normalized.includes('no active ready session')
    || normalized.includes('sse')
    || normalized.includes('session error')
    || normalized.includes('connection')
    || normalized.includes('network')
  );
}

function parseTerminationError(message: string): { code: 'grant_revoked' | 'session_terminated'; message: string } | null {
  const normalized = message.toLowerCase();
  if (normalized.includes('grant_revoked') || normalized.includes('grant revoked')) {
    return {
      code: 'grant_revoked',
      message,
    };
  }
  if (normalized.includes('session_terminated') || normalized.includes('session terminated')) {
    return {
      code: 'session_terminated',
      message,
    };
  }
  // Only treat explicit grant-specific error codes as terminal.
  // Generic 403/forbidden/unauthorized may be transient auth issues and should
  // not permanently terminate the device session.
  if (normalized.includes('grant_expired') || normalized.includes('grant expired')) {
    return {
      code: 'grant_revoked',
      message,
    };
  }
  return null;
}

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    auth: AuthService;
    gatewayClient: GatewayClient;
    sessionManager: SessionManager;
    emitToAllWindows?: (channel: string, payload: Record<string, unknown>) => void;
    emitStructuredLog?: (event: string, fields?: Record<string, unknown>) => void;
    onShareGrantLinked?: (grantId: string, caseId: string) => void;
    onShareGrantRevoked?: (grantId: string) => void;
    onShareGrantLeft?: (grantId: string) => void;
  },
): void {
  const {
    registry,
    auth,
    gatewayClient,
    sessionManager,
    emitToAllWindows,
    emitStructuredLog,
    onShareGrantLinked,
    onShareGrantRevoked,
    onShareGrantLeft,
  } = deps;
  const mediationCommandQueues = new Map<string, Promise<unknown>>();
  const deviceTerminationState = new Map<string, { code: 'grant_revoked' | 'session_terminated'; message: string; atMs: number }>();

  sessionManager.onChatEvent((rawPayload) => {
    const eventType = typeof rawPayload.type === 'string' ? rawPayload.type : '';
    const deviceId = pickString(rawPayload, 'deviceId');
    if (eventType !== 'session.error' || !deviceId) {
      return;
    }
    const message = parseEventError(
      (rawPayload.payload && typeof rawPayload.payload === 'object')
        ? rawPayload.payload as Record<string, unknown>
        : undefined,
      pickString(rawPayload, 'error') || 'session error',
    );
    const termination = parseTerminationError(message);
    if (!termination) {
      return;
    }
    deviceTerminationState.set(deviceId, {
      code: termination.code,
      message: termination.message,
      atMs: Date.now(),
    });
  });

  const runSerializedMediationCommand = async (
    deviceId: string,
    task: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    const previous = mediationCommandQueues.get(deviceId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);

    let tracked: Promise<unknown>;
    tracked = run
      .catch(() => undefined)
      .finally(() => {
        if (mediationCommandQueues.get(deviceId) === tracked) {
          mediationCommandQueues.delete(deviceId);
        }
      });

    mediationCommandQueues.set(deviceId, tracked);
    return run;
  };

  registry.handle(ipcMain, CH.GW_DEVICES, async () => {
    try {
      const gatewayUrl = auth.getGatewayUrl();
      const result = await gatewayClient.fetchDevices(gatewayUrl);
      const devices = Array.isArray((result as { devices?: unknown[] }).devices)
        ? (result as { devices: unknown[] }).devices
        : result;
      return { ok: true, devices };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle(ipcMain, CH.GW_START_SESSION, async (_event, payload) => {
    try {
      const deviceId = normalizeDeviceId(payload?.deviceId);
      if (!deviceId) {
        return invalidDeviceResponse();
      }
      return await sessionManager.startSession(auth.getGatewayUrl(), deviceId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle(ipcMain, CH.GW_SEND_MESSAGE, async (_event, payload) => {
    try {
      const deviceId = normalizeDeviceId(payload?.deviceId);
      if (!deviceId) {
        return invalidDeviceResponse();
      }

      const text = typeof payload?.text === 'string' ? payload.text : '';
      if (!text.trim()) {
        return {
          ok: false,
          error: {
            code: 'invalid_message',
            message: 'Message text is required',
            recoverable: true,
          },
        };
      }

      const correlationId = typeof payload?.correlationId === 'string' && payload.correlationId.trim()
        ? payload.correlationId.trim()
        : undefined;

      const gatewayUrl = auth.getGatewayUrl();
      await ensureSessionReady(sessionManager, gatewayUrl, deviceId);
      return await sessionManager.sendMessage(gatewayUrl, deviceId, text, { correlationId });
    } catch (err) {
      return { ok: false, error: normalizeGatewaySendError(err) };
    }
  });

  registry.handle(ipcMain, CH.GW_MEDIATION_COMMAND, async (_event, payload) => {
    try {
      const deviceId = normalizeDeviceId(payload?.deviceId);
      if (!deviceId) {
        return invalidDeviceResponse();
      }

      const command = payload?.command && typeof payload.command === 'object'
        ? payload.command as Record<string, unknown>
        : null;
      if (!command) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'command object is required',
            recoverable: true,
          },
        };
      }

      const timeoutMs = Number.isFinite(payload?.timeoutMs)
        ? Math.max(5_000, Math.min(120_000, Math.trunc(payload.timeoutMs)))
        : 60_000;
      const maxRetries = Number.isFinite(payload?.maxRetries)
        ? Math.max(1, Math.min(3, Math.trunc(payload.maxRetries)))
        : 3;
      const authStatus = auth.getStatus();
      const transportAuthContext = parseMediationTransportAuthContext(
        (payload && typeof payload === 'object') ? payload as Record<string, unknown> : undefined,
        authStatus,
      );

      return await runSerializedMediationCommand(deviceId, async () => {
        const terminated = deviceTerminationState.get(deviceId);
        if (terminated) {
          return {
            ok: false,
            error: {
              code: terminated.code,
              message: terminated.message,
              recoverable: false,
            },
          };
        }

        const gatewayUrl = auth.getGatewayUrl();
        let attempt = 0;
        let lastMessage = 'remote command failed';

        while (attempt < maxRetries) {
          attempt += 1;
          const correlationId = `corr_${randomUUID()}`;
          try {
            await ensureSessionReady(sessionManager, gatewayUrl, deviceId);
            await sessionManager.sendMessage(
              gatewayUrl,
              deviceId,
              JSON.stringify(command),
              transportAuthContext
                ? { correlationId, authContext: transportAuthContext }
                : { correlationId },
            );
            const awaited = await waitForMediationResult(sessionManager, deviceId, correlationId, timeoutMs);
            if (awaited.ok) {
              deviceTerminationState.delete(deviceId);
              return {
                ok: true,
                result: awaited.result,
                attempts: attempt,
              };
            }

            lastMessage = awaited.error;
            const awaitedTermination = parseTerminationError(lastMessage);
            if (awaitedTermination) {
              deviceTerminationState.set(deviceId, {
                code: awaitedTermination.code,
                message: awaitedTermination.message,
                atMs: Date.now(),
              });
              return {
                ok: false,
                error: {
                  code: awaitedTermination.code,
                  message: lastMessage,
                  recoverable: false,
                },
              };
            }
            if (!isRetryableSessionError(lastMessage) || attempt >= maxRetries) {
              return {
                ok: false,
                error: {
                  code: 'session_error',
                  message: lastMessage,
                  recoverable: isRetryableSessionError(lastMessage),
                },
                attempts: attempt,
              };
            }
          } catch (err) {
            lastMessage = err instanceof Error ? err.message : String(err);
            const terminatedState = parseTerminationError(lastMessage);
            if (terminatedState) {
              deviceTerminationState.set(deviceId, {
                code: terminatedState.code,
                message: terminatedState.message,
                atMs: Date.now(),
              });
            }
            if (!isRetryableSessionError(lastMessage) || attempt >= maxRetries) {
              return {
                ok: false,
                error: {
                  code: 'session_error',
                  message: lastMessage,
                  recoverable: isRetryableSessionError(lastMessage),
                },
                attempts: attempt,
              };
            }
          }

          await sleep(Math.min(250 * attempt, 1_000));
        }

        return {
          ok: false,
          error: {
            code: 'session_error',
            message: lastMessage,
            recoverable: true,
          },
          attempts: maxRetries,
        };
      });
    } catch (err) {
      return { ok: false, error: normalizeGatewaySendError(err) };
    }
  });

  registry.handle(ipcMain, CH.GW_END_SESSION, async (_event, payload) => {
    try {
      const deviceId = normalizeDeviceId(payload?.deviceId);
      if (!deviceId) {
        return invalidDeviceResponse();
      }
      return await sessionManager.endSession(deviceId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle(ipcMain, CH.GW_SHARE_CONSUME, async (_event, payload) => {
    try {
      const rawInput = typeof payload?.input === 'string'
        ? payload.input
        : (typeof payload?.token === 'string' ? payload.token : '');

      const normalized = normalizeShareTokenInput(rawInput);
      if (!normalized.ok) {
        emitStructuredLog?.('share.consume.error', {
          error: normalized.error,
          source: 'renderer',
        });
        emitShareEvent(emitToAllWindows, {
          type: 'share.consume.error',
          source: 'renderer',
          error: normalized.error,
        });
        return { ok: false, error: normalized.error };
      }

      if (!isSignedIn(auth)) {
        emitStructuredLog?.('share.consume.requires_auth', {
          source: 'renderer',
        });
        emitShareEvent(emitToAllWindows, {
          type: 'share.consume.requires-auth',
          source: 'renderer',
        });
        return {
          ok: false,
          requiresAuth: true,
          error: 'Sign in required to accept share links',
        };
      }

      const result = await gatewayClient.consumeShareInvite(auth.getGatewayUrl(), normalized.token);
      emitStructuredLog?.('share.consume.success', {
        grant_id: typeof result.grantId === 'string' ? result.grantId : '',
        device_id: typeof result.deviceId === 'string' ? result.deviceId : '',
      });
      emitShareEvent(emitToAllWindows, {
        type: 'share.consume.success',
        source: 'renderer',
        deviceId: typeof result.deviceId === 'string' ? result.deviceId : null,
        grantId: typeof result.grantId === 'string' ? result.grantId : null,
      });

      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitStructuredLog?.('share.consume.error', {
        error: message,
        source: 'renderer',
      });
      emitShareEvent(emitToAllWindows, {
        type: 'share.consume.error',
        source: 'renderer',
        error: message,
      });
      return { ok: false, error: message };
    }
  });

  registry.handle(ipcMain, CH.GW_SHARE_CREATE, async (_event, payload) => {
    try {
      const deviceId = normalizeDeviceId(payload?.deviceId);
      if (!deviceId) {
        return invalidDeviceResponse();
      }

      const email = normalizeEmail(payload?.email);
      if (!email) {
        return {
          ok: false,
          error: {
            code: 'invalid_email',
            message: 'Invalid email',
            recoverable: true,
          },
        };
      }

      const requestBody: {
        deviceId: string;
        email: string;
        grantExpiresAt?: number;
        inviteTokenTtlSeconds?: number;
      } = {
        deviceId,
        email,
      };

      if (Number.isFinite(payload?.grantExpiresAt)) {
        requestBody.grantExpiresAt = Math.trunc(payload.grantExpiresAt);
      }
      if (Number.isFinite(payload?.inviteTokenTtlSeconds)) {
        requestBody.inviteTokenTtlSeconds = Math.trunc(payload.inviteTokenTtlSeconds);
      }

      const result = await gatewayClient.createShareInvite(auth.getGatewayUrl(), requestBody);
      emitStructuredLog?.('share.create.success', {
        grant_id: typeof result.grantId === 'string' ? result.grantId : '',
        device_id: deviceId,
      });
      emitShareEvent(emitToAllWindows, {
        type: 'share.create.success',
        deviceId,
        grantId: typeof result.grantId === 'string' ? result.grantId : null,
      });

      const caseId = typeof payload?.caseId === 'string' ? payload.caseId.trim() : '';
      const grantId = typeof result.grantId === 'string' ? result.grantId.trim() : '';
      if (caseId && grantId) {
        onShareGrantLinked?.(grantId, caseId);
      }

      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitStructuredLog?.('share.create.error', {
        error: message,
      });
      emitShareEvent(emitToAllWindows, {
        type: 'share.create.error',
        error: message,
      });
      return { ok: false, error: message };
    }
  });

  registry.handle(ipcMain, CH.GW_SHARE_LIST_GRANTS, async (_event, payload) => {
    try {
      const deviceId = normalizeDeviceId(payload?.deviceId);
      if (!deviceId) {
        return invalidDeviceResponse();
      }

      const result = await gatewayClient.listShareGrants(auth.getGatewayUrl(), deviceId);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle(ipcMain, CH.GW_SHARE_REVOKE, async (_event, payload) => {
    try {
      const grantId = normalizeGrantId(payload?.grantId);
      if (!grantId) {
        return invalidGrantResponse();
      }

      const result = await gatewayClient.revokeShareGrant(auth.getGatewayUrl(), grantId);
      onShareGrantRevoked?.(grantId);
      emitShareEvent(emitToAllWindows, {
        type: 'share.revoke.success',
        grantId: typeof result.grantId === 'string' ? result.grantId : grantId,
      });

      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitShareEvent(emitToAllWindows, {
        type: 'share.revoke.error',
        error: message,
      });
      return { ok: false, error: message };
    }
  });

  registry.handle(ipcMain, CH.GW_SHARE_LEAVE, async (_event, payload) => {
    try {
      const grantId = normalizeGrantId(payload?.grantId);
      if (!grantId) {
        return invalidGrantResponse();
      }

      const result = await gatewayClient.leaveShareGrant(auth.getGatewayUrl(), grantId);
      onShareGrantLeft?.(grantId);
      emitShareEvent(emitToAllWindows, {
        type: 'share.leave.success',
        grantId: typeof result.grantId === 'string' ? result.grantId : grantId,
      });

      return { ok: true, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitShareEvent(emitToAllWindows, {
        type: 'share.leave.error',
        error: message,
      });
      return { ok: false, error: message };
    }
  });
}
