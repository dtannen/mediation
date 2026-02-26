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
    getStatusPayload?: () => Record<string, unknown>;
    onSignedIn?: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
    onSignedOut?: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  },
): void {
  const { registry, auth } = deps;
  const statusPayload = (): Record<string, unknown> => (
    typeof deps.getStatusPayload === 'function'
      ? deps.getStatusPayload()
      : auth.getStatus()
  );

  registry.handle(ipcMain, CH.AUTH_SIGN_IN, async (_event, payload) => {
    try {
      const result = await auth.signIn({
        gatewayUrl: typeof payload?.gatewayUrl === 'string' ? payload.gatewayUrl : undefined,
      });
      if (result.ok === true) {
        const runtimeResult = await deps.onSignedIn?.();
        deps.emitAuthChanged?.(statusPayload());
        if (runtimeResult && typeof runtimeResult === 'object') {
          return { ...result, runtime: runtimeResult };
        }
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
      await deps.onSignedOut?.();
      deps.emitAuthChanged?.(statusPayload());
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
      return statusPayload();
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
