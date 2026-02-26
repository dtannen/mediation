import type { MediationCase } from '../domain/types';

type ActorRole = 'owner' | 'collaborator';

function isJoined(state: string): boolean {
  return state === 'joined' || state === 'ready';
}

function draftListForParty(mediationCase: MediationCase, partyId: string): Record<string, unknown>[] {
  return Object.values(mediationCase.groupChat.draftsById)
    .filter((draft) => draft.partyId === partyId)
    .map((draft) => ({
      draft_id: draft.id,
      status: draft.status,
      compose_messages: draft.composeMessages.map((message) => ({
        id: message.id,
        created_at: message.createdAt,
        author: message.author,
        text: message.text,
      })),
      suggested_text: draft.suggestedText ?? null,
      approved_text: draft.approvedText ?? null,
      approved_at: draft.approvedAt ?? null,
      rejected_at: draft.rejectedAt ?? null,
      rejection_reason: draft.rejectionReason ?? null,
      sent_message_id: draft.sentMessageId ?? null,
      created_at: draft.createdAt,
      updated_at: draft.updatedAt,
    }));
}

export function projectCaseForActor(
  mediationCase: MediationCase,
  actorPartyId: string | null,
  _actorRole: ActorRole,
): Record<string, unknown> {
  const parties = mediationCase.parties.map((party) => {
    const participation = mediationCase.partyParticipationById[party.id];
    const consent = mediationCase.consent.byPartyId[party.id];
    const thread = mediationCase.privateIntakeByPartyId[party.id];
    const sameParty = actorPartyId === party.id;
    const canSeePrivate = sameParty;
    const hasConsent = Boolean(consent);

    return {
      party_id: party.id,
      label: party.displayName,
      joined: Boolean(participation && isJoined(participation.state)),
      ready: Boolean(participation && participation.state === 'ready'),
      has_consent: hasConsent,
      consent: canSeePrivate && consent
        ? {
          allowSummaryShare: consent.allowSummaryShare,
          allowDirectQuote: consent.allowDirectQuote,
          allowedTags: [...consent.allowedTags],
        }
        : null,
      // Private intake threads are never transmitted over gateway payloads.
      private_thread: null,
      private_summary: canSeePrivate && thread ? (thread.summary || null) : null,
      drafts: canSeePrivate ? draftListForParty(mediationCase, party.id) : null,
    };
  });

  return {
    case_id: mediationCase.id,
    title: mediationCase.topic,
    phase: mediationCase.phase,
    created_at: mediationCase.createdAt,
    updated_at: mediationCase.updatedAt,
    parties,
    group_thread: mediationCase.groupChat.messages.map((message) => ({
      id: message.id,
      created_at: message.createdAt,
      author_type: message.authorType,
      author_party_id: message.authorPartyId ?? null,
      text: message.text,
      tags: [...message.tags],
      visibility: message.visibility,
      delivery_mode: message.deliveryMode ?? null,
      source_draft_id: message.sourceDraftId ?? null,
    })),
    resolution: mediationCase.resolution ?? null,
    mediator_notes: mediationCase.groupChat.mediatorSummary || null,
  };
}
