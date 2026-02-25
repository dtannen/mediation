import { randomUUID } from 'node:crypto';

export interface OrchestrationStartInput {
  profileId: string;
  mode?: 'manual' | 'semi_auto' | 'full_auto';
  objective: string;
  initialRemoteMessage?: string;
}

export interface OrchestrationEvent {
  ts: string;
  runId: string;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

interface LocalPromptBridge {
  requestLocalPrompt: (
    profileId: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; frame?: Record<string, unknown>; error?: Record<string, unknown> }>;
}

export interface MediationOrchestratorDeps {
  localBridge: LocalPromptBridge;
  emitOrchestrationEvent?: (event: OrchestrationEvent) => void;
}

interface OrchestrationRun {
  runId: string;
  profileId: string;
  mode: 'manual' | 'semi_auto' | 'full_auto';
  objective: string;
  paused: boolean;
  stopped: boolean;
  awaitingApproval: boolean;
  lastDraft: string;
  history: Array<{ role: 'local_agent' | 'remote_agent'; text: string }>;
  createdAt: number;
  updatedAt: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export default function createMediationOrchestrator(deps: MediationOrchestratorDeps) {
  const runs = new Map<string, OrchestrationRun>();

  function emit(run: OrchestrationRun, type: string, message?: string, data?: Record<string, unknown>): void {
    deps.emitOrchestrationEvent?.({
      ts: nowIso(),
      runId: run.runId,
      type,
      ...(message ? { message } : {}),
      ...(data ? { data } : {}),
    });
  }

  function toPublicRun(run: OrchestrationRun): Record<string, unknown> {
    return {
      runId: run.runId,
      profileId: run.profileId,
      mode: run.mode,
      objective: run.objective,
      paused: run.paused,
      stopped: run.stopped,
      awaitingApproval: run.awaitingApproval,
      lastDraft: run.lastDraft,
      history: run.history,
      createdAt: new Date(run.createdAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
    };
  }

  async function start(input: Partial<OrchestrationStartInput>): Promise<Record<string, unknown>> {
    const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : '';
    const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
    if (!profileId) {
      return { ok: false, error: { code: 'invalid_profile_id', message: 'profileId is required', recoverable: true } };
    }
    if (!objective) {
      return { ok: false, error: { code: 'invalid_objective', message: 'objective is required', recoverable: true } };
    }

    const mode = input.mode === 'manual' || input.mode === 'semi_auto' || input.mode === 'full_auto'
      ? input.mode
      : 'manual';

    const run: OrchestrationRun = {
      runId: `orch_${randomUUID()}`,
      profileId,
      mode,
      objective,
      paused: false,
      stopped: false,
      awaitingApproval: mode !== 'full_auto',
      lastDraft: '',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (typeof input.initialRemoteMessage === 'string' && input.initialRemoteMessage.trim()) {
      run.history.push({ role: 'remote_agent', text: input.initialRemoteMessage.trim() });
    }

    runs.set(run.runId, run);
    emit(run, 'started', 'orchestration started');

    if (run.history.length > 0) {
      await requestDraft(run, run.history[run.history.length - 1].text);
    }

    return { ok: true, run: toPublicRun(run) };
  }

  async function requestDraft(run: OrchestrationRun, remoteMessage: string): Promise<void> {
    if (run.stopped || run.paused) {
      return;
    }

    const payload = {
      type: 'desktop.local_prompt.request',
      request_id: `req_${randomUUID()}`,
      profile_id: run.profileId,
      mode: run.mode,
      objective: run.objective,
      remote_message: remoteMessage,
      history: run.history,
      constraints: {
        max_output_chars: 12000,
        allow_tool_use: false,
        max_history_turns: 6,
        max_history_chars: 24000,
      },
    };

    const result = await deps.localBridge.requestLocalPrompt(run.profileId, payload, 90_000);
    run.updatedAt = Date.now();

    if (!result.ok) {
      emit(run, 'draft_error', String(result.error?.message || 'local prompt failed'));
      return;
    }

    const frame = result.frame || {};
    if (frame.status === 'error') {
      emit(run, 'draft_error', String(frame.reason || 'local prompt failed'));
      return;
    }

    const draft = typeof frame.draft_message === 'string' ? frame.draft_message.trim() : '';
    run.lastDraft = draft;
    run.awaitingApproval = run.mode !== 'full_auto';

    emit(run, 'draft_ready', undefined, {
      draft,
      awaitingApproval: run.awaitingApproval,
    });
  }

  async function approveSend(input: { runId?: string; message?: string }): Promise<Record<string, unknown>> {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    const run = runs.get(runId);
    if (!run) {
      return { ok: false, error: { code: 'run_not_found', message: `run '${runId}' was not found`, recoverable: true } };
    }
    if (run.stopped) {
      return { ok: false, error: { code: 'run_stopped', message: 'run has already stopped', recoverable: false } };
    }

    const outgoing = typeof input.message === 'string' && input.message.trim()
      ? input.message.trim()
      : run.lastDraft;

    if (!outgoing) {
      return { ok: false, error: { code: 'empty_message', message: 'no message available to send', recoverable: true } };
    }

    run.history.push({ role: 'local_agent', text: outgoing });
    run.awaitingApproval = false;
    run.updatedAt = Date.now();

    emit(run, 'sent', undefined, { message: outgoing });

    return { ok: true, run: toPublicRun(run) };
  }

  async function pause(input: { runId?: string }): Promise<Record<string, unknown>> {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    const run = runs.get(runId);
    if (!run) {
      return { ok: false, error: { code: 'run_not_found', message: `run '${runId}' was not found`, recoverable: true } };
    }
    if (run.stopped) {
      return { ok: false, error: { code: 'run_stopped', message: 'run has already stopped', recoverable: false } };
    }

    run.paused = true;
    run.updatedAt = Date.now();
    emit(run, 'paused');

    return { ok: true, run: toPublicRun(run) };
  }

  async function resume(input: { runId?: string }): Promise<Record<string, unknown>> {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    const run = runs.get(runId);
    if (!run) {
      return { ok: false, error: { code: 'run_not_found', message: `run '${runId}' was not found`, recoverable: true } };
    }
    if (run.stopped) {
      return { ok: false, error: { code: 'run_stopped', message: 'run has already stopped', recoverable: false } };
    }

    run.paused = false;
    run.updatedAt = Date.now();
    emit(run, 'resumed');

    return { ok: true, run: toPublicRun(run) };
  }

  async function stop(input: { runId?: string; reason?: string }): Promise<Record<string, unknown>> {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
    const run = runs.get(runId);
    if (!run) {
      return { ok: false, error: { code: 'run_not_found', message: `run '${runId}' was not found`, recoverable: true } };
    }

    run.stopped = true;
    run.paused = false;
    run.updatedAt = Date.now();

    emit(run, 'stopped', input.reason || 'stopped by user');

    return { ok: true, run: toPublicRun(run) };
  }

  function status(input: { runId?: string } = {}): Record<string, unknown> {
    if (input.runId) {
      const run = runs.get(input.runId);
      if (!run) {
        return { ok: false, error: { code: 'run_not_found', message: `run '${input.runId}' was not found`, recoverable: true } };
      }
      return { ok: true, run: toPublicRun(run) };
    }

    return {
      ok: true,
      runs: Array.from(runs.values()).map((run) => toPublicRun(run)),
    };
  }

  async function onRemoteChatEvent(payload: Record<string, unknown>): Promise<void> {
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!runId || !message) {
      return;
    }

    const run = runs.get(runId);
    if (!run || run.stopped) {
      return;
    }

    run.history.push({ role: 'remote_agent', text: message });
    run.updatedAt = Date.now();
    emit(run, 'remote_message', undefined, { message });

    if (!run.paused) {
      await requestDraft(run, message);
    }
  }

  return {
    start,
    approveSend,
    pause,
    resume,
    stop,
    status,
    onRemoteChatEvent,
  };
}
