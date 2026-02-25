export const TRUSTED_ORIGINS = new Set([
  'https://api.commands.com',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);

export function validateTrustedOrigin(url: string): void {
  const parsed = new URL(url);
  if (!TRUSTED_ORIGINS.has(parsed.origin)) {
    throw new Error(`Untrusted origin: ${parsed.origin}`);
  }
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`HTTP not allowed for non-localhost: ${parsed.origin}`);
  }
}

export function normalizeTrustedUrl(value: string | undefined | null, fallbackUrl: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallbackUrl;
  }
  try {
    const parsed = new URL(value.trim());
    validateTrustedOrigin(parsed.origin);
    return parsed.origin;
  } catch {
    return fallbackUrl;
  }
}
