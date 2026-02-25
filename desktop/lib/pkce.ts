import crypto from 'node:crypto';

export const CLIENT_ID = 'commands-agent';
export const SCOPE = 'read_assets write_assets offline_access device';

export function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function randomString(byteLength: number): string {
  return base64Url(crypto.randomBytes(byteLength));
}

export function codeChallengeFromVerifier(verifier: string): string {
  return base64Url(crypto.createHash('sha256').update(verifier, 'utf8').digest());
}

export function parseJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return {};
    }
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '==='.slice((raw.length + 3) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function buildAuthorizeUrl(
  gatewayUrl: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(`${gatewayUrl}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
