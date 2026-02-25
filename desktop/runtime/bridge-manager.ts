import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

interface LocalPromptBridge {
  registerLocalPromptBridge: (profileId: string, child: ChildProcessWithoutNullStreams) => void;
  closeLocalPromptBridge: (profileId: string, reason?: string) => void;
  maybeHandleLocalPromptResponseLine: (profileId: string, line: string) => boolean;
}

export interface BridgeProfileRuntimeConfig {
  provider: string;
  model: string;
  cwd: string;
}

interface BridgeManagerDeps {
  localBridge: LocalPromptBridge;
  resolveProfileRuntimeConfig?: (profileId: string) => BridgeProfileRuntimeConfig;
  emitLog?: (profileId: string, message: string) => void;
}

export default function createBridgeManager(deps: BridgeManagerDeps) {
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  const outReaders = new Map<string, ReturnType<typeof createInterface>>();
  const errReaders = new Map<string, ReturnType<typeof createInterface>>();
  const bridgeScriptPath = path.join(__dirname, 'bridge-child.js');

  function resolveRuntimeConfig(profileId: string): BridgeProfileRuntimeConfig {
    if (deps.resolveProfileRuntimeConfig) {
      return deps.resolveProfileRuntimeConfig(profileId);
    }

    return {
      provider: process.env.MEDIATION_BRIDGE_PROVIDER || process.env.PROVIDER || 'claude',
      model: process.env.MEDIATION_BRIDGE_MODEL || process.env.MODEL || 'sonnet',
      cwd: process.env.MEDIATION_BRIDGE_CWD || process.cwd(),
    };
  }

  function cleanupReaders(profileId: string): void {
    const out = outReaders.get(profileId);
    if (out) {
      try {
        out.removeAllListeners();
        out.close();
      } catch {
        // best-effort
      }
      outReaders.delete(profileId);
    }

    const err = errReaders.get(profileId);
    if (err) {
      try {
        err.removeAllListeners();
        err.close();
      } catch {
        // best-effort
      }
      errReaders.delete(profileId);
    }
  }

  function stopBridge(profileId: string, reason = 'bridge_stopped'): void {
    const child = children.get(profileId);
    if (!child) {
      deps.localBridge.closeLocalPromptBridge(profileId, reason);
      cleanupReaders(profileId);
      return;
    }

    children.delete(profileId);
    cleanupReaders(profileId);
    deps.localBridge.closeLocalPromptBridge(profileId, reason);

    try {
      child.kill('SIGTERM');
    } catch {
      // no-op
    }
  }

  function wireChildStreams(profileId: string, child: ChildProcessWithoutNullStreams): void {
    const stdoutReader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      terminal: false,
    });
    outReaders.set(profileId, stdoutReader);

    stdoutReader.on('line', (line: string) => {
      if (!deps.localBridge.maybeHandleLocalPromptResponseLine(profileId, line)) {
        const trimmed = line.trim();
        if (trimmed) {
          deps.emitLog?.(profileId, `[bridge:stdout] ${trimmed}`);
        }
      }
    });

    const stderrReader = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
      terminal: false,
    });
    errReaders.set(profileId, stderrReader);

    stderrReader.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed) {
        deps.emitLog?.(profileId, `[bridge:stderr] ${trimmed}`);
      }
    });
  }

  function spawnBridge(profileId: string): ChildProcessWithoutNullStreams {
    const cfg = resolveRuntimeConfig(profileId);
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MEDIATION_BRIDGE_PROFILE_ID: profileId,
      MEDIATION_BRIDGE_PROVIDER: cfg.provider,
      MEDIATION_BRIDGE_MODEL: cfg.model,
      MEDIATION_BRIDGE_CWD: cfg.cwd,
    };

    const child = spawn(process.execPath, [bridgeScriptPath], {
      env,
      cwd: cfg.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    deps.localBridge.registerLocalPromptBridge(profileId, child);
    wireChildStreams(profileId, child);

    child.on('error', (err) => {
      deps.emitLog?.(profileId, `[bridge:error] ${err.message}`);
      children.delete(profileId);
      cleanupReaders(profileId);
      deps.localBridge.closeLocalPromptBridge(profileId, 'bridge_error');
    });

    child.on('close', (code, signal) => {
      children.delete(profileId);
      cleanupReaders(profileId);
      deps.localBridge.closeLocalPromptBridge(profileId, 'bridge_exit');
      deps.emitLog?.(
        profileId,
        `[bridge:exit] code=${code == null ? 'null' : String(code)} signal=${signal || 'none'}`,
      );
    });

    children.set(profileId, child);
    deps.emitLog?.(profileId, `[bridge:start] provider=${cfg.provider} model=${cfg.model}`);
    return child;
  }

  function ensureBridge(profileId: string): ChildProcessWithoutNullStreams {
    const existing = children.get(profileId);
    if (existing && !existing.killed) {
      return existing;
    }
    return spawnBridge(profileId);
  }

  function stopAll(reason = 'bridge_manager_stopped'): void {
    for (const profileId of [...children.keys()]) {
      stopBridge(profileId, reason);
    }
  }

  return {
    ensureBridge,
    stopBridge,
    stopAll,
  };
}

