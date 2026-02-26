import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors';
import type {
  AppendMessageInput,
  CaseConsent,
  CoachComposeAuthor,
  CreateCaseInput,
  GroupMessageDeliveryMode,
  GroupMessageDraft,
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
  return `${prefix}_${randomUUID()}`;
}

function makeInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

function makeMessage(
  authorType: AppendMessageInput['authorType'],
  text: string,
  visibility: ThreadMessage['visibility'],
  authorPartyId?: string,
  tags: string[] = [],
  options?: { deliveryMode?: GroupMessageDeliveryMode; sourceDraftId?: string },
): ThreadMessage {
  return {
    id: makeId('msg'),
    createdAt: nowIso(),
    authorType,
    authorPartyId,
    text,
    tags,
    visibility,
    deliveryMode: options?.deliveryMode,
    sourceDraftId: options?.sourceDraftId,
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

function assertPartyExists(mediationCase: MediationCase, partyId: string): void {
  const found = mediationCase.parties.some((party) => party.id === partyId);
  if (!found) {
    throw new DomainError('party_not_found', `party '${partyId}' not found in case`);
  }
}

function assertGroupChatPhase(mediationCase: MediationCase): void {
  if (mediationCase.phase !== 'group_chat') {
    throw new DomainError('invalid_phase', 'group operations are only allowed during group_chat phase');
  }
}

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function pickStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter((entry) => entry.length > 0);
}

function pickRecordArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[];
}

function asPhase(value: string): MediationPhase {
  if (
    value === 'awaiting_join'
    || value === 'private_intake'
    || value === 'group_chat'
    || value === 'resolved'
    || value === 'closed'
  ) {
    return value;
  }
  return 'awaiting_join';
}

function asAuthorType(value: string): ThreadMessage['authorType'] {
  if (value === 'party' || value === 'party_llm' || value === 'mediator_llm' || value === 'system') {
    return value;
  }
  return 'system';
}

function asVisibility(value: string): ThreadMessage['visibility'] {
  if (value === 'private' || value === 'group' || value === 'system') {
    return value;
  }
  return 'group';
}

function asDeliveryMode(value: string): GroupMessageDeliveryMode | undefined {
  if (value === 'direct' || value === 'coach_approved' || value === 'system') {
    return value;
  }
  return undefined;
}

function asDraftStatus(value: string): GroupMessageDraft['status'] {
  if (value === 'composing' || value === 'pending_approval' || value === 'approved' || value === 'rejected') {
    return value;
  }
  return 'composing';
}

function asComposeAuthor(value: string): CoachComposeAuthor {
  return value === 'party_llm' ? 'party_llm' : 'party';
}

function toIsoOrNow(value: string): string {
  if (!value) {
    return nowIso();
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : nowIso();
}

function cloneCase(mediationCase: MediationCase): MediationCase {
  return JSON.parse(JSON.stringify(mediationCase)) as MediationCase;
}

function cloneMessages(messages: ThreadMessage[]): ThreadMessage[] {
  return JSON.parse(JSON.stringify(messages || [])) as ThreadMessage[];
}

const REMOTE_TOMBSTONE_STATUSES = new Set(['access_revoked', 'left', 'removed']);

export class MediationService {
  constructor(private readonly store: InMemoryMediationStore = new InMemoryMediationStore()) {}

  createCase(input: CreateCaseInput): MediationCase {
    const topic = input.topic.trim();
    if (!topic) {
      throw new DomainError('invalid_topic', 'mediation topic is required');
    }
    if (input.parties.length < 2) {
      throw new DomainError('invalid_party_count', 'a mediation case requires at least 2 parties');
    }

    assertUniqueParties(input.parties);
    assertConsentCoverage(input.parties, input.consent);

    const caseId = makeId('case');
    const inviteToken = makeInviteToken();
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
      topic,
      description: (input.description || '').trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      syncMetadata: {
        source: 'owner_local',
        accessRole: 'owner',
        syncStatus: 'live',
        syncUpdatedAt: nowIso(),
      },
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
        introductionsSent: false,
        mediatorSummary: '',
        messages: [],
        draftsById: {},
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

  joinParty(caseId: string, partyId: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    return this.joinPartyInCase(mediationCase, partyId);
  }

  appendPrivateMessage(input: AppendMessageInput): MediationCase {
    const mediationCase = this.getCase(input.caseId);
    if (mediationCase.phase !== 'awaiting_join' && mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'private intake messages are only allowed during awaiting_join/private_intake phases');
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
    if (mediationCase.phase !== 'awaiting_join' && mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'private summaries are only allowed during awaiting_join/private_intake phases');
    }

    const participant = mediationCase.partyParticipationById[partyId];
    if (!participant) {
      throw new DomainError('party_not_found', `party '${partyId}' not found in case`);
    }
    if (!hasJoined(participant.state)) {
      throw new DomainError('party_not_joined', `party '${partyId}' must join before private summary`);
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

  setPartyConsent(
    caseId: string,
    partyId: string,
    input: { allowSummaryShare: boolean; allowDirectQuote: boolean; allowedTags?: string[] },
  ): MediationCase {
    const mediationCase = this.getCase(caseId);
    const participant = mediationCase.partyParticipationById[partyId];
    if (!participant) {
      throw new DomainError('party_not_found', `party '${partyId}' not found in case`);
    }

    const grant = mediationCase.consent.byPartyId[partyId];
    if (!grant) {
      throw new DomainError('missing_consent', `consent policy for '${partyId}' is missing`);
    }

    grant.allowSummaryShare = input.allowSummaryShare === true;
    grant.allowDirectQuote = input.allowDirectQuote === true;
    if (Array.isArray(input.allowedTags)) {
      grant.allowedTags = input.allowedTags
        .map((entry) => String(entry || '').trim())
        .filter((entry) => entry.length > 0);
    }

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  setPartyReady(caseId: string, partyId: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    if (mediationCase.phase !== 'awaiting_join' && mediationCase.phase !== 'private_intake') {
      throw new DomainError('invalid_phase', 'parties can only be marked ready during awaiting_join/private_intake phases');
    }

    const participant = mediationCase.partyParticipationById[partyId];
    if (!participant) {
      throw new DomainError('party_not_found', `party '${partyId}' not found in case`);
    }
    if (!hasJoined(participant.state)) {
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
      this.emitMediatorOpenMessages(mediationCase);
    }

    this.store.save(mediationCase);
    return mediationCase;
  }

  private emitMediatorOpenMessages(mediationCase: MediationCase): void {
    if (mediationCase.groupChat.introductionsSent) {
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
        return `${party.displayName}: summary remains private and was not shared.`;
      }

      return `${party.displayName} coach summary: ${shareResult.text}`;
    });

    const intro = [
      `Welcome. I am a neutral mediator for topic: ${mediationCase.topic}.`,
      'Each party has their own private coach LLM. I will start with approved coach summaries:',
      ...positionLines,
    ].join('\n');

    const guidance = [
      'I will facilitate this mediation by asking structured questions to both parties.',
      'Opening questions:',
      '1. Party A: what are your top 2 goals and top 2 constraints?',
      '2. Party B: what are your top 2 goals and top 2 constraints?',
      '3. Each party: what is one flexible point you can offer today?',
      'You can answer directly or use your private coach conversation before posting.',
    ].join('\n');

    mediationCase.groupChat.messages.push(
      makeMessage('mediator_llm', intro, 'group', undefined, ['introduction', 'coach_summaries'], {
        deliveryMode: 'system',
      }),
    );
    mediationCase.groupChat.messages.push(
      makeMessage('mediator_llm', guidance, 'group', undefined, ['guidance'], {
        deliveryMode: 'system',
      }),
    );

    mediationCase.groupChat.introductionsSent = true;
    mediationCase.updatedAt = nowIso();
  }

  sendDirectGroupMessage(caseId: string, partyId: string, text: string, tags: string[] = []): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);
    assertPartyExists(mediationCase, partyId);

    const finalText = text.trim();
    if (!finalText) {
      throw new DomainError('invalid_group_message', 'group message text cannot be empty');
    }

    mediationCase.groupChat.messages.push(
      makeMessage('party', finalText, 'group', partyId, tags, {
        deliveryMode: 'direct',
      }),
    );

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  createCoachDraft(caseId: string, partyId: string, initialPartyMessage: string): GroupMessageDraft {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);
    assertPartyExists(mediationCase, partyId);
    const hasActiveDraft = Object.values(mediationCase.groupChat.draftsById)
      .some((draft) => draft.partyId === partyId && draft.status !== 'approved' && draft.status !== 'rejected');
    if (hasActiveDraft) {
      throw new DomainError('draft_already_active', `party '${partyId}' already has an active draft`);
    }

    const initialText = initialPartyMessage.trim();
    if (!initialText) {
      throw new DomainError('invalid_intent', 'initial coach conversation message is required');
    }

    const draft: GroupMessageDraft = {
      id: makeId('draft'),
      partyId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'composing',
      composeMessages: [
        {
          id: makeId('compose'),
          createdAt: nowIso(),
          author: 'party',
          text: initialText,
        },
      ],
    };

    mediationCase.groupChat.draftsById[draft.id] = draft;
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return draft;
  }

  appendCoachDraftMessage(
    caseId: string,
    draftId: string,
    author: CoachComposeAuthor,
    text: string,
  ): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);

    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft) {
      throw new DomainError('draft_not_found', `draft '${draftId}' not found`);
    }
    if (draft.status === 'approved' || draft.status === 'rejected') {
      throw new DomainError('draft_closed', `draft '${draftId}' is already ${draft.status}`);
    }

    const finalText = text.trim();
    if (!finalText) {
      throw new DomainError('invalid_compose_message', 'coach conversation message text cannot be empty');
    }

    draft.composeMessages.push({
      id: makeId('compose'),
      createdAt: nowIso(),
      author,
      text: finalText,
    });

    // If the party continues iterating after a prior suggestion, move back to composing.
    if (author === 'party' && draft.status === 'pending_approval') {
      draft.status = 'composing';
      draft.suggestedText = undefined;
    }

    draft.updatedAt = nowIso();
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  setCoachDraftSuggestion(caseId: string, draftId: string, suggestedText: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);

    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft) {
      throw new DomainError('draft_not_found', `draft '${draftId}' not found`);
    }
    if (draft.status === 'approved' || draft.status === 'rejected') {
      throw new DomainError('draft_closed', `draft '${draftId}' is already ${draft.status}`);
    }

    const finalSuggestion = suggestedText.trim();
    if (!finalSuggestion) {
      throw new DomainError('invalid_suggested_text', 'suggested text is required');
    }

    draft.composeMessages.push({
      id: makeId('compose'),
      createdAt: nowIso(),
      author: 'party_llm',
      text: finalSuggestion,
    });

    draft.suggestedText = finalSuggestion;
    draft.status = 'pending_approval';
    draft.updatedAt = nowIso();

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  approveCoachDraftAndSend(caseId: string, draftId: string, approvedText?: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);

    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft) {
      throw new DomainError('draft_not_found', `draft '${draftId}' not found`);
    }
    if (draft.status === 'approved' || draft.status === 'rejected') {
      throw new DomainError('draft_closed', `draft '${draftId}' is already ${draft.status}`);
    }

    const lastComposeText = draft.composeMessages.length > 0
      ? draft.composeMessages[draft.composeMessages.length - 1].text
      : '';
    const sourceText = approvedText || draft.suggestedText || lastComposeText || '';
    const finalText = sourceText.trim();
    if (!finalText) {
      throw new DomainError('invalid_approved_text', 'approved text cannot be empty');
    }

    draft.status = 'approved';
    draft.approvedText = finalText;
    draft.approvedAt = nowIso();
    draft.updatedAt = nowIso();

    const sent = makeMessage('party', finalText, 'group', draft.partyId, ['coach_draft'], {
      deliveryMode: 'coach_approved',
      sourceDraftId: draft.id,
    });
    draft.sentMessageId = sent.id;

    mediationCase.groupChat.messages.push(sent);
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  rejectCoachDraft(caseId: string, draftId: string, reason?: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);

    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft) {
      throw new DomainError('draft_not_found', `draft '${draftId}' not found`);
    }
    if (draft.status === 'approved' || draft.status === 'rejected') {
      throw new DomainError('draft_closed', `draft '${draftId}' is already ${draft.status}`);
    }

    draft.status = 'rejected';
    draft.rejectedAt = nowIso();
    draft.rejectionReason = (reason || '').trim() || undefined;
    draft.updatedAt = nowIso();

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  appendGroupMessage(input: AppendMessageInput): MediationCase {
    const mediationCase = this.getCase(input.caseId);
    assertGroupChatPhase(mediationCase);

    if (input.authorType === 'party') {
      if (!input.partyId) {
        throw new DomainError('missing_party', 'partyId is required for party messages');
      }
      return this.sendDirectGroupMessage(input.caseId, input.partyId, input.text, input.tags ?? []);
    }

    mediationCase.groupChat.messages.push(
      makeMessage(
        input.authorType,
        input.text,
        'group',
        input.partyId,
        input.tags ?? [],
        { deliveryMode: 'system' },
      ),
    );

    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  setMediatorSummary(caseId: string, summary: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);

    mediationCase.groupChat.mediatorSummary = summary.trim();
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    return mediationCase;
  }

  resolveCase(caseId: string, resolution: string): MediationCase {
    const mediationCase = this.getCase(caseId);
    assertGroupChatPhase(mediationCase);

    // Spec requires at least one group message before resolving
    if (!mediationCase.groupChat.messages || mediationCase.groupChat.messages.length === 0) {
      throw new DomainError('invalid_phase', 'at least one group message is required before resolving');
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

  upsertRemoteCaseSnapshot(input: {
    projectedCase: Record<string, unknown>;
    ownerDeviceId: string;
    grantId: string;
    accessRole: 'owner' | 'collaborator';
    localPartyId?: string;
    remoteVersion?: number;
    syncStatus?: MediationCase['syncMetadata'] extends { syncStatus?: infer T } ? T : never;
  }): MediationCase {
    const projected = input.projectedCase || {};
    const caseId = pickString(projected, 'case_id');
    if (!caseId) {
      throw new DomainError('invalid_payload', 'remote case snapshot missing case_id');
    }

    const incomingVersion = Number.isFinite(input.remoteVersion)
      ? Math.max(0, Math.trunc(input.remoteVersion as number))
      : 0;
    const existing = this.store.get(caseId);
    const existingVersion = Number(existing?.syncMetadata?.remoteVersion || 0);
    if (
      existing
      && existing.syncMetadata?.source === 'shared_remote'
      && incomingVersion > 0
      && existingVersion > 0
      && incomingVersion <= existingVersion
    ) {
      return existing;
    }

    const projectedParties = pickRecordArray(projected, 'parties');
    const parties: Party[] = projectedParties.map((party, idx) => {
      const partyId = pickString(party, 'party_id') || `party_${idx + 1}`;
      return {
        id: partyId,
        displayName: pickString(party, 'label') || partyId,
        localLLM: {
          provider: 'remote',
          model: 'remote',
        },
      };
    });

    const partyParticipationById: MediationCase['partyParticipationById'] = {};
    const privateIntakeByPartyId: MediationCase['privateIntakeByPartyId'] = {};
    const consentByPartyId: CaseConsent['byPartyId'] = {};

    for (const party of projectedParties) {
      const partyId = pickString(party, 'party_id');
      if (!partyId) {
        continue;
      }

      const joined = party.joined === true;
      const ready = party.ready === true;
      const participationState: PartyParticipationState = ready ? 'ready' : (joined ? 'joined' : 'invited');
      partyParticipationById[partyId] = {
        partyId,
        state: participationState,
        invitedAt: existing?.partyParticipationById?.[partyId]?.invitedAt || toIsoOrNow(pickString(projected, 'created_at')),
        ...(joined ? { joinedAt: existing?.partyParticipationById?.[partyId]?.joinedAt || nowIso() } : {}),
        ...(ready ? { readyAt: existing?.partyParticipationById?.[partyId]?.readyAt || nowIso() } : {}),
      };

      const consentRecord = party.consent && typeof party.consent === 'object'
        ? party.consent as Record<string, unknown>
        : {};
      const explicitTags = pickStringArray(consentRecord, 'allowedTags');
      consentByPartyId[partyId] = {
        allowSummaryShare: consentRecord.allowSummaryShare === true || party.has_consent === true,
        allowDirectQuote: consentRecord.allowDirectQuote === true,
        allowedTags: explicitTags,
      };

      const privateThread = Array.isArray(party.private_thread)
        ? party.private_thread as Array<Record<string, unknown>>
        : null;
      const messages: ThreadMessage[] = privateThread
        ? privateThread.map((message) => {
          const messageId = pickString(message, 'id') || makeId('msg');
          return {
            id: messageId,
            createdAt: toIsoOrNow(pickString(message, 'created_at')),
            authorType: asAuthorType(pickString(message, 'author_type')),
            authorPartyId: pickString(message, 'author_party_id') || undefined,
            text: pickString(message, 'text'),
            tags: pickStringArray(message, 'tags'),
            visibility: asVisibility(pickString(message, 'visibility')),
            deliveryMode: asDeliveryMode(pickString(message, 'delivery_mode')),
            sourceDraftId: pickString(message, 'source_draft_id') || undefined,
          };
        })
        : cloneMessages(existing?.privateIntakeByPartyId?.[partyId]?.messages || []);

      privateIntakeByPartyId[partyId] = {
        partyId,
        resolved: Boolean(pickString(party, 'private_summary')),
        summary: pickString(party, 'private_summary'),
        messages,
      };
    }

    const groupThread = pickRecordArray(projected, 'group_thread');
    const groupMessages: ThreadMessage[] = groupThread.map((message) => ({
      id: pickString(message, 'id') || makeId('msg'),
      createdAt: toIsoOrNow(pickString(message, 'created_at')),
      authorType: asAuthorType(pickString(message, 'author_type')),
      authorPartyId: pickString(message, 'author_party_id') || undefined,
      text: pickString(message, 'text'),
      tags: pickStringArray(message, 'tags'),
      visibility: asVisibility(pickString(message, 'visibility')),
      deliveryMode: asDeliveryMode(pickString(message, 'delivery_mode')),
      sourceDraftId: pickString(message, 'source_draft_id') || undefined,
    }));

    const draftsById: Record<string, GroupMessageDraft> = {};
    for (const party of projectedParties) {
      const partyId = pickString(party, 'party_id');
      if (!partyId || !Array.isArray(party.drafts)) {
        continue;
      }

      for (const draftRecord of party.drafts as Array<Record<string, unknown>>) {
        const draftId = pickString(draftRecord, 'draft_id');
        if (!draftId) {
          continue;
        }
        const composeMessages = pickRecordArray(draftRecord, 'compose_messages').map((entry) => ({
          id: pickString(entry, 'id') || makeId('compose'),
          createdAt: toIsoOrNow(pickString(entry, 'created_at')),
          author: asComposeAuthor(pickString(entry, 'author')),
          text: pickString(entry, 'text'),
        }));

        draftsById[draftId] = {
          id: draftId,
          partyId,
          createdAt: toIsoOrNow(pickString(draftRecord, 'created_at')),
          updatedAt: toIsoOrNow(pickString(draftRecord, 'updated_at')),
          status: asDraftStatus(pickString(draftRecord, 'status')),
          composeMessages,
          suggestedText: pickString(draftRecord, 'suggested_text') || undefined,
          approvedText: pickString(draftRecord, 'approved_text') || undefined,
          approvedAt: pickString(draftRecord, 'approved_at') || undefined,
          rejectedAt: pickString(draftRecord, 'rejected_at') || undefined,
          rejectionReason: pickString(draftRecord, 'rejection_reason') || undefined,
          sentMessageId: pickString(draftRecord, 'sent_message_id') || undefined,
        };
      }
    }

    const createdAt = toIsoOrNow(pickString(projected, 'created_at') || existing?.createdAt || nowIso());
    const updatedAt = toIsoOrNow(pickString(projected, 'updated_at') || nowIso());
    const topic = pickString(projected, 'title') || existing?.topic || `Remote Case ${caseId}`;
    const phase = asPhase(pickString(projected, 'phase') || existing?.phase || 'awaiting_join');

    const nextCase: MediationCase = {
      id: caseId,
      topic,
      description: existing?.description || '',
      createdAt,
      updatedAt,
      syncMetadata: {
        source: 'shared_remote',
        ownerDeviceId: input.ownerDeviceId,
        grantId: input.grantId,
        accessRole: input.accessRole,
        localPartyId: input.localPartyId || existing?.syncMetadata?.localPartyId,
        remoteVersion: incomingVersion > 0 ? incomingVersion : existingVersion,
        syncUpdatedAt: nowIso(),
        syncStatus: (input.syncStatus as any) || existing?.syncMetadata?.syncStatus || 'live',
      },
      phase,
      parties: parties.length > 0 ? parties : (existing?.parties || []),
      inviteLink: existing?.inviteLink || {
        token: '',
        url: '',
        createdAt,
      },
      partyParticipationById,
      consent: { byPartyId: consentByPartyId },
      privateIntakeByPartyId,
      groupChat: {
        opened: phase === 'group_chat' || phase === 'resolved' || phase === 'closed',
        introductionsSent: groupMessages.length > 0,
        mediatorSummary: pickString(projected, 'mediator_notes'),
        messages: groupMessages,
        draftsById,
      },
      resolution: pickString(projected, 'resolution') || undefined,
    };

    this.store.save(nextCase);
    return cloneCase(nextCase);
  }

  markRemoteGrantStatus(grantId: string, status: 'access_revoked' | 'left'): MediationCase[] {
    const normalizedGrantId = grantId.trim();
    if (!normalizedGrantId) {
      return [];
    }

    const now = nowIso();
    const updated: MediationCase[] = [];
    for (const mediationCase of this.store.list()) {
      if (mediationCase.syncMetadata?.source !== 'shared_remote') {
        continue;
      }
      if (mediationCase.syncMetadata.grantId !== normalizedGrantId) {
        continue;
      }

      mediationCase.syncMetadata.syncStatus = status;
      mediationCase.syncMetadata.syncUpdatedAt = now;
      mediationCase.updatedAt = now;
      this.store.save(mediationCase);
      updated.push(cloneCase(mediationCase));
    }
    return updated;
  }

  markRemoteCaseRemoved(grantId: string, caseId: string): void {
    const normalizedGrantId = grantId.trim();
    const normalizedCaseId = caseId.trim();
    if (!normalizedGrantId || !normalizedCaseId) {
      return;
    }

    const mediationCase = this.store.get(normalizedCaseId);
    if (!mediationCase || mediationCase.syncMetadata?.source !== 'shared_remote') {
      return;
    }
    if (mediationCase.syncMetadata.grantId !== normalizedGrantId) {
      return;
    }

    mediationCase.syncMetadata.syncStatus = 'removed';
    mediationCase.syncMetadata.syncUpdatedAt = nowIso();
    mediationCase.updatedAt = nowIso();
    this.store.save(mediationCase);
    this.store.delete(normalizedCaseId);
  }

  purgeExpiredRemoteTombstones(): number {
    const cutoffMs = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let purged = 0;
    for (const mediationCase of this.store.list()) {
      const metadata = mediationCase.syncMetadata;
      if (!metadata || metadata.source !== 'shared_remote') {
        continue;
      }
      if (!metadata.syncStatus || !REMOTE_TOMBSTONE_STATUSES.has(metadata.syncStatus)) {
        continue;
      }

      if (metadata.syncStatus === 'removed') {
        this.store.delete(mediationCase.id);
        purged += 1;
        continue;
      }

      const updatedAtMs = Date.parse(metadata.syncUpdatedAt || mediationCase.updatedAt || '');
      if (!Number.isFinite(updatedAtMs) || updatedAtMs < cutoffMs) {
        this.store.delete(mediationCase.id);
        purged += 1;
      }
    }
    return purged;
  }

  private joinPartyInCase(mediationCase: MediationCase, partyId: string): MediationCase {
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
      this.transition(mediationCase.id, 'private_intake');
      return this.getCase(mediationCase.id);
    }

    return mediationCase;
  }
}
