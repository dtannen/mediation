import type { ProviderPlugin, ProviderRunInput } from './provider';

const registry = new Map<string, ProviderPlugin>();

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class UnknownProviderError extends Error {
  constructor(id: string) {
    super(`Unknown provider "${id}". Available: ${listProviderIds().join(', ') || '(none)'}`);
    this.name = 'UnknownProviderError';
  }
}

function isValidPlugin(plugin: unknown): plugin is ProviderPlugin {
  if (!plugin || typeof plugin !== 'object') {
    return false;
  }
  const candidate = plugin as Record<string, unknown>;
  const capabilities = candidate.capabilities as Record<string, unknown> | undefined;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.defaultModel === 'string' &&
    typeof candidate.runPrompt === 'function' &&
    capabilities !== undefined &&
    typeof capabilities.supportsTools === 'boolean' &&
    typeof capabilities.supportsSessionResume === 'boolean' &&
    typeof capabilities.supportsPolicy === 'boolean'
  );
}

export function registerProvider(plugin: ProviderPlugin): void {
  if (!isValidPlugin(plugin)) {
    throw new Error('Invalid provider plugin: missing required fields');
  }
  if (!PROVIDER_ID_RE.test(plugin.id)) {
    throw new Error(`Invalid provider ID "${plugin.id}": must match /^[a-z][a-z0-9_-]{0,63}$/`);
  }
  if (registry.has(plugin.id)) {
    throw new Error(`Provider "${plugin.id}" is already registered`);
  }
  registry.set(plugin.id, plugin);
}

export function getProvider(id: string): ProviderPlugin | undefined {
  return registry.get(id);
}

export function resolveProvider(id: string): ProviderPlugin {
  const plugin = registry.get(id);
  if (!plugin) {
    throw new UnknownProviderError(id);
  }
  return plugin;
}

export function listProviderIds(): string[] {
  return [...registry.keys()];
}

export function buildProviderConfig(providerId: string): Record<string, string> {
  const prefix = `PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && typeof value === 'string') {
      const configKey = key.slice(prefix.length);
      if (configKey.length > 0) {
        config[configKey] = value;
      }
    }
  }
  return config;
}

export function buildProviderInput(
  plugin: ProviderPlugin,
  rawInput: Omit<ProviderRunInput, 'providerConfig'> & { providerConfig?: Record<string, string> },
): ProviderRunInput {
  const input: ProviderRunInput = {
    prompt: rawInput.prompt,
    cwd: rawInput.cwd,
    model: rawInput.model,
    providerConfig: rawInput.providerConfig ?? {},
  };

  if (rawInput.systemPrompt !== undefined) {
    input.systemPrompt = rawInput.systemPrompt;
  }
  if (rawInput.maxTurns !== undefined) {
    input.maxTurns = rawInput.maxTurns;
  }

  if (plugin.capabilities.supportsTools) {
    if (rawInput.allowToolUse !== undefined) {
      input.allowToolUse = rawInput.allowToolUse;
    }
    if (rawInput.mcpServers !== undefined) {
      input.mcpServers = rawInput.mcpServers;
    }
  } else {
    input.allowToolUse = false;
  }

  if (plugin.capabilities.supportsPolicy && rawInput.policy !== undefined) {
    input.policy = rawInput.policy;
  }

  if (plugin.capabilities.supportsSessionResume && rawInput.resumeSessionId !== undefined) {
    input.resumeSessionId = rawInput.resumeSessionId;
  }

  return input;
}

export async function loadExternalProviders(
  pluginDir?: string,
  verifyPlugin?: (pluginPath: string) => Promise<{ ok: boolean; error?: string }>,
): Promise<void> {
  if (!pluginDir) {
    return;
  }

  if (!verifyPlugin) {
    return;
  }

  const { access, readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  let entries: string[];
  try {
    entries = await readdir(pluginDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const pluginPath = join(pluginDir, entry);
    try {
      const pkgRaw = await readFile(join(pluginPath, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as {
        commands?: {
          providerId?: string;
          defaultModel?: string;
        };
      };

      const providerId = pkg.commands?.providerId;
      if (!providerId || typeof providerId !== 'string') {
        continue;
      }

      const declaredDefaultModel = pkg.commands?.defaultModel;
      if (!declaredDefaultModel || typeof declaredDefaultModel !== 'string') {
        continue;
      }

      const verification = await verifyPlugin(pluginPath);
      if (!verification.ok) {
        continue;
      }

      let entryFile = 'index.js';
      try {
        await access(join(pluginPath, entryFile));
      } catch {
        entryFile = 'index.mjs';
        await access(join(pluginPath, entryFile));
      }

      const pluginModule = await import(join(pluginPath, entryFile)) as {
        default?: unknown;
        [key: string]: unknown;
      };
      const exported = (pluginModule.default ?? pluginModule) as unknown;

      if (!isValidPlugin(exported)) {
        continue;
      }
      if (exported.id !== providerId || exported.defaultModel !== declaredDefaultModel) {
        continue;
      }

      registerProvider(exported);
    } catch {
      // best-effort discovery only
    }
  }
}

export function resetProviderRegistry(): void {
  registry.clear();
}
