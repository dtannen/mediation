const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

interface DesktopProviderPlugin {
  id: string;
  defaultModel: string;
  configSchema?: Record<string, unknown>;
  validate?: (input: { config?: Record<string, unknown>; model?: string; profile?: Record<string, unknown> }) => Promise<{ ok: boolean; error?: string }>;
  listModels?: (config?: Record<string, unknown>) => Promise<{ models: string[] }>;
  buildEnv?: (config?: Record<string, unknown>, profile?: Record<string, unknown>) => Record<string, string>;
  agentOnly?: boolean;
}

function isValidDesktopPlugin(mod: unknown): mod is Partial<DesktopProviderPlugin> {
  if (!mod || typeof mod !== 'object') {
    return false;
  }
  const candidate = mod as Record<string, unknown>;
  return (
    typeof candidate.validate === 'function'
    || typeof candidate.buildEnv === 'function'
    || typeof candidate.listModels === 'function'
    || candidate.configSchema !== undefined
  );
}

export default function createProviderRegistry({
  builtIn,
  pluginDir,
  verifyPlugin,
}: {
  builtIn?: Record<string, Omit<DesktopProviderPlugin, 'id'>>;
  pluginDir?: string;
  verifyPlugin?: (pluginPath: string) => Promise<{ ok: boolean; error?: string }>;
} = {}) {
  const providers = new Map<string, DesktopProviderPlugin>();

  if (builtIn && typeof builtIn === 'object') {
    for (const [id, plugin] of Object.entries(builtIn)) {
      if (PROVIDER_ID_RE.test(id)) {
        providers.set(id, { id, ...plugin });
      }
    }
  }

  const loadExternalPromise = (async () => {
    if (!pluginDir || !verifyPlugin) {
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
            desktopEntry?: string;
          };
        };

        const providerId = pkg.commands?.providerId;
        if (!providerId || typeof providerId !== 'string' || !PROVIDER_ID_RE.test(providerId)) {
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

        const desktopEntry = pkg.commands?.desktopEntry;
        if (desktopEntry) {
          await access(join(pluginPath, desktopEntry));
          const mod = await import(join(pluginPath, desktopEntry)) as { default?: unknown; [key: string]: unknown };
          const exported = (mod.default ?? mod) as unknown;
          if (!isValidDesktopPlugin(exported)) {
            continue;
          }

          providers.set(providerId, {
            id: providerId,
            defaultModel: declaredDefaultModel,
            ...(exported as Omit<DesktopProviderPlugin, 'id' | 'defaultModel'>),
          });
        } else {
          providers.set(providerId, {
            id: providerId,
            defaultModel: declaredDefaultModel,
            agentOnly: true,
          });
        }
      } catch {
        // skip invalid plugin
      }
    }
  })();

  return {
    ready: loadExternalPromise,
    getProvider(id: string): DesktopProviderPlugin | undefined {
      return providers.get(id);
    },
    listProviders(): Array<{ id: string; defaultModel: string; hasDesktopModule: boolean; configSchema: Record<string, unknown> }> {
      return [...providers.values()].map((provider) => ({
        id: provider.id,
        defaultModel: provider.defaultModel,
        hasDesktopModule: !provider.agentOnly,
        configSchema: provider.configSchema || {},
      }));
    },
    getConfigSchema(id: string): Record<string, unknown> {
      return providers.get(id)?.configSchema || {};
    },
    async validateConfig(
      id: string,
      input: { config?: Record<string, unknown>; model?: string; profile?: Record<string, unknown> } = {},
    ): Promise<{ ok: boolean; error?: string }> {
      const provider = providers.get(id);
      if (!provider) {
        return { ok: false, error: `Unknown provider: ${id}` };
      }
      if (typeof provider.validate !== 'function') {
        return { ok: true };
      }
      return provider.validate(input);
    },
  };
}
