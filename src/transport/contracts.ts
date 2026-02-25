export interface LocalPartyLLMRequest {
  partyId: string;
  caseId: string;
  prompt: string;
}

export interface LocalPartyLLMResponse {
  summary: string;
  readyForCrossDialogue: boolean;
}

export interface LocalPartyLLMAdapter {
  runPrivateIntake(request: LocalPartyLLMRequest): Promise<LocalPartyLLMResponse>;
}

export interface GatewayDialogueRequest {
  caseId: string;
  fromPartyId: string;
  toPartyId: string;
  payload: string;
}

export interface GatewayDialogueAdapter {
  sendAgentDialogue(request: GatewayDialogueRequest): Promise<void>;
}

export interface MediatorLLMRequest {
  caseId: string;
  objective: string;
  sharedContext: string;
}

export interface MediatorLLMAdapter {
  openJointRoom(request: MediatorLLMRequest): Promise<{ openingMessage: string }>;
}
