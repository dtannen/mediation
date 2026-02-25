export interface LocalCoachSummaryRequest {
  partyId: string;
  caseId: string;
  privateConversation: string;
}

export interface LocalCoachSummaryResponse {
  summary: string;
  readyForGroupChat: boolean;
}

export interface LocalCoachDraftRequest {
  partyId: string;
  caseId: string;
  intentText: string;
}

export interface LocalCoachDraftResponse {
  suggestedText: string;
  rationale?: string;
}

export interface LocalCoachAdapter {
  summarizePrivateIntake(request: LocalCoachSummaryRequest): Promise<LocalCoachSummaryResponse>;
  createGroupDraft(request: LocalCoachDraftRequest): Promise<LocalCoachDraftResponse>;
}

export interface MediatorOpenRequest {
  caseId: string;
  topic: string;
  approvedCoachSummaries: string[];
}

export interface MediatorTurnRequest {
  caseId: string;
  topic: string;
  groupTranscript: string;
}

export interface MediatorLLMAdapter {
  buildOpeningMessages(request: MediatorOpenRequest): Promise<{ intro: string; guidance: string }>;
  nextFacilitationTurn(request: MediatorTurnRequest): Promise<{ message: string }>;
}

export interface GatewayGroupMessageRequest {
  caseId: string;
  fromPartyId: string;
  payload: string;
  correlationId: string;
}

export interface GatewayGroupMessageAdapter {
  sendGroupMessage(request: GatewayGroupMessageRequest): Promise<void>;
}
