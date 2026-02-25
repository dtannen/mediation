import { MediationService } from './app/mediation-service';

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function main(): void {
  const service = new MediationService();

  const mediationCase = service.createCase({
    topic: 'Co-founder equity and governance dispute',
    description: 'One founder took on larger operational load; both want a fair long-term structure.',
    parties: [
      {
        id: 'party_a',
        displayName: 'Alex',
        localLLM: { provider: 'ollama', model: 'llama3.2' },
      },
      {
        id: 'party_b',
        displayName: 'Blair',
        localLLM: { provider: 'claude', model: 'sonnet' },
      },
    ],
    consent: {
      byPartyId: {
        party_a: {
          allowSummaryShare: true,
          allowDirectQuote: false,
          allowedTags: ['summary'],
        },
        party_b: {
          allowSummaryShare: true,
          allowDirectQuote: true,
          allowedTags: ['summary'],
        },
      },
    },
  });

  printSection('Created Mediation + Invite Link');
  console.log({
    caseId: mediationCase.id,
    topic: mediationCase.topic,
    phase: mediationCase.phase,
    inviteLink: mediationCase.inviteLink.url,
  });

  service.joinWithInvite(mediationCase.id, 'party_a', mediationCase.inviteLink.token);
  service.joinWithInvite(mediationCase.id, 'party_b', mediationCase.inviteLink.token);

  printSection('Both Parties Joined (Private Intake Active)');
  console.log({
    phase: service.getCase(mediationCase.id).phase,
    partyParticipation: service.getCase(mediationCase.id).partyParticipationById,
  });

  service.appendPrivateMessage({
    caseId: mediationCase.id,
    partyId: 'party_a',
    authorType: 'party',
    text: 'I can accept a staged equity change if governance protections are explicit and enforceable.',
    tags: ['summary'],
  });

  service.appendPrivateMessage({
    caseId: mediationCase.id,
    partyId: 'party_b',
    authorType: 'party',
    text: 'I need a structure that reflects operating load while preserving trust and shared control.',
    tags: ['summary'],
  });

  service.setPrivateSummary(
    mediationCase.id,
    'party_a',
    'Alex accepts a staged equity adjustment if major decisions require joint governance controls.',
  );
  service.setPrivateSummary(
    mediationCase.id,
    'party_b',
    'Blair wants equity to reflect operational burden with clear accountability and periodic review.',
  );

  service.setPartyReady(mediationCase.id, 'party_a');
  service.setPartyReady(mediationCase.id, 'party_b');

  printSection('Group Chat Opened (Mediator Introductions Sent)');
  console.log({
    phase: service.getCase(mediationCase.id).phase,
    introductions: service.getCase(mediationCase.id).groupChat.messages,
  });

  service.appendGroupMessage({
    caseId: mediationCase.id,
    authorType: 'party',
    partyId: 'party_a',
    text: 'My top goals are fairness and decision stability. My key constraint is avoiding unilateral control.',
    tags: ['goals'],
  });

  service.appendGroupMessage({
    caseId: mediationCase.id,
    authorType: 'party',
    partyId: 'party_b',
    text: 'My top goals are execution accountability and sustainable ownership alignment.',
    tags: ['goals'],
  });

  service.appendGroupMessage({
    caseId: mediationCase.id,
    authorType: 'mediator_llm',
    text: 'Proposed path: milestone-linked adjustment, joint veto on strategic pivots, and quarterly review checkpoints.',
    tags: ['proposal'],
  });

  service.setMediatorSummary(
    mediationCase.id,
    'Mediator summary: both parties align on phased equity updates tied to milestones and a written governance protocol.',
  );

  service.resolveCase(
    mediationCase.id,
    'Resolved with phased equity adjustments, a governance charter, and quarterly review cadence.',
  );

  printSection('Final Case Snapshot');
  const finalCase = service.getCase(mediationCase.id);
  console.log({
    caseId: finalCase.id,
    phase: finalCase.phase,
    resolution: finalCase.resolution,
    mediatorSummary: finalCase.groupChat.mediatorSummary,
  });
}

main();
