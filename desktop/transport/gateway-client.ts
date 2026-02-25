import { validateTrustedOrigin } from '../lib/trusted-origins';
import { parseSseStream, createDedupSet } from '../lib/sse-parser';
import { sleepWithAbort } from '../lib/sleep-with-abort';

interface GatewayClientDeps {
  getAuthHeaders: (input?: { forceRefresh?: boolean }) => Promise<Record<string, string>>;
}

interface HttpError extends Error {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
const POLL_HANDSHAKE_REQUEST_TIMEOUT_MS = 10_000;

function buildHttpError(message: string, status: number, body = ''): HttpError {
  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = body ? JSON.parse(body) as Record<string, unknown> : null;
  } catch {
    parsedBody = null;
  }

  const code = typeof parsedBody?.error === 'string' && parsedBody.error.trim()
    ? parsedBody.error.trim()
    : '';
  const detailMessage = typeof parsedBody?.message === 'string' && parsedBody.message.trim()
    ? parsedBody.message.trim()
    : '';

  const fallbackBodyText = body.length > 300 ? `${body.slice(0, 297)}...` : body;
  const suffix = detailMessage || fallbackBodyText;

  const err = new Error(`${message}: ${status}${code ? ` ${code}` : ''}${suffix ? ` ${suffix}` : ''}`) as HttpError;
  err.status = status;
  if (code) {
    err.code = code;
  }
  if (parsedBody && typeof parsedBody === 'object') {
    err.details = parsedBody;
  }
  return err;
}

function validateGatewayOrigin(gatewayUrl: string): void {
  validateTrustedOrigin(gatewayUrl);
}

export default function createGatewayClient(deps: GatewayClientDeps) {
  async function gatewayFetch(url: string, options: RequestInit = {}, retry = true): Promise<Response> {
    validateGatewayOrigin(url);

    const authHeaders = await deps.getAuthHeaders();

    const response = await fetch(url, {
      ...options,
      redirect: 'manual',
      headers: {
        ...options.headers,
        ...authHeaders,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401 && retry) {
      await deps.getAuthHeaders({ forceRefresh: true });
      return gatewayFetch(url, options, false);
    }

    return response;
  }

  async function gatewayJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await gatewayFetch(url, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw buildHttpError(`Gateway ${options.method || 'GET'} ${url} failed`, response.status, text);
    }
    return response.json() as Promise<T>;
  }

  async function fetchDevices(gatewayUrl: string): Promise<Record<string, unknown>> {
    return gatewayJson(`${gatewayUrl}/gateway/v1/devices`);
  }

  async function fetchIdentityKey(gatewayUrl: string, deviceId: string): Promise<Record<string, unknown>> {
    return gatewayJson(`${gatewayUrl}/gateway/v1/devices/${encodeURIComponent(deviceId)}/identity-key`);
  }

  async function initHandshake(
    gatewayUrl: string,
    sessionId: string,
    handshakeId: string,
    deviceId: string,
    clientEphemeralPubKey: string,
    clientSessionNonce: string,
    conversationId: string | null = null,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      handshake_id: handshakeId,
      device_id: deviceId,
      client_ephemeral_public_key: clientEphemeralPubKey,
      client_session_nonce: clientSessionNonce,
    };
    if (typeof conversationId === 'string' && conversationId.trim()) {
      body.conversation_id = conversationId.trim();
    }

    return gatewayJson(`${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/client-init`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async function pollHandshake(
    gatewayUrl: string,
    sessionId: string,
    handshakeId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutController.abort(new Error('Handshake poll request timed out'));
    }, POLL_HANDSHAKE_REQUEST_TIMEOUT_MS);

    const forwardAbort = () => timeoutController.abort(new Error('Handshake poll aborted'));

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutHandle);
        timeoutController.abort(new Error('Handshake poll aborted'));
      } else {
        signal.addEventListener('abort', forwardAbort, { once: true });
      }
    }

    try {
      return gatewayJson(
        `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/handshake/${encodeURIComponent(handshakeId)}`,
        { signal: timeoutController.signal },
      );
    } finally {
      clearTimeout(timeoutHandle);
      if (signal) {
        signal.removeEventListener('abort', forwardAbort);
      }
    }
  }

  async function sendMessage(gatewayUrl: string, sessionId: string, encryptedFrame: Record<string, unknown>): Promise<Record<string, unknown>> {
    return gatewayJson(`${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(encryptedFrame),
    });
  }

  async function createIntegrationRoute(
    gatewayUrl: string,
    bearerToken: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
    validateGatewayOrigin(gatewayUrl);

    const response = await fetch(`${gatewayUrl}/gateway/v1/integrations/routes`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
    return { ok: true, status: response.status, data: parsed };
  }

  async function updateIntegrationRoute(
    gatewayUrl: string,
    routeId: string,
    bearerToken: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
    validateGatewayOrigin(gatewayUrl);

    const response = await fetch(`${gatewayUrl}/gateway/v1/integrations/routes/${encodeURIComponent(routeId)}`, {
      method: 'PUT',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
    return { ok: true, status: response.status, data: parsed };
  }

  async function deleteIntegrationRoute(
    gatewayUrl: string,
    routeId: string,
    bearerToken: string,
  ): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
    validateGatewayOrigin(gatewayUrl);

    const response = await fetch(`${gatewayUrl}/gateway/v1/integrations/routes/${encodeURIComponent(routeId)}`, {
      method: 'DELETE',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
    return { ok: true, status: response.status, data: parsed };
  }

  async function rotateIntegrationRouteToken(
    gatewayUrl: string,
    routeId: string,
    bearerToken: string,
    graceSeconds = 300,
  ): Promise<{ ok: boolean; status: number; data?: Record<string, unknown>; error?: string }> {
    validateGatewayOrigin(gatewayUrl);

    const response = await fetch(`${gatewayUrl}/gateway/v1/integrations/routes/${encodeURIComponent(routeId)}/rotate-token`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grace_seconds: Math.max(0, Math.min(1800, Math.floor(graceSeconds))),
      }),
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return { ok: false, status: response.status, error: text || `HTTP ${response.status}` };
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }
    return { ok: true, status: response.status, data: parsed };
  }

  async function subscribeSse(
    url: string,
    onEvent: (event: { event: string; data: string; id: string }) => void,
    signal: AbortSignal,
    lastEventId: string | null = null,
    options: { maxConsecutiveFailures?: number } = {},
  ): Promise<{ lastEventId: string | null }> {
    validateGatewayOrigin(url);

    const dedup = createDedupSet();
    let currentLastId = lastEventId;
    let attempt = 0;
    let lastWas401 = false;
    let consecutiveFailures = 0;

    const maxConsecutiveFailures = Number.isInteger(options.maxConsecutiveFailures)
      && (options.maxConsecutiveFailures as number) > 0
      ? (options.maxConsecutiveFailures as number)
      : Infinity;

    while (!signal.aborted) {
      try {
        const authHeaders = await deps.getAuthHeaders(lastWas401 ? { forceRefresh: true } : undefined);
        lastWas401 = false;

        const headers: Record<string, string> = {
          ...authHeaders,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        };
        if (currentLastId) {
          headers['Last-Event-ID'] = currentLastId;
        }

        const response = await fetch(url, {
          headers,
          redirect: 'manual',
          signal,
        });

        if (response.status === 401) {
          lastWas401 = true;
          const body = await response.text().catch(() => '');
          throw buildHttpError('SSE connect failed', response.status, body);
        }

        if (!response.ok || !response.body) {
          const body = await response.text().catch(() => '');
          throw buildHttpError('SSE connect failed', response.status, body);
        }

        attempt = 0;
        consecutiveFailures = 0;

        for await (const event of parseSseStream(response.body)) {
          if (signal.aborted) {
            break;
          }

          if (event.id) {
            currentLastId = event.id;
          }

          if (event.id && dedup.has(event.id)) {
            continue;
          }
          if (event.id) {
            dedup.add(event.id);
          }

          try {
            onEvent(event);
          } catch {
            // listener isolation
          }
        }

        if (!signal.aborted) {
          throw new Error('SSE stream ended');
        }
      } catch (err) {
        if (signal.aborted) {
          break;
        }
        if ((err as HttpError)?.status === 404) {
          throw err;
        }

        consecutiveFailures += 1;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`SSE terminated after ${consecutiveFailures} consecutive failures: ${reason}`);
        }

        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
        const jitter = Math.random() * delay * 0.3;
        await sleepWithAbort(delay + jitter, signal, { resolveOnAbort: true });
      }
    }

    return { lastEventId: currentLastId };
  }

  async function subscribeSessionEvents(
    gatewayUrl: string,
    sessionId: string,
    onEvent: (event: { event: string; data: string; id: string }) => void,
    signal: AbortSignal,
    lastEventId: string | null = null,
  ): Promise<{ lastEventId: string | null }> {
    return subscribeSse(
      `${gatewayUrl}/gateway/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      onEvent,
      signal,
      lastEventId,
    );
  }

  return {
    fetchDevices,
    fetchIdentityKey,
    initHandshake,
    pollHandshake,
    sendMessage,
    createIntegrationRoute,
    updateIntegrationRoute,
    deleteIntegrationRoute,
    rotateIntegrationRouteToken,
    subscribeSse,
    subscribeSessionEvents,
  };
}
