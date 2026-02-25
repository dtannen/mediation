import { DomainError } from '../domain/errors';
import type {
  AppendMessageInput,
  CaseConsent,
  CreateCaseInput,
  MediationCase,
  MediationPhase,
  Party,
  ThreadMessage,
} from '../domain/types';
import { validateTransition } from '../engine/phase-engine';
import { enforceShareGrant } from '../policy/consent';
import { InMemoryMediationStore } from '../store/in-memory-store';

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `id_${ts}_${rand}`;
}

function makeMessage(
  authorType: AppendMessageInput['authorType'],
  text: string,
  visibility: ThreadMessage['visibility'],
  authorPartyId?: string,
  tags: string[] = [],
): ThreadMessage {
  return {
    id: makeId(),
    createdAt: nowIso(),
    authorType,
    authorPartyId,
    text,
    tags,
    visibility,
  };
}

function assertUniqueParties(parties: Party[]): void {
  const seen = new Set<string>();
  for (const party of parties) {
    if (seen.has(party.id)) {
      throw new DomainError('duplicate_party_id', `duplicate party id '${party.id}'`);
    }
    seen.add(party.id);
  }
}

function assertConsentCoverage(parties: Party[], consent: CaseConsent): void {
  for (const party of parties) {
    if (!consent.byPartyId[party.id]) {
      throw new DomainError('missing_consent', `missing consent policy for party '${party.id}'`);
    }
  }
}

export class MediationService {
  constructor(private readonly store: InMemoryMediationStore = new InMemoryMediationStore()) {}

  createCase(input: CreateCaseInput): MediationCase {
    if (!input.title.trim()) {
      throw new DomainError('invalid_title', 'case title is required');
    }
    if (!input.issue.trim()) {
      throw new DomainError('invalid_issue', 'case issue is required');
    }
    if (input.parties.length < 2) {
      throw new DomainError('invalid_party_count', 'a mediation case requires at least 2 parties');
    }

    assertUniqueParties(input.parties);
    assertConsentCoverage(input.parties, input.consent);

    const privateIntakeByPartyId = Object.fromEntries(
      input.parties.map((party) => [
        party.id,
        {
          partyId: party.id,
          resolved: false,
          summary: '',
          messages: [],
        },
      ]),
    );

    const mediationCase: MediationCase = {
      id: makeId(),
      title: input.title.trim(),
      issue: input.issue.trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      phase: 'private_intake',
      parties: input.parties,
      consent: input.consent,
      privateIntakeByPartyId,
      sharedDialogue: {
        completed: false,
        summary: '',
        messages: [],
      },
      jointRoom: {
        opened: false,
        mediatorSummary: '',
        messages: [],
      },
    };

    this.store.save(mediationCase);
    return mediationCase;
  }

  getCase(caseId: string): MediationCase {
    const mediationCase = this.store.get(caseId);
    if (!mediationCase) {
      throw new DomainError('case_not_found', `case '${caseId}' was not found`);
    }
    return mediationCase;
  }

  listCases(): MediationCase[] {
    return this.store.list();
  }

  appendPrivateMessage(input: AppendMessageInput): MediationCase {
    const mediationCase = this.getCase(input.caseId);
    if (mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'private intake messages are only allowed during private_intake phase');
    }
    if (!input.partyId) {
      throw new DomainError('missing_party', 'partyId is required for private messages');
    }

    const thread = mediationCase.privateIntakeByPartyId[input.partyId];
    if (!thread) {
      throw new DomainError('party_not_found', `party '${input.partyId}' not found in case`);
    }

    thread.messages.push(
      makeMessage(
        input.authorType,
        input.text,
        'private',
        input.partyId,
        input.tags ?? [],
      ),
    );

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  setPrivateSummary(caseId: string, partyId: string, summary: string, resolved = true): MediationCase {
    const mediationCase = this.getCase(caseId);
    const thread = mediationCase.privateIntakeByPartyId[partyId];
    if (!thread) {
      throw new DomainError('party_not_found', `party '${partyId}' not found in case`);
    }

    thread.summary = summary.trim();
    thread.resolved = resolved;

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  transition(caseId: string, targetPhase: MediationPhase): MediationCase {
    const mediationCase = this.getCase(caseId);
    const validation = validateTransition(mediationCase, targetPhase);
    if (!validation.allowed) {
      throw new DomainError('invalid_transition', validation.reason || 'transition denied');
    }

    mediationCase.phase = targetPhase;
    mediationCase.updatedAt = nowIso();

    if (targetPhase === 'joint_mediation' && !mediationCase.jointRoom.opened) {
      mediationCase.jointRoom.opened = true;
      mediationCase.jointRoom.messages.push(
        makeMessage(
          'system',
          'Joint mediation room opened. Mediator LLM should establish shared ground rules and goals.',
          'system',
        ),
      );
    }

    this.store.save(mediationCase);
    return mediationCase;
  }

  runCrossAgentDialogue(caseId: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    if (mediationCase.phase === 'private_intake') {
      this.transition(caseId, 'cross_agent_dialogue');
    }
    if (mediationCase.phase !== 'cross_agent_dialogue') {
      throw new DomainError('invalid_phase', 'cross-agent dialogue can only run during cross_agent_dialogue phase');
    }

    const shareMessages: string[] = [];

    for (const party of mediationCase.parties) {
      const thread = mediationCase.privateIntakeByPartyId[party.id];
      const grant = mediationCase.consent.byPartyId[party.id];

      const result = enforceShareGrant(grant, {
        partyId: party.id,
        text: thread.summary || '',
        tags: ['summary'],
      });

      if (!result.allowed) {
        mediationCase.sharedDialogue.messages.push(
          makeMessage('system', `Share denied for ${party.displayName}: ${result.reason}`, 'shared'),
        );
        continue;
      }

      const sharedText = `${party.displayName} (via local LLM): ${result.text}`;
      shareMessages.push(sharedText);
      mediationCase.sharedDialogue.messages.push(
        makeMessage('party_llm', sharedText, 'shared', party.id, ['summary']),
      );
    }

    mediationCase.sharedDialogue.summary =
      shareMessages.length > 0
        ? `Cross-agent consensus draft: ${shareMessages.join(' | ')}`
        : 'No shareable intake content was approved by party consent policies.';
    mediationCase.sharedDialogue.completed = true;

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  appendJointMessage(input: AppendMessageInput): MediationCase {
    const mediationCase = this.getCase(input.caseId);
    if (mediationCase.phase !== 'joint_mediation') {
      throw new DomainError('invalid_phase', 'joint messages are only allowed during joint_mediation phase');
    }

    mediationCase.jointRoom.messages.push(
      makeMessage(
        input.authorType,
        input.text,
        'joint',
        input.partyId,
        input.tags ?? [],
      ),
    );

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  setMediatorSummary(caseId: string, summary: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    mediationCase.jointRoom.mediatorSummary = summary.trim();
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  resolveCase(caseId: string, resolution: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    if (mediationCase.phase !== 'joint_mediation') {
      throw new DomainError('invalid_phase', 'cases can only be resolved from joint_mediation phase');
    }

    this.transition(caseId, 'resolved');
    const updated = this.getCase(caseId);
    updated.resolution = resolution.trim();
    updated.updatedAt = nowIso();
    this.store.save(updated);
    return updated;
  }

  closeCase(caseId: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    if (mediationCase.phase !== 'closed') {
      this.transition(caseId, 'closed');
    }
    return this.getCase(caseId);
  }
}
