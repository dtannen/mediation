import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron';
import { MediationService } from '../src/app/mediation-service';
import type { MediationCase } from '../src/domain/types';
import createAuthService from './auth';
import createGatewayClient from './transport/gateway-client';
import createSessionManager from './transport/session-manager';
import createInterfacesService from './interfaces-service';
import createLocalPromptBridge from './runtime/local-prompt-bridge';
import createBridgeManager from './runtime/bridge-manager';
import { createIpcRegistry } from './ipc/ipc-registry';
import { register as registerAuthIpc } from './ipc/auth-ipc';
import { register as registerGatewayIpc } from './ipc/gateway-ipc';
import { register as registerMediationIpc } from './ipc/mediation-ipc';
import {
  register as registerRoomIpc,
  createEmitRoomEvent,
  createEmitRoomMetrics,
} from './ipc/group-chat-ipc';
import { register as registerInterfacesIpc } from './ipc/interfaces-ipc';
import { CH } from './ipc/channel-manifest';
import createGroupChatRuntime from '../src/room/group-chat-runtime';
import {
  initPluginRegistry,
  isRegistryReady,
  getAvailablePluginManifests,
} from '../src/room/plugin-registry';

let mainWindow: BrowserWindow | null = null;
let stopBridgeManager: (() => void) | null = null;

interface SessionStatus {
  status?: string;
  sessionId?: string;
  conversationId?: string;
}

interface SessionChatEvent {
  type?: string;
  deviceId?: string;
  messageId?: string;
  message_id?: string;
  correlationId?: string;
  correlation_id?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

function emitToAllWindows(channel: string, payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, 'preload-main.js');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  const rendererPath = path.resolve(process.cwd(), 'desktop/renderer/index.html');
  await mainWindow.loadFile(rendererPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pickString(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function extractCorrelationIdFromPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return '';
  }

  const top = pickString(payload, 'correlation_id') || pickString(payload, 'correlationId');
  if (top) {
    return top;
  }

  const nested = payload.message;
  if (nested && typeof nested === 'object') {
    return (
      pickString(nested as Record<string, unknown>, 'correlation_id')
      || pickString(nested as Record<string, unknown>, 'correlationId')
    );
  }

  return '';
}

function extractRemoteText(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return '';
  }

  const direct = (
    pickString(payload, 'result')
    || pickString(payload, 'response')
    || pickString(payload, 'text')
    || pickString(payload, 'message')
    || pickString(payload, 'output')
    || pickString(payload, 'content')
  );
  if (direct) {
    return direct;
  }

  const nestedMessage = payload.message;
  if (nestedMessage && typeof nestedMessage === 'object') {
    const nestedText = (
      pickString(nestedMessage as Record<string, unknown>, 'text')
      || pickString(nestedMessage as Record<string, unknown>, 'content')
      || pickString(nestedMessage as Record<string, unknown>, 'message')
    );
    if (nestedText) {
      return nestedText;
    }
  }

  return '';
}

function extractRemoteError(payload: Record<string, unknown> | undefined, fallback = ''): string {
  if (!payload) {
    return fallback;
  }
  return (
    pickString(payload, 'error')
    || pickString(payload, 'message')
    || fallback
  );
}

function buildIntakePromptTemplate(mediationCase: MediationCase, partyId: string): string {
  const party = mediationCase.parties.find((entry) => entry.id === partyId);
  const partyName = party?.displayName || partyId;
  const steps = [
    '1. Clarify the user goals in two concise bullets.',
    '2. Clarify hard constraints and non-negotiables in two concise bullets.',
    '3. Identify one realistic concession the user can offer.',
    '4. Identify one concrete request the user should make.',
    '5. Draft a private summary (120-220 words) for mediation context.',
    '6. Keep tone neutral, practical, and non-accusatory.',
  ];

  return [
    `You are the private intake coach for ${partyName}.`,
    '',
    `Mediation Topic: ${mediationCase.topic}`,
    `Case Description: ${mediationCase.description || 'No additional description provided.'}`,
    '',
    'Complete the following steps exactly:',
    ...steps,
    '',
    'Return only the final private summary text (no JSON, no markdown headings).',
  ].join('\n');
}

async function ensureRemoteSessionReady(
  sessionManager: {
    getSessionStatus: (deviceId: string) => SessionStatus | null;
    startSession: (gatewayUrl: string, deviceId: string) => Promise<Record<string, unknown>>;
  },
  gatewayUrl: string,
  deviceId: string,
  timeoutMs = 45_000,
): Promise<void> {
  const current = sessionManager.getSessionStatus(deviceId);
  if (!current || !current.status || current.status === 'ended' || current.status === 'error') {
    await sessionManager.startSession(gatewayUrl, deviceId);
    return;
  }

  if (current.status === 'ready') {
    return;
  }

  if (current.status !== 'handshaking') {
    await sessionManager.startSession(gatewayUrl, deviceId);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = sessionManager.getSessionStatus(deviceId);
    if (status?.status === 'ready') {
      return;
    }
    if (!status || status.status !== 'handshaking') {
      break;
    }
    await sleep(200);
  }

  const latest = sessionManager.getSessionStatus(deviceId);
  if (latest?.status !== 'ready') {
    throw new Error(`Remote session did not become ready (status=${latest?.status || 'none'})`);
  }
}

function waitForRemoteResult(
  sessionManager: {
    onChatEvent: (listener: (payload: Record<string, unknown>) => void) => () => void;
  },
  deviceId: string,
  correlationId: string,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      resolve({ ok: false, error: `remote response timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    const unsubscribe = sessionManager.onChatEvent((rawPayload) => {
      if (settled) {
        return;
      }

      const event = rawPayload as SessionChatEvent;
      if (event.deviceId !== deviceId) {
        return;
      }

      const payload = event.payload && typeof event.payload === 'object'
        ? event.payload
        : undefined;

      const eventCorrelation = (
        (typeof event.correlationId === 'string' ? event.correlationId.trim() : '')
        || (typeof event.correlation_id === 'string' ? event.correlation_id.trim() : '')
        || extractCorrelationIdFromPayload(payload)
      );
      const eventMessageId = (
        (typeof event.messageId === 'string' ? event.messageId.trim() : '')
        || (typeof event.message_id === 'string' ? event.message_id.trim() : '')
      );

      const matches = (
        (eventCorrelation && eventCorrelation === correlationId)
        || (eventMessageId && eventMessageId === correlationId)
        || (
          !eventCorrelation
          && !eventMessageId
          && (event.type === 'session.result' || event.type === 'session.event')
        )
      );
      if (!matches) {
        return;
      }

      if (event.type === 'session.error') {
        settled = true;
        clearTimeout(timeoutId);
        unsubscribe();
        resolve({
          ok: false,
          error: extractRemoteError(payload, event.error || 'remote session error'),
        });
        return;
      }

      if (event.type !== 'session.result' && event.type !== 'session.event') {
        return;
      }

      const text = extractRemoteText(payload);
      if (!text) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      resolve({ ok: true, text });
    });
  });
}

async function bootstrap(): Promise<void> {
  const registry = createIpcRegistry();

  const mediationService = new MediationService();

  const auth = createAuthService({
    shell,
    safeStorage,
    homedir: os.homedir(),
  });

  const gatewayClient = createGatewayClient({
    getAuthHeaders: auth.getAuthHeaders,
  });

  const sessionManager = createSessionManager({
    gateway: gatewayClient,
    emitToAllWindows,
  });

  const emitLog = (profileId: string, message: string): void => {
    emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
      ts: new Date().toISOString(),
      type: 'log',
      message,
      profileId,
    });
  };

  const localBridge = createLocalPromptBridge();
  const bridgeManager = createBridgeManager({
    localBridge,
    emitLog,
  });
  stopBridgeManager = () => {
    bridgeManager.stopAll('app_shutdown');
  };

  const runIntakeTemplate = async (input: { caseId: string; partyId: string }): Promise<Record<string, unknown>> => {
    const caseId = input.caseId.trim();
    const partyId = input.partyId.trim();
    if (!caseId || !partyId) {
      throw new Error('caseId and partyId are required');
    }

    const mediationCase = mediationService.getCase(caseId);
    if (mediationCase.phase !== 'awaiting_join' && mediationCase.phase !== 'private_intake') {
      throw new Error('intake template is only available during awaiting_join/private_intake');
    }

    const participation = mediationCase.partyParticipationById[partyId];
    if (!participation || (participation.state !== 'joined' && participation.state !== 'ready')) {
      throw new Error(`party '${partyId}' must join before private intake`);
    }

    const party = mediationCase.parties.find((entry) => entry.id === partyId);
    if (!party) {
      throw new Error(`party '${partyId}' not found in case`);
    }

    const profileId = `case_${caseId}_${partyId}`;
    bridgeManager.ensureBridge(profileId);

    const promptTemplate = buildIntakePromptTemplate(mediationCase, partyId);
    const timeoutMs = 120_000;
    const result = await localBridge.requestLocalPrompt(
      profileId,
      {
        objective: `Private intake for ${party.displayName}`,
        mode: 'manual',
        text: promptTemplate,
        constraints: {
          allow_tool_use: false,
          max_output_chars: 8_000,
          max_history_turns: 0,
          max_history_chars: 0,
          local_turn_timeout_ms: timeoutMs,
        },
      },
      timeoutMs,
    );

    const resultRecord = result as Record<string, unknown>;
    if (resultRecord.ok !== true) {
      const errorRecord = (
        resultRecord.error
        && typeof resultRecord.error === 'object'
      ) ? resultRecord.error as Record<string, unknown> : undefined;
      throw new Error(pickString(errorRecord, 'message') || 'local prompt failed');
    }

    const frame = (
      resultRecord.frame
      && typeof resultRecord.frame === 'object'
    ) ? resultRecord.frame as Record<string, unknown> : {};
    if (pickString(frame, 'status') === 'error') {
      throw new Error(pickString(frame, 'reason') || 'local prompt error');
    }

    const summary = pickString(frame, 'draft_message');
    if (!summary) {
      throw new Error('local prompt returned empty summary');
    }

    mediationService.appendPrivateMessage({
      caseId,
      partyId,
      authorType: 'party_llm',
      text: summary,
      tags: ['summary', 'intake_template'],
    });
    const updatedCase = mediationService.setPrivateSummary(caseId, partyId, summary, false);

    return {
      case: updatedCase,
      summary,
      promptTemplate,
    };
  };

  const roomRuntime = createGroupChatRuntime({
    requestLocalPrompt: async (profileId, payload, timeoutMs) => {
      bridgeManager.ensureBridge(profileId);
      return localBridge.requestLocalPrompt(profileId, payload, timeoutMs) as Promise<any>;
    },
    sendRemoteMessage: async (deviceId, text, timeoutMs = 60_000) => {
      try {
        const gatewayUrl = auth.getGatewayUrl();
        await ensureRemoteSessionReady(sessionManager, gatewayUrl, deviceId);

        const correlationId = `corr_${randomUUID()}`;
        await sessionManager.sendMessage(gatewayUrl, deviceId, text, { correlationId });

        const result = await waitForRemoteResult(sessionManager, deviceId, correlationId, timeoutMs);
        if (!result.ok) {
          return {
            ok: false,
            error: {
              code: 'remote_send_failed',
              message: result.error,
            },
          };
        }

        return {
          ok: true,
          response: result.text,
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'remote_send_failed',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    emitRoomEvent: createEmitRoomEvent(emitToAllWindows),
    emitRoomMetrics: createEmitRoomMetrics(emitToAllWindows),
  });

  const interfacesService = createInterfacesService({
    auth,
    gatewayClient,
    emitAgentLog: (_source, message, profileId) => {
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        ts: new Date().toISOString(),
        type: 'log',
        message,
        profileId,
      });
    },
  });

  await initPluginRegistry(path.join(app.getPath('userData'), 'room-plugins')).catch(() => undefined);

  registerAuthIpc(ipcMain, {
    registry: registry as any,
    auth,
    emitAuthChanged: (payload) => {
      emitToAllWindows(CH.OUT_AUTH_CHANGED, payload);
    },
  });

  registerGatewayIpc(ipcMain, {
    registry: registry as any,
    auth,
    gatewayClient,
    sessionManager,
  });

  registerMediationIpc(ipcMain, {
    registry: registry as any,
    mediationService: mediationService as any,
    runIntakeTemplate,
  });

  registerRoomIpc(ipcMain, {
    registry: registry as any,
    roomRuntime,
    isRegistryReady,
    getAvailablePluginManifests: getAvailablePluginManifests as any,
  });

  registerInterfacesIpc(ipcMain, {
    registry: registry as any,
    interfacesService,
  });
}

void app.whenReady().then(async () => {
  await bootstrap();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  stopBridgeManager?.();
  stopBridgeManager = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
