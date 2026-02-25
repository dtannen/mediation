export interface LocalCoachSummaryRequest {
  partyId: string;
  caseId: string;
  privateConversation: string;
}

export interface LocalCoachSummaryResponse {
  summary: string;
  readyForGroupChat: boolean;
}

export interface LocalCoachConversationTurn {
  author: 'party' | 'party_llm';
  text: string;
}

export interface LocalCoachDraftRequest {
  partyId: string;
  caseId: string;
  conversationTurns: LocalCoachConversationTurn[];
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

export interface GatewaySessionMessageFrame {
  type: 'session.message';
  session_id: string;
  conversation_id: string;
  message_id: string;
  handshake_id: string;
  encrypted: true;
  alg: 'aes-256-gcm';
  direction: 'client_to_agent' | 'agent_to_client';
  seq: number;
  nonce: string;
  ciphertext: string;
  tag: string;
  aad?: string;
}

export interface SessionPlaintextPayload {
  session_id: string;
  conversation_id: string;
  message_id: string;
  prompt: string;
  origin_agent_device_id?: string;
  trace_id?: string;
  orchestrator_profile_id?: string;
  hop_count: number;
}

export interface LocalPromptHistoryEntry {
  role: 'local_agent' | 'remote_agent';
  text: string;
}

export interface LocalPromptConstraints {
  max_output_chars?: number;
  allow_tool_use?: boolean;
  max_history_turns?: number;
  max_history_chars?: number;
  max_tool_rounds?: number;
  local_turn_timeout_ms?: number;
}

export interface LocalPromptRequestFrame {
  type: 'desktop.local_prompt.request';
  request_id: string;
  profile_id?: string;
  session_id?: string;
  resume_session_id?: string;
  turn_index?: number;
  mode?: 'manual' | 'semi_auto' | 'full_auto';
  objective?: string;
  remote_message?: string;
  text?: string;
  history?: LocalPromptHistoryEntry[];
  history_summary?: string;
  correlation_id?: string;
  probe?: boolean;
  constraints?: LocalPromptConstraints;
}

export interface LocalPromptResponseFrame {
  type: 'desktop.local_prompt.response';
  request_id: string;
  status: 'ok' | 'error';
  correlation_id?: string;
  provider_session_id?: string;
  draft_message?: string;
  reason?: string;
  code?: string;
  metrics: {
    latency_ms: number;
    turns?: number;
    cost_usd?: number;
    model?: string;
  };
}
