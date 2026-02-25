import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { CLIENT_ID, randomString, codeChallengeFromVerifier, parseJwtPayload, buildAuthorizeUrl } from './lib/pkce';
import { validateTrustedOrigin, normalizeTrustedUrl } from './lib/trusted-origins';

export const DEFAULT_GATEWAY_URL = 'https://api.commands.com';

const LOGIN_TIMEOUT_MS = 300_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

interface AuthServiceDeps {
  shell: { openExternal: (url: string) => Promise<void> | void };
  safeStorage?: {
    isEncryptionAvailable: () => boolean;
    encryptString: (input: string) => Buffer;
    decryptString: (input: Buffer) => string;
  };
  homedir: string;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.trunc(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function startCallbackServer(expectedState: string, timeoutMs: number): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => void;
  cancel: (reason?: string) => void;
}> {
  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;

    let setupSettled = false;
    let serverClosed = false;
    let codeSettled = false;

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const settleCodeResolve = (value: string): void => {
      if (codeSettled) {
        return;
      }
      codeSettled = true;
      resolveCode(value);
    };

    const settleCodeReject = (err: Error): void => {
      if (codeSettled) {
        return;
      }
      codeSettled = true;
      rejectCode(err);
    };

    const settleSetupResolve = (value: {
      redirectUri: string;
      waitForCode: () => Promise<string>;
      close: () => void;
      cancel: (reason?: string) => void;
    }): void => {
      if (setupSettled) {
        return;
      }
      setupSettled = true;
      resolveSetup(value);
    };

    const settleSetupReject = (err: Error): void => {
      if (setupSettled) {
        return;
      }
      setupSettled = true;
      rejectSetup(err);
    };

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('missing request url');
        return;
      }

      const requestUrl = new URL(req.url, 'http://localhost');
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      const state = requestUrl.searchParams.get('state') || '';
      const code = requestUrl.searchParams.get('code') || '';

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('invalid state');
        return;
      }

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('oauth error');
        settleCodeReject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('missing code');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Signed in. You can close this tab.');
      settleCodeResolve(code);
    });

    const closeServer = (): void => {
      if (serverClosed) {
        return;
      }
      serverClosed = true;
      try {
        server.close();
      } catch {
        // no-op
      }
    };

    server.on('error', (err) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (setupSettled) {
        settleCodeReject(new Error(`OAuth callback server error: ${normalized.message}`));
      }
      closeServer();
      settleSetupReject(normalized);
    });

    server.listen(0, 'localhost', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        closeServer();
        settleSetupReject(new Error('Failed to bind callback server'));
        return;
      }

      const redirectUri = `http://localhost:${address.port}/callback`;

      const waitForCode = (): Promise<string> => {
        const timer = setTimeout(() => {
          settleCodeReject(new Error('Sign-in timed out (5 minutes). Please try again.'));
        }, timeoutMs);

        return codePromise.finally(() => {
          clearTimeout(timer);
          closeServer();
        });
      };

      const cancel = (reason = 'Sign-in cancelled'): void => {
        settleCodeReject(new Error(reason));
        closeServer();
      };

      settleSetupResolve({
        redirectUri,
        waitForCode,
        close: closeServer,
        cancel,
      });
    });
  });
}

export default function createAuthService(deps: AuthServiceDeps) {
  // Share desktop OAuth state with commands-com-agent so both apps reuse
  // the same sign-in session and refresh token lifecycle.
  const DESKTOP_AUTH_DIR = path.join(deps.homedir, '.commands-agent');
  const DESKTOP_AUTH_PATH = path.join(DESKTOP_AUTH_DIR, 'desktop-auth.enc');
  const DESKTOP_SIGNOUT_SENTINEL = path.join(DESKTOP_AUTH_DIR, 'desktop-signed-out');

  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let tokenExpiresAt = 0;
  let email = '';
  let uid = '';
  let gatewayUrl = DEFAULT_GATEWAY_URL;

  let refreshPromise: Promise<void> | null = null;

  function ensureAuthDir(): void {
    mkdirSync(DESKTOP_AUTH_DIR, { recursive: true });
  }

  function parseTokenMetadata(token: string): { uid: string; email: string } {
    const payload = parseJwtPayload(token);
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const emailValue = typeof payload.email === 'string' ? payload.email : '';
    return { uid: sub, email: emailValue };
  }

  function persistAuthState(): void {
    ensureAuthDir();

    const snapshot = {
      gatewayUrl,
      accessToken,
      refreshToken,
      tokenExpiresAt,
      uid,
      email,
      updatedAt: Date.now(),
    };

    const serialized = JSON.stringify(snapshot);

    if (deps.safeStorage?.isEncryptionAvailable()) {
      const encrypted = deps.safeStorage.encryptString(serialized);
      const tmpPath = `${DESKTOP_AUTH_PATH}.tmp`;
      writeFileSync(tmpPath, encrypted);
      renameSync(tmpPath, DESKTOP_AUTH_PATH);
    } else {
      const tmpPath = `${DESKTOP_AUTH_PATH}.tmp`;
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, DESKTOP_AUTH_PATH);
    }
  }

  function clearPersistedAuthState(): void {
    try {
      if (existsSync(DESKTOP_AUTH_PATH)) {
        unlinkSync(DESKTOP_AUTH_PATH);
      }
      ensureAuthDir();
      writeFileSync(DESKTOP_SIGNOUT_SENTINEL, String(Date.now()), 'utf8');
    } catch {
      // ignore cleanup failures
    }
  }

  function loadPersistedAuthState(): void {
    if (!existsSync(DESKTOP_AUTH_PATH)) {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      const raw = readFileSync(DESKTOP_AUTH_PATH);
      const text = deps.safeStorage?.isEncryptionAvailable()
        ? deps.safeStorage.decryptString(raw)
        : raw.toString('utf8');
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof parsed.gatewayUrl === 'string') {
      gatewayUrl = normalizeTrustedUrl(parsed.gatewayUrl, DEFAULT_GATEWAY_URL);
    }
    accessToken = typeof parsed.accessToken === 'string' && parsed.accessToken.trim() ? parsed.accessToken : null;
    refreshToken = typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim() ? parsed.refreshToken : null;
    tokenExpiresAt = typeof parsed.tokenExpiresAt === 'number' ? parsed.tokenExpiresAt : 0;
    uid = typeof parsed.uid === 'string' ? parsed.uid : '';
    email = typeof parsed.email === 'string' ? parsed.email : '';

    if (!uid && accessToken) {
      const meta = parseTokenMetadata(accessToken);
      uid = meta.uid;
      email = meta.email;
    }
  }

  async function exchangeCodeForToken(
    gatewayUrlValue: string,
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<Record<string, unknown>> {
    validateTrustedOrigin(gatewayUrlValue);

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    });

    const response = await fetchWithTimeout(
      `${gatewayUrlValue}/oauth/token`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
      TOKEN_REQUEST_TIMEOUT_MS,
      'Token exchange',
    );

    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const msg = typeof parsed.error_description === 'string'
        ? parsed.error_description
        : (typeof parsed.error === 'string' ? parsed.error : `Token exchange failed: HTTP ${response.status}`);
      throw new Error(msg);
    }

    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new Error('Token exchange returned invalid response');
    }

    return parsed;
  }

  async function exchangeRefreshToken(gatewayUrlValue: string, refreshTokenValue: string): Promise<Record<string, unknown>> {
    validateTrustedOrigin(gatewayUrlValue);

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTokenValue,
      client_id: CLIENT_ID,
    });

    const response = await fetchWithTimeout(
      `${gatewayUrlValue}/oauth/token`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
      TOKEN_REQUEST_TIMEOUT_MS,
      'Token refresh',
    );

    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const message = typeof parsed.error_description === 'string'
        ? parsed.error_description
        : (typeof parsed.error === 'string' ? parsed.error : `Token refresh failed: HTTP ${response.status}`);
      const err = new Error(message) as Error & { status?: number; oauthError?: string };
      err.status = response.status;
      if (typeof parsed.error === 'string') {
        err.oauthError = parsed.error;
      }
      throw err;
    }

    if (typeof parsed.access_token !== 'string' || typeof parsed.expires_in !== 'number') {
      throw new Error('Token refresh returned invalid response');
    }

    return parsed;
  }

  async function performRefreshTokenIfNeeded(force = false): Promise<void> {
    if (!accessToken) {
      throw new Error('Not signed in');
    }

    const now = Date.now();
    const refreshLeadMs = 60_000;
    const expiredOrNearExpiry = tokenExpiresAt <= now + refreshLeadMs;

    if (!force && !expiredOrNearExpiry) {
      return;
    }

    if (!refreshToken) {
      if (tokenExpiresAt <= now) {
        throw new Error('Access token expired and no refresh token is available');
      }
      return;
    }

    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      const parsed = await exchangeRefreshToken(gatewayUrl, refreshToken as string);
      accessToken = String(parsed.access_token);
      if (typeof parsed.refresh_token === 'string' && parsed.refresh_token.trim()) {
        refreshToken = parsed.refresh_token;
      }
      tokenExpiresAt = Date.now() + Number(parsed.expires_in) * 1000;

      const meta = parseTokenMetadata(accessToken);
      uid = meta.uid;
      email = meta.email;

      persistAuthState();
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  }

  async function signIn(input: { gatewayUrl?: string } = {}): Promise<Record<string, unknown>> {
    gatewayUrl = normalizeTrustedUrl(input.gatewayUrl || gatewayUrl, DEFAULT_GATEWAY_URL);
    validateTrustedOrigin(gatewayUrl);

    const state = randomString(16);
    const codeVerifier = randomString(64);
    const codeChallenge = codeChallengeFromVerifier(codeVerifier);

    const callback = await startCallbackServer(state, LOGIN_TIMEOUT_MS);

    const authorizeUrl = buildAuthorizeUrl(gatewayUrl, callback.redirectUri, state, codeChallenge);
    await deps.shell.openExternal(authorizeUrl);

    try {
      const code = await callback.waitForCode();
      const parsed = await exchangeCodeForToken(gatewayUrl, code, callback.redirectUri, codeVerifier);

      accessToken = String(parsed.access_token);
      refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null;
      tokenExpiresAt = Date.now() + Number(parsed.expires_in) * 1000;

      const meta = parseTokenMetadata(accessToken);
      uid = meta.uid;
      email = meta.email;

      persistAuthState();

      return {
        ok: true,
        uid,
        email,
        expiresAt: new Date(tokenExpiresAt).toISOString(),
        gatewayUrl,
      };
    } finally {
      callback.close();
    }
  }

  async function signOut(): Promise<Record<string, unknown>> {
    accessToken = null;
    refreshToken = null;
    tokenExpiresAt = 0;
    uid = '';
    email = '';
    clearPersistedAuthState();

    return { ok: true };
  }

  function getStatus(): Record<string, unknown> {
    const signedIn = Boolean(accessToken);
    return {
      ok: true,
      signedIn,
      uid: signedIn ? uid : null,
      email: signedIn ? email : null,
      gatewayUrl,
      expiresAt: signedIn && tokenExpiresAt > 0 ? new Date(tokenExpiresAt).toISOString() : null,
    };
  }

  async function getAuthHeaders(options: { forceRefresh?: boolean } = {}): Promise<Record<string, string>> {
    if (!accessToken) {
      throw new Error('Not signed in');
    }

    await performRefreshTokenIfNeeded(Boolean(options.forceRefresh));

    if (!accessToken) {
      throw new Error('Not signed in');
    }

    return {
      Authorization: `Bearer ${accessToken}`,
    };
  }

  function getGatewayUrl(): string {
    return normalizeTrustedUrl(gatewayUrl, DEFAULT_GATEWAY_URL);
  }

  loadPersistedAuthState();

  return {
    signIn,
    signOut,
    getStatus,
    getAuthHeaders,
    getGatewayUrl,
  };
}
