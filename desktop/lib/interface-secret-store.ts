import path from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

interface SecretStoreDeps {
  baseDir: string;
  encrypt?: (text: string) => Buffer;
  decrypt?: (buf: Buffer) => string;
}

export default function createInterfaceSecretStore(deps: SecretStoreDeps) {
  const secretsDir = path.join(deps.baseDir, 'interfaces-secrets');

  async function ensureDir(): Promise<void> {
    await mkdir(secretsDir, { recursive: true });
    await chmod(secretsDir, 0o700).catch(() => undefined);
  }

  function secretPath(interfaceId: string): string {
    return path.join(secretsDir, `${interfaceId}.secret`);
  }

  async function set(interfaceId: string, value: Record<string, unknown>): Promise<void> {
    await ensureDir();
    const serialized = JSON.stringify(value);
    const payload = deps.encrypt ? deps.encrypt(serialized) : Buffer.from(serialized, 'utf8');
    const filePath = secretPath(interfaceId);
    await writeFile(filePath, payload, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
  }

  async function get(interfaceId: string): Promise<Record<string, unknown> | null> {
    const filePath = secretPath(interfaceId);
    let raw: Buffer;
    try {
      raw = await readFile(filePath);
    } catch {
      return null;
    }

    const text = deps.decrypt ? deps.decrypt(raw) : raw.toString('utf8');
    return JSON.parse(text) as Record<string, unknown>;
  }

  return {
    set,
    get,
  };
}
