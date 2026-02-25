export type MediationPhase =
  | 'private_intake'
  | 'cross_agent_dialogue'
  | 'joint_mediation'
  | 'resolved'
  | 'closed';

export type MessageAuthorType =
  | 'party'
  | 'party_llm'
  | 'mediator_llm'
  | 'system';

export type MessageVisibility = 'private' | 'shared' | 'joint' | 'system';

export interface LLMChoice {
  provider: string;
  model: string;
}

export interface Party {
  id: string;
  displayName: string;
  localLLM: LLMChoice;
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
  summary?: string;
  messages: ThreadMessage[];
}

export interface SharedDialogueThread {
  completed: boolean;
  summary?: string;
  messages: ThreadMessage[];
}

export interface JointMediationRoom {
  opened: boolean;
  mediatorSummary?: string;
  messages: ThreadMessage[];
}

export interface MediationCase {
  id: string;
  title: string;
  issue: string;
  createdAt: string;
  updatedAt: string;
  phase: MediationPhase;
  parties: Party[];
  consent: CaseConsent;
  privateIntakeByPartyId: Record<string, PrivateIntakeThread>;
  sharedDialogue: SharedDialogueThread;
  jointRoom: JointMediationRoom;
  resolution?: string;
}

export interface CreateCaseInput {
  title: string;
  issue: string;
  parties: Party[];
  consent: CaseConsent;
}

export interface AppendMessageInput {
  caseId: string;
  partyId?: string;
  authorType: MessageAuthorType;
  text: string;
  tags?: string[];
}
