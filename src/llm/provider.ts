export interface AgentMcpServerConfig {
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type AgentMcpServers = Record<string, AgentMcpServerConfig>;

export interface AgentPolicy {
  mode?: 'block';
  allowNetwork?: boolean;
  maxFileWrites?: number;
}

export interface ProviderRunInput {
  prompt: string;
  cwd: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  allowToolUse?: boolean;
  resumeSessionId?: string;
  mcpServers?: AgentMcpServers;
  policy?: AgentPolicy;
  providerConfig: Record<string, string>;
}

export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsSessionResume: boolean;
  supportsPolicy: boolean;
  /** Default context window size in tokens for the provider's default model (Section 5.2.1) */
  contextWindowTokens?: number;
}

export interface ProviderRunResult {
  result: string;
  turns: number;
  costUsd: number;
  model?: string;
  sessionId?: string;
}

export interface ProviderPlugin {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;
  runPrompt(input: ProviderRunInput): Promise<ProviderRunResult>;
}
