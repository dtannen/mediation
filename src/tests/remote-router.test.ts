import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { MediationService } from '../app/mediation-service';
import { IdempotencyStore } from '../remote/idempotency-store';
import { validateAndNormalizeCommand, type GatewayAuthContext } from '../remote/protocol';
import { RemoteMediationRouter } from '../remote/router';
import { FileBackedMediationStore } from '../store/file-backed-store';
import { runCases } from './test-utils';

function createCase(service: MediationService): { caseId: string } {
  const mediationCase = service.createCase({
    topic: 'Remote Router Test',
    parties: [
      { id: 'party_a', displayName: 'Alex', localLLM: { provider: 'claude', model: 'sonnet' } },
      { id: 'party_b', displayName: 'Blair', localLLM: { provider: 'claude', model: 'sonnet' } },
    ],
    consent: {
      byPartyId: {
        party_a: { allowSummaryShare: true, allowDirectQuote: false, allowedTags: ['summary'] },
        party_b: { allowSummaryShare: true, allowDirectQuote: false, allowedTags: ['summary'] },
      },
    },
  });
  return { caseId: mediationCase.id };
}

function collaboratorAuth(grantId: string): GatewayAuthContext {
  return {
    requesterUid: 'user_collab',
    requesterDeviceId: 'dev_collab',
    grantId,
    role: 'collaborator',
    grantStatus: 'active',
  };
}

function ownerAuth(): GatewayAuthContext {
  return {
    requesterUid: 'user_owner',
    requesterDeviceId: 'dev_owner',
    grantId: 'grant_owner',
    role: 'owner',
    grantStatus: 'active',
  };
}

export async function runRemoteRouterTests(): Promise<{ passed: number; failed: number }> {
  return runCases('remote', [
    {
      name: 'protocol validation enforces envelope rules',
      run: () => {
        const missingCase = validateAndNormalizeCommand({
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_1',
          command: 'case.get',
          payload: {},
        });
        assert.equal(missingCase.ok, false);
        if (!missingCase.ok) {
          assert.equal(missingCase.error.error.code, 'missing_case_id');
        }

        const invalidPayload = validateAndNormalizeCommand({
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_2',
          command: 'case.join',
          case_id: 'c1',
          party_id: 'party_a',
          payload: { party_id: 'party_a', idempotency_key: 'idem_1' },
        });
        assert.equal(invalidPayload.ok, false);
        if (!invalidPayload.ok) {
          assert.equal(invalidPayload.error.error.code, 'invalid_payload');
        }

        const identityPayload = validateAndNormalizeCommand({
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_3',
          command: 'case.join',
          case_id: 'c1',
          party_id: 'party_a',
          payload: {
            idempotency_key: 'idem_2',
            actor_uid: 'spoof',
          },
        });
        assert.equal(identityPayload.ok, false);
        if (!identityPayload.ok) {
          assert.equal(identityPayload.error.error.code, 'invalid_payload');
        }
      },
    },
    {
      name: 'router enforces default deny visibility for collaborators',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });

        const result = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_get',
          command: 'case.get',
          case_id: caseId,
          payload: {},
        });

        assert.equal(result.result.ok, false);
        if (result.result.ok === false) {
          assert.equal(result.result.error.code, 'case_not_visible');
        }
      },
    },
    {
      name: 'router joins party and returns idempotent replay for retries',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });
        router.grantCaseVisibility('grant_1', caseId);

        const command = {
          type: 'mediation.command' as const,
          schema_version: 1 as const,
          request_id: 'req_join_1',
          command: 'case.join' as const,
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_join_1',
          },
        };

        const first = await router.handleCommand(collaboratorAuth('grant_1'), command);
        assert.equal(first.result.ok, true);
        if (first.result.ok) {
          assert.equal(typeof first.result.remote_version, 'number');
        }

        const replay = await router.handleCommand(collaboratorAuth('grant_1'), {
          ...command,
          request_id: 'req_join_2',
        });
        assert.equal(replay.result.ok, true);
        if (replay.result.ok) {
          assert.equal(replay.result.replayed, true);
        }
      },
    },
    {
      name: 'projection redacts other party private intake for collaborator',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        service.joinParty(caseId, 'party_a');
        service.joinParty(caseId, 'party_b');
        service.appendPrivateMessage({
          caseId,
          partyId: 'party_a',
          authorType: 'party',
          text: 'private A',
        });

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });
        router.grantCaseVisibility('grant_1', caseId);

        await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_join',
          command: 'case.join',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_join',
          },
        });

        const result = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_get',
          command: 'case.get',
          case_id: caseId,
          payload: {},
        });

        assert.equal(result.result.ok, true);
        if (result.result.ok) {
          const projected = result.result.case as Record<string, unknown>;
          const parties = Array.isArray(projected.parties)
            ? projected.parties as Array<Record<string, unknown>>
            : [];
          const partyA = parties.find((entry) => entry.party_id === 'party_a');
          const partyB = parties.find((entry) => entry.party_id === 'party_b');
          assert.equal(partyA?.private_thread, null);
          assert.equal(partyA?.private_summary, null);
          assert.equal(partyB?.private_thread, null);
        }
      },
    },
    {
      name: 'router enforces command phase requirements for private intake commands',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });
        router.grantCaseVisibility('grant_1', caseId);

        const joined = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_join_pvt',
          command: 'case.join',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_join_pvt',
          },
        });
        assert.equal(joined.result.ok, true);

        const append = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_append_pvt',
          command: 'case.append_private',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_append_pvt',
            message: {
              role: 'user',
              content: 'hello',
            },
          },
        });
        assert.equal(append.result.ok, false);
        if (append.result.ok === false) {
          assert.equal(append.result.error.code, 'invalid_phase');
        }
      },
    },
    {
      name: 'create_draft blocks second active draft for same party',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        service.joinParty(caseId, 'party_a');

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });
        router.grantCaseVisibility('grant_1', caseId);

        const join = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_join_draft',
          command: 'case.join',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_join_draft',
          },
        });
        assert.equal(join.result.ok, true);

        service.setPrivateSummary(caseId, 'party_a', 'a summary', true);
        service.setPrivateSummary(caseId, 'party_b', 'b summary', true);
        service.setPartyReady(caseId, 'party_a');
        service.setPartyReady(caseId, 'party_b');

        const firstDraft = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_create_draft_1',
          command: 'case.create_draft',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            content: 'first draft',
            idempotency_key: 'idem_create_1',
          },
        });
        assert.equal(firstDraft.result.ok, true);

        const secondDraft = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_create_draft_2',
          command: 'case.create_draft',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            content: 'second draft',
            idempotency_key: 'idem_create_2',
          },
        });
        assert.equal(secondDraft.result.ok, false);
        if (secondDraft.result.ok === false) {
          assert.equal(secondDraft.result.error.code, 'draft_already_active');
        }
      },
    },
    {
      name: 'draft operations are party-scoped and cannot target another party draft',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        service.joinParty(caseId, 'party_a');

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });
        router.grantCaseVisibility('grant_1', caseId);

        const join = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_join_scope',
          command: 'case.join',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_join_scope',
          },
        });
        assert.equal(join.result.ok, true);

        service.setPrivateSummary(caseId, 'party_a', 'a summary', true);
        service.setPrivateSummary(caseId, 'party_b', 'b summary', true);
        service.setPartyReady(caseId, 'party_a');
        service.setPartyReady(caseId, 'party_b');
        const foreignDraft = service.createCoachDraft(caseId, 'party_a', 'foreign draft');

        const append = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_append_scope',
          command: 'case.append_draft',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            draft_id: foreignDraft.id,
            content: 'tamper',
            idempotency_key: 'idem_scope_append',
          },
        });
        assert.equal(append.result.ok, false);
        if (append.result.ok === false) {
          assert.equal(append.result.error.code, 'draft_not_found');
        }
      },
    },
    {
      name: 'resolve and close are owner-only commands',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        service.joinParty(caseId, 'party_a');
        service.joinParty(caseId, 'party_b');
        service.setPrivateSummary(caseId, 'party_a', 'a summary', true);
        service.setPrivateSummary(caseId, 'party_b', 'b summary', true);
        service.setPartyReady(caseId, 'party_a');
        service.setPartyReady(caseId, 'party_b');

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });
        router.grantCaseVisibility('grant_1', caseId);

        const collaboratorResolve = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_resolve',
          command: 'case.resolve',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            resolution_text: 'resolution',
            idempotency_key: 'idem_resolve',
          },
        });
        assert.equal(collaboratorResolve.result.ok, false);
        if (collaboratorResolve.result.ok === false) {
          assert.equal(collaboratorResolve.result.error.code, 'not_authorized_to_resolve');
        }

        const ownerCloseBeforeResolve = await router.handleCommand(ownerAuth(), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_owner_close_early',
          command: 'case.close',
          case_id: caseId,
          party_id: 'party_a',
          payload: {
            idempotency_key: 'idem_owner_close_early',
          },
        });
        assert.equal(ownerCloseBeforeResolve.result.ok, false);
        if (ownerCloseBeforeResolve.result.ok === false) {
          assert.equal(ownerCloseBeforeResolve.result.error.code, 'invalid_phase');
        }

        const ownerResolve = await router.handleCommand(ownerAuth(), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_owner_resolve',
          command: 'case.resolve',
          case_id: caseId,
          party_id: 'party_a',
          payload: {
            resolution_text: 'resolution',
            idempotency_key: 'idem_owner_resolve',
          },
        });
        assert.equal(ownerResolve.result.ok, true);

        const collaboratorClose = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_close_collab',
          command: 'case.close',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_close_collab',
          },
        });
        assert.equal(collaboratorClose.result.ok, false);
        if (collaboratorClose.result.ok === false) {
          assert.equal(collaboratorClose.result.error.code, 'not_authorized_to_close');
        }
      },
    },
    {
      name: 'owner projection does not include collaborator private intake data',
      run: async () => {
        const service = new MediationService();
        const { caseId } = createCase(service);
        service.joinParty(caseId, 'party_a');
        service.joinParty(caseId, 'party_b');
        service.appendPrivateMessage({
          caseId,
          partyId: 'party_b',
          authorType: 'party',
          text: 'collaborator private',
        });
        service.setPrivateSummary(caseId, 'party_b', 'collaborator summary', true);

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const idem = new IdempotencyStore(path.join(tempDir, 'idempotency.json'));
        const router = new RemoteMediationRouter({ mediationService: service, idempotencyStore: idem });

        const result = await router.handleCommand(ownerAuth(), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_owner_get',
          command: 'case.get',
          case_id: caseId,
          payload: {},
        });

        assert.equal(result.result.ok, true);
        if (result.result.ok) {
          const projected = result.result.case as Record<string, unknown>;
          const parties = Array.isArray(projected.parties)
            ? projected.parties as Array<Record<string, unknown>>
            : [];
          const partyA = parties.find((entry) => entry.party_id === 'party_a');
          const partyB = parties.find((entry) => entry.party_id === 'party_b');
          assert.equal(partyA?.private_thread, null);
          assert.equal(partyA?.private_summary, null);
          assert.equal(partyA?.consent, null);
          assert.equal(partyB?.private_thread, null);
          assert.equal(partyB?.private_summary, null);
          assert.equal(partyB?.consent, null);
        }
      },
    },
    {
      name: 'full remote lifecycle executes and persists across restart',
      run: async () => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'mediation-remote-'));
        const storePath = path.join(tempDir, 'cases.json');
        const idempotencyPath = path.join(tempDir, 'idempotency.json');

        const service = new MediationService(new FileBackedMediationStore(storePath));
        const { caseId } = createCase(service);
        service.joinParty(caseId, 'party_a');
        service.setPrivateSummary(caseId, 'party_a', 'owner summary', true);
        service.setPartyReady(caseId, 'party_a');

        const router = new RemoteMediationRouter({
          mediationService: service,
          idempotencyStore: new IdempotencyStore(idempotencyPath),
          runDraftSuggestion: async ({ caseId: targetCaseId, draftId }) => {
            const suggestedText = 'I hear your concern and want to find a practical compromise.';
            const updated = service.setCoachDraftSuggestion(targetCaseId, draftId, suggestedText);
            return { case: updated, suggestedText };
          },
        });
        router.grantCaseVisibility('grant_1', caseId);

        const join = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_join',
          command: 'case.join',
          case_id: caseId,
          party_id: 'party_b',
          payload: { idempotency_key: 'idem_full_join' },
        });
        assert.equal(join.result.ok, true);

        const consent = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_consent',
          command: 'case.set_consent',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_consent',
            consent: {
              allowSummaryShare: true,
              allowDirectQuote: false,
              allowedTags: ['summary'],
            },
          },
        });
        assert.equal(consent.result.ok, true);

        const summary = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_summary',
          command: 'case.set_private_summary',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_summary',
            summary: 'collaborator summary',
          },
        });
        assert.equal(summary.result.ok, true);

        const ready = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_ready',
          command: 'case.set_ready',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_ready',
            ready: true,
          },
        });
        assert.equal(ready.result.ok, true);

        const sendGroup = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_group',
          command: 'case.send_group',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_group',
            message: {
              role: 'user',
              content: 'Group message from collaborator',
            },
          },
        });
        assert.equal(sendGroup.result.ok, true);

        const createDraft = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_create_draft',
          command: 'case.create_draft',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_create_draft',
            content: 'Initial draft text',
          },
        });
        assert.equal(createDraft.result.ok, true);
        assert.equal(createDraft.result.ok && typeof createDraft.result.draft_id === 'string', true);
        const draftId = createDraft.result.ok ? String(createDraft.result.draft_id || '') : '';
        assert.ok(draftId);

        const suggest = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_suggest',
          command: 'case.run_draft_suggestion',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_suggest',
            draft_id: draftId,
          },
        });
        assert.equal(suggest.result.ok, true);

        const approve = await router.handleCommand(collaboratorAuth('grant_1'), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_approve',
          command: 'case.approve_draft',
          case_id: caseId,
          party_id: 'party_b',
          payload: {
            idempotency_key: 'idem_full_approve',
            draft_id: draftId,
            use_suggestion: true,
          },
        });
        assert.equal(approve.result.ok, true);

        const resolve = await router.handleCommand(ownerAuth(), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_resolve',
          command: 'case.resolve',
          case_id: caseId,
          party_id: 'party_a',
          payload: {
            idempotency_key: 'idem_full_resolve',
            resolution_text: 'Resolved with a concrete shared plan.',
          },
        });
        assert.equal(resolve.result.ok, true);

        const close = await router.handleCommand(ownerAuth(), {
          type: 'mediation.command',
          schema_version: 1,
          request_id: 'req_full_close',
          command: 'case.close',
          case_id: caseId,
          party_id: 'party_a',
          payload: {
            idempotency_key: 'idem_full_close',
          },
        });
        assert.equal(close.result.ok, true);

        const reloaded = new MediationService(new FileBackedMediationStore(storePath)).getCase(caseId);
        assert.equal(reloaded.phase, 'closed');
        assert.equal(reloaded.resolution, 'Resolved with a concrete shared plan.');
      },
    },
  ]);
}
