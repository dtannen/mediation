import { CH } from './channel-manifest';

interface IpcRegistry {
  handle: (ipcMain: unknown, channel: string, handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>) => void;
}

interface InterfacesService {
  listInterfaces: (profileId?: string) => Promise<Record<string, unknown>>;
  createSlackInterface: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  updateInterface: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteInterface: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  rotateInterfaceToken: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getWebhookUrl: (payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getInterfaceRuntimeStatus: () => Promise<Record<string, unknown>>;
  syncTunnel: () => Promise<Record<string, unknown>>;
}

function normalizeResponse(result: Record<string, unknown>): Record<string, unknown> {
  if (result && result.ok === false) {
    return {
      ok: false,
      error: typeof result.error === 'string' ? result.error : String(result.error || 'Unknown error'),
      ...(result.retryable === true ? { retryable: true } : {}),
    };
  }
  return result;
}

function catchToError(err: unknown): Record<string, unknown> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function register(ipcMain: unknown, deps: { registry: IpcRegistry; interfacesService: InterfacesService }): void {
  const r = deps.registry;
  const service = deps.interfacesService;

  r.handle(ipcMain, CH.INTERFACES_LIST, async (_event, payload) => {
    try {
      return normalizeResponse(await service.listInterfaces(typeof payload?.profileId === 'string' ? payload.profileId : undefined));
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_CREATE_SLACK, async (_event, payload) => {
    try {
      return normalizeResponse(await service.createSlackInterface(payload || {}));
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_UPDATE, async (_event, payload) => {
    try {
      return normalizeResponse(await service.updateInterface(payload || {}));
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_DELETE, async (_event, payload) => {
    try {
      return normalizeResponse(await service.deleteInterface(payload || {}));
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_ROTATE_TOKEN, async (_event, payload) => {
    try {
      return normalizeResponse(await service.rotateInterfaceToken(payload || {}));
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_GET_WEBHOOK_URL, async (_event, payload) => {
    try {
      return normalizeResponse(await service.getWebhookUrl(payload || {}));
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_RUNTIME_STATUS, async () => {
    try {
      return normalizeResponse(await service.getInterfaceRuntimeStatus());
    } catch (err) {
      return catchToError(err);
    }
  });

  r.handle(ipcMain, CH.INTERFACES_SYNC, async () => {
    try {
      return normalizeResponse(await service.syncTunnel());
    } catch (err) {
      return catchToError(err);
    }
  });
}
