import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import createMediationPlugin from './plugins/mediation-plugin';
import { validatePluginManifest, type PluginManifest } from './contracts';

const BUILTIN_FACTORIES: Record<string, () => unknown> = {
  mediation: () => createMediationPlugin(),
};

const ALLOWLIST_FILENAME = 'room-plugins-allowed.json';

interface PluginDescriptor {
  manifest: PluginManifest;
  createPlugin: () => unknown;
}

const pluginDescriptors = new Map<string, PluginDescriptor>();
let registryReady = false;

function normalizeBuiltin(factory: () => unknown): PluginDescriptor {
  const instance = factory() as { manifest: PluginManifest };
  return {
    manifest: instance.manifest,
    createPlugin() {
      return factory();
    },
  };
}

function validateDescriptor(type: string, descriptor: PluginDescriptor): void {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error(`Invalid plugin descriptor for ${type}`);
  }
  if (typeof descriptor.createPlugin !== 'function') {
    throw new Error(`Invalid plugin descriptor for ${type}: createPlugin must be a function`);
  }

  const manifestResult = validatePluginManifest(descriptor.manifest);
  if (!manifestResult.ok) {
    throw new Error(`Invalid manifest for ${type}: ${manifestResult.error.code}: ${manifestResult.error.message}`);
  }

  if (descriptor.manifest.orchestratorType !== type) {
    throw new Error(
      `Invalid manifest for ${type}: manifest.orchestratorType ` +
      `"${descriptor.manifest.orchestratorType}" does not match "${type}"`,
    );
  }
}

async function collectPluginFiles(
  dirPath: string,
  options: { includeNodeModules?: boolean; rejectSymlinks?: boolean } = {},
): Promise<Array<{ relativePath: string; fullPath: string }>> {
  const includeNodeModules = options.includeNodeModules === true;
  const rejectSymlinks = options.rejectSymlinks === true;
  const results: Array<{ relativePath: string; fullPath: string }> = [];

  async function walk(currentPath: string, relativePath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        if (rejectSymlinks) {
          throw new Error(`Symlink detected at '${relPath}'`);
        }
        const realPath = await fs.realpath(fullPath);
        const stat = await fs.stat(realPath);
        if (stat.isDirectory()) {
          if (entry.name === 'node_modules' && !includeNodeModules) {
            continue;
          }
          await walk(fullPath, relPath);
        } else if (stat.isFile()) {
          results.push({ relativePath: relPath, fullPath: realPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' && !includeNodeModules) {
          continue;
        }
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        results.push({ relativePath: relPath, fullPath });
      }
    }
  }

  await walk(dirPath, '');
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

async function computeIntegrityHash(pluginPath: string): Promise<string> {
  const files = await collectPluginFiles(pluginPath, {
    includeNodeModules: true,
    rejectSymlinks: true,
  });
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    const content = await fs.readFile(file.fullPath);
    hash.update(content);
  }
  return hash.digest('hex');
}

async function loadAllowlist(pluginDir: string): Promise<Map<string, { name: string; sha256?: string }> | null> {
  const allowlistPath = path.join(path.dirname(pluginDir), ALLOWLIST_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(allowlistPath, 'utf-8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { allowed?: unknown }).allowed)) {
    return null;
  }

  const allowlist = new Map<string, { name: string; sha256?: string }>();

  for (const entry of (parsed as { allowed: unknown[] }).allowed) {
    if (typeof entry === 'string' && entry.trim()) {
      allowlist.set(entry.trim(), { name: entry.trim() });
      continue;
    }

    if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      const name = (entry as { name: string }).name.trim();
      const sha256 = typeof (entry as { sha256?: unknown }).sha256 === 'string'
        ? ((entry as { sha256: string }).sha256.trim().toLowerCase() || undefined)
        : undefined;
      if (name) {
        allowlist.set(name, { name, ...(sha256 ? { sha256 } : {}) });
      }
    }
  }

  return allowlist;
}

async function loadSingleExternalPlugin(
  pluginPath: string,
  dirName: string,
  allowlist: Map<string, { name: string; sha256?: string }> | null,
  registeredIds: Set<string>,
  trustAll: boolean,
): Promise<void> {
  let allowEntry: { name: string; sha256?: string } | null = null;
  if (!trustAll) {
    allowEntry = allowlist?.get(dirName) ?? null;
    if (!allowEntry) {
      return;
    }
  }

  const manifestPath = path.join(pluginPath, 'manifest.json');
  const indexPath = path.join(pluginPath, 'index.js');

  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile()) {
    throw new Error(`manifest.json must be a regular file (${dirName})`);
  }

  const indexStat = await fs.lstat(indexPath);
  if (!indexStat.isFile()) {
    throw new Error(`index.js must be a regular file (${dirName})`);
  }

  const manifestJson = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as PluginManifest;
  const manifestValidation = validatePluginManifest(manifestJson);
  if (!manifestValidation.ok) {
    throw new Error(`Invalid manifest for ${dirName}: ${manifestValidation.error.message}`);
  }

  if (!trustAll && allowEntry?.sha256) {
    const digest = await computeIntegrityHash(pluginPath);
    if (digest !== allowEntry.sha256) {
      throw new Error(`Integrity mismatch for ${dirName}`);
    }
  }

  if (pluginDescriptors.has(manifestJson.orchestratorType)) {
    const existing = pluginDescriptors.get(manifestJson.orchestratorType)?.manifest?.id || 'unknown';
    throw new Error(
      `orchestratorType collision: '${manifestJson.orchestratorType}' from ${dirName} conflicts with '${existing}'`,
    );
  }

  if (registeredIds.has(manifestJson.id)) {
    throw new Error(`id collision: '${manifestJson.id}' from ${dirName} is already registered`);
  }

  const fileUrl = pathToFileURL(path.resolve(indexPath)).href;
  const mod = await import(fileUrl);
  const descriptor = (mod.default ?? mod) as { manifest?: PluginManifest; createPlugin?: () => unknown };

  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error(`Plugin module ${indexPath} must export an object descriptor`);
  }
  if (!descriptor.manifest || typeof descriptor.manifest !== 'object') {
    throw new Error(`Plugin module ${indexPath} must export descriptor.manifest`);
  }
  if (typeof descriptor.createPlugin !== 'function') {
    throw new Error(`Plugin module ${indexPath} must export descriptor.createPlugin()`);
  }

  if (JSON.stringify(descriptor.manifest) !== JSON.stringify(manifestJson)) {
    throw new Error(`Manifest mismatch for ${dirName}`);
  }

  const normalizedDescriptor: PluginDescriptor = {
    manifest: manifestJson,
    createPlugin: descriptor.createPlugin,
  };

  validateDescriptor(manifestJson.orchestratorType, normalizedDescriptor);

  pluginDescriptors.set(manifestJson.orchestratorType, normalizedDescriptor);
  registeredIds.add(manifestJson.id);
}

async function loadExternalPlugins(pluginDir: string): Promise<void> {
  let flags = { devMode: false, trustAllPlugins: false };
  try {
    const settingsPath = path.join(os.homedir(), '.commands-agent', 'desktop-settings.json');
    const parsed = JSON.parse(fsSync.readFileSync(settingsPath, 'utf8')) as {
      devMode?: boolean;
      trustAllPlugins?: boolean;
    };

    if (parsed.devMode === true) {
      flags.devMode = true;
    }
    if (parsed.trustAllPlugins === true) {
      flags.trustAllPlugins = true;
    }
  } catch {
    // default flags
  }

  const isDev = process.env.COMMANDS_AGENT_DEV === '1' || flags.devMode;
  const trustAll = isDev && (
    process.env.COMMANDS_AGENT_TRUST_ALL_PLUGINS === '1' ||
    flags.trustAllPlugins
  );

  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(pluginDir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return;
    }
    throw err;
  }

  const dirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (dirNames.length === 0) {
    return;
  }

  const allowlist = trustAll ? null : await loadAllowlist(pluginDir);
  if (!trustAll && !allowlist) {
    return;
  }

  const registeredIds = new Set(
    Array.from(pluginDescriptors.values())
      .map((descriptor) => descriptor.manifest.id)
      .filter(Boolean),
  );

  for (const dirName of dirNames) {
    const pluginPath = path.join(pluginDir, dirName);
    try {
      await loadSingleExternalPlugin(pluginPath, dirName, allowlist, registeredIds, trustAll);
    } catch {
      // skip invalid plugin
    }
  }
}

export async function initPluginRegistry(pluginDir?: string): Promise<void> {
  registryReady = false;
  pluginDescriptors.clear();

  for (const [type, factory] of Object.entries(BUILTIN_FACTORIES)) {
    const descriptor = normalizeBuiltin(factory);
    validateDescriptor(type, descriptor);
    pluginDescriptors.set(type, descriptor);
  }

  if (pluginDir) {
    await loadExternalPlugins(pluginDir).catch(() => undefined);
  }

  registryReady = true;
}

export function isRegistryReady(): boolean {
  return registryReady;
}

export function resolvePlugin(orchestratorType: string): { plugin: unknown; manifest: PluginManifest } {
  const descriptor = pluginDescriptors.get(orchestratorType);
  if (!descriptor) {
    throw new Error(`Unknown orchestratorType: ${orchestratorType}`);
  }
  return {
    plugin: descriptor.createPlugin(),
    manifest: descriptor.manifest,
  };
}

export function getKnownTypes(): string[] {
  return Array.from(pluginDescriptors.keys()).sort();
}

export function getAvailablePluginManifests(): PluginManifest[] {
  return Array.from(pluginDescriptors.values()).map((descriptor) => descriptor.manifest);
}
