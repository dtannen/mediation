import { randomBytes } from 'node:crypto';

const LOCAL_PROMPT_REQUEST_TYPE = 'desktop.local_prompt.request';
const LOCAL_PROMPT_RESPONSE_TYPE = 'desktop.local_prompt.response';

interface LocalPromptBridgeState {
  child: {
    stdin?: {
      write: (text: string, encoding: BufferEncoding, cb?: (err?: Error | null) => void) => boolean;
      once?: (event: string, handler: () => void) => void;
    };
  };
  activeRequestId: string | null;
  pending: Map<string, {
    resolve: (result: Record<string, unknown>) => void;
    timeoutId: NodeJS.Timeout;
  }>;
}

export default function createLocalPromptBridge() {
  const localPromptBridges = new Map<string, LocalPromptBridgeState>();

  function getLocalPromptBridgeState(profileId: string): LocalPromptBridgeState | undefined {
    return localPromptBridges.get(profileId);
  }

  function closeLocalPromptBridge(profileId: string, reason = 'bridge_closed'): void {
    const bridge = localPromptBridges.get(profileId);
    if (!bridge) {
      return;
    }

    for (const pending of bridge.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.resolve({ ok: false, error: { code: 'bridge_closed', message: reason } });
    }

    bridge.pending.clear();
    bridge.activeRequestId = null;
    localPromptBridges.delete(profileId);
  }

  function registerLocalPromptBridge(profileId: string, child: LocalPromptBridgeState['child']): void {
    const existing = localPromptBridges.get(profileId);
    if (existing && existing.child !== child) {
      closeLocalPromptBridge(profileId, 'bridge_replaced');
    }

    localPromptBridges.set(profileId, {
      child,
      activeRequestId: null,
      pending: new Map(),
    });
  }

  function maybeHandleLocalPromptResponseLine(profileId: string, line: string): boolean {
    if (typeof line !== 'string') {
      return false;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      return false;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return false;
    }

    if (payload.type !== LOCAL_PROMPT_RESPONSE_TYPE) {
      return false;
    }

    const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
    const bridge = getLocalPromptBridgeState(profileId);
    if (!bridge || !requestId) {
      return true;
    }

    const pending = bridge.pending.get(requestId);
    if (!pending) {
      if (bridge.activeRequestId === requestId) {
        bridge.activeRequestId = null;
      }
      return true;
    }

    clearTimeout(pending.timeoutId);
    bridge.pending.delete(requestId);
    bridge.activeRequestId = null;

    pending.resolve({ ok: true, frame: payload });
    return true;
  }

  function requestLocalPrompt(
    profileId: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 120_000,
  ): Promise<Record<string, unknown>> {
    const bridge = getLocalPromptBridgeState(profileId);
    if (!bridge) {
      return Promise.resolve({
        ok: false,
        error: { code: 'bridge_unavailable', message: 'local prompt bridge is unavailable' },
      });
    }

    if (bridge.activeRequestId) {
      return Promise.resolve({
        ok: false,
        error: { code: 'orchestration_busy', message: 'local prompt request already in flight' },
      });
    }

    const requestId = randomBytes(8).toString('hex');
    const frame = {
      type: LOCAL_PROMPT_REQUEST_TYPE,
      request_id: requestId,
      ...payload,
    };

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        const current = getLocalPromptBridgeState(profileId);
        if (current) {
          current.pending.delete(requestId);
          setTimeout(() => {
            const b = getLocalPromptBridgeState(profileId);
            if (b && b.activeRequestId === requestId) {
              b.activeRequestId = null;
            }
          }, timeoutMs).unref();
        }

        resolve({ ok: false, error: { code: 'timeout', message: 'local prompt request timed out' } });
      }, timeoutMs);

      bridge.pending.set(requestId, { resolve, timeoutId });
      bridge.activeRequestId = requestId;

      const frameText = `${JSON.stringify(frame)}\n`;

      const onWriteDone = (err?: Error | null): void => {
        if (!err) {
          return;
        }

        clearTimeout(timeoutId);
        const current = getLocalPromptBridgeState(profileId);
        if (current) {
          current.pending.delete(requestId);
          if (current.activeRequestId === requestId) {
            current.activeRequestId = null;
          }
        }

        resolve({ ok: false, error: { code: 'write_failed', message: err.message } });
      };

      try {
        const writable = bridge.child.stdin;
        if (!writable || typeof writable.write !== 'function') {
          onWriteDone(new Error('agent stdin is unavailable'));
          return;
        }

        const writeResult = writable.write(frameText, 'utf8', onWriteDone);
        if (writeResult === false && typeof writable.once === 'function') {
          writable.once('drain', () => undefined);
        }
      } catch (err) {
        onWriteDone(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  return {
    getLocalPromptBridgeState,
    closeLocalPromptBridge,
    registerLocalPromptBridge,
    maybeHandleLocalPromptResponseLine,
    requestLocalPrompt,
  };
}
