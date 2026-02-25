import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  validateTrustedOrigin,
  normalizeTrustedUrl,
  createSessionPlaintextPayload,
  extractCorrelationId,
} from '../transport/gateway-client';
import {
  encryptFramePayload,
  decryptFramePayload,
  validateSeq,
} from '../security/crypto';
import { runCases } from './test-utils';

export async function runTransportTests(): Promise<{ passed: number; failed: number }> {
  return runCases('transport', [
    {
      name: 'trusted origin validation allows allowlist and rejects untrusted hosts',
      run: () => {
        assert.doesNotThrow(() => validateTrustedOrigin('https://api.commands.com'));
        assert.doesNotThrow(() => validateTrustedOrigin('http://localhost:8091'));

        assert.throws(() => validateTrustedOrigin('https://evil.example.com'));
        assert.throws(() => validateTrustedOrigin('http://api.commands.com'));

        assert.equal(
          normalizeTrustedUrl('https://evil.example.com', 'https://api.commands.com'),
          'https://api.commands.com',
        );
      },
    },
    {
      name: 'replay protection rejects out-of-order sequence numbers',
      run: () => {
        const keyBase64 = randomBytes(32).toString('base64');
        const encrypted = encryptFramePayload({
          keyBase64,
          direction: 'client_to_agent',
          seq: 1,
          plaintextUtf8: 'hello',
        });

        const ok = decryptFramePayload({
          keyBase64,
          direction: 'client_to_agent',
          seq: 1,
          nonceBase64: encrypted.nonce,
          ciphertextBase64: encrypted.ciphertext,
          tagBase64: encrypted.tag,
        });
        assert.equal(ok, 'hello');

        assert.throws(() => {
          decryptFramePayload({
            keyBase64,
            direction: 'client_to_agent',
            seq: 2,
            nonceBase64: encrypted.nonce,
            ciphertextBase64: encrypted.ciphertext,
            tagBase64: encrypted.tag,
          });
        }, /nonce mismatch|invalid sequence/);
      },
    },
    {
      name: 'validateSeq rejects seq <= 0',
      run: () => {
        assert.throws(() => validateSeq(0));
        assert.throws(() => validateSeq(-1));
        assert.doesNotThrow(() => validateSeq(1));
      },
    },
    {
      name: 'correlation id is preserved in plaintext payload helpers',
      run: () => {
        const payload = createSessionPlaintextPayload({
          sessionId: 's1',
          conversationId: 'c1',
          messageId: 'm1',
          prompt: 'hello',
          correlationId: 'corr-123',
        });

        assert.equal(extractCorrelationId(payload), 'corr-123');
        assert.equal(extractCorrelationId({}), null);
      },
    },
  ]);
}
