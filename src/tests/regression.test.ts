import assert from 'node:assert/strict';
import { MediationService } from '../app/mediation-service';
import { InMemoryMediationStore } from '../store/in-memory-store';
import { migrateToV2 } from '../store/case-migration';
import type { MediationCase, TemplateSelection, MainTopicConfig } from '../domain/types';
import { runCases } from './test-utils';

function createTestService(): MediationService {
  return new MediationService(new InMemoryMediationStore());
}

function createTestCase(svc: MediationService): MediationCase {
  return svc.createCase({
    topic: 'Regression Test',
    description: 'Testing backward compatibility',
    parties: [
      { id: 'party_a', displayName: 'Alice', localLLM: { provider: 'ollama', model: 'llama3.2' } },
      { id: 'party_b', displayName: 'Bob', localLLM: { provider: 'claude', model: 'sonnet' } },
    ],
    consent: {
      byPartyId: {
        party_a: { allowSummaryShare: true, allowDirectQuote: true, allowedTags: ['summary'] },
        party_b: { allowSummaryShare: true, allowDirectQuote: true, allowedTags: ['summary'] },
      },
    },
  });
}

function joinBoth(svc: MediationService, caseId: string): void {
  svc.joinParty(caseId, 'party_a');
  svc.joinParty(caseId, 'party_b');
}

function readyBoth(svc: MediationService, caseId: string): void {
  svc.appendPrivateMessage({ caseId, partyId: 'party_a', authorType: 'party', text: 'My perspective' });
  svc.setPartyConsent(caseId, 'party_a', { allowSummaryShare: true, allowDirectQuote: true });
  svc.setPrivateSummary(caseId, 'party_a', 'Alice summary', true);
  svc.setPartyReady(caseId, 'party_a');

  svc.appendPrivateMessage({ caseId, partyId: 'party_b', authorType: 'party', text: 'My perspective' });
  svc.setPartyConsent(caseId, 'party_b', { allowSummaryShare: true, allowDirectQuote: true });
  svc.setPrivateSummary(caseId, 'party_b', 'Bob summary', true);
  svc.setPartyReady(caseId, 'party_b');
}

export async function runRegressionTests(): Promise<{ passed: number; failed: number }> {
  return runCases('regression', [
    {
      name: 'direct send workflow unchanged for v2 cases',
      run: () => {
        const svc = createTestService();
        const c = createTestCase(svc);
        joinBoth(svc, c.id);
        readyBoth(svc, c.id);

        // Now in group_chat, direct send should work
        const updated = svc.sendDirectGroupMessage(c.id, 'party_a', 'Hello from Alice');
        assert.equal(updated.phase, 'group_chat');
        const lastMsg = updated.groupChat.messages[updated.groupChat.messages.length - 1];
        assert.equal(lastMsg.text, 'Hello from Alice');
        assert.equal(lastMsg.authorPartyId, 'party_a');
      },
    },
    {
      name: 'approve-draft workflow unchanged for v2 cases',
      run: () => {
        const svc = createTestService();
        const c = createTestCase(svc);
        joinBoth(svc, c.id);
        readyBoth(svc, c.id);

        // Create draft, set suggestion, approve
        const draft = svc.createCoachDraft(c.id, 'party_a', 'I want to say...');
        svc.setCoachDraftSuggestion(c.id, draft.id, 'Polished message');
        const approved = svc.approveCoachDraftAndSend(c.id, draft.id);

        const sentDraft = approved.groupChat.draftsById[draft.id];
        assert.ok(sentDraft.approvedAt);
        assert.ok(sentDraft.sentMessageId);
      },
    },
    {
      name: 'consent filtering still works after v2 changes',
      run: () => {
        const svc = createTestService();
        const c = svc.createCase({
          topic: 'Consent Test',
          parties: [
            { id: 'party_a', displayName: 'Alice', localLLM: { provider: 'ollama', model: 'llama3.2' } },
            { id: 'party_b', displayName: 'Bob', localLLM: { provider: 'claude', model: 'sonnet' } },
          ],
          consent: {
            byPartyId: {
              party_a: { allowSummaryShare: false, allowDirectQuote: false, allowedTags: [] },
              party_b: { allowSummaryShare: true, allowDirectQuote: true, allowedTags: ['summary'] },
            },
          },
        });

        const latest = svc.getCase(c.id);
        assert.equal(latest.consent.byPartyId['party_a'].allowSummaryShare, false);
        assert.equal(latest.consent.byPartyId['party_b'].allowSummaryShare, true);
      },
    },
    {
      name: 'pre-v2 case (no schemaVersion) migrates correctly',
      run: () => {
        const preV2Case: MediationCase = {
          id: 'case_legacy',
          topic: 'Legacy case',
          description: 'Created before v2',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          phase: 'group_chat',
          parties: [],
          inviteLink: { token: 'tok', url: 'http://test', createdAt: new Date().toISOString() },
          partyParticipationById: {},
          consent: { byPartyId: {} },
          privateIntakeByPartyId: {},
          groupChat: { opened: true, introductionsSent: false, mediatorSummary: '', messages: [], draftsById: {} },
        };

        assert.equal(preV2Case.schemaVersion, undefined);
        const changed = migrateToV2(preV2Case, { templateId: 'tpl_test', versionId: 'tplv_test' });
        assert.equal(changed, true);
        assert.equal(preV2Case.schemaVersion, 2);
        assert.ok(preV2Case.templateSelection);
        assert.equal((preV2Case.templateSelection as TemplateSelection).templateId, 'tpl_test');
        assert.ok(preV2Case.mainTopicConfig);
        assert.equal((preV2Case.mainTopicConfig as MainTopicConfig).topic, 'Legacy case');
      },
    },
    {
      name: 'v2 case has schemaVersion set on creation',
      run: () => {
        const svc = createTestService();
        const c = createTestCase(svc);
        assert.equal(c.schemaVersion, 2);
      },
    },
    {
      name: 'v2 draft coach reject resets to exploring (non-terminal)',
      run: () => {
        const svc = createTestService();
        const c = createTestCase(svc);
        joinBoth(svc, c.id);
        readyBoth(svc, c.id);

        // Create draft with v2 coach meta
        const draft = svc.createCoachDraft(c.id, 'party_a', 'My message');
        svc.initializeDraftCoachMeta(c.id, draft.id);
        svc.setCoachDraftSuggestion(c.id, draft.id, 'Suggested text');

        // Reject — should NOT be terminal for v2 drafts
        const rejected = svc.rejectCoachDraft(c.id, draft.id, 'Try again');
        const rejectedDraft = rejected.groupChat.draftsById[draft.id];
        assert.equal(rejectedDraft.rejectedAt, undefined);
        assert.equal(rejectedDraft.coachMeta!.phase, 'exploring');

        // Can still set a new suggestion
        const updated = svc.setCoachDraftSuggestion(c.id, draft.id, 'Better text');
        assert.equal(updated.groupChat.draftsById[draft.id].suggestedText, 'Better text');
      },
    },
    {
      name: 'resolve and close phases still work correctly',
      run: () => {
        const svc = createTestService();
        const c = createTestCase(svc);
        joinBoth(svc, c.id);
        readyBoth(svc, c.id);

        const resolved = svc.resolveCase(c.id, 'Agreement reached');
        assert.equal(resolved.phase, 'resolved');

        const closed = svc.closeCase(c.id);
        assert.equal(closed.phase, 'closed');
      },
    },
  ]);
}
