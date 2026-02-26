import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { MediationService } from '../app/mediation-service';
import { FileBackedMediationStore } from '../store/file-backed-store';
import { IdempotencyStore } from '../remote/idempotency-store';
import { RemoteMediationRouter } from '../remote/router';
import type { GatewayAuthContext } from '../remote/protocol';

function ownerAuth(): GatewayAuthContext {
  return {
    requesterUid: 'owner_user',
    requesterDeviceId: 'owner_device',
    grantId: 'owner_local',
    role: 'owner',
    grantStatus: 'active',
  };
}

function collaboratorAuth(): GatewayAuthContext {
  return {
    requesterUid: 'collaborator_user',
    requesterDeviceId: 'collaborator_device',
    grantId: 'grant_acceptance_1',
    role: 'collaborator',
    grantStatus: 'active',
  };
}

function envelope(input: {
  requestId: string;
  command: string;
  caseId?: string;
  partyId?: string;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: 'mediation.command',
    schema_version: 1,
    request_id: input.requestId,
    command: input.command,
    ...(input.caseId ? { case_id: input.caseId } : {}),
    ...(input.partyId ? { party_id: input.partyId } : {}),
    payload: input.payload || {},
  };
}

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-acceptance-'));
  const ownerStorePath = path.join(tempDir, 'owner-cases.json');
  const collaboratorStorePath = path.join(tempDir, 'collaborator-cases.json');
  const idempotencyPath = path.join(tempDir, 'idempotency.json');

  const ownerService = new MediationService(new FileBackedMediationStore(ownerStorePath));
  const collaboratorService = new MediationService(new FileBackedMediationStore(collaboratorStorePath));
  const router = new RemoteMediationRouter({
    mediationService: ownerService,
    idempotencyStore: new IdempotencyStore(idempotencyPath),
    runDraftSuggestion: async ({ caseId, draftId }) => {
      const suggestedText = 'I want a practical agreement and I am open to clear next steps.';
      const updated = ownerService.setCoachDraftSuggestion(caseId, draftId, suggestedText);
      return { case: updated, suggestedText };
    },
  });

  const created = ownerService.createCase({
    topic: 'Acceptance Flow',
    description: 'Two-machine end-to-end acceptance flow',
    parties: [
      { id: 'party_a', displayName: 'Owner Party', localLLM: { provider: 'claude', model: 'sonnet' } },
      { id: 'party_b', displayName: 'Collaborator Party', localLLM: { provider: 'claude', model: 'sonnet' } },
    ],
    consent: {
      byPartyId: {
        party_a: { allowSummaryShare: true, allowDirectQuote: false, allowedTags: ['summary'] },
        party_b: { allowSummaryShare: true, allowDirectQuote: false, allowedTags: ['summary'] },
      },
    },
  });
  const caseId = created.id;

  ownerService.joinParty(caseId, 'party_a');
  ownerService.setPrivateSummary(caseId, 'party_a', 'Owner summary', true);
  ownerService.setPartyReady(caseId, 'party_a');
  router.grantCaseVisibility(collaboratorAuth().grantId, caseId);

  async function runCollaboratorCommand(
    requestId: string,
    command: string,
    partyId: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const handled = await router.handleCommand(
      collaboratorAuth(),
      envelope({
        requestId,
        command,
        caseId,
        partyId,
        payload,
      }),
    );
    assert.equal(handled.result.ok, true, `Expected ${command} to succeed`);
    if (handled.result.ok && handled.result.case && typeof handled.result.case === 'object') {
      collaboratorService.upsertRemoteCaseSnapshot({
        projectedCase: handled.result.case,
        ownerDeviceId: 'owner_device',
        grantId: collaboratorAuth().grantId,
        accessRole: 'collaborator',
        localPartyId: 'party_b',
        remoteVersion: Number.isFinite(handled.result.remote_version) ? Number(handled.result.remote_version) : undefined,
      });
    }
    return handled.result as unknown as Record<string, unknown>;
  }

  await runCollaboratorCommand('req_join', 'case.join', 'party_b', { idempotency_key: 'idem_join' });
  await runCollaboratorCommand('req_private', 'case.append_private', 'party_b', {
    idempotency_key: 'idem_private',
    message: { role: 'user', content: 'This is my private intake context.' },
  });
  await runCollaboratorCommand('req_consent', 'case.set_consent', 'party_b', {
    idempotency_key: 'idem_consent',
    consent: {
      allowSummaryShare: true,
      allowDirectQuote: false,
      allowedTags: ['summary'],
    },
  });
  await runCollaboratorCommand('req_summary', 'case.set_private_summary', 'party_b', {
    idempotency_key: 'idem_summary',
    summary: 'Collaborator summary',
  });
  await runCollaboratorCommand('req_ready', 'case.set_ready', 'party_b', {
    idempotency_key: 'idem_ready',
    ready: true,
  });
  await runCollaboratorCommand('req_group', 'case.send_group', 'party_b', {
    idempotency_key: 'idem_group',
    message: { role: 'user', content: 'Group message from collaborator.' },
  });
  const draftResult = await runCollaboratorCommand('req_create_draft', 'case.create_draft', 'party_b', {
    idempotency_key: 'idem_create_draft',
    content: 'Draft message',
  });
  const draftId = typeof draftResult.draft_id === 'string' ? draftResult.draft_id : '';
  assert.ok(draftId, 'Expected draft_id from case.create_draft');
  await runCollaboratorCommand('req_suggest', 'case.run_draft_suggestion', 'party_b', {
    idempotency_key: 'idem_suggest',
    draft_id: draftId,
  });
  await runCollaboratorCommand('req_approve', 'case.approve_draft', 'party_b', {
    idempotency_key: 'idem_approve',
    draft_id: draftId,
    use_suggestion: true,
  });

  const ownerResolve = await router.handleCommand(ownerAuth(), envelope({
    requestId: 'req_owner_resolve',
    command: 'case.resolve',
    caseId,
    partyId: 'party_a',
    payload: {
      idempotency_key: 'idem_owner_resolve',
      resolution_text: 'Resolved with concrete commitments.',
    },
  }));
  assert.equal(ownerResolve.result.ok, true, 'Owner resolve should succeed');

  const ownerClose = await router.handleCommand(ownerAuth(), envelope({
    requestId: 'req_owner_close',
    command: 'case.close',
    caseId,
    partyId: 'party_a',
    payload: {
      idempotency_key: 'idem_owner_close',
    },
  }));
  assert.equal(ownerClose.result.ok, true, 'Owner close should succeed');

  const collaboratorGet = await router.handleCommand(collaboratorAuth(), envelope({
    requestId: 'req_collab_get',
    command: 'case.get',
    caseId,
    payload: {},
  }));
  assert.equal(collaboratorGet.result.ok, true, 'Collaborator get should succeed after close');
  if (collaboratorGet.result.ok && collaboratorGet.result.case && typeof collaboratorGet.result.case === 'object') {
    collaboratorService.upsertRemoteCaseSnapshot({
      projectedCase: collaboratorGet.result.case,
      ownerDeviceId: 'owner_device',
      grantId: collaboratorAuth().grantId,
      accessRole: 'collaborator',
      localPartyId: 'party_b',
      remoteVersion: Number.isFinite(collaboratorGet.result.remote_version) ? Number(collaboratorGet.result.remote_version) : undefined,
    });
  }

  const ownerAfterRestart = new MediationService(new FileBackedMediationStore(ownerStorePath)).getCase(caseId);
  const collaboratorAfterRestart = new MediationService(new FileBackedMediationStore(collaboratorStorePath)).getCase(caseId);

  assert.equal(ownerAfterRestart.phase, 'closed', 'Owner persisted phase should be closed');
  assert.equal(collaboratorAfterRestart.phase, 'closed', 'Collaborator persisted phase should be closed');
  assert.equal(ownerAfterRestart.resolution, 'Resolved with concrete commitments.');
  assert.equal(collaboratorAfterRestart.resolution, 'Resolved with concrete commitments.');

  console.log('Two-machine acceptance script passed');
}

void main().catch((err) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
