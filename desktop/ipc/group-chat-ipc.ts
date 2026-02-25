import { CH } from './channel-manifest';

interface IpcRegistry {
  handle: (ipcMain: unknown, channel: string, handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>) => void;
}

interface GroupChatRuntime {
  createRoom: (payload: unknown, options?: { background?: boolean }) => Promise<Record<string, unknown>>;
  pauseRoom: (roomId: string) => Promise<Record<string, unknown>>;
  resumeRoom: (roomId: string) => Promise<Record<string, unknown>>;
  stopRoom: (roomId: string, reason?: string) => Promise<Record<string, unknown>>;
  getRoomStatus: (roomId?: string) => Record<string, unknown>;
  editRoomState: (roomId: string, edits: Record<string, unknown>) => Promise<Record<string, unknown>>;
  approveRoom: (roomId: string) => Promise<Record<string, unknown>>;
}

export function createEmitRoomEvent(emitToAllWindows: (channel: string, payload: Record<string, unknown>) => void) {
  return function emitRoomEvent(payload: Record<string, unknown>): void {
    emitToAllWindows(CH.OUT_ROOM_EVENT, payload);
  };
}

export function createEmitRoomMetrics(emitToAllWindows: (channel: string, payload: Record<string, unknown>) => void) {
  return function emitRoomMetrics(payload: Record<string, unknown>): void {
    emitToAllWindows(CH.OUT_ROOM_METRICS, payload);
  };
}

function internalError(message: string): Record<string, unknown> {
  return { ok: false, error: { code: 'internal_error', message, recoverable: false } };
}

export function register(ipcMain: unknown, deps: { registry: IpcRegistry; roomRuntime: GroupChatRuntime; getAvailablePluginManifests: () => Record<string, unknown>[]; isRegistryReady: () => boolean }): void {
  const { registry, roomRuntime } = deps;

  registry.handle(ipcMain, CH.ROOM_CREATE, async (_event, payload) => {
    if (!deps.isRegistryReady()) {
      return { ok: false, error: { code: 'registry_not_ready', message: 'Plugin registry is still loading' } };
    }
    try {
      return await roomRuntime.createRoom(payload, { background: true });
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_PAUSE, async (_event, payload) => {
    try {
      return await roomRuntime.pauseRoom(String(payload?.roomId || ''));
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_RESUME, async (_event, payload) => {
    try {
      return await roomRuntime.resumeRoom(String(payload?.roomId || ''));
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_STOP, async (_event, payload) => {
    try {
      return await roomRuntime.stopRoom(String(payload?.roomId || ''), typeof payload?.reason === 'string' ? payload.reason : undefined);
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_STATUS, async (_event, payload) => {
    try {
      return roomRuntime.getRoomStatus(typeof payload?.roomId === 'string' ? payload.roomId : undefined);
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_EDIT_STATE, async (_event, payload) => {
    try {
      return await roomRuntime.editRoomState(String(payload?.roomId || ''), (payload?.edits && typeof payload.edits === 'object') ? payload.edits : {});
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_APPROVE, async (_event, payload) => {
    try {
      return await roomRuntime.approveRoom(String(payload?.roomId || ''));
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });

  registry.handle(ipcMain, CH.ROOM_PLUGIN_LIST, async () => {
    if (!deps.isRegistryReady()) {
      return { ok: false, error: { code: 'registry_not_ready', message: 'Plugin registry is still loading' } };
    }
    try {
      return { ok: true, manifests: deps.getAvailablePluginManifests() };
    } catch (err) {
      return internalError(err instanceof Error ? err.message : String(err));
    }
  });
}
