export type MediationPhase =
  | 'awaiting_join'
  | 'private_intake'
  | 'group_chat'
  | 'resolved'
  | 'closed';

export type MessageAuthorType =
  | 'party'
  | 'party_llm'
  | 'mediator_llm'
  | 'system';

export type MessageVisibility = 'private' | 'group' | 'system';

export interface LLMChoice {
  provider: string;
  model: string;
}

export interface Party {
  id: string;
  displayName: string;
  localLLM: LLMChoice;
}

export type PartyParticipationState = 'invited' | 'joined' | 'ready';

export interface PartyParticipation {
  partyId: string;
  state: PartyParticipationState;
  invitedAt: string;
  joinedAt?: string;
  readyAt?: string;
}

export interface InviteLink {
  token: string;
  url: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ConsentGrant {
  allowSummaryShare: boolean;
  allowDirectQuote: boolean;
  allowedTags: string[];
}

export interface CaseConsent {
  byPartyId: Record<string, ConsentGrant>;
}

export interface ThreadMessage {
  id: string;
  createdAt: string;
  authorType: MessageAuthorType;
  authorPartyId?: string;
  text: string;
  tags: string[];
  visibility: MessageVisibility;
}

export interface PrivateIntakeThread {
  partyId: string;
  resolved: boolean;
  summary: string;
  messages: ThreadMessage[];
}

export interface GroupChatRoom {
  opened: boolean;
  introductionSent: boolean;
  mediatorSummary: string;
  messages: ThreadMessage[];
}

export interface MediationCase {
  id: string;
  topic: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  phase: MediationPhase;
  parties: Party[];
  inviteLink: InviteLink;
  partyParticipationById: Record<string, PartyParticipation>;
  consent: CaseConsent;
  privateIntakeByPartyId: Record<string, PrivateIntakeThread>;
  groupChat: GroupChatRoom;
  resolution?: string;
}

export interface CreateCaseInput {
  topic: string;
  description?: string;
  parties: Party[];
  consent: CaseConsent;
  inviteBaseUrl?: string;
}

export interface AppendMessageInput {
  caseId: string;
  partyId?: string;
  authorType: MessageAuthorType;
  text: string;
  tags?: string[];
}
