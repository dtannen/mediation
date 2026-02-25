import { spawn } from 'node:child_process';
import type { ProviderRunInput, ProviderRunResult } from './provider';

type ClaudeQueryOptions = {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  resume?: string;
  permissionMode?: 'bypassPermissions' | 'dontAsk';
  allowDangerouslySkipPermissions?: boolean;
  tools?: string[];
  mcpServers?: Record<string, unknown>;
  spawnClaudeCodeProcess?: (input: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    signal?: AbortSignal;
  }) => {
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    kill: (signal?: NodeJS.Signals | number) => void;
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    once: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    readonly killed?: boolean;
    readonly exitCode?: number | null;
  };
};

type ClaudeStreamMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{ type?: string; text?: string }> | string;
  };
  result?: string;
  total_cost_usd?: number;
  model?: string;
};

type ClaudeQuery = (input: {
  prompt: string;
  options?: ClaudeQueryOptions;
}) => AsyncIterable<unknown>;

let queryPromise: Promise<ClaudeQuery> | null = null;

function dynamicImport(specifier: string): Promise<Record<string, unknown>> {
  const fn = Function('s', 'return import(s)') as (s: string) => Promise<Record<string, unknown>>;
  return fn(specifier);
}

async function loadClaudeQuery(): Promise<ClaudeQuery> {
  if (!queryPromise) {
    queryPromise = dynamicImport('@anthropic-ai/claude-agent-sdk').then((mod) => {
      const query = mod.query;
      if (typeof query !== 'function') {
        throw new Error('claude_sdk_query_unavailable');
      }
      return query as ClaudeQuery;
    });
  }
  return queryPromise;
}

function normalizeModelForSdk(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return 'sonnet';
  }

  if (normalized === 'sonnet' || normalized === 'opus' || normalized === 'haiku' || normalized === 'inherit') {
    return normalized;
  }

  if (normalized.startsWith('claude-sonnet')) {
    return 'sonnet';
  }
  if (normalized.startsWith('claude-opus')) {
    return 'opus';
  }
  if (normalized.startsWith('claude-haiku')) {
    return 'haiku';
  }

  return model;
}

function resolveClaudeRuntimeCommand(defaultCommand: string): {
  command: string;
  forceElectronNodeMode: boolean;
} {
  if (defaultCommand !== 'node') {
    return { command: defaultCommand, forceElectronNodeMode: false };
  }

  const execPath = process.execPath;
  if (!execPath || typeof execPath !== 'string') {
    return { command: defaultCommand, forceElectronNodeMode: false };
  }

  return {
    command: execPath,
    forceElectronNodeMode: Boolean(process.versions?.electron),
  };
}

function extractAssistantText(message: ClaudeStreamMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const chunks: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text);
    }
  }
  return chunks.join('');
}

function buildQueryOptions(input: ProviderRunInput): ClaudeQueryOptions {
  const options: ClaudeQueryOptions = {
    cwd: input.cwd,
    model: normalizeModelForSdk(input.model),
    maxTurns: input.maxTurns ?? 40,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const resolved = resolveClaudeRuntimeCommand(command);
      const childEnv = { ...env };
      if (resolved.forceElectronNodeMode) {
        childEnv.ELECTRON_RUN_AS_NODE = '1';
      }

      const child = spawn(resolved.command, args, {
        cwd,
        env: childEnv,
        signal,
        stdio: ['pipe', 'pipe', env.DEBUG_CLAUDE_AGENT_SDK ? 'pipe' : 'ignore'],
        windowsHide: true,
      });

      if (!child.stdin || !child.stdout) {
        throw new Error('Failed to spawn Claude runtime with piped stdio');
      }

      return {
        stdin: child.stdin,
        stdout: child.stdout,
        kill: child.kill.bind(child),
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off?.bind(child),
        get killed() {
          return child.killed;
        },
        get exitCode() {
          return child.exitCode;
        },
      };
    },
  };

  if (input.resumeSessionId) {
    options.resume = input.resumeSessionId;
  }

  if (input.allowToolUse === false) {
    options.permissionMode = 'dontAsk';
    options.allowDangerouslySkipPermissions = false;
    options.tools = [];
    options.mcpServers = {};
  } else {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
    if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
      options.mcpServers = input.mcpServers as unknown as Record<string, unknown>;
    }
  }

  return options;
}

export async function runClaudeSdkPrompt(input: ProviderRunInput): Promise<ProviderRunResult> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return {
      result: '',
      turns: 1,
      costUsd: 0,
      model: input.model,
      sessionId: input.resumeSessionId,
    };
  }

  const query = await loadClaudeQuery();
  const options = buildQueryOptions(input);

  let turns = 0;
  let latestAssistant = '';
  let finalResult = '';
  let costUsd = 0;
  let detectedModel: string | undefined;
  let detectedSessionId: string | undefined;

  for await (const raw of query({ prompt: input.prompt, options })) {
    const message = raw as ClaudeStreamMessage;

    if (typeof message.session_id === 'string' && message.session_id.trim()) {
      detectedSessionId = message.session_id.trim();
    }

    if (message.type === 'assistant') {
      turns += 1;
      const text = extractAssistantText(message).trim();
      if (text) {
        latestAssistant = text;
      }
      continue;
    }

    if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
      detectedModel = message.model;
      continue;
    }

    if (message.type === 'result') {
      if (typeof message.result === 'string' && message.result.trim()) {
        finalResult = message.result;
      }
      if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd)) {
        costUsd = message.total_cost_usd;
      }
      break;
    }
  }

  if (!finalResult) {
    finalResult = latestAssistant;
  }

  return {
    result: finalResult,
    turns,
    costUsd,
    model: detectedModel || input.model,
    sessionId: detectedSessionId || input.resumeSessionId,
  };
}

