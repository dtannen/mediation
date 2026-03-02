import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, ipcMain, shell, safeStorage } from 'electron';
import { MediationService } from '../src/app/mediation-service';
import type { MediationCase } from '../src/domain/types';
import { DomainError } from '../src/domain/errors';
import { FileBackedMediationStore } from '../src/store/file-backed-store';
import createAuthService from './auth';
import createGatewayClient from './transport/gateway-client';
import createSessionManager from './transport/session-manager';
import createInterfacesService from './interfaces-service';
import createLocalPromptBridge from './runtime/local-prompt-bridge';
import createBridgeManager from './runtime/bridge-manager';
import createAgentRuntimeManager from './runtime/agent-runtime-manager';
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
import { register as registerTemplateIpc } from './ipc/template-ipc';
import { UserProfileStore } from './lib/user-profile-store';
import { FileBackedTemplateStore } from '../src/store/template-store';
import { TemplateService } from '../src/app/template-service';
import { migrateCaseStore } from '../src/store/case-migration';
import type { CoachingRole, CoachingTemplateVersion, MainTopicConfig, DraftCoachPhase } from '../src/domain/types';
import { CH } from './ipc/channel-manifest';
import createGroupChatRuntime from '../src/room/group-chat-runtime';
import {
  initPluginRegistry,
  isRegistryReady,
  getAvailablePluginManifests,
} from '../src/room/plugin-registry';
import { IdempotencyStore } from '../src/remote/idempotency-store';
import { RemoteMediationRouter } from '../src/remote/router';
import { FileBackedRouterStatePersistence } from '../src/remote/router-state-persistence';
import type { GatewayAuthContext, MediationEventEnvelope } from '../src/remote/protocol';
import { projectCaseForActor } from '../src/remote/projection';
import { getProvider, listProviderIds } from '../src/llm/provider-registry';
import { registerBuiltInProviders } from '../src/llm/providers';

function normalizeDevProfileId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) {
    return '';
  }
  return raw
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function parseProfileArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith('--mediation-profile=')) {
      return normalizeDevProfileId(value.slice('--mediation-profile='.length));
    }
    if (value.startsWith('--profile=')) {
      return normalizeDevProfileId(value.slice('--profile='.length));
    }
    if ((value === '--mediation-profile' || value === '--profile') && i + 1 < argv.length) {
      return normalizeDevProfileId(argv[i + 1]);
    }
  }
  return '';
}

const devProfileId = parseProfileArg(process.argv)
  || normalizeDevProfileId(process.env.MEDIATION_PROFILE)
  || normalizeDevProfileId(process.env.MEDIATION_DEV_PROFILE);

if (devProfileId) {
  const defaultUserDataPath = app.getPath('userData');
  app.setPath('userData', path.join(defaultUserDataPath, 'profiles', devProfileId));
}

const enforceSingleInstance = !devProfileId;
let mainWindow: BrowserWindow | null = null;
let stopBridgeManager: (() => void) | null = null;
let stopAgentRuntime: (() => Promise<void>) | null = null;
let quitDrainState: 'idle' | 'draining' | 'ready' = 'idle';
const hasSingleInstanceLock = enforceSingleInstance ? app.requestSingleInstanceLock() : true;
const SIGNAL_FORCE_EXIT_MS = 5_000;
let signalForceExitTimer: NodeJS.Timeout | null = null;
const launchParentPid = process.ppid;
let parentWatchTimer: NodeJS.Timeout | null = null;
let parentGoneHandled = false;
let signalShutdownInFlight = false;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearSignalForceExitTimer(): void {
  if (!signalForceExitTimer) {
    return;
  }
  clearTimeout(signalForceExitTimer);
  signalForceExitTimer = null;
}

function handleProcessSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  // Fire best-effort cleanup without blocking, then exit immediately.
  const stopAgent = stopAgentRuntime;
  const stopBridge = stopBridgeManager;
  stopAgentRuntime = null;
  stopBridgeManager = null;

  try {
    stopBridge?.();
  } catch {
    // best-effort
  }

  if (stopAgent) {
    void stopAgent().catch(() => {});
  }

  quitDrainState = 'ready';
  clearSignalForceExitTimer();
  app.exit(0);
}

process.on('SIGINT', () => {
  handleProcessSignal('SIGINT');
});

process.on('SIGTERM', () => {
  handleProcessSignal('SIGTERM');
});

if (launchParentPid > 1) {
  parentWatchTimer = setInterval(() => {
    if (parentGoneHandled || quitDrainState === 'ready') {
      return;
    }
    // npm/electron launcher in dev may exit on first Ctrl+C before the
    // Electron app receives the signal. If parent disappears, initiate quit.
    if (process.ppid === 1 || !isPidAlive(launchParentPid)) {
      parentGoneHandled = true;
      handleProcessSignal('SIGTERM');
    }
  }, 250);
  if (typeof parentWatchTimer.unref === 'function') {
    parentWatchTimer.unref();
  }
}

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

function emitStructuredMainLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }));
  } catch {
    // best effort
  }
}

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, 'preload-main.js');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 1000,
    minWidth: 960,
    minHeight: 760,
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

function buildDefaultGatewayAuthContext(authStatus: Record<string, unknown>): GatewayAuthContext {
  const mediationDevice = (
    authStatus.mediationDevice
    && typeof authStatus.mediationDevice === 'object'
  ) ? authStatus.mediationDevice as Record<string, unknown> : {};

  return {
    requesterUid: pickString(authStatus, 'uid') || pickString(authStatus, 'userId') || 'owner_local',
    requesterDeviceId: pickString(mediationDevice, 'id') || 'owner_device',
    grantId: 'owner_local',
    role: 'owner',
    grantStatus: 'active',
  };
}

function parseGatewayAuthContext(
  payload: Record<string, unknown>,
  authStatus: Record<string, unknown>,
): GatewayAuthContext {
  const defaultContext = buildDefaultGatewayAuthContext(authStatus);
  const raw = (
    payload.authContext
    && typeof payload.authContext === 'object'
  ) ? payload.authContext as Record<string, unknown> : {};

  const role = pickString(raw, 'role') === 'collaborator' ? 'collaborator' : defaultContext.role;
  const grantStatus = pickString(raw, 'grantStatus') === 'revoked' ? 'revoked' : 'active';
  const grantId = pickString(raw, 'grantId');
  const requesterUid = pickString(raw, 'requesterUid');

  // Fail closed: collaborator requests MUST provide grantId and requesterUid explicitly
  if (role === 'collaborator' && (!grantId || !requesterUid)) {
    throw new Error('Collaborator auth context requires grantId and requesterUid');
  }

  return {
    requesterUid: requesterUid || defaultContext.requesterUid,
    requesterDeviceId: pickString(raw, 'requesterDeviceId') || defaultContext.requesterDeviceId,
    grantId: grantId || defaultContext.grantId,
    role,
    grantStatus,
  };
}

// ── Template-aware prompt assembly (Spec Section 5.1) ──────────────────────

const DEFAULT_INTAKE_PREAMBLE = 'You are a private intake coach helping a mediation party articulate their perspective.';
const DEFAULT_DRAFT_COACH_PREAMBLE = 'You are a draft coach helping a mediation party compose thoughtful messages for group discussion.';
const DEFAULT_MEDIATOR_PREAMBLE = 'You are a neutral AI mediator facilitating constructive dialogue between parties.';
const DEFAULT_INTAKE_INSTRUCTIONS = 'Guide the party through structured questions to understand their position, interests, and constraints.';
const DEFAULT_DRAFT_COACH_INSTRUCTIONS = 'Help the party refine their message for clarity, empathy, and constructiveness.';
const DEFAULT_MEDIATOR_INSTRUCTIONS = 'Facilitate balanced discussion, ask clarifying questions, and help identify common ground.';

const ROLE_PREAMBLE_DEFAULTS: Record<CoachingRole, string> = {
  intake: DEFAULT_INTAKE_PREAMBLE,
  draft_coach: DEFAULT_DRAFT_COACH_PREAMBLE,
  mediator: DEFAULT_MEDIATOR_PREAMBLE,
};
const ROLE_INSTRUCTION_DEFAULTS: Record<CoachingRole, string> = {
  intake: DEFAULT_INTAKE_INSTRUCTIONS,
  draft_coach: DEFAULT_DRAFT_COACH_INSTRUCTIONS,
  mediator: DEFAULT_MEDIATOR_INSTRUCTIONS,
};

/**
 * Template-driven prompt assembly (Spec Section 5.1).
 *
 * Assembly order:
 *   1. Role preamble (template override or runtime default)
 *   2. globalGuidance from template
 *   3. Role-specific instructions (template or runtime default)
 *   4. Topic + description from mainTopicConfig
 *   5. Runtime context lines (transcript, instructions, etc.)
 */
/** Resolve the role-specific preamble from v2 individual fields or legacy preambles map */
function resolveRolePreamble(tv: CoachingTemplateVersion | null, role: CoachingRole): string {
  if (!tv) return ROLE_PREAMBLE_DEFAULTS[role];
  // V2 spec fields first (Section 4.3)
  const preambleMap: Record<CoachingRole, string | undefined> = {
    intake: tv.intakeCoachPreamble,
    draft_coach: tv.draftCoachPreamble,
    mediator: tv.mediatorPreamble,
  };
  if (preambleMap[role]) return preambleMap[role]!;
  // Legacy fallback
  if (tv.preambles?.[role]) return tv.preambles[role];
  return ROLE_PREAMBLE_DEFAULTS[role];
}

/** Resolve the role-specific instructions from v2 individual fields or legacy instructions map */
function resolveRoleInstructions(tv: CoachingTemplateVersion | null, role: CoachingRole): string {
  if (!tv) return ROLE_INSTRUCTION_DEFAULTS[role];
  // V2 spec fields first (Section 4.3)
  const instructionsMap: Record<CoachingRole, string | undefined> = {
    intake: tv.intakeCoachInstructions,
    draft_coach: tv.draftCoachInstructions,
    mediator: tv.mediatorInstructions,
  };
  if (instructionsMap[role]) return instructionsMap[role]!;
  // Legacy fallback
  if (tv.instructions?.[role]) return tv.instructions[role];
  return ROLE_INSTRUCTION_DEFAULTS[role];
}

function assemblePrompt(
  role: CoachingRole,
  templateVersion: CoachingTemplateVersion | null,
  mainTopicConfig: MainTopicConfig | null | undefined,
  runtimeLines: string[],
): string {
  // 1. Role preamble: v2 individual field > legacy preambles map > runtime default (Section 5.1)
  const preamble = resolveRolePreamble(templateVersion, role);

  // 2. Global guidance from template (Section 5.1)
  const globalGuidance = templateVersion?.globalGuidance || '';

  // 3. Role-specific instructions: v2 individual field > legacy instructions map > runtime default
  const instructions = resolveRoleInstructions(templateVersion, role);

  // 4. Case topic and description
  const topicLine = mainTopicConfig?.topic
    ? `Case topic: ${mainTopicConfig.topic}`
    : '';
  const descriptionLine = mainTopicConfig?.description
    ? `Case description: ${mainTopicConfig.description}`
    : '';

  return [
    preamble,
    '',
    globalGuidance ? `Global guidance: ${globalGuidance}` : '',
    '',
    instructions,
    '',
    topicLine,
    descriptionLine,
    '',
    ...runtimeLines,
  ].filter((line) => line !== undefined && line !== '').join('\n');
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

function buildCoachReplyPrompt(
  mediationCase: MediationCase,
  partyId: string,
  latestPartyPrompt: string,
): string {
  const party = mediationCase.parties.find((entry) => entry.id === partyId);
  const partyName = party?.displayName || partyId;
  const thread = mediationCase.privateIntakeByPartyId[partyId];
  const history = (thread?.messages || [])
    .slice(-10)
    .map((message) => {
      const role = message.authorType === 'party' ? 'Party' : 'Coach';
      return `${role}: ${message.text}`;
    })
    .join('\n');

  return [
    `You are the private mediation coach for ${partyName}.`,
    'Respond with empathy, neutrality, and actionability.',
    'Keep your reply under 180 words and ask at most one clarifying question.',
    '',
    `Case topic: ${mediationCase.topic}`,
    `Case description: ${mediationCase.description || 'N/A'}`,
    '',
    history ? 'Recent private intake transcript:' : '',
    history || '',
    '',
    `Latest party message: ${latestPartyPrompt}`,
    '',
    'Return only the coach response text.',
  ].filter(Boolean).join('\n');
}

function buildDraftSuggestionPrompt(
  mediationCase: MediationCase,
  draftId: string,
): string {
  const draft = mediationCase.groupChat.draftsById[draftId];
  const party = mediationCase.parties.find((entry) => entry.id === draft.partyId);
  const composeHistory = draft.composeMessages
    .slice(-12)
    .map((message) => `${message.author === 'party' ? 'Party' : 'Coach'}: ${message.text}`)
    .join('\n');

  return [
    `You are helping ${party?.displayName || draft.partyId} craft a mediation group-chat message.`,
    `Case topic: ${mediationCase.topic}`,
    `Case description: ${mediationCase.description || 'N/A'}`,
    '',
    'Compose history:',
    composeHistory,
    '',
    'Draft a single final message for the group chat.',
    'Tone: calm, specific, non-accusatory, and negotiation-oriented.',
    'Length: 60-180 words.',
    'Return only the final message text.',
  ].join('\n');
}

function buildMediatorTurnPrompt(
  mediationCase: MediationCase,
  speakerPartyId: string,
  latestMessageText: string,
): string {
  const speakerName = mediationCase.parties.find((entry) => entry.id === speakerPartyId)?.displayName || speakerPartyId;
  const participantNames = mediationCase.parties.map((entry) => entry.displayName || entry.id).join(', ');
  const transcript = mediationCase.groupChat.messages
    .slice(-14)
    .map((message) => {
      if (message.authorType === 'party') {
        const partyName = mediationCase.parties.find((entry) => entry.id === message.authorPartyId)?.displayName
          || message.authorPartyId
          || 'Participant';
        return `${partyName}: ${message.text}`;
      }
      if (message.authorType === 'mediator_llm') {
        return `Mediator: ${message.text}`;
      }
      return `Assistant: ${message.text}`;
    })
    .join('\n');

  return [
    `You are the neutral live mediator for case topic: ${mediationCase.topic}.`,
    `Participants: ${participantNames}.`,
    'Use participant display names exactly as listed. Never use generic labels like "Party A" or "Party B".',
    'Write one concise facilitator response that moves the conversation forward.',
    'Keep tone neutral and practical, 45-120 words, and ask at most one focused follow-up question.',
    '',
    `Latest speaker: ${speakerName}`,
    `Latest message: ${latestMessageText}`,
    '',
    'Recent transcript:',
    transcript || '(no prior transcript)',
    '',
    'Return only the mediator message text.',
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

  const mediationStorePath = path.join(app.getPath('userData'), 'mediation-cases.json');
  const mediationStore = new FileBackedMediationStore(mediationStorePath);
  const mediationService = new MediationService(mediationStore);
  mediationService.purgeExpiredRemoteTombstones();

  const templateStorePath = path.join(app.getPath('userData'), 'mediation-templates.json');
  const templateStore = new FileBackedTemplateStore(templateStorePath);
  const templateService = new TemplateService(templateStore);

  // User profile store for admin authorization (Spec Section 1.3)
  const userProfileStore = new UserProfileStore();
  userProfileStore.ensureLocalOwner('local_owner');

  const auditLogPath = path.join(app.getPath('userData'), 'audit.log');

  // Migrate pre-v2 cases
  try {
    const systemDefault = templateService.getSystemDefault();
    const cases = mediationService.listCases() as any[];
    // c2_4 fix: pass version resolver to deterministically map legacy versionId → versionNumber
    const versionResolver = (tplId: string, verId: string): number | undefined => {
      try { return templateService.resolveVersionIdToNumber(tplId, verId); } catch { return undefined; }
    };
    const migrated = migrateCaseStore(cases, {
      templateId: systemDefault.template.id as string,
      versionId: systemDefault.version.id as string,
      templateVersion: (systemDefault.version as any).versionNumber ?? 1,
    }, versionResolver);
    if (migrated > 0) {
      for (const c of cases) {
        mediationStore.save(c);
      }
    }
  } catch {
    // best-effort migration
  }

  const auth = createAuthService({
    shell,
    safeStorage,
    homedir: os.homedir(),
    ...(devProfileId ? { profileId: devProfileId } : {}),
  });

  const gatewayClient = createGatewayClient({
    getAuthHeaders: auth.getAuthHeaders,
  });

  const sessionManager = createSessionManager({
    gateway: gatewayClient,
    emitToAllWindows,
  });

  let emitAuthChanged = (): void => {};
  let remoteRouter: RemoteMediationRouter | null = null;

  const runtimeManager = createAgentRuntimeManager({
    homedir: os.homedir(),
    defaultCwd: process.cwd(),
    emitLog: (message) => {
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        ts: new Date().toISOString(),
        type: 'log',
        profileId: 'mediation_device',
        message,
      });
    },
    onStatusChanged: () => {
      emitAuthChanged();
    },
    onMediationCommandRequest: (payload) => {
      void (async () => {
        const requestId = pickString(payload, 'request_id');
        if (!requestId || !remoteRouter) {
          return;
        }

        const command = (
          payload.command
          && typeof payload.command === 'object'
        ) ? payload.command as Record<string, unknown> : {};
        const commandName = pickString(command, 'command');
        const commandCaseId = pickString(command, 'case_id');
        const commandPartyId = pickString(command, 'party_id');
        const commandPayload = (
          command.payload
          && typeof command.payload === 'object'
        ) ? command.payload as Record<string, unknown> : {};
        const commandMessage = (
          commandPayload.message
          && typeof commandPayload.message === 'object'
        ) ? commandPayload.message as Record<string, unknown> : {};
        const commandContent = pickString(commandMessage, 'content');

        // Build auth context: require explicit identity fields for remote collaborators.
        // Fail closed when collaborator context is incomplete instead of defaulting to owner.
        const hasExplicitIdentity = Boolean(
          payload.requesterUid
          || payload.requester_uid
        );
        const explicitRole = pickString(payload, 'role');
        const explicitGrantId = pickString(payload, 'grantId') || pickString(payload, 'grant_id');
        const isCollaboratorRequest = explicitRole === 'collaborator';

        // If the request claims to be from a collaborator but is missing required grant context, reject it
        if (isCollaboratorRequest && (!hasExplicitIdentity || !explicitGrantId)) {
          runtimeManager.sendControlFrame({
            type: 'desktop.mediation.command.response',
            request_id: requestId,
            result: {
              type: 'mediation.result',
              schema_version: 1,
              request_id: requestId,
              ok: false,
              error: {
                code: 'unauthorized',
                message: 'Collaborator requests require requester_uid, grant_id, and role in transport context',
                recoverable: false,
              },
            },
          });
          return;
        }

        const authContext = hasExplicitIdentity ? {
          requesterUid: pickString(payload, 'requesterUid') || pickString(payload, 'requester_uid') || 'unknown',
          requesterDeviceId: pickString(payload, 'requesterDeviceId') || pickString(payload, 'requester_device_id') || 'unknown',
          grantId: explicitGrantId,
          role: (explicitRole === 'collaborator' ? 'collaborator' : 'owner') as 'owner' | 'collaborator',
          grantStatus: (pickString(payload, 'grantStatus') === 'revoked' ? 'revoked' : 'active') as 'active' | 'revoked',
        } : buildDefaultGatewayAuthContext(auth.getStatus() as Record<string, unknown>);

        emitStructuredMainLog('mediation.command.received', {
          request_id: pickString(command, 'request_id') || requestId,
          command: pickString(command, 'command'),
          case_id: pickString(command, 'case_id'),
          party_id: pickString(command, 'party_id'),
          device_id: authContext.requesterDeviceId || '',
          grant_id: authContext.grantId || '',
        });

        // Section 6.2.1: Emit remote-party typing indicators for content-bearing commands.
        // The renderer handles sourceType: 'remote_party' but needs the backend to emit them.
        // chatSurface values must conform to spec enum: 'intake' | 'group' | 'coach_panel'
        const CONTENT_COMMANDS: Record<string, string> = {
          'case.send_group': 'group',
          'case.append_private': 'intake',
          'case.append_draft': 'coach_panel',
        };
        const remoteTypingSurface = commandName ? CONTENT_COMMANDS[commandName] : undefined;
        if (remoteTypingSurface && commandCaseId && commandPartyId) {
          emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
            type: 'typing_start',
            sourceType: 'remote_party',
            sourceId: commandPartyId,
            caseId: commandCaseId,
            chatSurface: remoteTypingSurface,
            timestamp: new Date().toISOString(),
          });
        }

        const handled = await remoteRouter.handleCommand(authContext, command);

        // Emit typing_stop after the remote command is processed
        if (remoteTypingSurface && commandCaseId && commandPartyId) {
          emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
            type: 'typing_stop',
            sourceType: 'remote_party',
            sourceId: commandPartyId,
            caseId: commandCaseId,
            chatSurface: remoteTypingSurface,
            timestamp: new Date().toISOString(),
          });
        }

        const remoteVersion = (
          handled.result.ok === true
            ? Number((handled.result as { remote_version?: unknown }).remote_version || 0)
            : 0
        );
        if (handled.result.ok === true) {
          emitStructuredMainLog('mediation.command.applied', {
            request_id: pickString(command, 'request_id') || requestId,
            command: pickString(command, 'command'),
            case_id: pickString(command, 'case_id'),
            party_id: pickString(command, 'party_id'),
            device_id: authContext.requesterDeviceId || '',
            grant_id: authContext.grantId || '',
            remote_version: remoteVersion > 0 ? remoteVersion : undefined,
          });
        } else {
          const errorRecord = (handled.result.error && typeof handled.result.error === 'object')
            ? handled.result.error as { code?: unknown }
            : { code: '' };
          emitStructuredMainLog('mediation.command.denied', {
            request_id: pickString(command, 'request_id') || requestId,
            command: pickString(command, 'command'),
            case_id: pickString(command, 'case_id'),
            party_id: pickString(command, 'party_id'),
            device_id: authContext.requesterDeviceId || '',
            grant_id: authContext.grantId || '',
            'error.code': typeof errorRecord.code === 'string' ? errorRecord.code.trim() : '',
          });
        }
        if (commandCaseId) {
          try {
            const canonicalCase = mediationService.getCase(commandCaseId);
            emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
              ts: new Date().toISOString(),
              type: 'case.updated',
              action: 'remote_command',
              caseId: commandCaseId,
              case: canonicalCase,
            });
          } catch {
            // best effort only
          }
        }
        for (const eventPayload of handled.events) {
          emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
            ts: new Date().toISOString(),
            ...eventPayload,
          });
        }
        // Fanout events to other bound collaborators (excluding the requester's device)
        fanoutEventsToCollaborators(
          handled.events,
          authContext.requesterDeviceId,
        );

        if (
          handled.result.ok === true
          && commandName === 'case.send_group'
          && commandCaseId
          && commandPartyId
          && commandContent
        ) {
          void (async () => {
            try {
              const followUp = await runMediatorTurn({
                caseId: commandCaseId,
                partyId: commandPartyId,
                content: commandContent,
              });
              const updatedCase = (
                followUp.case
                && typeof followUp.case === 'object'
              ) ? followUp.case as MediationCase : null;
              if (!updatedCase || !remoteRouter) {
                return;
              }

              emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
                ts: new Date().toISOString(),
                type: 'case.updated',
                action: 'mediator_turn',
                caseId: commandCaseId,
                partyId: commandPartyId,
                case: updatedCase,
              });

              const nextRemoteVersion = remoteRouter.nextRemoteVersionForSync(commandCaseId);
              fanoutEventsToCollaborators([
                {
                  type: 'mediation.event',
                  schema_version: 1,
                  event: 'case.updated',
                  case_id: commandCaseId,
                  remote_version: nextRemoteVersion,
                },
              ], undefined);
            } catch (err) {
              emitStructuredMainLog('mediation.mediator_turn.error', {
                case_id: commandCaseId,
                party_id: commandPartyId,
                source: 'runtime_command',
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
        }

        runtimeManager.sendControlFrame({
          type: 'desktop.mediation.command.response',
          request_id: requestId,
          result: handled.result,
        });
      })().catch((err) => {
        runtimeManager.sendControlFrame({
          type: 'desktop.mediation.command.response',
          request_id: pickString(payload, 'request_id'),
          error: {
            code: 'session_error',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      });
    },
    onMediationEventReceived: (payload) => {
      // Handle inbound mediation events pushed from the owner device.
      // Apply the projected case snapshot to local storage and notify the renderer.
      const eventType = typeof payload.event === 'string' ? payload.event : '';
      const caseId = typeof payload.case_id === 'string' ? payload.case_id : '';
      const projectedCase = (payload.case && typeof payload.case === 'object') ? payload.case as Record<string, unknown> : null;

      if (eventType === 'case.updated' && caseId && projectedCase) {
        // ── Security: derive grant/device context from local state only ──
        // Never trust event-embedded identity fields (sender_device_id,
        // grant_id) — they are not transport-authenticated and could be
        // spoofed. Instead, look up the existing local case metadata that
        // was established through the authenticated command-response flow.
        // This also enforces collaborator-side only: owner_local cases are
        // rejected, preventing a collaborator from spoofing events to
        // overwrite owner-authoritative state.
        let existingCase: MediationCase | null = null;
        try {
          existingCase = mediationService.getCase(caseId) as MediationCase;
        } catch {
          // Case not found — cannot accept push sync for unknown cases
        }

        const syncMeta = existingCase?.syncMetadata;
        if (!existingCase || !syncMeta || syncMeta.source !== 'shared_remote') {
          emitStructuredMainLog('mediation.event.receive.skip', {
            event: eventType,
            case_id: caseId,
            reason: !existingCase
              ? 'case_not_found'
              : 'not_shared_remote',
          });
          return;
        }

        const storedGrantId = syncMeta.grantId || '';
        const storedOwnerDeviceId = syncMeta.ownerDeviceId || '';
        if (!storedGrantId || !storedOwnerDeviceId) {
          emitStructuredMainLog('mediation.event.receive.skip', {
            event: eventType,
            case_id: caseId,
            reason: 'incomplete_local_sync_metadata',
          });
          return;
        }

        // When frame-level transport-authenticated context is available,
        // verify it matches the stored metadata as an additional check.
        const frameDeviceId = typeof payload.requesterDeviceId === 'string' ? payload.requesterDeviceId : '';
        const frameGrantId = typeof payload.grantId === 'string' ? payload.grantId : '';
        if (frameDeviceId && frameDeviceId !== 'unknown' && frameDeviceId !== storedOwnerDeviceId) {
          emitStructuredMainLog('mediation.event.receive.skip', {
            event: eventType,
            case_id: caseId,
            reason: 'device_id_mismatch',
            frame_device_id: frameDeviceId,
          });
          return;
        }
        if (frameGrantId && frameGrantId !== storedGrantId) {
          emitStructuredMainLog('mediation.event.receive.skip', {
            event: eventType,
            case_id: caseId,
            reason: 'grant_id_mismatch',
            frame_grant_id: frameGrantId,
          });
          return;
        }

        try {
          const remoteVersion = typeof payload.remote_version === 'number' ? payload.remote_version : undefined;

          const updatedCase = mediationService.upsertRemoteCaseSnapshot({
            projectedCase,
            ownerDeviceId: storedOwnerDeviceId,
            grantId: storedGrantId,
            accessRole: 'collaborator',
            remoteVersion,
          });

          emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
            ts: new Date().toISOString(),
            type: 'case.updated',
            action: 'remote_push_sync',
            caseId,
            case: updatedCase,
          });
        } catch (err) {
          emitStructuredMainLog('mediation.event.receive.error', {
            event: eventType,
            case_id: caseId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    onGrantTerminated: ({ grantId, mode }) => {
      if (!grantId) {
        return;
      }

      const events = !remoteRouter
        ? []
        : (mode === 'revoke' ? remoteRouter.revokeGrant(grantId) : remoteRouter.leaveGrant(grantId));

      for (const eventPayload of events) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          ...eventPayload,
        });
      }

      const syncedCases = mediationService.markRemoteGrantStatus(grantId, mode === 'revoke' ? 'access_revoked' : 'left');
      for (const mediationCase of syncedCases) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          type: 'case.updated',
          action: 'mark_remote_grant_status',
          caseId: mediationCase.id,
          case: mediationCase,
          grantId,
        });
      }

      emitToAllWindows(CH.OUT_GATEWAY_SHARE_EVENT, {
        type: mode === 'revoke' ? 'access.revoked' : 'access.left',
        grantId,
      });
    },
  });
  stopAgentRuntime = () => runtimeManager.ensureStopped();

  const emitLog = (profileId: string, message: string): void => {
    emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
      ts: new Date().toISOString(),
      type: 'log',
      message,
      profileId,
    });
  };

  const localBridge = createLocalPromptBridge();

  // c4_2: Eagerly register built-in providers so contextWindowTokens is available
  // before any transcript compression calls (which can run on the first AI turn).
  // The bridge-manager also calls registerBuiltInProviders() lazily, but that
  // happens too late for first-call paths. This is idempotent via duplicate guards.
  try {
    if (!listProviderIds().includes('chatgpt')) {
      registerBuiltInProviders();
    }
  } catch {
    // best-effort — bridge-manager will retry lazily
  }

  // ── V2 Model Family Defaults (Spec Section 5.4) ───────────────────────
  //
  // Model resolution precedence (highest to lowest):
  //   1. Feature flag override (reserved, not set in v2)
  //   2. Template-level override (reserved, not present in v2 schema)
  //   3. Runtime default — ChatGPT for all three AI roles
  //   4. Per-party localLLM config — DEPRECATED for v2 AI roles
  //
  // Environment variable overrides:
  //   MEDIATION_V2_MODEL_PROVIDER  (default: 'chatgpt')
  //   MEDIATION_V2_MODEL           (default: 'gpt-4o')
  //   MEDIATION_BRIDGE_PROVIDER / MEDIATION_BRIDGE_MODEL — legacy, lower precedence
  const V2_DEFAULT_PROVIDER = process.env.MEDIATION_V2_MODEL_PROVIDER || 'chatgpt';
  const V2_DEFAULT_MODEL = process.env.MEDIATION_V2_MODEL || 'gpt-4o';

  // Profile patterns for v2 AI roles (intake, draft coach, mediator)
  const V2_ROLE_PROFILE_RE = /^(case_|coach_|draftcoach_|mediator_|draft_)/;

  function resolveProfileRuntimeConfig(profileId: string): { provider: string; model: string; cwd: string } {
    const cwd = process.env.MEDIATION_BRIDGE_CWD || process.cwd();

    // V2 AI role profiles default to ChatGPT per Section 5.4
    if (V2_ROLE_PROFILE_RE.test(profileId)) {
      return {
        provider: V2_DEFAULT_PROVIDER,
        model: V2_DEFAULT_MODEL,
        cwd,
      };
    }

    // Non-role profiles use legacy bridge defaults
    return {
      provider: process.env.MEDIATION_BRIDGE_PROVIDER || process.env.PROVIDER || 'claude',
      model: process.env.MEDIATION_BRIDGE_MODEL || process.env.MODEL || 'sonnet',
      cwd,
    };
  }

  const bridgeManager = createBridgeManager({
    localBridge,
    emitLog,
    resolveProfileRuntimeConfig,
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

    // Resolve template-driven prompt (Issue 8 fix)
    let templateVersion: CoachingTemplateVersion | null = null;
    try {
      const sel = mediationCase.templateSelection;
      const resolved = templateService.resolveTemplateForCase(sel?.templateId, sel?.templateVersion);
      templateVersion = resolved.version;
    } catch {
      // Fallback to hardcoded defaults
    }

    const profileId = `case_${caseId}_${partyId}`;
    bridgeManager.ensureBridge(profileId);

    // Emit typing start (Section 6.2.1 TypingIndicatorEvent)
    emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
      type: 'typing_start',
      sourceType: 'ai_generation',
      sourceId: 'intake_coach',
      caseId,
      chatSurface: 'intake',
      timestamp: new Date().toISOString(),
    });

    // Build prompt using template assembly (Section 5.1)
    const runtimeLines = [
      `You are the private intake coach for ${party.displayName}.`,
      '',
      'Complete the following steps exactly:',
      '1. Clarify the user goals in two concise bullets.',
      '2. Clarify hard constraints and non-negotiables in two concise bullets.',
      '3. Identify one realistic concession the user can offer.',
      '4. Identify one concrete request the user should make.',
      '5. Draft a private summary (120-220 words) for mediation context.',
      '6. Keep tone neutral, practical, and non-accusatory.',
      '',
      'Return only the final private summary text (no JSON, no markdown headings).',
    ];
    const promptTemplate = assemblePrompt('intake', templateVersion, mediationCase.mainTopicConfig, runtimeLines);
    const timeoutMs = 120_000;
    try {
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
    } finally {
      // Emit typing stop (Section 6.2.1 TypingIndicatorEvent)
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        type: 'typing_stop',
        sourceType: 'ai_generation',
        sourceId: 'intake_coach',
        caseId,
        chatSurface: 'intake',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const runCoachReply = async (input: {
    caseId: string;
    partyId: string;
    prompt: string;
  }): Promise<Record<string, unknown>> => {
    const caseId = input.caseId.trim();
    const partyId = input.partyId.trim();
    const partyPrompt = input.prompt.trim();
    if (!caseId || !partyId || !partyPrompt) {
      throw new Error('caseId, partyId, and prompt are required');
    }

    const mediationCase = mediationService.getCase(caseId);
    if (mediationCase.phase !== 'awaiting_join' && mediationCase.phase !== 'private_intake') {
      throw new Error('coach replies are only available during awaiting_join/private_intake');
    }

    const participation = mediationCase.partyParticipationById[partyId];
    if (!participation || (participation.state !== 'joined' && participation.state !== 'ready')) {
      throw new Error(`party '${partyId}' must join before private intake`);
    }

    const party = mediationCase.parties.find((entry) => entry.id === partyId);
    if (!party) {
      throw new Error(`party '${partyId}' not found in case`);
    }

    // Resolve template-driven prompt (Section 5.1)
    let templateVersion: CoachingTemplateVersion | null = null;
    try {
      const sel = mediationCase.templateSelection;
      const resolved = templateService.resolveTemplateForCase(sel?.templateId, sel?.templateVersion);
      templateVersion = resolved.version;
    } catch {
      // Fallback to hardcoded defaults
    }

    const profileId = `coach_${caseId}_${partyId}`;
    bridgeManager.ensureBridge(profileId);

    // Emit typing start (Section 6.2.1 TypingIndicatorEvent)
    emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
      type: 'typing_start',
      sourceType: 'ai_generation',
      sourceId: 'intake_coach',
      caseId,
      chatSurface: 'intake',
      timestamp: new Date().toISOString(),
    });

    // Build prompt using template assembly (Section 5.1)
    const thread = mediationCase.privateIntakeByPartyId[partyId];
    const history = (thread?.messages || [])
      .slice(-10)
      .map((message) => {
        const role = message.authorType === 'party' ? 'Party' : 'Coach';
        return `${role}: ${message.text}`;
      })
      .join('\n');

    const runtimeLines = [
      history ? 'Recent private intake transcript:' : '',
      history || '',
      '',
      `Latest party message: ${partyPrompt}`,
      '',
      'Respond with empathy, neutrality, and actionability.',
      'Keep your reply under 180 words and ask at most one clarifying question.',
      'Return only the coach response text.',
    ].filter(Boolean);
    const promptTemplate = assemblePrompt('intake', templateVersion, mediationCase.mainTopicConfig, runtimeLines);
    const timeoutMs = 120_000;
    try {
      const result = await localBridge.requestLocalPrompt(
        profileId,
        {
          objective: `Private intake coach reply for ${party.displayName}`,
          mode: 'manual',
          text: promptTemplate,
          constraints: {
            allow_tool_use: false,
            max_output_chars: 4_000,
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

      const reply = pickString(frame, 'draft_message');
      if (!reply) {
        throw new Error('local prompt returned empty coach reply');
      }

      const updatedCase = mediationService.appendPrivateMessage({
        caseId,
        partyId,
        authorType: 'party_llm',
        text: reply,
        tags: ['coach_reply'],
      });

      return {
        case: updatedCase,
        reply,
      };
    } finally {
      // Emit typing stop (Section 6.2.1 TypingIndicatorEvent)
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        type: 'typing_stop',
        sourceType: 'ai_generation',
        sourceId: 'intake_coach',
        caseId,
        chatSurface: 'intake',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const runDraftSuggestion = async (input: {
    caseId: string;
    draftId: string;
  }): Promise<Record<string, unknown>> => {
    const caseId = input.caseId.trim();
    const draftId = input.draftId.trim();
    if (!caseId || !draftId) {
      throw new Error('caseId and draftId are required');
    }

    const mediationCase = mediationService.getCase(caseId);
    if (mediationCase.phase !== 'group_chat') {
      throw new Error('draft suggestions are only available during group_chat');
    }

    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft) {
      throw new Error(`draft '${draftId}' not found in case`);
    }

    const profileId = `draft_${caseId}_${draft.partyId}`;
    bridgeManager.ensureBridge(profileId);

    const promptTemplate = buildDraftSuggestionPrompt(mediationCase, draftId);
    const timeoutMs = 120_000;
    const result = await localBridge.requestLocalPrompt(
      profileId,
      {
        objective: `Draft suggestion for ${draft.partyId}`,
        mode: 'manual',
        text: promptTemplate,
        constraints: {
          allow_tool_use: false,
          max_output_chars: 4_000,
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

    const suggestedText = pickString(frame, 'draft_message');
    if (!suggestedText) {
      throw new Error('local prompt returned empty draft suggestion');
    }

    const updatedCase = mediationService.setCoachDraftSuggestion(caseId, draftId, suggestedText);
    return {
      case: updatedCase,
      suggestedText,
    };
  };

  // ── V2 Transcript Compression (Section 5.2.1 Normative) ────────────────
  // Deterministic 7-step algorithm with token budgeting, required markers,
  // and structured context_budget_exceeded diagnostics.
  const IMMUTABLE_TURNS = 30;
  const BLOCK_SIZE = 10;
  const FALLBACK_BLOCK_SIZE = 20;
  const CHARS_PER_TOKEN = 4; // approximation for token-budget estimation
  const RESERVED_OUTPUT_TOKENS = 4096; // Section 5.2.1: reserved output buffer
  const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192; // conservative default if provider unknown

  /**
   * Resolve the V2 default provider's context window token limit.
   * Ensures providers are registered before lookup (c4_2) so first-call
   * paths (e.g. first draft-coach turn) get provider-derived budgets
   * rather than the conservative 8192 fallback.
   */
  function resolveV2ContextWindowTokens(): number {
    // Ensure providers are registered — idempotent via duplicate guards.
    try {
      if (!listProviderIds().length) {
        registerBuiltInProviders();
      }
    } catch {
      // best-effort
    }

    try {
      // Try the V2 default provider first
      const plugin = getProvider(V2_DEFAULT_PROVIDER);
      if (plugin?.capabilities?.contextWindowTokens) {
        return plugin.capabilities.contextWindowTokens;
      }

      // Fallback: use the largest context window from any registered provider
      let maxTokens = 0;
      for (const id of listProviderIds()) {
        try {
          const p = getProvider(id);
          const tokens = p?.capabilities?.contextWindowTokens || 0;
          if (tokens > maxTokens) maxTokens = tokens;
        } catch {
          // skip
        }
      }
      return maxTokens > 0 ? maxTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
    } catch {
      return DEFAULT_CONTEXT_WINDOW_TOKENS;
    }
  }

  /** Estimate token count from text length */
  function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Extractive summary for a block of turns (Section 5.2.1 step 2):
   * Retain first and last turn verbatim; intermediate turns → one sentence each.
   */
  function extractiveSummary(turns: Array<{ label: string; text: string }>, subjectLineOnly = false): string {
    if (turns.length === 0) return '';
    if (turns.length === 1) return `${turns[0].label}: ${turns[0].text}`;

    const lines: string[] = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (i === 0 || i === turns.length - 1) {
        // First and last turn: keep verbatim
        lines.push(`${t.label}: ${t.text}`);
      } else if (subjectLineOnly) {
        // Fallback: subject-line-only extracts (≤15 tokens ~ ≤60 chars)
        const subject = t.text.slice(0, 60).split(/[.!?]/)[0] || t.text.slice(0, 60);
        lines.push(`${t.label}: ${subject.trim()}`);
      } else {
        // Normal: one sentence per turn
        const firstSentence = t.text.split(/[.!?]\s/)[0] || t.text.slice(0, 80);
        lines.push(`${t.label}: ${firstSentence.trim()}`);
      }
    }
    return lines.join(' | ');
  }

  /**
   * Section 5.2.1 normative transcript compression.
   * @param maxContextTokens - provider model's context window (minus reserved output)
   */
  function compressTranscript(
    messages: Array<{ authorType: string; authorPartyId?: string; text: string }>,
    parties: Array<{ id: string; displayName: string }>,
    prefix: string,
    maxContextTokens?: number,
  ): string {
    const budgetTokens = (maxContextTokens || DEFAULT_CONTEXT_WINDOW_TOKENS) - RESERVED_OUTPUT_TOKENS;

    const labeled = messages.map((m, idx) => {
      let label: string;
      if (m.authorType === 'party') {
        label = parties.find((p) => p.id === m.authorPartyId)?.displayName || m.authorPartyId || 'Participant';
      } else if (m.authorType === 'mediator_llm') {
        label = 'Mediator';
      } else {
        label = m.authorType === 'party_llm' ? 'Coach' : 'System';
      }
      return { label, text: m.text, turnIndex: idx + 1 };
    });

    // Step 1: Split into immutable (recent 30) and compressible (older)
    const immutableStart = Math.max(0, labeled.length - IMMUTABLE_TURNS);
    const immutable = labeled.slice(immutableStart);
    const older = labeled.slice(0, immutableStart);

    const formatTurn = (t: { label: string; text: string }) => `${t.label}: ${t.text}`;
    const immutableText = immutable.map(formatTurn).join('\n');
    const immutableTokens = estimateTokens(immutableText);

    // Step 7: If immutable segments alone exceed budget, emit context_budget_exceeded
    // Structured diagnostics surfaced as IPC error.details (Section 5.2.1 / 7.0)
    if (immutableTokens > budgetTokens) {
      throw new DomainError(
        'context_budget_exceeded',
        `Immutable segment (${immutable.length} turns, ~${immutableTokens} tokens) exceeds context budget (~${budgetTokens} tokens)`,
        {
          requiredTokens: immutableTokens,
          availableTokens: budgetTokens,
          immutableTurnCount: immutable.length,
          totalTurnCount: labeled.length,
          contextWindowTokens: maxContextTokens || DEFAULT_CONTEXT_WINDOW_TOKENS,
          reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
        },
      );
    }

    if (older.length === 0) {
      return immutableText;
    }

    // Step 2-3: Group older turns into blocks with extractive summaries
    const remainingTokenBudget = budgetTokens - immutableTokens;
    let compressed = compressOlderTurns(older, BLOCK_SIZE, false);

    // Step 4: Check if compressed + immutable fits within budget
    if (estimateTokens(compressed) > remainingTokenBudget) {
      // Step 5: Fallback — increase block size to 20, subject-line-only extracts
      compressed = compressOlderTurns(older, FALLBACK_BLOCK_SIZE, true);
    }

    // Step 6: If still over budget, truncate oldest compressed blocks
    if (estimateTokens(compressed) > remainingTokenBudget) {
      const lines = compressed.split('\n');
      // Remove oldest blocks (from the front) until it fits
      while (lines.length > 0 && estimateTokens(lines.join('\n')) > remainingTokenBudget) {
        lines.shift();
      }
      // Prepend truncation marker (Section 5.2.1 step 6)
      const firstOmitted = older[0]?.turnIndex || 1;
      const lastOmittedIdx = older.length - (lines.length > 0 ? FALLBACK_BLOCK_SIZE * lines.length : 0);
      const lastOmitted = lastOmittedIdx > 0 ? older[Math.min(lastOmittedIdx - 1, older.length - 1)]?.turnIndex || older.length : older.length;
      lines.unshift(`[Transcript truncated: turns ${firstOmitted}–${lastOmitted} omitted]`);
      compressed = lines.join('\n');

      // Final safety: hard-truncate to fit
      if (estimateTokens(compressed) > remainingTokenBudget) {
        const maxChars = remainingTokenBudget * CHARS_PER_TOKEN;
        compressed = compressed.slice(0, maxChars - 80) + `\n[Transcript truncated: turns 1–${older[older.length - 1]?.turnIndex || older.length} omitted]`;
      }
    }

    return compressed ? `${compressed}\n${immutableText}` : immutableText;
  }

  /**
   * Compress older turns into block summaries with normative markers.
   * Returns compressed text with `[Compressed: turns N–M]` markers (Section 5.2.1).
   */
  function compressOlderTurns(
    turns: Array<{ label: string; text: string; turnIndex: number }>,
    blockSize: number,
    subjectLineOnly: boolean,
  ): string {
    const blocks: string[] = [];
    for (let i = 0; i < turns.length; i += blockSize) {
      const block = turns.slice(i, i + blockSize);
      const firstTurn = block[0].turnIndex;
      const lastTurn = block[block.length - 1].turnIndex;
      const summary = extractiveSummary(block, subjectLineOnly);
      // Section 5.2.1 step 3: required [Compressed: turns N–M] marker
      blocks.push(`[Compressed: turns ${firstTurn}–${lastTurn}] ${summary}`);
    }
    return blocks.join('\n');
  }

  // ── V2 Draft Coach Turn runner (Spec Section 5.2) ───────────────────────
  const runDraftCoachTurn = async (input: {
    caseId: string;
    draftId: string;
    partyId: string;
    userMessage: string;
    composeText?: string;
  }): Promise<Record<string, unknown>> => {
    const caseId = input.caseId.trim();
    const draftId = input.draftId.trim();
    const partyId = input.partyId.trim();
    const userMessage = input.userMessage.trim();
    if (!caseId || !draftId || !partyId) {
      throw new Error('caseId, draftId, and partyId are required');
    }

    const mediationCase = mediationService.getCase(caseId);
    if (mediationCase.phase !== 'group_chat') {
      throw new Error('draft coach is only available during group_chat');
    }

    // F-06 gating check
    if (!mediationCase.mainTopicConfig?.topic?.trim() || !mediationCase.templateSelection?.templateId) {
      throw new DomainError('main_topic_not_configured', 'Main topic and template must be configured');
    }

    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft) {
      throw new DomainError('draft_not_found', `draft '${draftId}' not found in case`);
    }

    const party = mediationCase.parties.find((entry) => entry.id === partyId);
    if (!party) {
      throw new Error(`party '${partyId}' not found in case`);
    }

    // Ensure draft has coach metadata initialized
    if (!draft.coachMeta) {
      mediationService.initializeDraftCoachMeta(caseId, draftId);
    }

    // Resolve pinned template version for prompt assembly (Issue 4 fix)
    let templateVersion: CoachingTemplateVersion | null = null;
    try {
      const sel = mediationCase.templateSelection;
      const resolved = templateService.resolveTemplateForCase(
        sel?.templateId,
        sel?.templateVersion,
      );
      templateVersion = resolved.version;
    } catch {
      // Fallback to hardcoded defaults
    }

    const mainTopicCfg = mediationCase.mainTopicConfig || null;

    // Build context: private intake + group chat + coach history
    // Uses Section 5.2.1 transcript compression for group chat
    const intakeThread = mediationCase.privateIntakeByPartyId[partyId];
    const intakeContext = (intakeThread?.messages || [])
      .slice(-6)
      .map((m) => `[Intake] ${m.authorType === 'party' ? 'Party' : 'Coach'}: ${m.text}`)
      .join('\n');

    let groupChatContext: string;
    try {
      groupChatContext = compressTranscript(
        mediationCase.groupChat.messages,
        mediationCase.parties,
        'Group',
        resolveV2ContextWindowTokens(),
      );
    } catch (compErr) {
      if (compErr instanceof DomainError && compErr.code === 'context_budget_exceeded') {
        throw compErr; // Propagate context_budget_exceeded
      }
      // Fallback to simple slice
      groupChatContext = mediationCase.groupChat.messages
        .slice(-10)
        .map((m) => {
          if (m.authorType === 'party') {
            const pName = mediationCase.parties.find((p) => p.id === m.authorPartyId)?.displayName || m.authorPartyId || 'Participant';
            return `[Group] ${pName}: ${m.text}`;
          }
          if (m.authorType === 'mediator_llm') {
            return `[Group] Mediator: ${m.text}`;
          }
          return `[Group] System: ${m.text}`;
        })
        .join('\n');
    }

    // Get refreshed case for coach history
    const refreshedCase = mediationService.getCase(caseId);
    const refreshedDraft = refreshedCase.groupChat.draftsById[draftId];
    const coachMeta = refreshedDraft?.coachMeta;
    const coachHistoryContext = (coachMeta?.coachHistory || [])
      .slice(-12)
      .map((m) => `${m.author === 'party' ? 'Party' : 'Coach'}: ${m.text}`)
      .join('\n');

    // Phase-aware prompt construction (Section 4.2.1)
    // Per spec: user input in confirm_ready resets to exploring.
    // Only an explicit "Generate Formal Draft" action (empty userMessage) triggers formal draft.
    const currentPhase = coachMeta?.phase || 'exploring';
    const isFormalDraftRequest = currentPhase === 'confirm_ready' && !userMessage;

    // If user sent a message while in confirm_ready, reset phase to exploring
    if (currentPhase === 'confirm_ready' && userMessage) {
      mediationService.setDraftReadiness(caseId, draftId, false);
    }

    const runtimeLines: string[] = [];
    if (intakeContext) {
      runtimeLines.push('Private intake context:', intakeContext, '');
    }
    if (groupChatContext) {
      runtimeLines.push('Group chat context:', groupChatContext, '');
    }
    if (coachHistoryContext) {
      runtimeLines.push('Draft coach conversation:', coachHistoryContext, '');
    }

    if (isFormalDraftRequest) {
      runtimeLines.push(
        `Now generate a formal draft message for ${party.displayName} to send in the group chat.`,
        'The draft should be calm, specific, non-accusatory, and negotiation-oriented.',
        'Length: 60-180 words.',
        'Return only the final message text.',
      );
    } else {
      if (userMessage) {
        runtimeLines.push(`Latest party message: ${userMessage}`, '');
      }
      runtimeLines.push(
        `Help ${party.displayName} prepare a message for the group chat.`,
        'Analyze their perspective and provide coaching guidance.',
        'Keep your reply under 180 words and ask at most one clarifying question.',
        'Return only the coaching response text.',
      );
    }

    const promptText = assemblePrompt('draft_coach', templateVersion, mainTopicCfg, runtimeLines);

    // Emit typing start (Section 6.2.1 TypingIndicatorEvent)
    emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
      type: 'typing_start',
      sourceType: 'ai_generation',
      sourceId: 'draft_coach',
      caseId,
      chatSurface: 'coach_panel',
      timestamp: new Date().toISOString(),
    });

    const profileId = `draftcoach_${caseId}_${partyId}`;
    bridgeManager.ensureBridge(profileId);

    const timeoutMs = 120_000;
    try {
      const result = await localBridge.requestLocalPrompt(
        profileId,
        {
          objective: isFormalDraftRequest
            ? `Formal draft for ${party.displayName}`
            : `Draft coaching for ${party.displayName}`,
          mode: 'manual',
          text: promptText,
          constraints: {
            allow_tool_use: false,
            max_output_chars: 6_000,
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

      const responseText = pickString(frame, 'draft_message');
      if (!responseText) {
        throw new Error('local prompt returned empty draft coach response');
      }

      // Record the user message if provided
      if (userMessage) {
        mediationService.appendCoachDraftMessage(caseId, draftId, 'party', userMessage);
      }

      // Record the coach response
      mediationService.appendCoachDraftMessage(caseId, draftId, 'party_llm', responseText);

      let updatedCase: Record<string, unknown>;
      if (isFormalDraftRequest) {
        // Set formal draft
        updatedCase = mediationService.setFormalDraftReady(caseId, draftId, responseText) as any;
      } else {
        // Get updated case after recording messages
        updatedCase = mediationService.getCase(caseId) as any;
      }

      return {
        case: updatedCase,
        draftId,
        phase: isFormalDraftRequest ? 'formal_draft_ready' : (coachMeta?.phase || 'exploring'),
        coachResponse: responseText,
      };
    } finally {
      // Emit typing stop (Section 6.2.1 TypingIndicatorEvent)
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        type: 'typing_stop',
        sourceType: 'ai_generation',
        sourceId: 'draft_coach',
        caseId,
        chatSurface: 'coach_panel',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const runMediatorTurn = async (input: {
    caseId: string;
    partyId: string;
    content: string;
  }): Promise<Record<string, unknown>> => {
    const caseId = input.caseId.trim();
    const partyId = input.partyId.trim();
    const content = input.content.trim();
    if (!caseId || !partyId || !content) {
      throw new Error('caseId, partyId, and content are required');
    }

    const mediationCase = mediationService.getCase(caseId);
    if (mediationCase.phase !== 'group_chat') {
      throw new Error('mediator follow-up is only available during group_chat');
    }

    const party = mediationCase.parties.find((entry) => entry.id === partyId);
    if (!party) {
      throw new Error(`party '${partyId}' not found in case`);
    }

    // Resolve template-driven prompt (Section 5.1)
    let templateVersion: CoachingTemplateVersion | null = null;
    try {
      const sel = mediationCase.templateSelection;
      const resolved = templateService.resolveTemplateForCase(sel?.templateId, sel?.templateVersion);
      templateVersion = resolved.version;
    } catch {
      // Fallback to hardcoded defaults
    }

    const profileId = `mediator_${caseId}`;
    bridgeManager.ensureBridge(profileId);

    // Emit typing start (Section 6.2.1 TypingIndicatorEvent)
    emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
      type: 'typing_start',
      sourceType: 'ai_generation',
      sourceId: 'mediator',
      caseId,
      chatSurface: 'group',
      timestamp: new Date().toISOString(),
    });

    // Build mediator prompt using template assembly (Section 5.1)
    // Uses Section 5.2.1 transcript compression
    const participantNames = mediationCase.parties.map((entry) => entry.displayName || entry.id).join(', ');
    let transcript: string;
    try {
      transcript = compressTranscript(
        mediationCase.groupChat.messages,
        mediationCase.parties,
        'Group',
        resolveV2ContextWindowTokens(),
      );
    } catch (compErr) {
      if (compErr instanceof DomainError && compErr.code === 'context_budget_exceeded') {
        throw compErr;
      }
      // Fallback to simple slice
      transcript = mediationCase.groupChat.messages
        .slice(-14)
        .map((message) => {
          if (message.authorType === 'party') {
            const pName = mediationCase.parties.find((entry) => entry.id === message.authorPartyId)?.displayName
              || message.authorPartyId
              || 'Participant';
            return `${pName}: ${message.text}`;
          }
          if (message.authorType === 'mediator_llm') {
            return `Mediator: ${message.text}`;
          }
          return `Assistant: ${message.text}`;
        })
        .join('\n');
    }

    const mediatorRuntimeLines = [
      `Participants: ${participantNames}.`,
      'Use participant display names exactly as listed. Never use generic labels like "Party A" or "Party B".',
      '',
      `Latest speaker: ${party.displayName}`,
      `Latest message: ${content}`,
      '',
      'Recent transcript:',
      transcript || '(no prior transcript)',
      '',
      'Write one concise facilitator response that moves the conversation forward.',
      'Keep tone neutral and practical, 45-120 words, and ask at most one focused follow-up question.',
      'Return only the mediator message text.',
    ];
    const promptTemplate = assemblePrompt('mediator', templateVersion, mediationCase.mainTopicConfig, mediatorRuntimeLines);
    const timeoutMs = 45_000;
    try {
      const result = await localBridge.requestLocalPrompt(
        profileId,
        {
          objective: `Mediator follow-up for ${mediationCase.topic}`,
          mode: 'manual',
          text: promptTemplate,
          constraints: {
            allow_tool_use: false,
            max_output_chars: 3_000,
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

      const mediatorReply = pickString(frame, 'draft_message');
      if (!mediatorReply) {
        throw new Error('local prompt returned empty mediator reply');
      }

      const updatedCase = mediationService.appendGroupMessage({
        caseId,
        authorType: 'mediator_llm',
        text: mediatorReply,
        tags: ['mediator_followup'],
      });

      return {
        case: updatedCase,
        reply: mediatorReply,
      };
    } finally {
      // Emit typing stop (Section 6.2.1 TypingIndicatorEvent)
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        type: 'typing_stop',
        sourceType: 'ai_generation',
        sourceId: 'mediator',
        caseId,
        chatSurface: 'group',
        timestamp: new Date().toISOString(),
      });
    }
  };

  const idempotencyStorePath = path.join(app.getPath('userData'), 'mediation-idempotency.json');
  const routerStatePath = path.join(app.getPath('userData'), 'mediation-router-state.json');
  remoteRouter = new RemoteMediationRouter({
    mediationService: mediationService as any,
    idempotencyStore: new IdempotencyStore(idempotencyStorePath),
    persistence: new FileBackedRouterStatePersistence(routerStatePath),
    runDraftSuggestion: async ({ caseId, draftId }) => {
      const result = await runDraftSuggestion({ caseId, draftId });
      const mediationCase = result.case as MediationCase | undefined;
      const suggestedText = typeof result.suggestedText === 'string' ? result.suggestedText : '';
      if (!mediationCase || !suggestedText) {
        throw new Error('draft suggestion failed');
      }
      return {
        case: mediationCase,
        suggestedText,
      };
    },
  });

  /**
   * Fanout mediation events to active collaborator sessions via the gateway.
   * case.updated payloads are always re-projected per recipient so actor-scoped
   * private fields never leak across collaborators.
   */
  const fanoutEventsToCollaborators = (events: MediationEventEnvelope[], excludeDeviceId?: string): void => {
    if (!remoteRouter || events.length === 0) {
      return;
    }

    const sendFanoutEvent = (deviceId: string, event: MediationEventEnvelope): void => {
      void (async () => {
        try {
          const gatewayUrl = auth.getGatewayUrl();
          await ensureRemoteSessionReady(sessionManager, gatewayUrl, deviceId);
          await sessionManager.sendMessage(gatewayUrl, deviceId, JSON.stringify(event));
        } catch (err) {
          emitStructuredMainLog('mediation.fanout.error', {
            device_id: deviceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    };

    for (const event of events) {
      const caseId = typeof event.case_id === 'string' ? event.case_id : '';
      if (!caseId) {
        continue;
      }

      const collaborators = remoteRouter
        .getActiveBoundCollaborators(caseId)
        .filter((collab) => collab.actorDeviceId && collab.actorDeviceId !== excludeDeviceId);

      if (collaborators.length === 0) {
        continue;
      }

      if (event.event === 'case.updated') {
        let canonicalCase: MediationCase | null = null;
        try {
          canonicalCase = mediationService.getCase(caseId) as MediationCase;
        } catch {
          canonicalCase = null;
        }
        if (!canonicalCase) {
          continue;
        }

        const remoteVersion = typeof event.remote_version === 'number'
          ? event.remote_version
          : remoteRouter.currentRemoteVersion(caseId);

        for (const collab of collaborators) {
          const projected = projectCaseForActor(canonicalCase, collab.partyId, 'collaborator');
          sendFanoutEvent(collab.actorDeviceId, {
            type: 'mediation.event',
            schema_version: 1,
            event: 'case.updated',
            case_id: caseId,
            case: projected,
            remote_version: remoteVersion,
          });
        }
        continue;
      }

      const passthroughEvent: MediationEventEnvelope = {
        type: 'mediation.event',
        schema_version: 1,
        event: event.event,
        ...(event.case_id ? { case_id: event.case_id } : {}),
        ...(event.party_id ? { party_id: event.party_id } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(typeof event.remote_version === 'number' ? { remote_version: event.remote_version } : {}),
      };
      for (const collab of collaborators) {
        sendFanoutEvent(collab.actorDeviceId, passthroughEvent);
      }
    }
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

  const buildAuthPayload = (): Record<string, unknown> => ({
    ...(auth.getStatus() as Record<string, unknown>),
    runtime: runtimeManager.getStatus(),
  });

  emitAuthChanged = (): void => {
    emitToAllWindows(CH.OUT_AUTH_CHANGED, buildAuthPayload());
  };

  const startMediationDeviceRuntime = async (): Promise<Record<string, unknown>> => {
    const launch = await auth.getRuntimeLaunchConfig();
    if (!launch) {
      return {
        ok: false,
        error: 'Sign in is required before starting mediation device runtime',
      };
    }

    const result = await runtimeManager.ensureStarted(launch);
    emitAuthChanged();
    return {
      ok: true,
      deviceId: launch.deviceId,
      status: result.status,
    };
  };

  const stopMediationDeviceRuntime = async (): Promise<Record<string, unknown>> => {
    await runtimeManager.ensureStopped();
    emitAuthChanged();
    return { ok: true };
  };

  void (async () => {
    try {
      const status = auth.getStatus() as Record<string, unknown>;
      if (status.signedIn === true) {
        await startMediationDeviceRuntime();
      }
    } catch (err) {
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        ts: new Date().toISOString(),
        type: 'log',
        profileId: 'mediation_device',
        message: `failed to auto-start mediation device runtime: ${err instanceof Error ? err.message : String(err)}`,
      });
      emitAuthChanged();
    }
  })();

  await initPluginRegistry(path.join(app.getPath('userData'), 'room-plugins')).catch(() => undefined);

  registry.handle(ipcMain, CH.MEDIATION_REMOTE_GRANT_CASE, async (_event, payload) => {
    try {
      const grantId = pickString(payload || {}, 'grantId');
      const caseId = pickString(payload || {}, 'caseId');
      if (!grantId || !caseId) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'grantId and caseId are required',
            recoverable: true,
          },
        };
      }
      remoteRouter.grantCaseVisibility(grantId, caseId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle(ipcMain, CH.MEDIATION_REMOTE_TERMINATE_GRANT, async (_event, payload) => {
    try {
      const grantId = pickString(payload || {}, 'grantId');
      const mode = pickString(payload || {}, 'mode');
      if (!grantId || (mode !== 'revoke' && mode !== 'leave')) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'grantId and mode (revoke|leave) are required',
            recoverable: true,
          },
        };
      }

      const events = mode === 'revoke'
        ? remoteRouter.revokeGrant(grantId)
        : remoteRouter.leaveGrant(grantId);
      for (const eventPayload of events) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          ...eventPayload,
        });
      }
      return { ok: true, events };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.handle(ipcMain, CH.MEDIATION_REMOTE_COMMAND, async (_event, payload) => {
    try {
      const authStatus = auth.getStatus() as Record<string, unknown>;
      const context = parseGatewayAuthContext(
        (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {},
        authStatus,
      );
      const command = (
        payload
        && typeof payload === 'object'
        && (payload as Record<string, unknown>).command
        && typeof (payload as Record<string, unknown>).command === 'object'
      ) ? (payload as Record<string, unknown>).command : payload;
      const commandRecord = (command && typeof command === 'object')
        ? command as Record<string, unknown>
        : {};
      const commandName = pickString(commandRecord, 'command');
      const commandCaseId = pickString(commandRecord, 'case_id');
      const commandPartyId = pickString(commandRecord, 'party_id');
      const commandPayload = (
        commandRecord.payload
        && typeof commandRecord.payload === 'object'
      ) ? commandRecord.payload as Record<string, unknown> : {};
      const commandMessage = (
        commandPayload.message
        && typeof commandPayload.message === 'object'
      ) ? commandPayload.message as Record<string, unknown> : {};
      const commandContent = pickString(commandMessage, 'content');

      const handled = await remoteRouter.handleCommand(context, command);
      for (const eventPayload of handled.events) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          ...eventPayload,
        });
      }
      // Fanout events to bound collaborator sessions
      fanoutEventsToCollaborators(
        handled.events,
        context.requesterDeviceId,
      );

      if (
        handled.result.ok === true
        && commandName === 'case.send_group'
        && commandCaseId
        && commandPartyId
        && commandContent
      ) {
        void (async () => {
          try {
            const followUp = await runMediatorTurn({
              caseId: commandCaseId,
              partyId: commandPartyId,
              content: commandContent,
            });
            const updatedCase = (
              followUp.case
              && typeof followUp.case === 'object'
            ) ? followUp.case as MediationCase : null;
            if (!updatedCase || !remoteRouter) {
              return;
            }

            emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
              ts: new Date().toISOString(),
              type: 'case.updated',
              action: 'mediator_turn',
              caseId: commandCaseId,
              partyId: commandPartyId,
              case: updatedCase,
            });

            const remoteVersion = remoteRouter.nextRemoteVersionForSync(commandCaseId);
            fanoutEventsToCollaborators([
              {
                type: 'mediation.event',
                schema_version: 1,
                event: 'case.updated',
                case_id: commandCaseId,
                remote_version: remoteVersion,
              },
            ], undefined);
          } catch (err) {
            emitStructuredMainLog('mediation.mediator_turn.error', {
              case_id: commandCaseId,
              party_id: commandPartyId,
              source: 'remote_command',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }

      return handled.result as unknown as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        type: 'mediation.result',
        schema_version: 1,
        request_id: '',
        error: {
          code: 'session_error',
          message: err instanceof Error ? err.message : String(err),
          recoverable: true,
        },
      };
    }
  });

  registerAuthIpc(ipcMain, {
    registry: registry as any,
    auth,
    emitAuthChanged,
    getStatusPayload: buildAuthPayload,
    onSignedIn: startMediationDeviceRuntime,
    onSignedOut: stopMediationDeviceRuntime,
  });

  registerGatewayIpc(ipcMain, {
    registry: registry as any,
    auth,
    gatewayClient,
    sessionManager,
    emitToAllWindows,
    emitStructuredLog: emitStructuredMainLog,
    onShareGrantLinked: (grantId, caseId) => {
      remoteRouter?.grantCaseVisibility(grantId, caseId);
    },
    onShareGrantRevoked: (grantId) => {
      if (!grantId) {
        return;
      }
      if (!remoteRouter) {
        return;
      }
      const events = remoteRouter.revokeGrant(grantId);
      for (const eventPayload of events) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          ...eventPayload,
        });
      }

      const syncedCases = mediationService.markRemoteGrantStatus(grantId, 'access_revoked');
      for (const mediationCase of syncedCases) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          type: 'case.updated',
          action: 'mark_remote_grant_status',
          caseId: mediationCase.id,
          case: mediationCase,
          grantId,
        });
      }
    },
    onShareGrantLeft: (grantId) => {
      if (!grantId) {
        return;
      }
      if (!remoteRouter) {
        return;
      }
      const events = remoteRouter.leaveGrant(grantId);
      for (const eventPayload of events) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          ...eventPayload,
        });
      }

      const syncedCases = mediationService.markRemoteGrantStatus(grantId, 'left');
      for (const mediationCase of syncedCases) {
        emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
          ts: new Date().toISOString(),
          type: 'case.updated',
          action: 'mark_remote_grant_status',
          caseId: mediationCase.id,
          case: mediationCase,
          grantId,
        });
      }
    },
  });

  registerMediationIpc(ipcMain, {
    registry: registry as any,
    mediationService: mediationService as any,
    runIntakeTemplate,
    runCoachReply,
    runDraftSuggestion,
    runDraftCoachTurn,
    runMediatorTurn,
    isAdmin: (actorId: string) => {
      const profile = userProfileStore.getProfile(actorId);
      return profile?.isAdmin === true;
    },
    // c4_1: Strict template resolvability check (no default fallback).
    // Uses isTemplateVersionResolvable which validates exact templateId + versionNumber
    // existence without falling back to the system default template.
    isTemplateResolvable: (templateId: string, templateVersion: number) => {
      return templateService.isTemplateVersionResolvable(templateId, templateVersion);
    },
    emitMediationEvent: (payload) => {
      emitToAllWindows(CH.OUT_MEDIATION_EVENT, {
        ts: new Date().toISOString(),
        ...payload,
      });
      // Fanout owner-initiated local case updates to bound collaborators.
      // Each collaborator receives a projected (redacted) view of the case
      // filtered through projectCaseForActor so private intake data is never leaked.
      const caseId = typeof payload.caseId === 'string' ? payload.caseId : '';
      if (caseId && remoteRouter && payload.type === 'case.updated') {
        try {
          const mediationCase = mediationService.getCase(caseId) as MediationCase;
          const collaborators = remoteRouter.getActiveBoundCollaborators(caseId);
          // Bump remote version for each owner-initiated sync event so
          // collaborator devices always see a monotonically increasing version
          // and don't reject the update as stale.
          const remoteVersion = collaborators.length > 0
            ? remoteRouter.nextRemoteVersionForSync(caseId)
            : remoteRouter.currentRemoteVersion(caseId);
          for (const collab of collaborators) {
            if (!collab.actorDeviceId) {
              continue;
            }
            const projected = projectCaseForActor(mediationCase, collab.partyId, 'collaborator');
            // Do NOT embed grant_id / sender_device_id in the event payload.
            // The collaborator derives grant/device context from its locally
            // stored authenticated case metadata, not from unverified payload fields.
            const syncEvent = {
              type: 'mediation.event',
              schema_version: 1,
              event: 'case.updated',
              case_id: caseId,
              case: projected,
              remote_version: remoteVersion,
            };
            void (async () => {
              try {
                const gatewayUrl = auth.getGatewayUrl();
                await ensureRemoteSessionReady(sessionManager, gatewayUrl, collab.actorDeviceId);
                await sessionManager.sendMessage(gatewayUrl, collab.actorDeviceId, JSON.stringify(syncEvent));
              } catch (err) {
                emitStructuredMainLog('mediation.fanout.error', {
                  device_id: collab.actorDeviceId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            })();
          }
        } catch {
          // best-effort fanout; case may not exist or other non-critical error
        }
      }
    },
    emitStructuredLog: emitStructuredMainLog,
  });

  registerTemplateIpc(ipcMain, {
    registry: registry as any,
    templateService: templateService as any,
    userProfileStore: userProfileStore as any,
    caseStore: mediationStore as any,
    auditLogPath,
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

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (enforceSingleInstance) {
    app.on('second-instance', () => {
      const existing = mainWindow || BrowserWindow.getAllWindows()[0] || null;
      if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) {
          existing.restore();
        }
        existing.focus();
        return;
      }
      void createMainWindow();
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
}

app.on('before-quit', (event) => {
  if (quitDrainState === 'ready') {
    return;
  }

  event.preventDefault();
  if (quitDrainState === 'draining') {
    return;
  }
  quitDrainState = 'draining';

  const stopAgent = stopAgentRuntime;
  const stopBridge = stopBridgeManager;
  stopAgentRuntime = null;
  stopBridgeManager = null;

  void (async () => {
    try {
      if (stopAgent) {
        await stopAgent();
      }
    } catch {
      // best-effort shutdown
    }

    try {
      stopBridge?.();
    } catch {
      // best-effort shutdown
    }

    quitDrainState = 'ready';
    clearSignalForceExitTimer();
    app.quit();
  })();
});

app.on('will-quit', () => {
  clearSignalForceExitTimer();
  if (parentWatchTimer) {
    clearInterval(parentWatchTimer);
    parentWatchTimer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
