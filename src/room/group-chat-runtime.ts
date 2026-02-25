import {
  DECISION_TYPES,
  ROOM_ERROR,
  ROOM_STATES,
  validateDecision,
  validateRoomConfig,
  parseLimits,
  makeRoomId,
  toRoomError,
  type RoomConfig,
  type RoomResult,
} from './contracts';
import { resolvePlugin } from './plugin-registry';

interface GroupChatRuntimeDeps {
  requestLocalPrompt?: (profileId: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<{ ok: boolean; frame?: Record<string, unknown>; error?: Record<string, unknown> }>;
  sendRemoteMessage?: (deviceId: string, text: string, timeoutMs?: number) => Promise<{ ok: boolean; response?: string; error?: Record<string, unknown> }>;
  emitRoomEvent?: (event: Record<string, unknown>) => void;
  emitRoomMetrics?: (event: Record<string, unknown>) => void;
}

interface FanOutItem {
  targetAgentId: string;
  prompt: string;
}

interface RoomRecord {
  roomId: string;
  config: RoomConfig;
  limits: ReturnType<typeof parseLimits>;
  createdAt: number;
  startedAt: number;
  state: string;
  stopReason: string | null;
  stopSummary: string;
  cycle: number;
  turnIndex: number;
  failures: number;
  userStopRequested: boolean;
  pausedByUser: boolean;
  awaitingApproval: boolean;
  pendingDecision: Record<string, unknown> | null;
  plugin: {
    init?: (ctx: Record<string, unknown>) => unknown;
    onRoomStart?: (ctx: Record<string, unknown>, state: unknown) => { state: unknown; decision: Record<string, unknown> };
    onTurnResult?: (
      ctx: Record<string, unknown>,
      state: unknown,
      turn: { agentId: string; text: string },
    ) => { state: unknown; decision: Record<string, unknown> };
  };
  pluginState: unknown;
  participants: Array<{
    agentId: string;
    displayName: string;
    role: string;
    endpoint: {
      type: 'local' | 'remote';
      profileId?: string;
      deviceId?: string;
    };
  }>;
  timeline: Array<Record<string, unknown>>;
  runPromise: Promise<void> | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function roomPublicSnapshot(room: RoomRecord): Record<string, unknown> {
  return {
    roomId: room.roomId,
    orchestratorType: room.config.orchestratorType,
    state: room.state,
    cycle: room.cycle,
    turnIndex: room.turnIndex,
    failures: room.failures,
    stopReason: room.stopReason,
    stopSummary: room.stopSummary,
    participants: clone(room.participants),
    objective: room.config.objective,
    createdAt: new Date(room.createdAt).toISOString(),
    startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : null,
    timeline: clone(room.timeline.slice(-50)),
  };
}

function normalizeFanOutItems(decision: Record<string, unknown>): FanOutItem[] {
  const out: FanOutItem[] = [];
  const seen = new Set<string>();

  const pushItem = (targetAgentIdInput: unknown, promptInput: unknown): void => {
    const targetAgentId = typeof targetAgentIdInput === 'string' ? targetAgentIdInput.trim() : '';
    const prompt = typeof promptInput === 'string' ? promptInput.trim() : '';
    if (!targetAgentId || !prompt) {
      return;
    }
    const key = `${targetAgentId}::${prompt}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ targetAgentId, prompt });
  };

  const globalPrompt = typeof decision.prompt === 'string' ? decision.prompt : '';

  if (Array.isArray(decision.fanOut)) {
    for (const rawItem of decision.fanOut) {
      if (!rawItem || typeof rawItem !== 'object') {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      pushItem(
        item.targetAgentId ?? item.agentId ?? item.target ?? '',
        item.prompt ?? item.text ?? item.message ?? globalPrompt,
      );
    }
  }

  if (Array.isArray(decision.targetAgentIds)) {
    for (const target of decision.targetAgentIds) {
      pushItem(target, globalPrompt);
    }
  }

  if (Array.isArray(decision.targets)) {
    for (const target of decision.targets) {
      if (typeof target === 'string') {
        pushItem(target, globalPrompt);
        continue;
      }
      if (!target || typeof target !== 'object') {
        continue;
      }
      const item = target as Record<string, unknown>;
      pushItem(
        item.targetAgentId ?? item.agentId ?? item.target ?? '',
        item.prompt ?? item.text ?? item.message ?? globalPrompt,
      );
    }
  }

  if (out.length === 0) {
    pushItem(decision.targetAgentId, decision.prompt);
  }

  return out;
}

export default function createGroupChatRuntime(deps: GroupChatRuntimeDeps) {
  const rooms = new Map<string, RoomRecord>();

  function emitEvent(room: RoomRecord, type: string, extra: Record<string, unknown> = {}): void {
    const payload: Record<string, unknown> = {
      ts: nowIso(),
      type,
      roomId: room.roomId,
      state: room.state,
      cycle: room.cycle,
      turnIndex: room.turnIndex,
      failures: room.failures,
      ...extra,
    };

    room.timeline.push(payload);
    while (room.timeline.length > 250) {
      room.timeline.shift();
    }

    deps.emitRoomEvent?.(payload);
  }

  function shouldStopForLimits(room: RoomRecord): string | null {
    if (room.userStopRequested) {
      return 'user_stop';
    }
    if (room.failures >= room.limits.maxFailures) {
      return 'failure_limit';
    }
    if (Date.now() - room.startedAt >= room.limits.maxDurationMs) {
      return 'duration_limit';
    }
    if (room.turnIndex >= room.limits.maxTurns) {
      return 'turn_limit';
    }
    if (room.cycle >= room.limits.maxCycles) {
      return 'cycle_limit';
    }
    return null;
  }

  function buildPluginContext(room: RoomRecord): Record<string, unknown> {
    return {
      roomId: room.roomId,
      objective: room.config.objective,
      participants: room.participants.map((participant) => ({
        agentId: participant.agentId,
        displayName: participant.displayName,
        role: participant.role,
      })),
      cycle: room.cycle,
      turnIndex: room.turnIndex,
      mode: room.config.mode,
    };
  }

  function applyTurnSuccess(
    room: RoomRecord,
    turn: { agentId: string; text: string },
    extra: Record<string, unknown> = {},
  ): void {
    room.turnIndex += 1;
    room.cycle = Math.max(room.cycle, Math.floor(room.turnIndex / Math.max(1, room.participants.length)));
    room.failures = 0;

    emitEvent(room, 'turn_completed', {
      agentId: turn.agentId,
      text: turn.text,
      ...extra,
    });

    deps.emitRoomMetrics?.({
      ts: nowIso(),
      roomId: room.roomId,
      turns: room.turnIndex,
      failures: room.failures,
    });
  }

  async function performSpeakDecision(
    room: RoomRecord,
    decision: Record<string, unknown>,
  ): Promise<{ ok: boolean; agentId?: string; text?: string; error?: string }> {
    const targetAgentId = typeof decision.targetAgentId === 'string' ? decision.targetAgentId : '';
    const prompt = typeof decision.prompt === 'string' ? decision.prompt : '';

    if (!targetAgentId || !prompt.trim()) {
      return { ok: false, error: 'invalid speak decision: missing targetAgentId or prompt' };
    }

    const participant = room.participants.find((p) => p.agentId === targetAgentId);
    if (!participant) {
      return { ok: false, error: `unknown target agent: ${targetAgentId}` };
    }

    const timeoutMs = room.limits.agentTimeoutMs;

    if (participant.endpoint.type === 'local') {
      if (!participant.endpoint.profileId || !deps.requestLocalPrompt) {
        return { ok: false, error: 'local prompt bridge unavailable' };
      }

      const result = await deps.requestLocalPrompt(participant.endpoint.profileId, {
        text: prompt,
        constraints: {
          allow_tool_use: false,
          local_turn_timeout_ms: timeoutMs,
        },
      }, timeoutMs);

      if (!result.ok) {
        return { ok: false, error: String(result.error?.message || 'local prompt failed') };
      }

      const frame = result.frame || {};
      if (frame.status === 'error') {
        return { ok: false, error: String(frame.reason || 'local prompt error') };
      }

      const text = typeof frame.draft_message === 'string' ? frame.draft_message.trim() : '';
      if (!text) {
        return { ok: false, error: 'local prompt returned empty response' };
      }

      return {
        ok: true,
        agentId: participant.agentId,
        text,
      };
    }

    if (participant.endpoint.type === 'remote') {
      if (!participant.endpoint.deviceId || !deps.sendRemoteMessage) {
        return { ok: false, error: 'remote transport unavailable' };
      }

      const result = await deps.sendRemoteMessage(participant.endpoint.deviceId, prompt, timeoutMs);
      if (!result.ok) {
        return { ok: false, error: String(result.error?.message || 'remote message failed') };
      }

      const text = typeof result.response === 'string' ? result.response.trim() : '';
      if (!text) {
        return { ok: false, error: 'remote agent returned empty response' };
      }

      return {
        ok: true,
        agentId: participant.agentId,
        text,
      };
    }

    return { ok: false, error: 'unsupported endpoint type' };
  }

  async function runRoomLoop(room: RoomRecord): Promise<void> {
    room.state = ROOM_STATES.RUNNING;
    room.startedAt = Date.now();

    const context = buildPluginContext(room);
    if (typeof room.plugin.init === 'function') {
      room.pluginState = room.plugin.init(context);
    }

    emitEvent(room, 'room_started');

    if (!room.plugin.onRoomStart) {
      room.state = ROOM_STATES.STOPPED;
      room.stopReason = 'plugin_stop';
      room.stopSummary = 'plugin does not implement onRoomStart';
      emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
      return;
    }

    let decisionBundle = room.plugin.onRoomStart(buildPluginContext(room), room.pluginState);
    room.pluginState = decisionBundle.state;
    let decision = decisionBundle.decision;

    while (room.state === ROOM_STATES.RUNNING) {
      const limitStop = shouldStopForLimits(room);
      if (limitStop) {
        room.state = ROOM_STATES.STOPPED;
        room.stopReason = limitStop;
        room.stopSummary = `room stopped due to ${limitStop}`;
        emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
        break;
      }

      const decisionValidation = validateDecision(decision);
      if (!decisionValidation.ok) {
        room.failures += 1;
        emitEvent(room, 'decision_invalid', { error: decisionValidation.error.message });
        room.state = ROOM_STATES.STOPPED;
        room.stopReason = 'plugin_stop';
        room.stopSummary = decisionValidation.error.message;
        emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
        break;
      }

      if (decision.type === DECISION_TYPES.PAUSE) {
        room.state = ROOM_STATES.PAUSED;
        room.pendingDecision = decision;
        room.awaitingApproval = true;
        emitEvent(room, 'room_paused', { reason: decision.reason || 'plugin_pause' });
        break;
      }

      if (decision.type === DECISION_TYPES.STOP) {
        room.state = ROOM_STATES.STOPPED;
        room.stopReason = 'plugin_stop';
        room.stopSummary = typeof decision.reason === 'string' ? decision.reason : 'plugin requested stop';
        emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
        break;
      }

      if (decision.type === DECISION_TYPES.FAN_OUT) {
        const fanOutItems = normalizeFanOutItems(decision);
        if (fanOutItems.length === 0) {
          room.failures += 1;
          emitEvent(room, 'decision_invalid', { error: 'invalid fan_out decision: no targets or prompts' });
          room.state = ROOM_STATES.STOPPED;
          room.stopReason = 'plugin_stop';
          room.stopSummary = 'invalid fan_out decision: no targets or prompts';
          emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
          break;
        }

        emitEvent(room, 'fan_out_start', { count: fanOutItems.length });

        let completed = 0;
        let failed = 0;
        let nextDecision: Record<string, unknown> | null = null;

        for (const item of fanOutItems) {
          const speakResult = await performSpeakDecision(room, {
            type: DECISION_TYPES.SPEAK,
            targetAgentId: item.targetAgentId,
            prompt: item.prompt,
          });

          if (!speakResult.ok || !speakResult.agentId || !speakResult.text) {
            failed += 1;
            room.failures += 1;
            emitEvent(room, 'turn_failed', {
              fanOut: true,
              error: speakResult.error || 'unknown error',
              targetAgentId: item.targetAgentId,
            });

            if (room.failures >= room.limits.maxFailures) {
              room.state = ROOM_STATES.STOPPED;
              room.stopReason = 'failure_limit';
              room.stopSummary = speakResult.error || 'maximum failures reached';
              emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
              break;
            }
            continue;
          }

          completed += 1;
          applyTurnSuccess(
            room,
            {
              agentId: speakResult.agentId,
              text: speakResult.text,
            },
            { fanOut: true },
          );

          if (!room.plugin.onTurnResult) {
            room.state = ROOM_STATES.STOPPED;
            room.stopReason = 'plugin_stop';
            room.stopSummary = 'plugin does not implement onTurnResult';
            emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
            break;
          }

          const decisionBundle = room.plugin.onTurnResult(
            buildPluginContext(room),
            room.pluginState,
            {
              agentId: speakResult.agentId,
              text: speakResult.text,
            },
          );
          room.pluginState = decisionBundle.state;
          nextDecision = decisionBundle.decision;
        }

        emitEvent(room, 'fan_out_complete', {
          requested: fanOutItems.length,
          completed,
          failed,
        });

        if (room.state !== ROOM_STATES.RUNNING) {
          break;
        }

        if (!nextDecision) {
          room.state = ROOM_STATES.STOPPED;
          room.stopReason = 'plugin_stop';
          room.stopSummary = 'fan_out completed without next decision';
          emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
          break;
        }

        decision = nextDecision;
        continue;
      }

      const speakResult = await performSpeakDecision(room, decision);
      if (!speakResult.ok || !speakResult.agentId || !speakResult.text) {
        room.failures += 1;
        emitEvent(room, 'turn_failed', {
          error: speakResult.error || 'unknown error',
          targetAgentId: decision.targetAgentId,
        });

        if (room.failures >= room.limits.maxFailures) {
          room.state = ROOM_STATES.STOPPED;
          room.stopReason = 'failure_limit';
          room.stopSummary = speakResult.error || 'maximum failures reached';
          emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
          break;
        }

        continue;
      }

      applyTurnSuccess(room, {
        agentId: speakResult.agentId,
        text: speakResult.text,
      });

      if (!room.plugin.onTurnResult) {
        room.state = ROOM_STATES.STOPPED;
        room.stopReason = 'plugin_stop';
        room.stopSummary = 'plugin does not implement onTurnResult';
        emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
        break;
      }

      decisionBundle = room.plugin.onTurnResult(
        buildPluginContext(room),
        room.pluginState,
        { agentId: speakResult.agentId, text: speakResult.text },
      );
      room.pluginState = decisionBundle.state;
      decision = decisionBundle.decision;
    }
  }

  async function createRoom(configInput: unknown, options: { background?: boolean } = {}): Promise<RoomResult<{ room: Record<string, unknown> }>> {
    const validation = validateRoomConfig(configInput);
    if (!validation.ok) {
      return { ok: false, error: validation.error };
    }

    const config = validation.config;
    let resolved: { plugin: unknown };
    try {
      resolved = resolvePlugin(config.orchestratorType);
    } catch (err) {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, err instanceof Error ? err.message : String(err)),
      };
    }

    const roomId = makeRoomId();
    const room: RoomRecord = {
      roomId,
      config,
      limits: parseLimits(config.limits),
      createdAt: Date.now(),
      startedAt: 0,
      state: ROOM_STATES.CREATED,
      stopReason: null,
      stopSummary: '',
      cycle: 0,
      turnIndex: 0,
      failures: 0,
      userStopRequested: false,
      pausedByUser: false,
      awaitingApproval: false,
      pendingDecision: null,
      plugin: resolved.plugin as RoomRecord['plugin'],
      pluginState: null,
      participants: config.agents.map((agent) => ({
        agentId: agent.agentId,
        displayName: agent.displayName,
        role: agent.role,
        endpoint: {
          type: agent.endpoint.type,
          ...(agent.endpoint.profileId ? { profileId: agent.endpoint.profileId } : {}),
          ...(agent.endpoint.deviceId ? { deviceId: agent.endpoint.deviceId } : {}),
        },
      })),
      timeline: [],
      runPromise: null,
    };

    rooms.set(roomId, room);
    emitEvent(room, 'room_created');

    if (options.background !== false) {
      room.runPromise = runRoomLoop(room).catch((err) => {
        room.state = ROOM_STATES.STOPPED;
        room.stopReason = 'plugin_stop';
        room.stopSummary = err instanceof Error ? err.message : String(err);
        emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
      });
    }

    return {
      ok: true,
      room: roomPublicSnapshot(room),
    };
  }

  async function pauseRoom(roomId: string): Promise<RoomResult<{ room: Record<string, unknown> }>> {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_FOUND, `room '${roomId}' was not found`) };
    }

    if (room.state !== ROOM_STATES.RUNNING) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_RUNNING, 'room is not running') };
    }

    room.state = ROOM_STATES.PAUSED;
    room.pausedByUser = true;
    emitEvent(room, 'room_paused', { reason: 'user_pause' });

    return { ok: true, room: roomPublicSnapshot(room) };
  }

  async function resumeRoom(roomId: string): Promise<RoomResult<{ room: Record<string, unknown> }>> {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_FOUND, `room '${roomId}' was not found`) };
    }

    if (room.state !== ROOM_STATES.PAUSED) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_PAUSED, 'room is not paused') };
    }

    room.pausedByUser = false;
    room.awaitingApproval = false;
    room.pendingDecision = null;

    room.runPromise = runRoomLoop(room).catch((err) => {
      room.state = ROOM_STATES.STOPPED;
      room.stopReason = 'plugin_stop';
      room.stopSummary = err instanceof Error ? err.message : String(err);
      emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });
    });

    return { ok: true, room: roomPublicSnapshot(room) };
  }

  async function stopRoom(roomId: string, reason = 'user_stop'): Promise<RoomResult<{ room: Record<string, unknown> }>> {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_FOUND, `room '${roomId}' was not found`) };
    }

    room.userStopRequested = true;
    room.state = ROOM_STATES.STOPPED;
    room.stopReason = 'user_stop';
    room.stopSummary = reason;
    emitEvent(room, 'room_stopped', { reason: room.stopReason, summary: room.stopSummary });

    return { ok: true, room: roomPublicSnapshot(room) };
  }

  function getRoomStatus(roomId?: string): RoomResult<{ room?: Record<string, unknown>; rooms?: Record<string, unknown>[] }> {
    if (roomId) {
      const room = rooms.get(roomId);
      if (!room) {
        return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_FOUND, `room '${roomId}' was not found`) };
      }
      return { ok: true, room: roomPublicSnapshot(room) };
    }

    return {
      ok: true,
      rooms: Array.from(rooms.values()).map((room) => roomPublicSnapshot(room)),
    };
  }

  async function editRoomState(roomId: string, edits: Record<string, unknown>): Promise<RoomResult<{ room: Record<string, unknown> }>> {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_FOUND, `room '${roomId}' was not found`) };
    }

    if (typeof edits.stopSummary === 'string') {
      room.stopSummary = edits.stopSummary;
    }

    if (typeof edits.awaitingApproval === 'boolean') {
      room.awaitingApproval = edits.awaitingApproval;
    }

    emitEvent(room, 'room_state_edited', { edits: clone(edits) });

    return {
      ok: true,
      room: roomPublicSnapshot(room),
    };
  }

  async function approveRoom(roomId: string): Promise<RoomResult<{ room: Record<string, unknown> }>> {
    const room = rooms.get(roomId);
    if (!room) {
      return { ok: false, error: toRoomError(ROOM_ERROR.ROOM_NOT_FOUND, `room '${roomId}' was not found`) };
    }

    room.awaitingApproval = false;
    emitEvent(room, 'room_approved');

    if (room.state === ROOM_STATES.PAUSED) {
      return resumeRoom(roomId);
    }

    return {
      ok: true,
      room: roomPublicSnapshot(room),
    };
  }

  return {
    createRoom,
    pauseRoom,
    resumeRoom,
    stopRoom,
    getRoomStatus,
    editRoomState,
    approveRoom,
  };
}
