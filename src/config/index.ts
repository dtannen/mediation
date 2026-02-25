import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

export interface RuntimeIdentity {
  algorithm: 'ed25519';
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  publicKeyRawBase64: string;
}

export interface MediationRuntimeConfig {
  gatewayUrl: string;
  deviceId: string;
  deviceToken: string;
  refreshToken?: string;
  identity: RuntimeIdentity;
  provider?: string;
  model?: string;
  auditLogPath?: string;
}

const MEDIATION_HOME = process.env.MEDIATION_HOME || os.homedir();

export const CONFIG_DIR = path.join(MEDIATION_HOME, '.mediation');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export function normalizeGatewayUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await chmod(CONFIG_DIR, 0o700).catch(() => undefined);
}

export async function loadConfig(): Promise<MediationRuntimeConfig | null> {
  let parsed: MediationRuntimeConfig;
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    parsed = JSON.parse(raw) as MediationRuntimeConfig;
  } catch {
    return null;
  }

  if (process.env.DESKTOP_DEVICE_TOKEN) {
    parsed.deviceToken = process.env.DESKTOP_DEVICE_TOKEN;
  }
  if (process.env.DESKTOP_REFRESH_TOKEN) {
    parsed.refreshToken = process.env.DESKTOP_REFRESH_TOKEN;
  }
  if (process.env.DESKTOP_PRIVATE_KEY_DER && parsed.identity) {
    parsed.identity = {
      ...parsed.identity,
      privateKeyDerBase64: process.env.DESKTOP_PRIVATE_KEY_DER,
    };
  }

  parsed.gatewayUrl = normalizeGatewayUrl(parsed.gatewayUrl);
  return parsed;
}

export async function requireConfig(): Promise<MediationRuntimeConfig> {
  const config = await loadConfig();
  if (!config) {
    throw new Error(`Config not found. Expected at: ${CONFIG_PATH}`);
  }
  return config;
}

export async function saveConfig(config: MediationRuntimeConfig): Promise<void> {
  await ensureConfigDir();
  const normalized: MediationRuntimeConfig = {
    ...config,
    gatewayUrl: normalizeGatewayUrl(config.gatewayUrl),
  };
  await writeFile(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8' });
  await chmod(CONFIG_PATH, 0o600).catch(() => undefined);
}
