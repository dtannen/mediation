import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { CLIENT_ID, randomString, codeChallengeFromVerifier, parseJwtPayload, buildAuthorizeUrl } from './lib/pkce';
import { validateTrustedOrigin, normalizeTrustedUrl } from './lib/trusted-origins';

export const DEFAULT_GATEWAY_URL = 'https://api.commands.com';

const LOGIN_TIMEOUT_MS = 300_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface MediationDeviceIdentity {
  algorithm: 'ed25519';
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  publicKeyRawBase64: string;
}

interface RuntimeLaunchConfig {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  ownerUid: string;
  ownerEmail: string;
  deviceId: string;
  deviceName: string;
  identity: MediationDeviceIdentity;
}

function readRawFromSpki(spkiDer: Buffer, prefix: Buffer, label: string): Buffer {
  if (spkiDer.length !== prefix.length + 32) {
    throw new Error(`Invalid ${label} SPKI length: ${spkiDer.length}`);
  }
  const head = spkiDer.subarray(0, prefix.length);
  if (!head.equals(prefix)) {
    throw new Error(`Unexpected ${label} SPKI prefix`);
  }
  return spkiDer.subarray(prefix.length);
}

function generateMediationIdentity(): MediationDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  const privateKeyDer = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }));
  const publicKeyRaw = readRawFromSpki(publicKeyDer, ED25519_SPKI_PREFIX, 'ed25519');

  return {
    algorithm: 'ed25519',
    publicKeyDerBase64: publicKeyDer.toString('base64'),
    privateKeyDerBase64: privateKeyDer.toString('base64'),
    publicKeyRawBase64: publicKeyRaw.toString('base64'),
  };
}

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
  let mediationDeviceId = '';
  let mediationDeviceName = '';
  let mediationIdentity: MediationDeviceIdentity | null = null;
  let mediationRegisteredAt = 0;
  let mediationOwnerUid = '';
  let mediationGatewayUrl = '';

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

  function generateMediationDeviceId(): string {
    return `dev_${crypto.randomBytes(16).toString('hex')}`;
  }

  function generateMediationDeviceName(currentUid: string): string {
    const host = os.hostname().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 20);
    const uidSuffix = currentUid ? currentUid.slice(-8) : crypto.randomBytes(4).toString('hex');
    return `mediation-${host || 'desktop'}-${uidSuffix}`;
  }

  function hasValidMediationIdentity(value: unknown): value is MediationDeviceIdentity {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      record.algorithm === 'ed25519'
      && typeof record.publicKeyDerBase64 === 'string'
      && record.publicKeyDerBase64.length > 0
      && typeof record.privateKeyDerBase64 === 'string'
      && record.privateKeyDerBase64.length > 0
      && typeof record.publicKeyRawBase64 === 'string'
      && record.publicKeyRawBase64.length > 0
    );
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
      mediationDevice: mediationDeviceId && mediationIdentity ? {
        deviceId: mediationDeviceId,
        deviceName: mediationDeviceName,
        identity: mediationIdentity,
        registeredAt: mediationRegisteredAt,
        ownerUid: mediationOwnerUid,
        gatewayUrl: mediationGatewayUrl,
      } : null,
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
      persistAuthState();
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

    const mediationRecord = parsed.mediationDevice;
    if (mediationRecord && typeof mediationRecord === 'object') {
      const deviceRecord = mediationRecord as Record<string, unknown>;
      if (typeof deviceRecord.deviceId === 'string' && hasValidMediationIdentity(deviceRecord.identity)) {
        mediationDeviceId = deviceRecord.deviceId;
        mediationIdentity = deviceRecord.identity;
        mediationDeviceName = typeof deviceRecord.deviceName === 'string'
          ? deviceRecord.deviceName
          : '';
        mediationRegisteredAt = typeof deviceRecord.registeredAt === 'number'
          ? deviceRecord.registeredAt
          : 0;
        mediationOwnerUid = typeof deviceRecord.ownerUid === 'string'
          ? deviceRecord.ownerUid
          : '';
        mediationGatewayUrl = typeof deviceRecord.gatewayUrl === 'string'
          ? normalizeTrustedUrl(deviceRecord.gatewayUrl, DEFAULT_GATEWAY_URL)
          : '';
      }
    }

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

  async function getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!accessToken) {
      throw new Error('Not signed in');
    }

    await performRefreshTokenIfNeeded(Boolean(options.forceRefresh));

    if (!accessToken) {
      throw new Error('Not signed in');
    }
    return accessToken;
  }

  async function putIdentityKey(
    gatewayUrlValue: string,
    token: string,
    deviceId: string,
    identity: MediationDeviceIdentity,
    displayName: string,
  ): Promise<void> {
    const response = await fetchWithTimeout(
      `${gatewayUrlValue}/gateway/v1/devices/${encodeURIComponent(deviceId)}/identity-key`,
      {
        method: 'PUT',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          algorithm: 'ed25519',
          public_key: identity.publicKeyRawBase64,
          ...(displayName ? { display_name: displayName } : {}),
        }),
      },
      TOKEN_REQUEST_TIMEOUT_MS,
      'Device registration',
    );

    const text = await response.text().catch(() => '');
    if (response.ok) {
      return;
    }

    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      parsed = {};
    }

    const message = (
      typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : (
          typeof parsed.error === 'string' && parsed.error.trim()
            ? parsed.error.trim()
            : text.trim()
        )
    ) || `HTTP ${response.status}`;

    const err = new Error(`Device registration failed: ${message}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  async function registerMediationDeviceIdentity(
    deviceId: string,
    identity: MediationDeviceIdentity,
    displayName: string,
  ): Promise<void> {
    const token = await getAccessToken();

    try {
      await putIdentityKey(gatewayUrl, token, deviceId, identity, displayName);
      return;
    } catch (err) {
      const status = typeof (err as { status?: unknown })?.status === 'number'
        ? (err as { status: number }).status
        : 0;
      if (status !== 401) {
        throw err;
      }
    }

    const refreshed = await getAccessToken({ forceRefresh: true });
    await putIdentityKey(gatewayUrl, refreshed, deviceId, identity, displayName);
  }

  async function ensureMediationDeviceRegistered(): Promise<{ deviceId: string; deviceName: string; reused: boolean }> {
    if (!uid) {
      throw new Error('Cannot register mediation device without authenticated user');
    }

    const reusable = Boolean(
      mediationDeviceId
      && mediationIdentity
      && mediationOwnerUid
      && mediationOwnerUid === uid
      && mediationGatewayUrl
      && normalizeTrustedUrl(mediationGatewayUrl, DEFAULT_GATEWAY_URL) === gatewayUrl,
    );

    const nextIdentity = reusable && mediationIdentity
      ? mediationIdentity
      : generateMediationIdentity();
    const nextDeviceId = reusable && mediationDeviceId
      ? mediationDeviceId
      : generateMediationDeviceId();
    const nextDeviceName = reusable && mediationDeviceName
      ? mediationDeviceName
      : generateMediationDeviceName(uid);

    await registerMediationDeviceIdentity(nextDeviceId, nextIdentity, nextDeviceName);

    mediationDeviceId = nextDeviceId;
    mediationDeviceName = nextDeviceName;
    mediationIdentity = nextIdentity;
    mediationRegisteredAt = Date.now();
    mediationOwnerUid = uid;
    mediationGatewayUrl = gatewayUrl;

    persistAuthState();

    return {
      deviceId: mediationDeviceId,
      deviceName: mediationDeviceName,
      reused: reusable,
    };
  }

  async function signIn(input: { gatewayUrl?: string } = {}): Promise<Record<string, unknown>> {
    gatewayUrl = normalizeTrustedUrl(input.gatewayUrl || gatewayUrl, DEFAULT_GATEWAY_URL);
    validateTrustedOrigin(gatewayUrl);

    if (accessToken) {
      try {
        await getAccessToken();
        if (!uid) {
          const meta = parseTokenMetadata(accessToken);
          uid = meta.uid;
          email = meta.email;
        }
        const mediationDevice = await ensureMediationDeviceRegistered();
        persistAuthState();
        return {
          ok: true,
          uid,
          email,
          expiresAt: tokenExpiresAt > 0 ? new Date(tokenExpiresAt).toISOString() : null,
          gatewayUrl,
          reusedSession: true,
          mediationDevice: {
            id: mediationDevice.deviceId,
            name: mediationDevice.deviceName,
            reused: mediationDevice.reused,
            registeredAt: new Date(mediationRegisteredAt).toISOString(),
          },
        };
      } catch {
        // Fall through to full OAuth if existing session cannot be reused.
      }
    }

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

      const mediationDevice = await ensureMediationDeviceRegistered();
      persistAuthState();

      return {
        ok: true,
        uid,
        email,
        expiresAt: new Date(tokenExpiresAt).toISOString(),
        gatewayUrl,
        mediationDevice: {
          id: mediationDevice.deviceId,
          name: mediationDevice.deviceName,
          reused: mediationDevice.reused,
          registeredAt: new Date(mediationRegisteredAt).toISOString(),
        },
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
    const hasMediationDevice = Boolean(mediationDeviceId && mediationIdentity);
    return {
      ok: true,
      signedIn,
      uid: signedIn ? uid : null,
      email: signedIn ? email : null,
      gatewayUrl,
      expiresAt: signedIn && tokenExpiresAt > 0 ? new Date(tokenExpiresAt).toISOString() : null,
      mediationDevice: hasMediationDevice ? {
        id: mediationDeviceId,
        name: mediationDeviceName || null,
        ownerUid: mediationOwnerUid || null,
        gatewayUrl: mediationGatewayUrl || null,
        registeredAt: mediationRegisteredAt > 0 ? new Date(mediationRegisteredAt).toISOString() : null,
      } : null,
    };
  }

  async function getAuthHeaders(options: { forceRefresh?: boolean } = {}): Promise<Record<string, string>> {
    const token = await getAccessToken(options);

    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async function getRuntimeLaunchConfig(): Promise<RuntimeLaunchConfig | null> {
    if (!accessToken || !uid) {
      return null;
    }

    if (!mediationDeviceId || !mediationIdentity) {
      await ensureMediationDeviceRegistered();
    }

    if (!mediationDeviceId || !mediationIdentity) {
      return null;
    }

    const token = await getAccessToken();

    return {
      gatewayUrl,
      accessToken: token,
      refreshToken,
      tokenExpiresAt: tokenExpiresAt > 0 ? new Date(tokenExpiresAt).toISOString() : null,
      ownerUid: uid,
      ownerEmail: email,
      deviceId: mediationDeviceId,
      deviceName: mediationDeviceName,
      identity: mediationIdentity,
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
    getRuntimeLaunchConfig,
  };
}
