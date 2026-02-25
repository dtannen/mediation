import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';

const SENSITIVE_FIELDS = ['deviceToken', 'refreshToken'] as const;
const SENSITIVE_NESTED: Record<string, string[]> = { identity: ['privateKeyDerBase64'] };
const REDACTED_PLACEHOLDER = '[secured-by-desktop-app]';

export interface CredentialsServiceDeps {
  profileRoot?: string;
  encryptString?: (text: string) => Buffer;
  decryptString?: (buf: Buffer) => string;
}

export default function createCredentialsService(deps: CredentialsServiceDeps = {}) {
  const profileRoot = deps.profileRoot || path.join(os.homedir(), '.mediation');

  function getConfigDir(profileId = ''): string {
    if (profileId.trim()) {
      return path.join(profileRoot, 'profiles', profileId, '.mediation');
    }
    return path.join(profileRoot, '.mediation');
  }

  function getConfigPath(profileId = ''): string {
    return path.join(getConfigDir(profileId), 'config.json');
  }

  function getCredentialsPath(profileId = ''): string {
    return path.join(getConfigDir(profileId), 'credentials.enc');
  }

  function extractSensitiveFields(config: Record<string, unknown>): Record<string, unknown> {
    const secrets: Record<string, unknown> = {};

    for (const field of SENSITIVE_FIELDS) {
      const value = config[field];
      if (value !== undefined && value !== REDACTED_PLACEHOLDER) {
        secrets[field] = value;
      }
    }

    for (const [parent, children] of Object.entries(SENSITIVE_NESTED)) {
      const parentValue = config[parent];
      if (!parentValue || typeof parentValue !== 'object') {
        continue;
      }

      for (const child of children) {
        const nested = (parentValue as Record<string, unknown>)[child];
        if (nested !== undefined && nested !== REDACTED_PLACEHOLDER) {
          if (!secrets[parent] || typeof secrets[parent] !== 'object') {
            secrets[parent] = {};
          }
          (secrets[parent] as Record<string, unknown>)[child] = nested;
        }
      }
    }

    return secrets;
  }

  function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = { ...config };

    for (const field of SENSITIVE_FIELDS) {
      if (redacted[field] !== undefined) {
        redacted[field] = REDACTED_PLACEHOLDER;
      }
    }

    for (const [parent, children] of Object.entries(SENSITIVE_NESTED)) {
      const parentValue = redacted[parent];
      if (!parentValue || typeof parentValue !== 'object') {
        continue;
      }

      const copy = { ...(parentValue as Record<string, unknown>) };
      for (const child of children) {
        if (copy[child] !== undefined) {
          copy[child] = REDACTED_PLACEHOLDER;
        }
      }
      redacted[parent] = copy;
    }

    redacted._credentialsSecured = true;
    return redacted;
  }

  function mergeSecrets(config: Record<string, unknown>, secrets: Record<string, unknown>): Record<string, unknown> {
    const restored: Record<string, unknown> = { ...config };

    for (const field of SENSITIVE_FIELDS) {
      if (secrets[field] !== undefined) {
        restored[field] = secrets[field];
      }
    }

    for (const [parent, children] of Object.entries(SENSITIVE_NESTED)) {
      if (!secrets[parent] || typeof secrets[parent] !== 'object') {
        continue;
      }
      if (!restored[parent] || typeof restored[parent] !== 'object') {
        restored[parent] = {};
      }
      const target = { ...(restored[parent] as Record<string, unknown>) };
      for (const child of children) {
        const value = (secrets[parent] as Record<string, unknown>)[child];
        if (value !== undefined) {
          target[child] = value;
        }
      }
      restored[parent] = target;
    }

    delete restored._credentialsSecured;
    return restored;
  }

  async function secureCredentials(profileId = ''): Promise<{ ok: boolean; reason?: string; alreadySecured?: boolean }> {
    const configPath = getConfigPath(profileId);
    let config: Record<string, unknown>;

    try {
      config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'no config file' };
    }

    const secrets = extractSensitiveFields(config);
    if (Object.keys(secrets).length === 0) {
      return { ok: true, alreadySecured: true };
    }

    await mkdir(getConfigDir(profileId), { recursive: true });
    await chmod(getConfigDir(profileId), 0o700).catch(() => undefined);

    const serializedSecrets = JSON.stringify(secrets);
    const encrypted = deps.encryptString
      ? deps.encryptString(serializedSecrets)
      : Buffer.from(serializedSecrets, 'utf8');

    const credentialsPath = getCredentialsPath(profileId);
    await writeFile(credentialsPath, encrypted, { mode: 0o600 });
    await chmod(credentialsPath, 0o600).catch(() => undefined);

    const redacted = redactConfig(config);
    await writeFile(configPath, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');

    return { ok: true };
  }

  async function restoreCredentials(profileId = ''): Promise<{ ok: boolean; reason?: string; alreadyRestored?: boolean }> {
    const configPath = getConfigPath(profileId);
    const credentialsPath = getCredentialsPath(profileId);

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'no config file' };
    }

    if (!config._credentialsSecured) {
      return { ok: true, alreadyRestored: true };
    }

    let encrypted: Buffer;
    try {
      encrypted = await readFile(credentialsPath);
    } catch {
      return { ok: false, reason: 'credentials.enc missing but config is marked as secured' };
    }

    let secrets: Record<string, unknown>;
    try {
      const decrypted = deps.decryptString ? deps.decryptString(encrypted) : encrypted.toString('utf8');
      secrets = JSON.parse(decrypted) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'decryption failed' };
    }

    const restored = mergeSecrets(config, secrets);
    await writeFile(configPath, `${JSON.stringify(restored, null, 2)}\n`, 'utf8');

    return { ok: true };
  }

  async function decryptCredentials(profileId = ''): Promise<{ ok: boolean; secrets?: Record<string, unknown>; reason?: string }> {
    const configPath = getConfigPath(profileId);
    const credentialsPath = getCredentialsPath(profileId);

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'no config file' };
    }

    if (!config._credentialsSecured) {
      return { ok: true, secrets: extractSensitiveFields(config) };
    }

    let encrypted: Buffer;
    try {
      encrypted = await readFile(credentialsPath);
    } catch {
      return { ok: false, reason: 'credentials.enc missing but config is marked as secured' };
    }

    try {
      const decrypted = deps.decryptString ? deps.decryptString(encrypted) : encrypted.toString('utf8');
      return { ok: true, secrets: JSON.parse(decrypted) as Record<string, unknown> };
    } catch {
      return { ok: false, reason: 'decryption failed' };
    }
  }

  return {
    extractSensitiveFields,
    secureCredentials,
    restoreCredentials,
    decryptCredentials,
  };
}
