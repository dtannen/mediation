import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const AES_256_GCM = 'aes-256-gcm';
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HKDF_INFO = Buffer.from('commands.com/gateway/v1/e2ee', 'utf8');

function decodeBase64(raw: string, label: string): Buffer {
  if (typeof raw !== 'string') {
    throw new Error(`invalid base64 type for ${label}`);
  }
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new Error(`invalid base64 for ${label}`);
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 0 && raw.length > 0) {
    throw new Error(`invalid base64 for ${label}`);
  }
  return buf;
}

function buildSpkiFromRaw(raw: Buffer, prefix: Buffer, label: string): Buffer {
  if (raw.length !== 32) {
    throw new Error(`Invalid ${label} raw key length: ${raw.length}`);
  }
  return Buffer.concat([prefix, raw]);
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

function directionPrefix(direction: 'client_to_agent' | 'agent_to_client'): Buffer {
  if (direction === 'client_to_agent') {
    return Buffer.from([0x63, 0x32, 0x61, 0x00]);
  }
  if (direction === 'agent_to_client') {
    return Buffer.from([0x61, 0x32, 0x63, 0x00]);
  }
  throw new Error(`invalid direction: ${direction}`);
}

function validateSeq(seq: number): void {
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error(`invalid sequence number: ${seq}`);
  }
}

export function generateEphemeralX25519(): { privateKey: KeyObject; publicKeyRawBase64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const publicKeyDer = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }));
  const publicRaw = readRawFromSpki(publicKeyDer, X25519_SPKI_PREFIX, 'x25519');
  return {
    privateKey,
    publicKeyRawBase64: publicRaw.toString('base64'),
  };
}

export function generateSessionNonce(): string {
  return randomBytes(16).toString('base64');
}

export function generateSessionId(): string {
  return randomUUID();
}

export function generateHandshakeId(): string {
  return randomUUID();
}

export function buildTranscriptHash(
  sessionId: string,
  handshakeId: string,
  clientEphPubBase64: string,
  clientNonce: string,
  agentEphPubBase64: string,
): string {
  const transcript = `${sessionId}|${handshakeId}|${clientEphPubBase64}|${clientNonce}|${agentEphPubBase64}`;
  return createHash('sha256').update(transcript, 'utf8').digest('base64');
}

export function deriveSharedSecret(
  ephemeralPrivateKey: KeyObject,
  agentEphemeralPublicKeyBase64: string,
): Buffer {
  const agentRaw = Buffer.from(agentEphemeralPublicKeyBase64, 'base64');
  const agentSpki = buildSpkiFromRaw(agentRaw, X25519_SPKI_PREFIX, 'x25519');
  const agentPubKey = createPublicKey({ format: 'der', type: 'spki', key: agentSpki });
  return diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: agentPubKey });
}

export function deriveSessionKeys(sharedSecret: Buffer, transcriptHashBase64: string): {
  clientToAgent: Buffer;
  agentToClient: Buffer;
  control: Buffer;
} {
  const salt = Buffer.from(transcriptHashBase64, 'base64');
  const keyMaterial = Buffer.from(hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 96));
  const clientToAgent = Buffer.from(keyMaterial.subarray(0, 32));
  const agentToClient = Buffer.from(keyMaterial.subarray(32, 64));
  const control = Buffer.from(keyMaterial.subarray(64, 96));
  keyMaterial.fill(0);
  return { clientToAgent, agentToClient, control };
}

function normalizeKeyMaterial(keyMaterial: Buffer | string, label: string): Buffer {
  if (Buffer.isBuffer(keyMaterial)) {
    return keyMaterial;
  }
  if (typeof keyMaterial === 'string') {
    return decodeBase64(keyMaterial, label);
  }
  throw new Error(`invalid ${label} type`);
}

export function deterministicNonce(direction: 'client_to_agent' | 'agent_to_client', seq: number): Buffer {
  validateSeq(seq);
  const nonce = Buffer.alloc(GCM_NONCE_BYTES);
  directionPrefix(direction).copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

export function buildAad(
  sessionId: string,
  messageId: string,
  seq: number,
  direction: 'client_to_agent' | 'agent_to_client',
): string {
  return Buffer.from(`${sessionId}|${messageId}|${seq}|${direction}`, 'utf8').toString('base64');
}

export function encryptFrame(
  keyMaterial: Buffer | string,
  direction: 'client_to_agent' | 'agent_to_client',
  seq: number,
  plaintextUtf8: string,
  sessionId: string,
  messageId: string,
): {
  alg: 'aes-256-gcm';
  direction: 'client_to_agent' | 'agent_to_client';
  seq: number;
  nonce: string;
  ciphertext: string;
  tag: string;
  aad: string;
} {
  const key = normalizeKeyMaterial(keyMaterial, 'session key');
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`invalid session key length: got ${key.length}, want ${AES_KEY_BYTES}`);
  }

  const nonce = deterministicNonce(direction, seq);
  const aadBase64 = buildAad(sessionId, messageId, seq, direction);
  const aad = Buffer.from(aadBase64, 'base64');

  const cipher = createCipheriv(AES_256_GCM, key, nonce, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintextUtf8, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    alg: 'aes-256-gcm',
    direction,
    seq,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
    aad: aadBase64,
  };
}

export function decryptFrame(
  keyMaterial: Buffer | string,
  frame: {
    alg: string;
    direction: 'client_to_agent' | 'agent_to_client';
    seq: number;
    nonce: string;
    ciphertext: string;
    tag: string;
    aad: string;
  },
): string {
  const key = normalizeKeyMaterial(keyMaterial, 'session key');
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`invalid session key length: got ${key.length}, want ${AES_KEY_BYTES}`);
  }
  if (frame.alg !== AES_256_GCM) {
    throw new Error(`unsupported frame alg: ${frame.alg}`);
  }

  const expectedNonce = deterministicNonce(frame.direction, frame.seq);
  const receivedNonce = decodeBase64(frame.nonce, 'nonce');

  if (receivedNonce.length !== GCM_NONCE_BYTES) {
    throw new Error(`invalid nonce length: got ${receivedNonce.length}, want ${GCM_NONCE_BYTES}`);
  }
  if (!timingSafeEqual(expectedNonce, receivedNonce)) {
    throw new Error('nonce mismatch for sequence/direction');
  }

  const tag = decodeBase64(frame.tag, 'tag');
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`invalid auth tag length: got ${tag.length}, want ${GCM_TAG_BYTES}`);
  }

  const ciphertext = decodeBase64(frame.ciphertext, 'ciphertext');

  const decipher = createDecipheriv(AES_256_GCM, key, receivedNonce, { authTagLength: GCM_TAG_BYTES });
  const aad = decodeBase64(frame.aad, 'aad');
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
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

export function zeroKey(keyMaterial: Buffer | null | undefined): void {
  if (!keyMaterial) {
    return;
  }
  try {
    keyMaterial.fill(0);
  } catch {
    // best effort
  }
}

export default {
  generateEphemeralX25519,
  generateSessionNonce,
  generateSessionId,
  generateHandshakeId,
  buildTranscriptHash,
  deriveSharedSecret,
  deriveSessionKeys,
  deterministicNonce,
  buildAad,
  encryptFrame,
  decryptFrame,
  verifyIdentitySignature,
  zeroKey,
};
