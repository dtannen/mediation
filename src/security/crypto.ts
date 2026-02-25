import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const AES_256_GCM = 'aes-256-gcm';
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type FrameDirection = 'client_to_agent' | 'agent_to_client';

export interface AgentIdentity {
  algorithm: 'ed25519';
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  publicKeyRawBase64: string;
}

export interface SessionKeys {
  clientToAgentBase64: string;
  agentToClientBase64: string;
  controlBase64: string;
}

export interface EncryptedFramePayload {
  alg: 'aes-256-gcm';
  direction: FrameDirection;
  seq: number;
  nonce: string;
  ciphertext: string;
  tag: string;
  aad?: string;
}

function decodeBase64(raw: string, label: string): Buffer {
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`invalid base64 for ${label}`);
  }
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

function buildSpkiFromRaw(raw: Buffer, prefix: Buffer, label: string): Buffer {
  if (raw.length !== 32) {
    throw new Error(`Invalid ${label} raw key length: ${raw.length}`);
  }
  return Buffer.concat([prefix, raw]);
}

function directionPrefix(direction: FrameDirection): Buffer {
  if (direction === 'client_to_agent') {
    return Buffer.from([0x63, 0x32, 0x61, 0x00]); // c2a\0
  }
  return Buffer.from([0x61, 0x32, 0x63, 0x00]); // a2c\0
}

export function validateSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`invalid sequence number: ${seq}`);
  }
}

function deterministicNonceBuffer(direction: FrameDirection, seq: number): Buffer {
  validateSeq(seq);
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  directionPrefix(direction).copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

function decodeKey(base64Key: string): Buffer {
  const key = decodeBase64(base64Key, 'session key');
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`invalid session key length: got ${key.length}, want ${AES_KEY_BYTES}`);
  }
  return key;
}

export function generateIdentity(): AgentIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
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

export function buildTranscriptHash(
  sessionId: string,
  handshakeId: string,
  clientEphemeralPublicKeyBase64: string,
  clientSessionNonce: string,
  agentEphemeralPublicKeyBase64: string,
): string {
  const transcript = `${sessionId}|${handshakeId}|${clientEphemeralPublicKeyBase64}|${clientSessionNonce}|${agentEphemeralPublicKeyBase64}`;
  return createHash('sha256').update(transcript, 'utf8').digest('base64');
}

export function signTranscriptHashBase64(identity: AgentIdentity, transcriptHashBase64: string): string {
  const privateKey = createPrivateKey({
    format: 'der',
    type: 'pkcs8',
    key: Buffer.from(identity.privateKeyDerBase64, 'base64'),
  });

  const signature = sign(null, Buffer.from(transcriptHashBase64, 'base64'), privateKey);
  return signature.toString('base64');
}

export function verifyIdentitySignature(
  identityPublicKeyBase64: string,
  transcriptHashBase64: string,
  signatureBase64: string,
): boolean {
  const rawKey = decodeBase64(identityPublicKeyBase64, 'identity public key');
  const spki = buildSpkiFromRaw(rawKey, ED25519_SPKI_PREFIX, 'ed25519');
  const pubKey = createPublicKey({ format: 'der', type: 'spki', key: spki });
  const message = decodeBase64(transcriptHashBase64, 'transcript hash');
  const signature = decodeBase64(signatureBase64, 'signature');
  return verify(null, message, pubKey, signature);
}

export interface EphemeralX25519 {
  privateKey: KeyObject;
  publicKeyRawBase64: string;
}

export function generateEphemeralX25519(): EphemeralX25519 {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicKeyDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  const publicRaw = readRawFromSpki(publicKeyDer, X25519_SPKI_PREFIX, 'x25519');

  return {
    privateKey,
    publicKeyRawBase64: publicRaw.toString('base64'),
  };
}

export function deriveSharedSecretFromClientEphemeral(
  privateKey: KeyObject,
  clientEphemeralPublicKeyBase64: string,
): Buffer {
  const clientRaw = Buffer.from(clientEphemeralPublicKeyBase64, 'base64');
  const clientSpki = buildSpkiFromRaw(clientRaw, X25519_SPKI_PREFIX, 'x25519');
  const clientPubKey = createPublicKey({ format: 'der', type: 'spki', key: clientSpki });
  return diffieHellman({ privateKey, publicKey: clientPubKey });
}

export function deriveSharedSecretFromAgentEphemeral(
  privateKey: KeyObject,
  agentEphemeralPublicKeyBase64: string,
): Buffer {
  const agentRaw = Buffer.from(agentEphemeralPublicKeyBase64, 'base64');
  const agentSpki = buildSpkiFromRaw(agentRaw, X25519_SPKI_PREFIX, 'x25519');
  const agentPubKey = createPublicKey({ format: 'der', type: 'spki', key: agentSpki });
  return diffieHellman({ privateKey, publicKey: agentPubKey });
}

export function deriveSessionKeys(sharedSecret: Buffer, salt: Buffer): SessionKeys {
  const info = Buffer.from('commands.com/gateway/v1/e2ee', 'utf8');
  const keyMaterial = Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, 96));

  return {
    clientToAgentBase64: keyMaterial.subarray(0, 32).toString('base64'),
    agentToClientBase64: keyMaterial.subarray(32, 64).toString('base64'),
    controlBase64: keyMaterial.subarray(64, 96).toString('base64'),
  };
}

export function deterministicNonceBase64(direction: FrameDirection, seq: number): string {
  return deterministicNonceBuffer(direction, seq).toString('base64');
}

export function encryptFramePayload(params: {
  keyBase64: string;
  direction: FrameDirection;
  seq: number;
  plaintextUtf8: string;
  aadBase64?: string;
}): EncryptedFramePayload {
  const key = decodeKey(params.keyBase64);
  const nonce = deterministicNonceBuffer(params.direction, params.seq);

  const cipher = createCipheriv(AES_256_GCM, key, nonce, {
    authTagLength: GCM_TAG_BYTES,
  });

  if (params.aadBase64) {
    const aad = decodeBase64(params.aadBase64, 'aad');
    cipher.setAAD(aad);
  }

  const ciphertext = Buffer.concat([
    cipher.update(params.plaintextUtf8, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    alg: 'aes-256-gcm',
    direction: params.direction,
    seq: params.seq,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
    ...(params.aadBase64 ? { aad: params.aadBase64 } : {}),
  };
}

export function decryptFramePayload(params: {
  keyBase64: string;
  direction: FrameDirection;
  seq: number;
  nonceBase64: string;
  ciphertextBase64: string;
  tagBase64: string;
  aadBase64?: string;
}): string {
  const key = decodeKey(params.keyBase64);
  const expectedNonce = deterministicNonceBuffer(params.direction, params.seq);
  const receivedNonce = decodeBase64(params.nonceBase64, 'nonce');

  if (receivedNonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`invalid nonce length: got ${receivedNonce.length}, want ${GCM_NONCE_BYTES}`);
  }
  if (!timingSafeEqual(expectedNonce, receivedNonce)) {
    throw new Error('nonce mismatch for sequence/direction');
  }

  const tag = decodeBase64(params.tagBase64, 'tag');
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`invalid auth tag length: got ${tag.length}, want ${GCM_TAG_BYTES}`);
  }

  const ciphertext = decodeBase64(params.ciphertextBase64, 'ciphertext');

  const decipher = createDecipheriv(AES_256_GCM, key, receivedNonce, {
    authTagLength: GCM_TAG_BYTES,
  });

  if (params.aadBase64) {
    const aad = decodeBase64(params.aadBase64, 'aad');
    decipher.setAAD(aad);
  }
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

export function shortFingerprint(base64Value: string): string {
  return createHash('sha256').update(Buffer.from(base64Value, 'base64')).digest('hex').slice(0, 16);
}

export function zeroKey(keyMaterial: Buffer | undefined | null): void {
  if (!keyMaterial) {
    return;
  }
  try {
    keyMaterial.fill(0);
  } catch {
    // best effort
  }
}
