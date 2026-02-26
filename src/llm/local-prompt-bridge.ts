import { createInterface } from 'node:readline';
import { resolveProvider, buildProviderInput, buildProviderConfig } from './provider-registry';
import type { ProviderRunResult } from './provider';
import type { AgentMcpServers, AgentPolicy } from './provider';

const REQUEST_TYPE = 'desktop.local_prompt.request';
const RESPONSE_TYPE = 'desktop.local_prompt.response';
const DEFAULT_HISTORY_TURNS = 6;
const DEFAULT_HISTORY_CHARS = 24_000;
const DEFAULT_OUTPUT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 3_600_000;
const FORCE_RELEASE_CEILING_MS = 4_320_000;
const DEFAULT_TOOL_ROUNDS = 3;

type BridgeMode = 'manual' | 'semi_auto' | 'full_auto';
type BridgeHistoryRole = 'local_agent' | 'remote_agent';

interface LocalPromptHistoryEntry {
  role: BridgeHistoryRole;
  text: string;
}

interface LocalPromptConstraints {
  max_output_chars: number;
  allow_tool_use: boolean;
  max_history_turns: number;
  max_history_chars: number;
  max_tool_rounds: number;
  local_turn_timeout_ms: number;
}

export interface LocalPromptRequestFrame {
  type: typeof REQUEST_TYPE;
  request_id: string;
  profile_id?: string;
  session_id?: string;
  resume_session_id?: string;
  turn_index?: number;
  mode?: BridgeMode;
  objective?: string;
  remote_message?: string;
  text?: string;
  history?: Array<Partial<LocalPromptHistoryEntry>>;
  history_summary?: string;
  constraints?: Partial<LocalPromptConstraints>;
  correlation_id?: string;
  probe?: boolean;
}

export interface LocalPromptResponseFrame {
  type: typeof RESPONSE_TYPE;
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

export interface LocalPromptBridgeOptions {
  profileId: string;
  defaultCwd: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  mcpServers?: AgentMcpServers;
  policy?: AgentPolicy;
  ollamaBaseUrl?: string;
}

function emitResponse(frame: LocalPromptResponseFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function normalizeText(input: unknown, fallback = ''): string {
  if (typeof input !== 'string') {
    return fallback;
  }
  return input.trim();
}

function normalizeMode(mode: unknown): BridgeMode {
  const normalized = normalizeText(mode);
  if (normalized === 'manual' || normalized === 'semi_auto' || normalized === 'full_auto') {
    return normalized;
  }
  return 'manual';
}

function normalizeConstraints(raw: unknown): LocalPromptConstraints {
  const record = (raw && typeof raw === 'object') ? raw as Partial<LocalPromptConstraints> : {};
  const allowToolUse = record.allow_tool_use === true;

  return {
    max_output_chars: clampInteger(record.max_output_chars, 64, 200_000, DEFAULT_OUTPUT_CHARS),
    allow_tool_use: allowToolUse,
    max_history_turns: clampInteger(record.max_history_turns, 0, 100, DEFAULT_HISTORY_TURNS),
    max_history_chars: clampInteger(record.max_history_chars, 0, 200_000, DEFAULT_HISTORY_CHARS),
    max_tool_rounds: clampInteger(record.max_tool_rounds, 1, 500, DEFAULT_TOOL_ROUNDS),
    local_turn_timeout_ms: clampInteger(
      record.local_turn_timeout_ms,
      1_000,
      allowToolUse ? TOOL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      allowToolUse ? TOOL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    ),
  };
}

function truncateChars(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

function normalizeHistory(
  input: unknown,
  constraints: LocalPromptConstraints,
): LocalPromptHistoryEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const normalized: LocalPromptHistoryEntry[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const role = normalizeText((entry as { role?: unknown }).role);
    const text = normalizeText((entry as { text?: unknown }).text);

    if (!text) {
      continue;
    }
    if (role !== 'local_agent' && role !== 'remote_agent') {
      continue;
    }

    normalized.push({ role, text });
  }

  const limitedTurns = constraints.max_history_turns > 0
    ? normalized.slice(-constraints.max_history_turns)
    : [];

  if (constraints.max_history_chars <= 0) {
    return [];
  }

  const bounded: LocalPromptHistoryEntry[] = [];
  let used = 0;

  for (let i = limitedTurns.length - 1; i >= 0; i -= 1) {
    const entry = limitedTurns[i];
    const remaining = constraints.max_history_chars - used;
    if (remaining <= 0) {
      break;
    }
    const boundedText = truncateChars(entry.text, remaining);
    if (!boundedText) {
      continue;
    }
    bounded.unshift({ role: entry.role, text: boundedText });
    used += boundedText.length;
  }

  return bounded;
}

function buildLocalPrompt(
  request: LocalPromptRequestFrame,
  constraints: LocalPromptConstraints,
): string {
  if (constraints.allow_tool_use) {
    const directMessage = normalizeText(request.text) || normalizeText(request.remote_message);
    if (directMessage) {
      return directMessage;
    }
  }

  const objective = normalizeText(request.objective, 'No objective provided.');
  const mode = normalizeMode(request.mode);
  const remoteMessage = normalizeText(request.remote_message) || normalizeText(request.text);
  const historySummary = normalizeText(request.history_summary);
  const history = normalizeHistory(request.history, constraints);
  const turnIndex = clampInteger(request.turn_index, 0, 10_000, 0);

  const lines: string[] = [];
  lines.push('You are drafting the next outbound message to a remote shared agent.');
  lines.push('Write only the message content that should be sent next.');
  lines.push('Do not add preamble, analysis, XML, JSON, or markdown wrappers.');
  lines.push('');
  lines.push(`Objective: ${objective}`);
  lines.push(`Mode: ${mode}`);
  lines.push(`Turn Index: ${turnIndex}`);
  lines.push(`Max Output Chars: ${constraints.max_output_chars}`);
  lines.push('Do not use tools. Respond directly from available context.');
  lines.push('');

  if (historySummary) {
    lines.push('Earlier Context Summary:');
    lines.push(historySummary);
    lines.push('');
  }

  if (history.length > 0) {
    lines.push('Recent Conversation History:');
    for (const item of history) {
      lines.push(`[${item.role}] ${item.text}`);
    }
    lines.push('');
  }

  if (remoteMessage) {
    lines.push('Latest Remote Agent Message:');
    lines.push(remoteMessage);
    lines.push('');
  }

  lines.push('Now draft the next outbound message.');
  return lines.join('\n').trim();
}

async function runLocalDraft(
  request: LocalPromptRequestFrame,
  constraints: LocalPromptConstraints,
  options: LocalPromptBridgeOptions,
): Promise<ProviderRunResult> {
  const prompt = buildLocalPrompt(request, constraints);
  const providerName = options.provider || 'claude';
  const plugin = resolveProvider(providerName);
  const resumeSessionId = normalizeText(request.resume_session_id);

  const maxTurns = constraints.allow_tool_use
    ? Math.max(1, constraints.max_tool_rounds + 1)
    : 1;

  const providerConfig = buildProviderConfig(providerName);
  if (options.ollamaBaseUrl) {
    providerConfig.OLLAMA_BASE_URL = options.ollamaBaseUrl;
  }

  const invokeProvider = async (resumeSession?: string): Promise<ProviderRunResult> => {
    return plugin.runPrompt(buildProviderInput(plugin, {
      prompt,
      cwd: options.defaultCwd,
      model: options.model,
      systemPrompt: options.systemPrompt,
      maxTurns,
      allowToolUse: constraints.allow_tool_use,
      resumeSessionId: resumeSession,
      mcpServers: constraints.allow_tool_use ? options.mcpServers : undefined,
      policy: options.policy,
      providerConfig,
    }));
  };

  try {
    return await invokeProvider(resumeSessionId || undefined);
  } catch (err) {
    if (!resumeSessionId) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(message || 'provider session resume failed') as Error & { code?: string };
    wrapped.code = 'provider_session_invalid';
    throw wrapped;
  }
}

function buildResponseFrame(input: {
  requestId: string;
  status: 'ok' | 'error';
  startedAt: number;
  correlationId?: string;
  providerSessionId?: string;
  draftMessage?: string;
  reason?: string;
  code?: string;
  metrics?: Partial<LocalPromptResponseFrame['metrics']>;
}): LocalPromptResponseFrame {
  return {
    type: RESPONSE_TYPE,
    request_id: input.requestId,
    status: input.status,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(input.providerSessionId ? { provider_session_id: input.providerSessionId } : {}),
    ...(input.draftMessage ? { draft_message: input.draftMessage } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.code ? { code: input.code } : {}),
    metrics: {
      latency_ms: Math.max(0, Date.now() - input.startedAt),
      ...(typeof input.metrics?.turns === 'number' ? { turns: input.metrics.turns } : {}),
      ...(typeof input.metrics?.cost_usd === 'number' ? { cost_usd: input.metrics.cost_usd } : {}),
      ...(typeof input.metrics?.model === 'string' && input.metrics.model.trim()
        ? { model: input.metrics.model.trim() }
        : {}),
    },
  };
}

export async function executeLocalPromptRequest(
  request: LocalPromptRequestFrame,
  options: LocalPromptBridgeOptions,
): Promise<LocalPromptResponseFrame> {
  const startedAt = Date.now();
  const requestId = normalizeText(request.request_id);
  if (!requestId) {
    return buildResponseFrame({
      requestId: '',
      status: 'error',
      startedAt,
      reason: 'request_id is required',
      code: 'invalid_request',
    });
  }

  const requestProfileId = normalizeText(request.profile_id);
  if (requestProfileId && requestProfileId !== options.profileId) {
    return buildResponseFrame({
      requestId,
      status: 'error',
      startedAt,
      reason: `profile mismatch (expected ${options.profileId}, got ${requestProfileId})`,
      code: 'profile_mismatch',
    });
  }

  const correlationId = normalizeText(request.correlation_id);
  if (request.probe) {
    return buildResponseFrame({
      requestId,
      status: 'ok',
      startedAt,
      correlationId,
    });
  }

  const constraints = normalizeConstraints(request.constraints);
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    const timeoutPromise = new Promise<ProviderRunResult>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error(`local prompt timeout after ${constraints.local_turn_timeout_ms}ms`) as Error & { code?: string };
        err.code = 'local_prompt_timeout';
        reject(err);
      }, constraints.local_turn_timeout_ms);
      if (typeof timeoutId.unref === 'function') {
        timeoutId.unref();
      }
    });

    const result = await Promise.race([
      runLocalDraft(request, constraints, options),
      timeoutPromise,
    ]);

    const resultText = truncateChars(result.result || '', constraints.max_output_chars);
    if (!resultText.trim()) {
      return buildResponseFrame({
        requestId,
        status: 'error',
        startedAt,
        correlationId,
        reason: 'local prompt produced empty draft message',
        code: 'local_prompt_empty',
      });
    }

    return buildResponseFrame({
      requestId,
      status: 'ok',
      startedAt,
      correlationId,
      providerSessionId: result.sessionId,
      draftMessage: resultText,
      metrics: {
        turns: result.turns,
        cost_usd: result.costUsd,
        model: result.model,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (
      err
      && typeof err === 'object'
      && typeof (err as { code?: unknown }).code === 'string'
      && (err as { code?: string }).code?.trim()
    )
      ? (err as { code: string }).code.trim()
      : 'local_prompt_failed';

    return buildResponseFrame({
      requestId,
      status: 'error',
      startedAt,
      correlationId,
      reason: message || 'local prompt execution failed',
      code,
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function startLocalPromptBridge(options: LocalPromptBridgeOptions): () => void {
  const input = process.stdin;
  if (!input) {
    return () => {};
  }

  input.setEncoding('utf8');
  input.resume();

  const rl = createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false,
  });

  let closed = false;
  let inFlightRequestId = '';

  const handleRequest = (request: LocalPromptRequestFrame): void => {
    const requestId = normalizeText(request.request_id);
    if (!requestId) {
      return;
    }

    const requestProfileId = normalizeText(request.profile_id);
    if (requestProfileId && requestProfileId !== options.profileId) {
      emitResponse({
        type: RESPONSE_TYPE,
        request_id: requestId,
        status: 'error',
        reason: `profile mismatch (expected ${options.profileId}, got ${requestProfileId})`,
        code: 'profile_mismatch',
        metrics: { latency_ms: 0 },
      });
      return;
    }

    const correlationId = normalizeText(request.correlation_id);

    if (request.probe) {
      emitResponse({
        type: RESPONSE_TYPE,
        request_id: requestId,
        status: 'ok',
        ...(correlationId ? { correlation_id: correlationId } : {}),
        metrics: { latency_ms: 0 },
      });
      return;
    }

    if (inFlightRequestId) {
      emitResponse({
        type: RESPONSE_TYPE,
        request_id: requestId,
        status: 'error',
        ...(correlationId ? { correlation_id: correlationId } : {}),
        reason: 'local prompt request already in progress',
        code: 'orchestration_busy',
        metrics: { latency_ms: 0 },
      });
      return;
    }

    inFlightRequestId = requestId;
    const constraints = normalizeConstraints(request.constraints);
    const started = Date.now();
    let responded = false;
    let released = false;

    const releaseInFlight = (): void => {
      if (released) {
        return;
      }
      released = true;
      if (inFlightRequestId === requestId) {
        inFlightRequestId = '';
      }
    };

    const emitFrame = (
      frame: Omit<LocalPromptResponseFrame, 'type' | 'request_id' | 'metrics'> & {
        metrics?: Partial<LocalPromptResponseFrame['metrics']>;
      },
    ): boolean => {
      if (responded || closed) {
        return false;
      }
      responded = true;
      const latencyMs = Math.max(0, Date.now() - started);
      emitResponse({
        type: RESPONSE_TYPE,
        request_id: requestId,
        status: frame.status,
        ...(correlationId ? { correlation_id: correlationId } : {}),
        ...(frame.draft_message ? { draft_message: frame.draft_message } : {}),
        ...(frame.provider_session_id ? { provider_session_id: frame.provider_session_id } : {}),
        ...(frame.reason ? { reason: frame.reason } : {}),
        ...(frame.code ? { code: frame.code } : {}),
        metrics: {
          latency_ms: latencyMs,
          ...(typeof frame.metrics?.turns === 'number' ? { turns: frame.metrics.turns } : {}),
          ...(typeof frame.metrics?.cost_usd === 'number' ? { cost_usd: frame.metrics.cost_usd } : {}),
          ...(typeof frame.metrics?.model === 'string' && frame.metrics.model.trim()
            ? { model: frame.metrics.model.trim() }
            : {}),
        },
      });
      return true;
    };

    const settle = (
      frame: Omit<LocalPromptResponseFrame, 'type' | 'request_id' | 'metrics'> & {
        metrics?: Partial<LocalPromptResponseFrame['metrics']>;
      },
      settleOptions: { keepBusy?: boolean } = {},
    ): void => {
      emitFrame(frame);
      if (!settleOptions.keepBusy) {
        releaseInFlight();
      }
    };

    const timeout = setTimeout(() => {
      settle({
        status: 'error',
        reason: `local prompt timeout after ${constraints.local_turn_timeout_ms}ms`,
        code: 'local_prompt_timeout',
      }, { keepBusy: true });
    }, constraints.local_turn_timeout_ms);
    if (typeof timeout.unref === 'function') {
      timeout.unref();
    }

    const forceReleaseCeilingMs = Math.max(
      constraints.local_turn_timeout_ms * 2,
      FORCE_RELEASE_CEILING_MS,
    );
    const forceReleaseTimeout = setTimeout(() => {
      releaseInFlight();
    }, forceReleaseCeilingMs);
    if (typeof forceReleaseTimeout.unref === 'function') {
      forceReleaseTimeout.unref();
    }

    void runLocalDraft(request, constraints, options)
      .then((result) => {
        clearTimeout(timeout);
        clearTimeout(forceReleaseTimeout);
        if (responded) {
          releaseInFlight();
          return;
        }

        const resultText = truncateChars(result.result || '', constraints.max_output_chars);
        if (!resultText.trim()) {
          settle({
            status: 'error',
            reason: 'local prompt produced empty draft message',
            code: 'local_prompt_empty',
          });
          return;
        }

        settle({
          status: 'ok',
          ...(result.sessionId ? { provider_session_id: result.sessionId } : {}),
          draft_message: resultText,
          metrics: {
            turns: result.turns,
            cost_usd: result.costUsd,
            model: result.model,
          },
        });
      })
      .catch((err: unknown) => {
        clearTimeout(timeout);
        clearTimeout(forceReleaseTimeout);
        if (responded) {
          releaseInFlight();
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        const code = (
          err
          && typeof err === 'object'
          && typeof (err as { code?: unknown }).code === 'string'
          && (err as { code?: string }).code?.trim()
        )
          ? (err as { code: string }).code.trim()
          : 'local_prompt_failed';

        settle({
          status: 'error',
          reason: message || 'local prompt execution failed',
          code,
        });
      });
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const type = normalizeText((parsed as { type?: unknown }).type);
    if (type !== REQUEST_TYPE) {
      return;
    }

    handleRequest(parsed as LocalPromptRequestFrame);
  });

  rl.on('close', () => {
    closed = true;
  });

  return () => {
    if (closed) {
      return;
    }
    closed = true;
    rl.close();
  };
}
