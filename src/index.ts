import { MediationService } from './app/mediation-service';

// Gracefully handle EPIPE errors (broken pipe) instead of crashing.
// This occurs when stdout/stderr is piped to a process that closes early.
function handleEpipe(err: NodeJS.ErrnoException): void {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
}
process.stdout.on('error', handleEpipe);
process.stderr.on('error', handleEpipe);

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

  service.joinParty(mediationCase.id, 'party_a');
  service.joinParty(mediationCase.id, 'party_b');

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

  printSection('Group Chat Opened (Neutral Mediator + Coach Summaries)');
  console.log({
    phase: service.getCase(mediationCase.id).phase,
    openingMessages: service.getCase(mediationCase.id).groupChat.messages,
  });

  // Optional private coach conversation path for party_a.
  const coachDraft = service.createCoachDraft(
    mediationCase.id,
    'party_a',
    'I want to propose phased changes without sounding adversarial.',
  );
  service.appendCoachDraftMessage(
    mediationCase.id,
    coachDraft.id,
    'party_llm',
    'Try framing this as shared risk management and joint accountability.',
  );
  service.appendCoachDraftMessage(
    mediationCase.id,
    coachDraft.id,
    'party',
    'Yes, I want that tone and to preserve joint major-decision control.',
  );
  service.setCoachDraftSuggestion(
    mediationCase.id,
    coachDraft.id,
    'I propose phased equity adjustments tied to agreed milestones, while keeping major strategic decisions jointly approved.',
  );
  service.approveCoachDraftAndSend(
    mediationCase.id,
    coachDraft.id,
    'I propose we use phased equity adjustments tied to milestones, while keeping major strategic decisions jointly approved.',
  );

  // Direct path: party_b skips coach drafting and sends directly.
  service.sendDirectGroupMessage(
    mediationCase.id,
    'party_b',
    'I can work with phased adjustments if milestones and review checkpoints are clearly defined.',
    ['direct'],
  );

  // Neutral mediator facilitation message.
  service.appendGroupMessage({
    caseId: mediationCase.id,
    authorType: 'mediator_llm',
    text: 'I hear alignment on phased structure plus governance safeguards. Next: define milestone triggers and review cadence.',
    tags: ['facilitation'],
  });

  service.setMediatorSummary(
    mediationCase.id,
    'Mediator summary: both parties align on phased equity updates tied to milestones and a governance protocol with review checkpoints.',
  );

  service.resolveCase(
    mediationCase.id,
    'Resolved with phased equity adjustments, jointly approved governance rules, and quarterly review checkpoints.',
  );

  printSection('Final Case Snapshot');
  const finalCase = service.getCase(mediationCase.id);
  console.log({
    caseId: finalCase.id,
    phase: finalCase.phase,
    resolution: finalCase.resolution,
    mediatorSummary: finalCase.groupChat.mediatorSummary,
    draftCount: Object.keys(finalCase.groupChat.draftsById).length,
    draftRecord: finalCase.groupChat.draftsById[coachDraft.id],
    lastMessages: finalCase.groupChat.messages.slice(-4),
  });
}

main();
