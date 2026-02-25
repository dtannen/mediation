import type { MediationCase, MediationPhase } from '../domain/types';

export interface PhaseValidation {
  allowed: boolean;
  reason?: string;
}

export const ALLOWED_TRANSITIONS: Record<MediationPhase, Set<MediationPhase>> = {
  awaiting_join: new Set(['private_intake', 'closed']),
  private_intake: new Set(['group_chat', 'closed']),
  group_chat: new Set(['resolved', 'closed']),
  resolved: new Set(['closed']),
  closed: new Set(),
};

export function allPartiesJoined(mediationCase: MediationCase): boolean {
  return mediationCase.parties.every((party) => {
    const participant = mediationCase.partyParticipationById[party.id];
    return participant && (participant.state === 'joined' || participant.state === 'ready');
  });
}

export function allPartiesReadyWithSummaries(mediationCase: MediationCase): boolean {
  return mediationCase.parties.every((party) => {
    const participant = mediationCase.partyParticipationById[party.id];
    const thread = mediationCase.privateIntakeByPartyId[party.id];
    return Boolean(
      participant &&
      participant.state === 'ready' &&
      thread &&
      thread.resolved &&
      thread.summary.trim().length > 0,
    );
  });
}

export function validateTransition(
  mediationCase: MediationCase,
  targetPhase: MediationPhase,
): PhaseValidation {
  const allowedTargets = ALLOWED_TRANSITIONS[mediationCase.phase];
  if (!allowedTargets.has(targetPhase)) {
    return {
      allowed: false,
      reason: `cannot transition from '${mediationCase.phase}' to '${targetPhase}'`,
    };
  }

  if (targetPhase === 'private_intake' && !allPartiesJoined(mediationCase)) {
    return {
      allowed: false,
      reason: 'all invited parties must join before private intake can begin',
    };
  }

  if (targetPhase === 'group_chat' && !allPartiesReadyWithSummaries(mediationCase)) {
    return {
      allowed: false,
      reason: 'all parties must be ready and have a private summary before entering group chat',
    };
  }

  return { allowed: true };
}
