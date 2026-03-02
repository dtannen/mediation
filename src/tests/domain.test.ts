import assert from 'node:assert/strict';
import { MediationService } from '../app/mediation-service';
import { DomainError } from '../domain/errors';
import { runCases, assertDomainErrorCode } from './test-utils';

function createServiceAndCase(options: {
  consentOverrides?: Record<string, Partial<{ allowSummaryShare: boolean; allowDirectQuote: boolean; allowedTags: string[] }>>;
} = {}) {
  const service = new MediationService();

  const consentA = {
    allowSummaryShare: true,
    allowDirectQuote: false,
    allowedTags: ['summary'],
    ...(options.consentOverrides?.party_a || {}),
  };

  const consentB = {
    allowSummaryShare: true,
    allowDirectQuote: true,
    allowedTags: ['summary'],
    ...(options.consentOverrides?.party_b || {}),
  };

  const mediationCase = service.createCase({
    topic: 'Mediation Test Topic',
    parties: [
      { id: 'party_a', displayName: 'Alex', localLLM: { provider: 'ollama', model: 'llama3.2' } },
      { id: 'party_b', displayName: 'Blair', localLLM: { provider: 'claude', model: 'sonnet' } },
    ],
    consent: {
      byPartyId: {
        party_a: consentA,
        party_b: consentB,
      },
    },
  });

  return { service, mediationCase };
}

function joinBoth(service: MediationService, caseId: string): void {
  service.joinParty(caseId, 'party_a');
  service.joinParty(caseId, 'party_b');
}

function readyBoth(service: MediationService, caseId: string): void {
  service.setPrivateSummary(caseId, 'party_a', 'Party A summary', true);
  service.setPrivateSummary(caseId, 'party_b', 'Party B summary', true);
  service.setPartyReady(caseId, 'party_a');
  service.setPartyReady(caseId, 'party_b');
}

export async function runDomainTests(): Promise<{ passed: number; failed: number }> {
  return runCases('domain', [
    {
      name: 'join requires a valid party id',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        service.joinParty(mediationCase.id, 'party_a');

        assert.throws(
          () => service.joinParty(mediationCase.id, 'party_missing'),
          (err: unknown) => {
            assertDomainErrorCode(err, 'party_not_found');
            return true;
          },
        );
      },
    },
    {
      name: 'private visibility isolation keeps party transcripts separate',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);

        service.appendPrivateMessage({
          caseId: mediationCase.id,
          partyId: 'party_a',
          authorType: 'party',
          text: 'Private message from A',
          tags: ['summary'],
        });

        const current = service.getCase(mediationCase.id);
        assert.equal(current.privateIntakeByPartyId.party_a.messages.length, 1);
        assert.equal(current.privateIntakeByPartyId.party_b.messages.length, 0);
      },
    },
    {
      name: 'all-ready gate blocks group chat until both summaries are resolved',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);

        service.setPrivateSummary(mediationCase.id, 'party_a', 'A summary');
        service.setPartyReady(mediationCase.id, 'party_a');

        assert.throws(
          () => service.setPartyReady(mediationCase.id, 'party_b'),
          (err: unknown) => {
            assertDomainErrorCode(err, 'missing_private_summary');
            return true;
          },
        );

        assert.equal(service.getCase(mediationCase.id).phase, 'private_intake');
      },
    },
    {
      name: 'joined party can complete intake while case is awaiting_join',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        service.joinParty(mediationCase.id, 'party_a');
        assert.equal(service.getCase(mediationCase.id).phase, 'awaiting_join');

        service.appendPrivateMessage({
          caseId: mediationCase.id,
          partyId: 'party_a',
          authorType: 'party',
          text: 'Early private intake message',
          tags: ['summary'],
        });
        service.setPrivateSummary(mediationCase.id, 'party_a', 'Early summary', true);
        service.setPartyReady(mediationCase.id, 'party_a');

        const afterFirstReady = service.getCase(mediationCase.id);
        assert.equal(afterFirstReady.phase, 'awaiting_join');
        assert.equal(afterFirstReady.partyParticipationById.party_a.state, 'ready');

        service.joinParty(mediationCase.id, 'party_b');
        assert.equal(service.getCase(mediationCase.id).phase, 'private_intake');

        service.setPrivateSummary(mediationCase.id, 'party_b', 'Party B summary', true);
        service.setPartyReady(mediationCase.id, 'party_b');
        assert.equal(service.getCase(mediationCase.id).phase, 'group_chat');
      },
    },
    {
      name: 'mediator opening emits two messages and applies consent policy',
      run: () => {
        const { service, mediationCase } = createServiceAndCase({
          consentOverrides: {
            party_a: { allowSummaryShare: false },
          },
        });

        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const current = service.getCase(mediationCase.id);
        assert.equal(current.phase, 'group_chat');
        assert.equal(current.groupChat.introductionsSent, true);
        assert.equal(current.groupChat.messages.length >= 2, true);

        const intro = current.groupChat.messages[0]?.text || '';
        assert.equal(intro.includes('summary remains private and was not shared'), true);
      },
    },
    {
      name: 'coach draft workflow supports iteration reset then approve and reject',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const draft = service.createCoachDraft(mediationCase.id, 'party_a', 'Initial intent');
        service.appendCoachDraftMessage(mediationCase.id, draft.id, 'party_llm', 'Coach follow-up');
        service.setCoachDraftSuggestion(mediationCase.id, draft.id, 'Suggested text');

        let current = service.getCase(mediationCase.id);
        assert.equal(current.groupChat.draftsById[draft.id].status, 'pending_approval');

        service.appendCoachDraftMessage(mediationCase.id, draft.id, 'party', 'Need a different tone');
        current = service.getCase(mediationCase.id);
        assert.equal(current.groupChat.draftsById[draft.id].status, 'composing');
        assert.equal(current.groupChat.draftsById[draft.id].suggestedText, undefined);

        service.setCoachDraftSuggestion(mediationCase.id, draft.id, 'Suggested text v2');
        service.approveCoachDraftAndSend(mediationCase.id, draft.id, 'Approved outbound text');
        current = service.getCase(mediationCase.id);
        assert.equal(current.groupChat.draftsById[draft.id].status, 'approved');
        assert.equal(Boolean(current.groupChat.draftsById[draft.id].sentMessageId), true);

        const rejectDraft = service.createCoachDraft(mediationCase.id, 'party_b', 'Another intent');
        service.setCoachDraftSuggestion(mediationCase.id, rejectDraft.id, 'Reject me');
        service.rejectCoachDraft(mediationCase.id, rejectDraft.id, 'Not good enough');

        current = service.getCase(mediationCase.id);
        assert.equal(current.groupChat.draftsById[rejectDraft.id].status, 'rejected');
      },
    },
    {
      name: 'direct send posts deliveryMode direct and rejects empty text',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        service.sendDirectGroupMessage(mediationCase.id, 'party_a', 'Hello', ['direct']);
        const current = service.getCase(mediationCase.id);
        const message = current.groupChat.messages[current.groupChat.messages.length - 1];
        assert.equal(message.deliveryMode, 'direct');

        assert.throws(
          () => service.sendDirectGroupMessage(mediationCase.id, 'party_a', '   ', ['direct']),
          (err: unknown) => {
            assertDomainErrorCode(err, 'invalid_group_message');
            return true;
          },
        );
      },
    },
    {
      name: 'transition guards reject illegal transitions',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        assert.throws(
          () => service.transition(mediationCase.id, 'group_chat'),
          (err: unknown) => {
            assertDomainErrorCode(err, 'invalid_transition');
            return true;
          },
        );
      },
    },
    {
      name: 'resolve and close move through terminal phases',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        service.resolveCase(mediationCase.id, 'Resolved text');
        assert.equal(service.getCase(mediationCase.id).phase, 'resolved');

        service.closeCase(mediationCase.id);
        assert.equal(service.getCase(mediationCase.id).phase, 'closed');

        assert.throws(
          () => service.transition(mediationCase.id, 'resolved'),
          (err: unknown) => {
            assertDomainErrorCode(err, 'invalid_transition');
            return true;
          },
        );
      },
    },
    {
      name: 'phase enforcement rejects operations outside allowed phase',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();

        assert.throws(
          () => service.sendDirectGroupMessage(mediationCase.id, 'party_a', 'Not yet'),
          (err: unknown) => {
            assertDomainErrorCode(err, 'invalid_phase');
            return true;
          },
        );

        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        assert.throws(
          () => service.appendPrivateMessage({
            caseId: mediationCase.id,
            partyId: 'party_a',
            authorType: 'party',
            text: 'Too late',
          }),
          (err: unknown) => {
            assertDomainErrorCode(err, 'invalid_phase');
            return true;
          },
        );
      },
    },

    /* V2: New service methods */

    {
      name: 'createCase sets schemaVersion to 2',
      run: () => {
        const { mediationCase } = createServiceAndCase();
        assert.equal(mediationCase.schemaVersion, 2);
      },
    },
    {
      name: 'setMainTopicConfig updates topic and mainTopicConfig',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        const updated = service.setMainTopicConfig(mediationCase.id, {
          topic: 'Updated Topic',
          description: 'New description',
          categoryId: 'cat_1',
        });

        assert.equal(updated.topic, 'Updated Topic');
        assert.equal(updated.description, 'New description');
        assert.ok(updated.mainTopicConfig);
        assert.equal(updated.mainTopicConfig!.topic, 'Updated Topic');
        assert.equal(updated.mainTopicConfig!.categoryId, 'cat_1');
        assert.ok(updated.mainTopicConfig!.confirmedAt);
      },
    },
    {
      name: 'setTemplateSelection stores template selection',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        const updated = service.setTemplateSelection(mediationCase.id, {
          templateId: 'tpl_test',
          versionId: 'tplv_test',
          selectedBy: 'admin',
        });

        assert.ok(updated.templateSelection);
        assert.equal(updated.templateSelection!.templateId, 'tpl_test');
        assert.equal(updated.templateSelection!.versionId, 'tplv_test');
        assert.equal(updated.templateSelection!.selectedBy, 'admin');
      },
    },
    {
      name: 'initializeDraftCoachMeta adds coach metadata to draft',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const draft = service.createCoachDraft(mediationCase.id, 'party_a', 'Help me write a message');
        const updated = service.initializeDraftCoachMeta(mediationCase.id, draft.id);
        const updatedDraft = updated.groupChat.draftsById[draft.id];

        assert.ok(updatedDraft.coachMeta);
        assert.equal(updatedDraft.coachMeta!.phase, 'exploring');
        assert.deepEqual(updatedDraft.coachMeta!.coachHistory, []);
      },
    },
    {
      name: 'setDraftReadiness transitions draft to confirm_ready',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const draft = service.createCoachDraft(mediationCase.id, 'party_a', 'Test message');
        service.initializeDraftCoachMeta(mediationCase.id, draft.id);

        const updated = service.setDraftReadiness(mediationCase.id, draft.id, true);
        const d = updated.groupChat.draftsById[draft.id];
        assert.equal(d.coachMeta!.phase, 'confirm_ready');
      },
    },
    {
      name: 'setFormalDraftReady transitions to formal_draft_ready with suggested text',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const draft = service.createCoachDraft(mediationCase.id, 'party_a', 'Write something');
        service.initializeDraftCoachMeta(mediationCase.id, draft.id);
        service.setDraftReadiness(mediationCase.id, draft.id, true);

        const updated = service.setFormalDraftReady(mediationCase.id, draft.id, 'Formal draft text');
        const d = updated.groupChat.draftsById[draft.id];
        assert.equal(d.coachMeta!.phase, 'formal_draft_ready');
        assert.equal(d.coachMeta!.formalDraftText, 'Formal draft text');
        assert.equal(d.suggestedText, 'Formal draft text');
        assert.equal(d.status, 'pending_approval');
      },
    },
    {
      name: 'rejectCoachDraft resets v2 draft to exploring instead of terminal reject',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const draft = service.createCoachDraft(mediationCase.id, 'party_a', 'Test');
        service.initializeDraftCoachMeta(mediationCase.id, draft.id);
        service.setDraftReadiness(mediationCase.id, draft.id, true);
        service.setFormalDraftReady(mediationCase.id, draft.id, 'Draft text');

        const updated = service.rejectCoachDraft(mediationCase.id, draft.id, 'Not quite right');
        const d = updated.groupChat.draftsById[draft.id];

        // V2: should reset to exploring, not terminal reject
        assert.equal(d.coachMeta!.phase, 'exploring');
        assert.equal(d.status, 'composing');
        assert.equal(d.coachMeta!.formalDraftText, undefined);
        assert.equal(d.suggestedText, undefined);
      },
    },
    {
      name: 'rejectCoachDraft v1 draft (no coachMeta) is terminal',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id);
        readyBoth(service, mediationCase.id);

        const draft = service.createCoachDraft(mediationCase.id, 'party_a', 'V1 style');
        service.setCoachDraftSuggestion(mediationCase.id, draft.id, 'Suggested');

        const updated = service.rejectCoachDraft(mediationCase.id, draft.id, 'Nope');
        const d = updated.groupChat.draftsById[draft.id];
        assert.equal(d.status, 'rejected');
        assert.ok(d.rejectedAt);
      },
    },
  ]);
}
