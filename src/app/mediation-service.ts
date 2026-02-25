import { DomainError } from '../domain/errors';
import type {
  AppendMessageInput,
  CaseConsent,
  CreateCaseInput,
  MediationCase,
  MediationPhase,
  Party,
  PartyParticipationState,
  ThreadMessage,
} from '../domain/types';
import { validateTransition } from '../engine/phase-engine';
import { enforceShareGrant } from '../policy/consent';
import { InMemoryMediationStore } from '../store/in-memory-store';

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix = 'id'): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

function makeMessage(
  authorType: AppendMessageInput['authorType'],
  text: string,
  visibility: ThreadMessage['visibility'],
  authorPartyId?: string,
  tags: string[] = [],
): ThreadMessage {
  return {
    id: makeId('msg'),
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

function hasJoined(state: PartyParticipationState): boolean {
  return state === 'joined' || state === 'ready';
}

export class MediationService {
  constructor(private readonly store: InMemoryMediationStore = new InMemoryMediationStore()) {}

  createCase(input: CreateCaseInput): MediationCase {
    if (!input.topic.trim()) {
      throw new DomainError('invalid_topic', 'mediation topic is required');
    }
    if (input.parties.length < 2) {
      throw new DomainError('invalid_party_count', 'a mediation case requires at least 2 parties');
    }

    assertUniqueParties(input.parties);
    assertConsentCoverage(input.parties, input.consent);

    const caseId = makeId('case');
    const inviteToken = makeId('invite');
    const inviteBase = (input.inviteBaseUrl || 'https://mediation.local/join').trim();
    const inviteUrl = `${inviteBase}?caseId=${encodeURIComponent(caseId)}&token=${encodeURIComponent(inviteToken)}`;

    const partyParticipationById: MediationCase['partyParticipationById'] = Object.fromEntries(
      input.parties.map((party) => [
        party.id,
        {
          partyId: party.id,
          state: 'invited' as const,
          invitedAt: nowIso(),
        },
      ]),
    );

    const privateIntakeByPartyId: MediationCase['privateIntakeByPartyId'] = Object.fromEntries(
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
      id: caseId,
      topic: input.topic.trim(),
      description: (input.description || '').trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      phase: 'awaiting_join',
      parties: input.parties,
      inviteLink: {
        token: inviteToken,
        url: inviteUrl,
        createdAt: nowIso(),
      },
      partyParticipationById,
      consent: input.consent,
      privateIntakeByPartyId,
      groupChat: {
        opened: false,
        introductionSent: false,
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

  getInviteLink(caseId: string): { token: string; url: string } {
    const mediationCase = this.getCase(caseId);
    return {
      token: mediationCase.inviteLink.token,
      url: mediationCase.inviteLink.url,
    };
  }

  joinWithInvite(caseId: string, partyId: string, inviteToken: string): MediationCase {
    const mediationCase = this.getCase(caseId);

    if (inviteToken !== mediationCase.inviteLink.token) {
      throw new DomainError('invalid_invite_token', 'invite token is invalid');
    }

    const participant = mediationCase.partyParticipationById[partyId];
    if (!participant) {
      throw new DomainError('party_not_found', `party '${partyId}' not found in case`);
    }

    if (!hasJoined(participant.state)) {
      participant.state = 'joined';
      participant.joinedAt = nowIso();
      mediationCase.updatedAt = nowIso();
      this.store.save(mediationCase);
    }

    const allJoined = mediationCase.parties.every((party) => {
      const state = mediationCase.partyParticipationById[party.id]?.state;
      return Boolean(state && hasJoined(state));
    });

    if (allJoined && mediationCase.phase === 'awaiting_join') {
      this.transition(caseId, 'private_intake');
      return this.getCase(caseId);
    }

    return mediationCase;
  }

  appendPrivateMessage(input: AppendMessageInput): MediationCase {
    const mediationCase = this.getCase(input.caseId);
    if (mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'private intake messages are only allowed during private_intake phase');
    }
    if (!input.partyId) {
      throw new DomainError('missing_party', 'partyId is required for private messages');
    }

    const participant = mediationCase.partyParticipationById[input.partyId];
    if (!participant || !hasJoined(participant.state)) {
      throw new DomainError('party_not_joined', `party '${input.partyId}' must join before private intake`);
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
    if (mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'private summaries are only allowed during private_intake phase');
    }

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

  setPartyReady(caseId: string, partyId: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    if (mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'parties can only be marked ready during private_intake phase');
    }

    const participant = mediationCase.partyParticipationById[partyId];
    if (!participant || !hasJoined(participant.state)) {
      throw new DomainError('party_not_joined', `party '${partyId}' must join before ready state`);
    }

    const thread = mediationCase.privateIntakeByPartyId[partyId];
    if (!thread || !thread.resolved || thread.summary.trim().length === 0) {
      throw new DomainError('missing_private_summary', `party '${partyId}' must complete a private summary before ready state`);
    }

    participant.state = 'ready';
    participant.readyAt = nowIso();
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);

    const allReady = mediationCase.parties.every((party) => {
      const state = mediationCase.partyParticipationById[party.id]?.state;
      return state === 'ready';
    });

    if (allReady) {
      this.transition(caseId, 'group_chat');
      return this.getCase(caseId);
    }

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

    if (targetPhase === 'group_chat' && !mediationCase.groupChat.opened) {
      mediationCase.groupChat.opened = true;
      this.emitMediatorIntroductions(mediationCase);
    }

    this.store.save(mediationCase);
    return mediationCase;
  }

  private emitMediatorIntroductions(mediationCase: MediationCase): void {
    if (mediationCase.groupChat.introductionSent) {
      return;
    }

    const positionLines = mediationCase.parties.map((party) => {
      const thread = mediationCase.privateIntakeByPartyId[party.id];
      const grant = mediationCase.consent.byPartyId[party.id];
      const shareResult = enforceShareGrant(grant, {
        partyId: party.id,
        text: thread.summary,
        tags: ['summary'],
      });

      if (!shareResult.allowed) {
        return `${party.displayName}: position is private and was not shared into group chat.`;
      }

      return `${party.displayName}: ${shareResult.text}`;
    });

    const intro = [
      `Welcome to the mediation for topic: ${mediationCase.topic}.`,
      'I will begin with each person\'s stated position from private intake:',
      ...positionLines,
    ].join('\n');

    const guidance = [
      'Discussion guide:',
      '1. Each party states top 2 goals and top 2 constraints.',
      '2. We identify overlap and non-negotiables.',
      '3. I will propose option sets and check for mutual acceptability.',
      '4. We finalize concrete next steps and accountability.',
    ].join('\n');

    mediationCase.groupChat.messages.push(
      makeMessage('mediator_llm', intro, 'group', undefined, ['introduction', 'positions']),
    );
    mediationCase.groupChat.messages.push(
      makeMessage('mediator_llm', guidance, 'group', undefined, ['guidance']),
    );

    mediationCase.groupChat.introductionSent = true;
    mediationCase.updatedAt = nowIso();
  }

  appendGroupMessage(input: AppendMessageInput): MediationCase {
    const mediationCase = this.getCase(input.caseId);
    if (mediationCase.phase !== 'group_chat') {
      throw new DomainError('invalid_phase', 'group chat messages are only allowed during group_chat phase');
    }

    mediationCase.groupChat.messages.push(
      makeMessage(
        input.authorType,
        input.text,
        'group',
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
    if (mediationCase.phase !== 'group_chat') {
      throw new DomainError('invalid_phase', 'mediator summary is only allowed during group_chat phase');
    }

    mediationCase.groupChat.mediatorSummary = summary.trim();
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  resolveCase(caseId: string, resolution: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    if (mediationCase.phase !== 'group_chat') {
      throw new DomainError('invalid_phase', 'cases can only be resolved from group_chat phase');
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
