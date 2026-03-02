export type MediationPhase =
  | 'awaiting_join'
  | 'private_intake'
  | 'group_chat'
  | 'resolved'
  | 'closed';

/* ============================================================
   V2: Coaching Template System (F-03 / F-05)
   ============================================================ */

export type CoachingRole = 'intake' | 'draft_coach' | 'mediator';

export interface CoachingCategory {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoachingTemplateVersion {
  id: string;
  templateId: string;
  versionNumber: number;
  /** @deprecated Use individual role preamble fields */
  preambles?: Record<CoachingRole, string>;
  /** @deprecated Use individual role instruction fields */
  instructions?: Record<CoachingRole, string>;
  /** @deprecated Use changeNote */
  changeNotes?: string;
  // V2 spec fields (Section 4.3 CoachingTemplateVersion)
  globalGuidance: string;
  intakeCoachPreamble?: string;
  draftCoachPreamble?: string;
  mediatorPreamble?: string;
  intakeCoachInstructions?: string;
  draftCoachInstructions?: string;
  mediatorInstructions?: string;
  changeNote: string;
  createdByActorId: string;
  createdByActorDisplay?: string;
  /** @deprecated Use createdByActorId */
  actorId?: string;
  createdAt: string;
}

export type TemplateStatus = 'active' | 'archived';

export interface CoachingTemplate {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  status: TemplateStatus;
  currentVersion: number;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;   // soft-delete marker (F-05)
}

export interface TemplateSelection {
  categoryId?: string;
  templateId: string;
  templateVersion: number;
  /** @deprecated Use templateVersion */
  versionId?: string;
  selectedAt: string;
  selectedBy?: string;
}

export interface MainTopicConfig {
  topic: string;
  description: string;
  categoryId: string;
  templateId?: string;
  templateVersion?: number;
  configuredAt?: string;
  /** @deprecated Use configuredAt */
  confirmedAt?: string;
  configuredByPartyId?: string;
}

/* ============================================================
   V2: Draft Coach Phases (F-01)
   ============================================================ */

export type DraftCoachPhase = 'exploring' | 'confirm_ready' | 'formal_draft_ready';

export interface DraftCoachMetadata {
  phase: DraftCoachPhase;
  coachHistory: CoachComposeMessage[];
  readinessConfirmedAt?: string;
  explorationSummary?: string;
  formalDraftText?: string;
  formalDraftGeneratedAt?: string;
  phaseChangedAt: string;
}

/* ============================================================
   V2: IPC Error Codes
   ============================================================ */

export type IpcErrorCode =
  | 'template_not_found'
  | 'template_inactive'
  | 'template_version_not_found'
  | 'template_in_use'
  | 'main_topic_required'
  | 'main_topic_not_configured'
  | 'draft_readiness_required'
  | 'invalid_template_category'
  | 'invalid_phase_transition'
  | 'no_coach_exchanges'
  | 'draft_not_found'
  | 'context_budget_exceeded'
  | 'admin_override_required'
  | 'unauthorized_admin_action'
  | 'internal_error';

export type MessageAuthorType =
  | 'party'
  | 'party_llm'
  | 'mediator_llm'
  | 'system';

export type MessageVisibility = 'private' | 'group' | 'system';

export type GroupMessageDeliveryMode = 'direct' | 'coach_approved' | 'system';

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

export interface CaseSyncMetadata {
  source: 'owner_local' | 'shared_remote';
  ownerDeviceId?: string;
  grantId?: string;
  accessRole?: 'owner' | 'collaborator';
  localPartyId?: string;
  remoteVersion?: number;
  syncUpdatedAt?: string;
  syncStatus?: 'live' | 'stale' | 'reconnecting' | 'access_revoked' | 'left' | 'removed';
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
  deliveryMode?: GroupMessageDeliveryMode;
  sourceDraftId?: string;
}

export interface PrivateIntakeThread {
  partyId: string;
  resolved: boolean;
  summary: string;
  messages: ThreadMessage[];
}

export type CoachComposeAuthor = 'party' | 'party_llm';

export interface CoachComposeMessage {
  id: string;
  createdAt: string;
  author: CoachComposeAuthor;
  text: string;
}

export type GroupDraftStatus = 'composing' | 'pending_approval' | 'approved' | 'rejected';

export interface GroupMessageDraft {
  id: string;
  partyId: string;
  createdAt: string;
  updatedAt: string;
  status: GroupDraftStatus;
  composeMessages: CoachComposeMessage[];
  suggestedText?: string;
  approvedText?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  sentMessageId?: string;
  coachMeta?: DraftCoachMetadata;
}

export interface GroupChatRoom {
  opened: boolean;
  introductionsSent: boolean;
  mediatorSummary: string;
  messages: ThreadMessage[];
  draftsById: Record<string, GroupMessageDraft>;
}

export interface MediationCase {
  id: string;
  topic: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  syncMetadata?: CaseSyncMetadata;
  phase: MediationPhase;
  parties: Party[];
  inviteLink: InviteLink;
  partyParticipationById: Record<string, PartyParticipation>;
  consent: CaseConsent;
  privateIntakeByPartyId: Record<string, PrivateIntakeThread>;
  groupChat: GroupChatRoom;
  resolution?: string;
  schemaVersion?: number;
  templateSelection?: TemplateSelection;
  mainTopicConfig?: MainTopicConfig;
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
