import {
  executeLocalPromptRequest,
  type LocalPromptBridgeOptions,
  type LocalPromptRequestFrame,
} from '../../src/llm/local-prompt-bridge';
import { registerBuiltInProviders } from '../../src/llm/providers';
import { listProviderIds } from '../../src/llm/provider-registry';

interface LocalPromptBridge {
  registerLocalPromptBridge: (
    profileId: string,
    bridge: {
      executor: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>;
    },
  ) => void;
  closeLocalPromptBridge: (profileId: string, reason?: string) => void;
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
  const profiles = new Map<string, BridgeProfileRuntimeConfig>();
  let providersReady = false;

  function ensureProvidersRegistered(): void {
    if (providersReady) {
      return;
    }

    const existing = new Set(listProviderIds());
    if (!existing.has('claude') || !existing.has('ollama')) {
      registerBuiltInProviders();
    }

    providersReady = true;
  }

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

  function stopBridge(profileId: string, reason = 'bridge_stopped'): void {
    if (!profiles.has(profileId)) {
      deps.localBridge.closeLocalPromptBridge(profileId, reason);
      return;
    }

    profiles.delete(profileId);
    deps.localBridge.closeLocalPromptBridge(profileId, reason);
    deps.emitLog?.(profileId, `[bridge:stop] reason=${reason}`);
  }

  function ensureBridge(profileId: string): void {
    if (profiles.has(profileId)) {
      return;
    }

    ensureProvidersRegistered();

    const cfg = resolveRuntimeConfig(profileId);
    const options: LocalPromptBridgeOptions = {
      profileId,
      provider: cfg.provider,
      model: cfg.model,
      defaultCwd: cfg.cwd,
    };

    deps.localBridge.registerLocalPromptBridge(profileId, {
      executor: async (frame) => {
        const response = await executeLocalPromptRequest(
          frame as unknown as LocalPromptRequestFrame,
          options,
        );
        return response as unknown as Record<string, unknown>;
      },
    });

    profiles.set(profileId, cfg);
    deps.emitLog?.(profileId, `[bridge:start] provider=${cfg.provider} model=${cfg.model} mode=in-process`);
  }

  function stopAll(reason = 'bridge_manager_stopped'): void {
    for (const profileId of [...profiles.keys()]) {
      stopBridge(profileId, reason);
    }
  }

  return {
    ensureBridge,
    stopBridge,
    stopAll,
  };
}
