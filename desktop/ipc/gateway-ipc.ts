import { CH } from './channel-manifest';
import { normalizeGatewaySendError } from '../lib/errors';

const DEVICE_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

interface IpcRegistry {
  handle: (
    ipcMain: unknown,
    channel: string,
    handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => void;
}

interface AuthService {
  getGatewayUrl: () => string;
}

interface GatewayClient {
  fetchDevices: (gatewayUrl: string) => Promise<Record<string, unknown>>;
}

interface SessionManager {
  startSession: (gatewayUrl: string, deviceId: string) => Promise<Record<string, unknown>>;
  sendMessage: (
    gatewayUrl: string,
    deviceId: string,
    text: string,
    options?: { correlationId?: string },
  ) => Promise<Record<string, unknown>>;
  endSession: (deviceId: string) => Promise<Record<string, unknown>>;
  getSessionStatus: (deviceId: string) => Record<string, unknown> | null;
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

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    auth: AuthService;
    gatewayClient: GatewayClient;
    sessionManager: SessionManager;
  },
): void {
  const { registry, auth, gatewayClient, sessionManager } = deps;

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
}
