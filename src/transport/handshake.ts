import type { MediationRuntimeConfig } from '../config';
import {
  buildTranscriptHash,
  deriveSessionKeys,
  deriveSharedSecretFromClientEphemeral,
  generateEphemeralX25519,
  shortFingerprint,
  signTranscriptHashBase64,
  type SessionKeys,
} from '../security/crypto';
import { postHandshakeAck } from './gateway-client';

export interface AcknowledgeHandshakeInput {
  sessionId: string;
  handshakeId: string;
  clientEphemeralPublicKey: string;
  clientSessionNonce: string;
}

export interface AcknowledgeHandshakeOptions {
  postToGateway?: boolean;
  requireGatewayAck?: boolean;
}

export interface AcknowledgeHandshakeResult {
  status: string;
  sessionId: string;
  handshakeId: string;
  agentEphemeralPublicKey: string;
  agentIdentitySignature: string;
  transcriptHash: string;
  agentEphemeralFingerprint: string;
  controlKeyFingerprint: string;
  gatewayAckPosted: boolean;
  gatewayAckError?: string;
  sessionKeys: SessionKeys;
}

export async function acknowledgeHandshake(
  config: MediationRuntimeConfig,
  input: AcknowledgeHandshakeInput,
  options: AcknowledgeHandshakeOptions = {},
): Promise<AcknowledgeHandshakeResult> {
  const postToGateway = options.postToGateway !== false;
  const requireGatewayAck = options.requireGatewayAck !== false;
  const ephemeral = generateEphemeralX25519();

  const transcriptHash = buildTranscriptHash(
    input.sessionId,
    input.handshakeId,
    input.clientEphemeralPublicKey,
    input.clientSessionNonce,
    ephemeral.publicKeyRawBase64,
  );

  const agentIdentitySignature = signTranscriptHashBase64(config.identity, transcriptHash);

  const sharedSecret = deriveSharedSecretFromClientEphemeral(
    ephemeral.privateKey,
    input.clientEphemeralPublicKey,
  );
  const salt = Buffer.from(transcriptHash, 'base64');
  const sessionKeys = deriveSessionKeys(sharedSecret, salt);

  let status = 'agent_acknowledged';
  let gatewayAckPosted = false;
  let gatewayAckError: string | undefined;

  if (postToGateway) {
    const ack = await postHandshakeAck(
      config.gatewayUrl,
      input.sessionId,
      config.deviceToken,
      {
        device_id: config.deviceId,
        agent_ephemeral_public_key: ephemeral.publicKeyRawBase64,
        agent_identity_signature: agentIdentitySignature,
        transcript_hash: transcriptHash,
        handshake_id: input.handshakeId,
      },
    );

    if (!ack.ok) {
      gatewayAckError = `http_ack_failed: ${ack.error || 'unknown'}`;
      if (requireGatewayAck) {
        throw new Error(`Handshake ack failed: ${ack.error || 'unknown'}`);
      }
      status = 'pending_gateway_ack';
    } else {
      gatewayAckPosted = true;
      status = (ack.data as { status?: string } | undefined)?.status ?? status;
    }
  } else {
    status = 'pending_gateway_ack';
    gatewayAckError = 'skipped_http_ack';
  }

  return {
    status,
    sessionId: input.sessionId,
    handshakeId: input.handshakeId,
    agentEphemeralPublicKey: ephemeral.publicKeyRawBase64,
    agentIdentitySignature,
    transcriptHash,
    agentEphemeralFingerprint: shortFingerprint(ephemeral.publicKeyRawBase64),
    controlKeyFingerprint: shortFingerprint(sessionKeys.controlBase64),
    gatewayAckPosted,
    ...(gatewayAckError ? { gatewayAckError } : {}),
    sessionKeys,
  };
}
