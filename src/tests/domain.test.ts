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

function joinBoth(service: MediationService, caseId: string, token: string): void {
  service.joinWithInvite(caseId, 'party_a', token);
  service.joinWithInvite(caseId, 'party_b', token);
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
      name: 'invite token join accepts valid token and rejects invalid token',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        service.joinWithInvite(mediationCase.id, 'party_a', mediationCase.inviteLink.token);

        assert.throws(
          () => service.joinWithInvite(mediationCase.id, 'party_b', 'bad_token'),
          (err: unknown) => {
            assertDomainErrorCode(err, 'invalid_invite_token');
            return true;
          },
        );
      },
    },
    {
      name: 'private visibility isolation keeps party transcripts separate',
      run: () => {
        const { service, mediationCase } = createServiceAndCase();
        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);

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
        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);

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
        service.joinWithInvite(mediationCase.id, 'party_a', mediationCase.inviteLink.token);
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

        service.joinWithInvite(mediationCase.id, 'party_b', mediationCase.inviteLink.token);
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

        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);
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
        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);
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
        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);
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
        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);
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

        joinBoth(service, mediationCase.id, mediationCase.inviteLink.token);
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
  ]);
}
