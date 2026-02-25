import { MediationService } from './app/mediation-service';

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function main(): void {
  const service = new MediationService();

  const mediationCase = service.createCase({
    title: 'Co-founder equity conflict',
    issue: 'Two co-founders disagree on revised equity and decision rights after one took on a larger operating role.',
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

  printSection('Created Case');
  console.log({ id: mediationCase.id, phase: mediationCase.phase, title: mediationCase.title });

  service.appendPrivateMessage({
    caseId: mediationCase.id,
    partyId: 'party_a',
    authorType: 'party',
    text: 'I am open to a small shift in equity, but I need explicit guardrails on unilateral decisions.',
    tags: ['summary'],
  });

  service.appendPrivateMessage({
    caseId: mediationCase.id,
    partyId: 'party_b',
    authorType: 'party',
    text: 'I am carrying execution risk and want the equity split to reflect that, while preserving trust.',
    tags: ['summary'],
  });

  service.setPrivateSummary(
    mediationCase.id,
    'party_a',
    'Alex can accept a limited equity adjustment if governance protections and escalation paths are explicit.',
  );
  service.setPrivateSummary(
    mediationCase.id,
    'party_b',
    'Blair seeks a revised split tied to operating burden, with a fair review checkpoint and clear accountability.',
  );

  printSection('Private Intake Complete');
  console.log(service.getCase(mediationCase.id).privateIntakeByPartyId);

  service.runCrossAgentDialogue(mediationCase.id);

  printSection('Cross-Agent Dialogue Output');
  console.log(service.getCase(mediationCase.id).sharedDialogue);

  service.transition(mediationCase.id, 'joint_mediation');
  service.appendJointMessage({
    caseId: mediationCase.id,
    authorType: 'mediator_llm',
    text: 'I propose we draft two options: milestone-based vesting change and governance charter update.',
    tags: ['proposal'],
  });

  service.setMediatorSummary(
    mediationCase.id,
    'Mediator draft: both parties tentatively agree to milestone-linked equity adjustment and joint veto on major strategic pivots.',
  );

  service.resolveCase(
    mediationCase.id,
    'Resolved with a staged equity update, quarterly review checkpoints, and a written governance protocol.',
  );

  printSection('Final Case Snapshot');
  const finalCase = service.getCase(mediationCase.id);
  console.log({
    id: finalCase.id,
    phase: finalCase.phase,
    resolution: finalCase.resolution,
    mediatorSummary: finalCase.jointRoom.mediatorSummary,
  });
}

main();
