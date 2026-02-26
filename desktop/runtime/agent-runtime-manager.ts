import path from 'node:path';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DESKTOP_EVENT_PREFIX = '__DESKTOP_EVENT__:';
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const FORCE_KILL_WAIT_MS = 2_000;
const DEFAULT_AGENT_ROOT = '/Users/dtannen/Code/commands-com-agent';

export interface MediationDeviceIdentity {
  algorithm: 'ed25519';
  publicKeyDerBase64: string;
  privateKeyDerBase64: string;
  publicKeyRawBase64: string;
}

export interface RuntimeLaunchConfig {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  ownerUid: string;
  ownerEmail: string;
  deviceId: string;
  deviceName: string;
  identity: MediationDeviceIdentity;
}

export interface RuntimeStatus {
  running: boolean;
  starting: boolean;
  ready: boolean;
  pid: number | null;
  deviceId: string | null;
  connectedAt: string | null;
  lastError: string | null;
  lastEventAt: string | null;
}

interface RuntimeManagerDeps {
  homedir: string;
  defaultCwd: string;
  agentRoot?: string;
  emitLog?: (message: string) => void;
  onStatusChanged?: (status: RuntimeStatus) => void;
}

function cloneStatus(status: RuntimeStatus): RuntimeStatus {
  return {
    running: status.running,
    starting: status.starting,
    ready: status.ready,
    pid: status.pid,
    deviceId: status.deviceId,
    connectedAt: status.connectedAt,
    lastError: status.lastError,
    lastEventAt: status.lastEventAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export default function createAgentRuntimeManager(deps: RuntimeManagerDeps) {
  const agentRoot = deps.agentRoot || DEFAULT_AGENT_ROOT;
  const agentEntry = path.join(agentRoot, 'dist', 'index.js');
  const commandsAgentHome = path.join(deps.homedir, '.commands-agent-mediation');
  const configDir = path.join(commandsAgentHome, '.commands-agent');
  const configPath = path.join(configDir, 'config.json');

  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let startDeferred: ReturnType<typeof createDeferred<{ ok: true }>> | null = null;
  let startTimer: NodeJS.Timeout | null = null;

  const status: RuntimeStatus = {
    running: false,
    starting: false,
    ready: false,
    pid: null,
    deviceId: null,
    connectedAt: null,
    lastError: null,
    lastEventAt: null,
  };

  function emitStatus(): void {
    status.lastEventAt = nowIso();
    deps.onStatusChanged?.(cloneStatus(status));
  }

  function emitLog(message: string): void {
    deps.emitLog?.(message);
  }

  function clearStartState(): void {
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    startDeferred = null;
  }

  function abortPendingStart(message: string): void {
    if (!startDeferred) {
      return;
    }
    startDeferred.reject(new Error(message));
    clearStartState();
  }

  function writeRuntimeConfig(launch: RuntimeLaunchConfig): void {
    mkdirSync(configDir, { recursive: true });

    const payload = {
      version: 1,
      gatewayUrl: launch.gatewayUrl,
      deviceId: launch.deviceId,
      ...(launch.deviceName ? { deviceName: launch.deviceName } : {}),
      deviceToken: '__desktop_runtime_env__',
      provider: 'claude',
      model: 'sonnet',
      permissionProfile: 'dev-safe',
      identity: launch.identity,
      ...(launch.refreshToken ? { refreshToken: launch.refreshToken } : {}),
      ...(launch.tokenExpiresAt ? { tokenExpiresAt: launch.tokenExpiresAt } : {}),
      ...(launch.ownerUid ? { ownerUID: launch.ownerUid } : {}),
      ...(launch.ownerEmail ? { ownerEmail: launch.ownerEmail } : {}),
    };

    const tmpPath = `${configPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, configPath);
  }

  function settleStartOk(): void {
    if (!startDeferred) {
      return;
    }
    startDeferred.resolve({ ok: true });
    clearStartState();
  }

  function settleStartErr(message: string): void {
    if (!startDeferred) {
      return;
    }
    startDeferred.reject(new Error(message));
    clearStartState();
  }

  function processStdoutLine(line: string): void {
    if (!line) {
      return;
    }
    if (!line.startsWith(DESKTOP_EVENT_PREFIX)) {
      emitLog(`[agent] ${line}`);
      return;
    }

    let eventPayload: Record<string, unknown>;
    try {
      eventPayload = JSON.parse(line.slice(DESKTOP_EVENT_PREFIX.length)) as Record<string, unknown>;
    } catch {
      emitLog('[agent] malformed desktop event');
      return;
    }

    const eventName = typeof eventPayload.event === 'string' ? eventPayload.event : '';
    if (eventName === 'runtime.ready') {
      status.starting = false;
      status.ready = true;
      status.running = true;
      status.connectedAt = nowIso();
      status.lastError = null;
      emitStatus();
      settleStartOk();
      return;
    }

    if (eventName === 'runtime.start_failed') {
      const reason = typeof eventPayload.message === 'string' && eventPayload.message.trim()
        ? eventPayload.message.trim()
        : 'agent runtime start failed';
      status.starting = false;
      status.ready = false;
      status.lastError = reason;
      emitStatus();
      emitLog(`[agent] runtime.start_failed ${reason}`);
      settleStartErr(reason);
      return;
    }

    emitLog(`[agent] event ${eventName}`);
  }

  function attachProcessHandlers(proc: ChildProcessWithoutNullStreams): void {
    proc.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += String(chunk);
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        processStdoutLine(line.trimEnd());
      }
    });

    proc.stderr.on('data', (chunk: Buffer | string) => {
      stderrBuffer += String(chunk);
      if (stderrBuffer.length > 4096) {
        stderrBuffer = stderrBuffer.slice(-4096);
      }

      const lines = String(chunk).split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          emitLog(`[agent:stderr] ${trimmed}`);
        }
      }
    });

    proc.on('error', (err: Error) => {
      status.running = false;
      status.starting = false;
      status.ready = false;
      status.pid = null;
      status.lastError = err.message;
      emitStatus();
      settleStartErr(err.message);
    });

    proc.on('close', (code, signal) => {
      if (child === proc) {
        child = null;
      }

      if (stdoutBuffer.trim()) {
        processStdoutLine(stdoutBuffer.trim());
      }
      stdoutBuffer = '';

      status.running = false;
      status.starting = false;
      status.ready = false;
      status.pid = null;
      if (code !== 0 && status.lastError == null) {
        status.lastError = `agent exited before ready (code=${code == null ? 'null' : code}, signal=${signal || 'none'})`;
      }
      emitStatus();

      if (startDeferred) {
        settleStartErr(status.lastError || 'agent exited before readiness');
      }
    });
  }

  async function ensureStopped(): Promise<void> {
    const proc = child;
    child = null;
    abortPendingStart('runtime stopped');

    status.running = false;
    status.starting = false;
    status.ready = false;
    status.pid = null;
    emitStatus();

    if (!proc) {
      return;
    }

    const deferred = createDeferred<void>();
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      deferred.resolve();
    };

    let forceKillWaitTimer: NodeJS.Timeout | null = null;
    const killTimer = setTimeout(() => {
      emitLog(`[agent] stop grace elapsed (${STOP_TIMEOUT_MS}ms); sending SIGKILL`);
      try {
        proc.kill('SIGKILL');
      } catch {
        // no-op
      }
      forceKillWaitTimer = setTimeout(() => {
        emitLog(`[agent] stop timed out waiting for process close after SIGKILL (${FORCE_KILL_WAIT_MS}ms)`);
        finish();
      }, FORCE_KILL_WAIT_MS);
    }, STOP_TIMEOUT_MS);

    proc.once('close', () => {
      clearTimeout(killTimer);
      if (forceKillWaitTimer) {
        clearTimeout(forceKillWaitTimer);
      }
      finish();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
      if (forceKillWaitTimer) {
        clearTimeout(forceKillWaitTimer);
      }
      finish();
    }

    await deferred.promise;
  }

  async function ensureStarted(launch: RuntimeLaunchConfig): Promise<{ ok: true; status: RuntimeStatus }> {
    if (!existsSync(agentEntry)) {
      throw new Error(`commands-com-agent runtime not found at ${agentEntry}`);
    }

    if (
      child
      && status.running
      && status.deviceId === launch.deviceId
      && (status.ready || status.starting)
    ) {
      if (startDeferred) {
        await startDeferred.promise;
      }
      return { ok: true, status: cloneStatus(status) };
    }

    if (child) {
      await ensureStopped();
    }

    writeRuntimeConfig(launch);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      COMMANDS_AGENT_HOME: commandsAgentHome,
      DESKTOP_DEVICE_TOKEN: launch.accessToken,
      ...(launch.refreshToken ? { DESKTOP_REFRESH_TOKEN: launch.refreshToken } : {}),
      DESKTOP_PRIVATE_KEY_DER: launch.identity.privateKeyDerBase64,
      DESKTOP_PARENT_PID: String(process.pid),
      DESKTOP_PROFILE_ID: `mediation_${launch.deviceId}`,
    };

    const args = [
      agentEntry,
      'start',
      '--default-cwd',
      deps.defaultCwd,
      '--provider',
      'claude',
      '--model',
      'sonnet',
      '--permission-profile',
      'dev-safe',
    ];

    emitLog(`[agent] starting runtime for device ${launch.deviceId}`);
    const proc = spawn(process.execPath, args, {
      cwd: agentRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = proc;

    status.running = true;
    status.starting = true;
    status.ready = false;
    status.pid = typeof proc.pid === 'number' ? proc.pid : null;
    status.deviceId = launch.deviceId;
    status.lastError = null;
    status.connectedAt = null;
    emitStatus();

    attachProcessHandlers(proc);

    const deferred = createDeferred<{ ok: true }>();
    startDeferred = deferred;
    startTimer = setTimeout(() => {
      status.running = false;
      status.starting = false;
      status.ready = false;
      status.lastError = `runtime start timed out after ${START_TIMEOUT_MS}ms`;
      emitStatus();
      settleStartErr(status.lastError);
      try {
        proc.kill('SIGTERM');
      } catch {
        // no-op
      }
    }, START_TIMEOUT_MS);

    await deferred.promise;
    return { ok: true, status: cloneStatus(status) };
  }

  function getStatus(): RuntimeStatus {
    return cloneStatus(status);
  }

  return {
    ensureStarted,
    ensureStopped,
    getStatus,
  };
}
