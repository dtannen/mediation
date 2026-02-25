import { randomBytes } from 'node:crypto';

export const ROOM_ERROR = Object.freeze({
  INVALID_CONFIG: 'invalid_config',
  INVALID_QUORUM: 'invalid_quorum',
  ROOM_NOT_FOUND: 'room_not_found',
  ROOM_ALREADY_RUNNING: 'room_already_running',
  ROOM_NOT_RUNNING: 'room_not_running',
  ROOM_NOT_PAUSED: 'room_not_paused',
  AGENT_TIMEOUT: 'agent_timeout',
  PLUGIN_HOOK_TIMEOUT: 'plugin_hook_timeout',
  LLM_TIMEOUT: 'llm_timeout',
  INVALID_FAN_OUT: 'invalid_fan_out',
  INVALID_DECISION: 'invalid_decision',
  PLUGIN_ERROR: 'plugin_error',
  BRIDGE_UNAVAILABLE: 'bridge_unavailable',
  CORRELATION_ECHO_MISSING: 'correlation_echo_missing',
  AGENT_REMOTE_ERROR: 'agent_remote_error',
});

export const STOP_REASONS = Object.freeze([
  'user_stop',
  'failure_limit',
  'duration_limit',
  'turn_limit',
  'convergence',
  'cycle_limit',
  'plugin_stop',
]);

export const ROOM_STATES = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
});

export const ROOM_MODES = Object.freeze({
  FULL_AUTO: 'full_auto',
  SEMI_AUTO: 'semi_auto',
  MANUAL: 'manual',
});

export const ROOM_DEFAULTS = Object.freeze({
  maxCycles: 5,
  maxTurns: 40,
  maxDurationMs: 3 * 60 * 60 * 1000,
  maxFailures: 3,
  agentTimeoutMs: 1_800_000,
  pluginHookTimeoutMs: 30_000,
  llmTimeoutMs: 60_000,
  mode: ROOM_MODES.FULL_AUTO,
});

export const ROOM_BOUNDS = Object.freeze({
  maxCycles: { min: 1, max: 100 },
  maxTurns: { min: 1, max: 1000 },
  maxDurationMs: { min: 60_000, max: 43_200_000 },
  maxFailures: { min: 1, max: 50 },
  agentTimeoutMs: { min: 10_000, max: 3_600_000 },
  pluginHookTimeoutMs: { min: 5_000, max: 600_000 },
  llmTimeoutMs: { min: 10_000, max: 600_000 },
});

export const DECISION_TYPES = Object.freeze({
  SPEAK: 'speak',
  FAN_OUT: 'fan_out',
  PAUSE: 'pause',
  STOP: 'stop',
});

export interface RoomError {
  code: string;
  message: string;
}

export type RoomResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: RoomError };

export interface RoomAgentEndpoint {
  type: 'local' | 'remote';
  profileId?: string;
  deviceId?: string;
}

export interface RoomAgentConfig {
  agentId: string;
  displayName: string;
  role: string;
  endpoint: RoomAgentEndpoint;
  capabilities?: {
    supportsTokenReporting?: boolean;
  };
}

export interface RoomLimits {
  maxCycles: number;
  maxTurns: number;
  maxDurationMs: number;
  maxFailures: number;
  agentTimeoutMs: number;
  pluginHookTimeoutMs: number;
  llmTimeoutMs: number;
}

export interface RoomConfig {
  orchestratorType: string;
  orchestratorLLM: {
    provider: string;
    model: string;
  };
  agents: RoomAgentConfig[];
  objective: string;
  initialContext?: string;
  mode?: string;
  limits?: Partial<RoomLimits>;
  quorum?: {
    minResponses?: number;
    onQuorumFailure?: 'pause' | 'retry_cycle' | 'stop';
  };
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  orchestratorType: string;
  roles: {
    required?: string[];
    optional?: string[];
    forbidden?: string[];
    minCount?: Record<string, number>;
  };
  description?: string;
  supportsQuorum?: boolean;
  dashboard?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  endpointConstraints?: Record<string, unknown>;
  display?: Record<string, unknown>;
  report?: Record<string, unknown>;
}

const MANIFEST_FIELDS = new Set([
  'id',
  'name',
  'version',
  'orchestratorType',
  'roles',
  'description',
  'supportsQuorum',
  'dashboard',
  'limits',
  'endpointConstraints',
  'display',
  'report',
]);

const ROLE_FIELDS = new Set(['required', 'optional', 'forbidden', 'minCount']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function makeRoomId(): string {
  return `room_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function clampRoomInt(input: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(input);
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

export function toRoomError(code: string, message: string): RoomError {
  return { code, message };
}

export function parseLimits(limits?: Partial<RoomLimits>): RoomLimits {
  return {
    maxCycles: clampRoomInt(limits?.maxCycles, ROOM_BOUNDS.maxCycles.min, ROOM_BOUNDS.maxCycles.max, ROOM_DEFAULTS.maxCycles),
    maxTurns: clampRoomInt(limits?.maxTurns, ROOM_BOUNDS.maxTurns.min, ROOM_BOUNDS.maxTurns.max, ROOM_DEFAULTS.maxTurns),
    maxDurationMs: clampRoomInt(limits?.maxDurationMs, ROOM_BOUNDS.maxDurationMs.min, ROOM_BOUNDS.maxDurationMs.max, ROOM_DEFAULTS.maxDurationMs),
    maxFailures: clampRoomInt(limits?.maxFailures, ROOM_BOUNDS.maxFailures.min, ROOM_BOUNDS.maxFailures.max, ROOM_DEFAULTS.maxFailures),
    agentTimeoutMs: clampRoomInt(limits?.agentTimeoutMs, ROOM_BOUNDS.agentTimeoutMs.min, ROOM_BOUNDS.agentTimeoutMs.max, ROOM_DEFAULTS.agentTimeoutMs),
    pluginHookTimeoutMs: clampRoomInt(limits?.pluginHookTimeoutMs, ROOM_BOUNDS.pluginHookTimeoutMs.min, ROOM_BOUNDS.pluginHookTimeoutMs.max, ROOM_DEFAULTS.pluginHookTimeoutMs),
    llmTimeoutMs: clampRoomInt(limits?.llmTimeoutMs, ROOM_BOUNDS.llmTimeoutMs.min, ROOM_BOUNDS.llmTimeoutMs.max, ROOM_DEFAULTS.llmTimeoutMs),
  };
}

export function parseQuorum(raw: RoomConfig['quorum']): { minResponses: number; onQuorumFailure: 'pause' | 'retry_cycle' | 'stop' } {
  const policy = raw?.onQuorumFailure;
  const onQuorumFailure = policy === 'pause' || policy === 'retry_cycle' || policy === 'stop'
    ? policy
    : 'retry_cycle';

  return {
    minResponses: clampRoomInt(raw?.minResponses, 1, 100, 1),
    onQuorumFailure,
  };
}

export function validatePluginManifest(manifest: unknown): RoomResult<{ manifest: PluginManifest }> {
  if (!isPlainObject(manifest)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest must be an object') };
  }

  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `unknown manifest field: ${key}`),
      };
    }
  }

  if (!isNonEmptyString(manifest.id)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest.id is required') };
  }
  if (!isNonEmptyString(manifest.name)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest.name is required') };
  }
  if (!isNonEmptyString(manifest.version)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest.version is required') };
  }
  if (!isNonEmptyString(manifest.orchestratorType)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest.orchestratorType is required') };
  }

  if (!isPlainObject(manifest.roles)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest.roles is required') };
  }

  for (const key of Object.keys(manifest.roles)) {
    if (!ROLE_FIELDS.has(key)) {
      return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `unknown roles field: ${key}`) };
    }
  }

  const roles = manifest.roles as Record<string, unknown>;
  const roleArrayFields = ['required', 'optional', 'forbidden'] as const;
  for (const field of roleArrayFields) {
    if (roles[field] !== undefined && !Array.isArray(roles[field])) {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `manifest.roles.${field} must be an array`),
      };
    }
  }

  if (roles.minCount !== undefined && !isPlainObject(roles.minCount)) {
    return {
      ok: false,
      error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'manifest.roles.minCount must be an object'),
    };
  }

  return {
    ok: true,
    manifest: manifest as unknown as PluginManifest,
  };
}

export function validateRoomConfig(config: unknown): RoomResult<{ config: RoomConfig }> {
  if (!isPlainObject(config)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'config must be an object') };
  }

  if (!isNonEmptyString(config.orchestratorType)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'orchestratorType is required') };
  }

  if (!isPlainObject(config.orchestratorLLM)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'orchestratorLLM is required') };
  }

  if (!isNonEmptyString(config.orchestratorLLM.provider)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'orchestratorLLM.provider is required') };
  }

  if (!isNonEmptyString(config.orchestratorLLM.model)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'orchestratorLLM.model is required') };
  }

  if (!isNonEmptyString(config.objective)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'objective is required') };
  }

  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'agents must be a non-empty array') };
  }

  const ids = new Set<string>();
  for (const agent of config.agents) {
    if (!isPlainObject(agent)) {
      return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'each agent must be an object') };
    }

    if (!isNonEmptyString(agent.agentId)) {
      return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, 'agent.agentId is required') };
    }
    if (ids.has(agent.agentId)) {
      return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `duplicate agentId: ${agent.agentId}`) };
    }
    ids.add(agent.agentId);

    if (!isNonEmptyString(agent.displayName)) {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `agent '${agent.agentId}' displayName is required`),
      };
    }
    if (!isNonEmptyString(agent.role)) {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `agent '${agent.agentId}' role is required`),
      };
    }
    if (!isPlainObject(agent.endpoint)) {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `agent '${agent.agentId}' endpoint is required`),
      };
    }

    const endpoint = agent.endpoint as Record<string, unknown>;
    if (endpoint.type === 'local') {
      if (!isNonEmptyString(endpoint.profileId)) {
        return {
          ok: false,
          error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `agent '${agent.agentId}' local endpoint requires profileId`),
        };
      }
    } else if (endpoint.type === 'remote') {
      if (!isNonEmptyString(endpoint.deviceId)) {
        return {
          ok: false,
          error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `agent '${agent.agentId}' remote endpoint requires deviceId`),
        };
      }
    } else {
      return {
        ok: false,
        error: toRoomError(ROOM_ERROR.INVALID_CONFIG, `agent '${agent.agentId}' endpoint.type must be local or remote`),
      };
    }
  }

  return { ok: true, config: config as unknown as RoomConfig };
}

export function validateDecision(decision: unknown): RoomResult<{ decision: Record<string, unknown> }> {
  if (!isPlainObject(decision)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_DECISION, 'decision must be an object') };
  }

  if (!isNonEmptyString(decision.type)) {
    return { ok: false, error: toRoomError(ROOM_ERROR.INVALID_DECISION, 'decision.type is required') };
  }

  const types = new Set<string>(Object.values(DECISION_TYPES));
  if (!types.has(decision.type)) {
    return {
      ok: false,
      error: toRoomError(ROOM_ERROR.INVALID_DECISION, `unsupported decision type: ${decision.type}`),
    };
  }

  return {
    ok: true,
    decision,
  };
}
