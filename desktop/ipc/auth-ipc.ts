import { CH } from './channel-manifest';

interface IpcRegistry {
  handle: (
    ipcMain: unknown,
    channel: string,
    handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => void;
}

interface AuthService {
  signIn: (payload?: { gatewayUrl?: string }) => Promise<Record<string, unknown>>;
  signOut: () => Promise<Record<string, unknown>>;
  getStatus: () => Record<string, unknown>;
}

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    auth: AuthService;
    emitAuthChanged?: (payload: Record<string, unknown>) => void;
  },
): void {
  const { registry, auth } = deps;

  registry.handle(ipcMain, CH.AUTH_SIGN_IN, async (_event, payload) => {
    try {
      const result = await auth.signIn({
        gatewayUrl: typeof payload?.gatewayUrl === 'string' ? payload.gatewayUrl : undefined,
      });
      if (result.ok === true) {
        deps.emitAuthChanged?.(auth.getStatus() as Record<string, unknown>);
      }
      return result;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  registry.handle(ipcMain, CH.AUTH_SIGN_OUT, async () => {
    try {
      const result = await auth.signOut();
      deps.emitAuthChanged?.(auth.getStatus() as Record<string, unknown>);
      return result;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  registry.handle(ipcMain, CH.AUTH_STATUS, async () => {
    try {
      return auth.getStatus();
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
