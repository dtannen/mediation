import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const TRUSTED_ORIGINS = new Set([
  'https://api.commands.com',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);

export interface GatewayJsonResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  details?: Record<string, unknown>;
}

export interface SseEventFrame {
  event: string;
  data: string;
  id: string;
}

export function createSessionPlaintextPayload(input: {
  sessionId: string;
  conversationId: string;
  messageId: string;
  prompt: string;
  hopCount?: number;
  originAgentDeviceId?: string;
  traceId?: string;
  orchestratorProfileId?: string;
  correlationId?: string;
}): Record<string, unknown> {
  return {
    session_id: input.sessionId,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    prompt: input.prompt,
    ...(input.originAgentDeviceId ? { origin_agent_device_id: input.originAgentDeviceId } : {}),
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    ...(input.orchestratorProfileId ? { orchestrator_profile_id: input.orchestratorProfileId } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    hop_count: typeof input.hopCount === 'number' ? input.hopCount : 0,
  };
}

export function extractCorrelationId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>).correlation_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
const MAX_SSE_EVENT_DATA_CHARS = 512 * 1024;

function parseJsonSafe(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeGatewayError(data: unknown, status: number): { error: string; details?: Record<string, unknown> } {
  if (data && typeof data === 'object') {
    const maybeObject = data as Record<string, unknown>;
    if (maybeObject.error && typeof maybeObject.error === 'object') {
      const nested = maybeObject.error as Record<string, unknown>;
      const code = typeof nested.code === 'string' ? nested.code : '';
      const message = typeof nested.message === 'string' ? nested.message : '';
      return {
        error: [code, message].filter(Boolean).join(': ') || `HTTP ${status}`,
        details: maybeObject,
      };
    }

    if (typeof maybeObject.error === 'string' && maybeObject.error.trim()) {
      return {
        error: maybeObject.error,
        details: maybeObject,
      };
    }

    if (typeof maybeObject.message === 'string' && maybeObject.message.trim()) {
      return {
        error: maybeObject.message,
        details: maybeObject,
      };
    }

    return {
      error: `HTTP ${status}`,
      details: maybeObject,
    };
  }

  return {
    error: typeof data === 'string' && data.trim() ? data : `HTTP ${status}`,
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function validateTrustedOrigin(url: string): void {
  const parsed = new URL(url);
  if (!TRUSTED_ORIGINS.has(parsed.origin)) {
    throw new Error(`Untrusted origin: ${parsed.origin}`);
  }
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`HTTP not allowed for non-localhost: ${parsed.origin}`);
  }
}

export function normalizeTrustedUrl(value: string, fallbackUrl: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallbackUrl;
  }

  try {
    const parsed = new URL(value.trim());
    validateTrustedOrigin(parsed.origin);
    return parsed.origin;
  } catch {
    return fallbackUrl;
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<GatewayJsonResult<T>> {
  validateTrustedOrigin(url);

  try {
    const resp = await fetch(url, init);
    const text = await resp.text();
    const parsed = parseJsonSafe(text);

    if (!resp.ok) {
      const normalized = normalizeGatewayError(parsed, resp.status);
      return {
        ok: false,
        status: resp.status,
        error: normalized.error,
        details: normalized.details,
      };
    }

    return {
      ok: true,
      status: resp.status,
      data: parsed as T,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function gatewayHealth(gatewayUrl: string): Promise<GatewayJsonResult<{ status: string }>> {
  return requestJson<{ status: string }>(`${gatewayUrl}/gateway/v1/health`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

export async function registerIdentityKey(
  gatewayUrl: string,
  deviceId: string,
  deviceToken: string,
  publicKeyRawBase64: string,
  displayName?: string,
): Promise<GatewayJsonResult<void>> {
  return requestJson<void>(`${gatewayUrl}/gateway/v1/devices/${encodeURIComponent(deviceId)}/identity-key`, {
    method: 'PUT',
    headers: authHeaders(deviceToken),
    body: JSON.stringify({
      algorithm: 'ed25519',
      public_key: publicKeyRawBase64,
      ...(displayName && displayName.trim() ? { display_name: displayName.trim() } : {}),
    }),
  });
}

interface HandshakeAckPayload {
  device_id: string;
  agent_ephemeral_public_key: string;
  agent_identity_signature: string;
  transcript_hash: string;
  handshake_id: string;
}

export async function postHandshakeAck(
  gatewayUrl: string,
  sessionId: string,
  deviceToken: string,
  payload: HandshakeAckPayload,
): Promise<GatewayJsonResult<{ status: string; session_id: string; handshake_id: string }>> {
  return requestJson<{ status: string; session_id: string; handshake_id: string }>(
    `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/agent-ack`,
    {
      method: 'POST',
      headers: authHeaders(deviceToken),
      body: JSON.stringify(payload),
    },
  );
}

export async function initHandshake(
  gatewayUrl: string,
  sessionId: string,
  deviceToken: string,
  payload: {
    handshake_id: string;
    device_id: string;
    client_ephemeral_public_key: string;
    client_session_nonce: string;
    conversation_id?: string;
  },
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(
    `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/client-init`,
    {
      method: 'POST',
      headers: authHeaders(deviceToken),
      body: JSON.stringify(payload),
    },
  );
}

export async function pollHandshake(
  gatewayUrl: string,
  sessionId: string,
  handshakeId: string,
  deviceToken: string,
  signal?: AbortSignal,
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(
    `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/${encodeURIComponent(handshakeId)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${deviceToken}`,
      },
      signal,
    },
  );
}

export async function sendMessage(
  gatewayUrl: string,
  sessionId: string,
  deviceToken: string,
  frame: Record<string, unknown>,
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(
    `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      headers: { ...authHeaders(deviceToken), 'X-Idempotency-Key': randomUUID() },
      body: JSON.stringify(frame),
    },
  );
}

export async function createIntegrationRoute(
  gatewayUrl: string,
  deviceToken: string,
  payload: Record<string, unknown>,
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(`${gatewayUrl}/gateway/v1/integrations/routes`, {
    method: 'POST',
    headers: authHeaders(deviceToken),
    body: JSON.stringify(payload),
  });
}

export async function updateIntegrationRoute(
  gatewayUrl: string,
  routeId: string,
  deviceToken: string,
  payload: Record<string, unknown>,
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(
    `${gatewayUrl}/gateway/v1/integrations/routes/${encodeURIComponent(routeId)}`,
    {
      method: 'PUT',
      headers: authHeaders(deviceToken),
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteIntegrationRoute(
  gatewayUrl: string,
  routeId: string,
  deviceToken: string,
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(
    `${gatewayUrl}/gateway/v1/integrations/routes/${encodeURIComponent(routeId)}`,
    {
      method: 'DELETE',
      headers: authHeaders(deviceToken),
    },
  );
}

export async function rotateIntegrationRouteToken(
  gatewayUrl: string,
  routeId: string,
  deviceToken: string,
  graceSeconds = 300,
): Promise<GatewayJsonResult<Record<string, unknown>>> {
  return requestJson<Record<string, unknown>>(
    `${gatewayUrl}/gateway/v1/integrations/routes/${encodeURIComponent(routeId)}/rotate-token`,
    {
      method: 'POST',
      headers: authHeaders(deviceToken),
      body: JSON.stringify({ grace_seconds: Math.max(0, Math.min(1800, Math.floor(graceSeconds))) }),
    },
  );
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEventFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';
  let hasDataField = false;
  let currentId = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      throw new Error('SSE frame exceeds parser buffer limit');
    }

    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?=.)/g, '\n');
    if (buffer.endsWith('\r')) {
      continue;
    }

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).replace(/^ /, '');
      } else if (line.startsWith('data:')) {
        hasDataField = true;
        const appended = (currentData ? '\n' : '') + line.slice(5).replace(/^ /, '');
        if (currentData.length + appended.length > MAX_SSE_EVENT_DATA_CHARS) {
          throw new Error('SSE event exceeds parser data limit');
        }
        currentData += appended;
      } else if (line.startsWith('id:')) {
        currentId = line.slice(3).replace(/^ /, '');
      } else if (line === '') {
        if (hasDataField) {
          yield {
            event: currentEvent || 'message',
            data: currentData,
            id: currentId,
          };
        }
        currentEvent = '';
        currentData = '';
        hasDataField = false;
        currentId = '';
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.endsWith('\r')) {
    buffer = `${buffer.slice(0, -1)}\n`;
  }

  if (buffer.length > 0) {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).replace(/^ /, '');
      } else if (line.startsWith('data:')) {
        hasDataField = true;
        currentData += (currentData ? '\n' : '') + line.slice(5).replace(/^ /, '');
      } else if (line.startsWith('id:')) {
        currentId = line.slice(3).replace(/^ /, '');
      } else if (line === '') {
        if (hasDataField) {
          yield {
            event: currentEvent || 'message',
            data: currentData,
            id: currentId,
          };
        }
        currentEvent = '';
        currentData = '';
        hasDataField = false;
        currentId = '';
      }
    }
  }

  if (hasDataField) {
    yield {
      event: currentEvent || 'message',
      data: currentData,
      id: currentId,
    };
  }
}

export async function subscribeSessionEvents(
  gatewayUrl: string,
  sessionId: string,
  deviceToken: string,
  onEvent: (event: SseEventFrame) => void,
  signal: AbortSignal,
  lastEventId: string | null = null,
): Promise<{ lastEventId: string | null }> {
  validateTrustedOrigin(gatewayUrl);

  let currentLastEventId = lastEventId;
  let attempt = 0;

  while (!signal.aborted) {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${deviceToken}`,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      };
      if (currentLastEventId) {
        headers['Last-Event-ID'] = currentLastEventId;
      }

      const response = await fetch(
        `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        {
          headers,
          redirect: 'manual',
          signal,
        },
      );

      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        const normalized = normalizeGatewayError(parseJsonSafe(body), response.status);
        throw new Error(normalized.error || `SSE connect failed: ${response.status}`);
      }

      attempt = 0;
      for await (const event of parseSseStream(response.body)) {
        if (signal.aborted) {
          break;
        }
        if (event.id) {
          currentLastEventId = event.id;
        }
        onEvent(event);
      }

      if (!signal.aborted) {
        throw new Error('SSE stream ended');
      }
    } catch (err) {
      if (signal.aborted) {
        break;
      }

      attempt += 1;
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      const jitter = Math.floor(Math.random() * backoff * 0.3);
      await sleep(backoff + jitter, undefined, { signal }).catch(() => undefined);
    }
  }

  return { lastEventId: currentLastEventId };
}
