import type { MediationCase, MediationPhase } from '../domain/types';

export interface PhaseValidation {
  allowed: boolean;
  reason?: string;
}

const ALLOWED_TRANSITIONS: Record<MediationPhase, Set<MediationPhase>> = {
  private_intake: new Set(['cross_agent_dialogue', 'closed']),
  cross_agent_dialogue: new Set(['joint_mediation', 'closed']),
  joint_mediation: new Set(['resolved', 'closed']),
  resolved: new Set(['closed']),
  closed: new Set(),
};

function readyForCrossAgentDialogue(mediationCase: MediationCase): boolean {
  return mediationCase.parties.every((party) => {
    const thread = mediationCase.privateIntakeByPartyId[party.id];
    return Boolean(thread && thread.resolved && thread.summary && thread.summary.trim().length > 0);
  });
}

function readyForJointMediation(mediationCase: MediationCase): boolean {
  return mediationCase.sharedDialogue.completed;
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

  if (targetPhase === 'cross_agent_dialogue' && !readyForCrossAgentDialogue(mediationCase)) {
    return {
      allowed: false,
      reason: 'all parties must complete private intake with a summary before cross-agent dialogue',
    };
  }

  if (targetPhase === 'joint_mediation' && !readyForJointMediation(mediationCase)) {
    return {
      allowed: false,
      reason: 'shared agent dialogue must be completed before opening joint mediation',
    };
  }

  return { allowed: true };
}
