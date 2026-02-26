import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { MediationService } from '../app/mediation-service';
import { FileBackedMediationStore } from '../store/file-backed-store';
import { runCases } from './test-utils';

function createCase(service: MediationService) {
  return service.createCase({
    topic: 'Persistence test case',
    parties: [
      { id: 'party_a', displayName: 'Alex', localLLM: { provider: 'claude', model: 'sonnet' } },
      { id: 'party_b', displayName: 'Blair', localLLM: { provider: 'claude', model: 'sonnet' } },
    ],
    consent: {
      byPartyId: {
        party_a: { allowSummaryShare: true, allowDirectQuote: true, allowedTags: ['summary'] },
        party_b: { allowSummaryShare: true, allowDirectQuote: true, allowedTags: ['summary'] },
      },
    },
  });
}

export async function runPersistenceTests(): Promise<{ passed: number; failed: number }> {
  return runCases('persistence', [
    {
      name: 'file-backed store reloads cases across service instances',
      run: () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-persist-'));
        const storagePath = path.join(tempDir, 'mediation-cases.json');

        try {
          const serviceOne = new MediationService(new FileBackedMediationStore(storagePath));
          const created = createCase(serviceOne);

          const serviceTwo = new MediationService(new FileBackedMediationStore(storagePath));
          const reloaded = serviceTwo.getCase(created.id);

          assert.equal(reloaded.id, created.id);
          assert.equal(reloaded.topic, 'Persistence test case');
          assert.equal(serviceTwo.listCases().length, 1);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
    },
  ]);
}
