import { getState, patchState, resetState, upsertCase, setToast, removeToast } from './state.js';
import { escapeHtml, renderMarkdownUntrusted } from './markdown.js';

const api = window.mediationDesktop;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;
const SHARE_CONTEXT_STORAGE_KEY = 'mediation.share.consume_result.v1';

const startScreen = document.getElementById('start-screen');
const startButton = document.getElementById('start-btn');
const startSpinner = document.getElementById('start-spinner');
const startStatus = document.getElementById('start-status');
const appShell = document.getElementById('app-shell');
const appRoot = document.getElementById('app-root');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast');

let toastTimer = null;

/* ============================================================
   HELPERS
   ============================================================ */

function nowIso() {
  return new Date().toISOString();
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatShortDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return formatShortDate(iso);
}

function parseEpochSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.trunc(num);
}

function formatEpochSeconds(value) {
  const seconds = parseEpochSeconds(value);
  if (!seconds) return '';
  return formatRelativeTime(new Date(seconds * 1000).toISOString());
}

function getInitial(name) {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

function getAvatarClass(partyId) {
  if (partyId === 'party_a') return 'avatar-a';
  if (partyId === 'party_b') return 'avatar-b';
  return 'avatar-a';
}

function friendlyPhase(phase) {
  switch (phase) {
    case 'awaiting_join': return 'Waiting';
    case 'private_intake': return 'Preparing';
    case 'group_chat': return 'In Session';
    case 'resolved': return 'Resolved';
    case 'closed': return 'Closed';
    default: return phase || '';
  }
}

function phasePillClass(phase) {
  if (phase === 'resolved') return 'resolved';
  if (phase === 'closed') return 'closed';
  return 'active';
}

function getCaseSource(caseData) {
  const source = caseData?.syncMetadata?.source;
  return source === 'shared_remote' ? 'shared_remote' : 'owner_local';
}

function sourceLabel(caseData) {
  return getCaseSource(caseData) === 'shared_remote' ? 'Shared' : 'Owned';
}

function friendlySyncStatus(caseData) {
  const status = String(caseData?.syncMetadata?.syncStatus || '').trim().toLowerCase();
  if (!status) return getCaseSource(caseData) === 'shared_remote' ? 'Stale' : 'Live';
  if (status === 'reconnecting') return 'Reconnecting';
  if (status === 'access_revoked') return 'Access Revoked';
  if (status === 'left') return 'Left';
  if (status === 'removed') return 'Removed';
  if (status === 'stale') return 'Stale';
  return 'Live';
}

function normalizeError(resultOrError, fallback = 'Something went wrong') {
  if (!resultOrError) return fallback;
  if (typeof resultOrError === 'string') return resultOrError;

  const err = resultOrError.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
    if (typeof err.code === 'string' && err.code.trim()) return err.code.trim();
  }
  if (resultOrError instanceof Error) return resultOrError.message;
  return fallback;
}

const REMOTE_MUTATING_COMMANDS = new Set([
  'case.join',
  'case.append_private',
  'case.set_consent',
  'case.set_private_summary',
  'case.set_ready',
  'case.send_group',
  'case.create_draft',
  'case.append_draft',
  'case.run_draft_suggestion',
  'case.submit_suggestion',
  'case.approve_draft',
  'case.reject_draft',
  'case.resolve',
  'case.close',
]);

function makeRequestId(prefix = 'req') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function makeIdempotencyKey(prefix = 'idem') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 12)}`;
}

function isSharedCase(caseData) {
  return getCaseSource(caseData) === 'shared_remote';
}

function isReadOnlySharedCase(caseData) {
  const status = String(caseData?.syncMetadata?.syncStatus || '').trim().toLowerCase();
  return status === 'access_revoked' || status === 'left' || status === 'removed';
}

function normalizeShareConsumeResult(input) {
  if (!input || typeof input !== 'object') return null;
  const grantId = typeof input.grantId === 'string' ? input.grantId.trim() : '';
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (!grantId || !deviceId) return null;
  const status = normalizeGrantStatus(input.status || 'active');
  return {
    grantId,
    deviceId,
    role: typeof input.role === 'string' ? input.role : 'collaborator',
    status,
    acceptedAt: typeof input.acceptedAt === 'string' && input.acceptedAt.trim()
      ? input.acceptedAt.trim()
      : nowIso(),
  };
}

function persistShareConsumeResult(input) {
  try {
    const normalized = normalizeShareConsumeResult(input);
    if (!normalized) {
      localStorage.removeItem(SHARE_CONTEXT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SHARE_CONTEXT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // best effort
  }
}

function loadPersistedShareConsumeResult() {
  try {
    const raw = localStorage.getItem(SHARE_CONTEXT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return normalizeShareConsumeResult(parsed);
  } catch {
    return null;
  }
}

function buildRemoteCommandEnvelope(input) {
  const payload = input && input.payload && typeof input.payload === 'object'
    ? { ...input.payload }
    : {};
  if (
    input
    && typeof input.command === 'string'
    && REMOTE_MUTATING_COMMANDS.has(input.command)
    && typeof payload.idempotency_key !== 'string'
  ) {
    payload.idempotency_key = makeIdempotencyKey(input.command.replace(/\./g, '_'));
  }

  return {
    type: 'mediation.command',
    schema_version: 1,
    request_id: input?.requestId || makeRequestId('med'),
    command: String(input?.command || ''),
    ...(input?.caseId ? { case_id: String(input.caseId) } : {}),
    ...(input?.partyId ? { party_id: String(input.partyId) } : {}),
    payload,
  };
}

function getRemoteContextFromCase(caseData) {
  if (!caseData || typeof caseData !== 'object') return null;
  const metadata = caseData.syncMetadata && typeof caseData.syncMetadata === 'object'
    ? caseData.syncMetadata
    : {};
  const ownerDeviceId = typeof metadata.ownerDeviceId === 'string' ? metadata.ownerDeviceId.trim() : '';
  const grantId = typeof metadata.grantId === 'string' ? metadata.grantId.trim() : '';
  const localPartyId = typeof metadata.localPartyId === 'string' ? metadata.localPartyId.trim() : '';
  if (!ownerDeviceId || !grantId) return null;
  return { ownerDeviceId, grantId, localPartyId };
}

function getRemoteContextFromShare() {
  const shareState = getShareState();
  const consume = shareState.consumeResult || {};
  const ownerDeviceId = typeof consume.deviceId === 'string' ? consume.deviceId.trim() : '';
  const grantId = typeof consume.grantId === 'string' ? consume.grantId.trim() : '';
  if (!ownerDeviceId || !grantId) return null;
  return { ownerDeviceId, grantId };
}

async function syncRemoteCaseFromResult(input) {
  if (!input || typeof input !== 'object') return null;
  const projectedCase = input.projectedCase;
  if (!projectedCase || typeof projectedCase !== 'object') return null;

  const result = await api.mediation.syncRemoteCase({
    projectedCase,
    ownerDeviceId: input.ownerDeviceId,
    grantId: input.grantId,
    accessRole: 'collaborator',
    localPartyId: input.localPartyId || undefined,
    remoteVersion: input.remoteVersion,
    syncStatus: input.syncStatus || 'live',
  });
  if (!result || result.ok !== true || !result.case) {
    return null;
  }
  return result.case;
}

async function sendGatewayMediationCommand(ownerDeviceId, envelope, options = {}) {
  const gatewayResult = await api.gateway.sendMediationCommand({
    deviceId: ownerDeviceId,
    command: envelope,
    timeoutMs: options.timeoutMs || 60000,
  });
  if (!gatewayResult || gatewayResult.ok !== true) {
    return { ok: false, error: normalizeError(gatewayResult, 'Unable to reach remote mediation host') };
  }

  const result = gatewayResult.result && typeof gatewayResult.result === 'object'
    ? gatewayResult.result
    : null;
  if (!result) {
    return { ok: false, error: 'Remote mediation host returned an invalid response' };
  }
  if (result.ok !== true) {
    return { ok: false, error: normalizeError(result, 'Remote mediation command failed'), result };
  }
  return { ok: true, result };
}

/* ============================================================
   TOAST
   ============================================================ */

function showToast(message, level = 'info', timeoutMs = 3800) {
  setToast(message, level);
  renderToast();

  if (toastTimer) clearTimeout(toastTimer);

  const current = getState().toast;
  if (!current) return;

  const toastId = current.id;
  toastTimer = setTimeout(() => {
    const state = getState();
    if (state.toast && state.toast.id === toastId) {
      removeToast();
      renderToast();
    }
  }, timeoutMs);
}

function renderToast() {
  const state = getState();
  const toast = state.toast;
  if (!toast) {
    toastRoot.className = 'hidden';
    toastRoot.textContent = '';
    return;
  }
  toastRoot.className = toast.level || 'info';
  toastRoot.textContent = toast.message;
}

/* ============================================================
   AUTH & RUNTIME
   ============================================================ */

function isRuntimeReady(auth) {
  if (!auth || auth.signedIn !== true) return false;
  const hasDevice = Boolean(auth.mediationDevice && auth.mediationDevice.id);
  const runtime = auth.runtime || {};
  return hasDevice && runtime.running === true && runtime.ready === true;
}

function getOwnDeviceId() {
  const state = getState();
  return state.auth && state.auth.mediationDevice && typeof state.auth.mediationDevice.id === 'string'
    ? state.auth.mediationDevice.id.trim()
    : '';
}

function updateStartVisibility() {
  const state = getState();
  const ready = isRuntimeReady(state.auth);

  if (ready) {
    startScreen.classList.add('hidden');
    appShell.classList.remove('hidden');
  } else {
    startScreen.classList.remove('hidden');
    appShell.classList.add('hidden');
  }

  if (state.startBusy) {
    startButton.classList.add('hidden');
    startSpinner.classList.add('visible');
    startStatus.textContent = state.startMessage || 'Setting things up...';
    startStatus.className = 'small';
  } else if (!ready) {
    startButton.classList.remove('hidden');
    startSpinner.classList.remove('visible');
    startStatus.textContent = '';
    startStatus.className = 'small muted';
  } else {
    startButton.classList.add('hidden');
    startSpinner.classList.remove('visible');
    startStatus.textContent = '';
    startStatus.className = 'small muted';
  }

  startButton.disabled = Boolean(state.startBusy);
}

/* ============================================================
   SHARE LINK PARSING
   ============================================================ */

function parseShareTokenInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const parseTokenFromUrl = (urlString) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return null;
    }

    const tokenFromQuery = parsed.searchParams.get('token');
    if (tokenFromQuery) {
      return tokenFromQuery;
    }

    const sharePrefix = '/share/';
    if (typeof parsed.pathname === 'string' && parsed.pathname.startsWith(sharePrefix)) {
      const tokenPart = parsed.pathname.slice(sharePrefix.length).split('/')[0];
      if (tokenPart) return tokenPart;
    }

    if (parsed.protocol === 'commands-desktop:' && parsed.hostname === 'share' && parsed.pathname.length > 1) {
      return parsed.pathname.slice(1).split('/')[0] || null;
    }

    return null;
  };

  const token = String(parseTokenFromUrl(raw) || raw).trim();
  if (!SHARE_TOKEN_RE.test(token)) {
    return null;
  }

  return { token, raw };
}

function extractLaunchLinkInput() {
  try {
    const url = new URL(window.location.href);
    const shareParsed = parseShareTokenInput(url.toString());
    if (shareParsed) return shareParsed.raw;
  } catch {
    // ignore malformed launch url
  }
  return '';
}

/* ============================================================
   CASE / PARTY HELPERS
   ============================================================ */

function getPartyState(caseData, partyId) {
  return caseData.partyParticipationById && caseData.partyParticipationById[partyId]
    ? caseData.partyParticipationById[partyId].state || 'invited'
    : 'invited';
}

function choosePartyForCase(caseData) {
  const state = getState();
  if (!caseData || !caseData.id || !Array.isArray(caseData.parties) || caseData.parties.length === 0) return '';

  const localPartyId = typeof caseData?.syncMetadata?.localPartyId === 'string'
    ? caseData.syncMetadata.localPartyId.trim()
    : '';
  if (localPartyId && caseData.parties.some((party) => party.id === localPartyId)) {
    state.partyByCase[caseData.id] = localPartyId;
    return localPartyId;
  }

  const selected = state.partyByCase[caseData.id];
  if (selected && caseData.parties.some((party) => party.id === selected)) return selected;

  const readyParty = caseData.parties.find((party) => getPartyState(caseData, party.id) === 'ready');
  if (readyParty) {
    state.partyByCase[caseData.id] = readyParty.id;
    return readyParty.id;
  }

  const joinedParty = caseData.parties.find((party) => getPartyState(caseData, party.id) === 'joined');
  if (joinedParty) {
    state.partyByCase[caseData.id] = joinedParty.id;
    return joinedParty.id;
  }

  state.partyByCase[caseData.id] = caseData.parties[0].id;
  return caseData.parties[0].id;
}

function getCurrentParty(caseData) {
  const partyId = choosePartyForCase(caseData);
  if (!partyId) return null;
  const party = caseData.parties.find((entry) => entry.id === partyId);
  return party ? { partyId, party } : null;
}

function getPrivateThread(caseData, partyId) {
  if (!caseData || !caseData.privateIntakeByPartyId) return { messages: [], summary: '', resolved: false };
  return caseData.privateIntakeByPartyId[partyId] || { messages: [], summary: '', resolved: false };
}

function ensureCaseInList(caseData) {
  upsertCase(caseData);
  const state = getState();
  state.cases.sort((a, b) => {
    const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bt - at;
  });
}

function setCaseData(caseData) {
  const state = getState();
  if (!caseData || !caseData.id) return;
  state.caseId = caseData.id;
  state.caseData = caseData;
  choosePartyForCase(caseData);
  ensureCaseInList(caseData);
}

/* ============================================================
   AUTH FLOWS
   ============================================================ */

async function refreshAuthStatus(options = {}) {
  const result = await api.auth.getStatus();
  const state = getState();
  state.auth = result;

  if (!options.silent && !isRuntimeReady(result)) {
    const runtime = result && result.runtime ? result.runtime : null;
    if (runtime && runtime.lastError) {
      showToast('Connection issue. Please try again.', 'error', 5000);
    }
  }

  updateStartVisibility();
  return result;
}

async function waitForRuntimeReady(timeoutMs = 75_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const auth = await refreshAuthStatus({ silent: true });
    if (isRuntimeReady(auth)) return auth;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return getState().auth;
}

async function startFlow() {
  const state = getState();
  state.startBusy = true;
  state.startMessage = 'Setting things up...';
  updateStartVisibility();

  try {
    const signInResult = await api.auth.signIn();
    if (!signInResult || signInResult.ok !== true) {
      throw new Error(normalizeError(signInResult, 'Unable to sign in'));
    }

    state.startMessage = 'Almost ready...';
    updateStartVisibility();

    const auth = await waitForRuntimeReady();
    if (!isRuntimeReady(auth)) {
      throw new Error('Having trouble connecting. Please try again.');
    }

    state.startMessage = '';
    showToast('Welcome back!', 'success');
    await refreshCases();
    if (state.pendingInvite && state.pendingInvite.type === 'share' && state.pendingInvite.input) {
      const pendingInput = String(state.pendingInvite.input);
      state.pendingInvite = null;
      await consumeShareInviteLink(pendingInput, { silent: true });
    }
    render();
  } catch (err) {
    state.startMessage = normalizeError(err, 'Unable to connect. Please try again.');
    showToast(state.startMessage, 'error', 5000);
  } finally {
    state.startBusy = false;
    updateStartVisibility();
  }
}

async function signOutFlow() {
  const result = await api.auth.signOut();
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Sign out failed'), 'error');
    return;
  }

  persistShareConsumeResult(null);
  resetState();
  patchState({ startBusy: false, startMessage: '' });
  await refreshAuthStatus({ silent: true });
  render();
}

/* ============================================================
   DATA FETCHING
   ============================================================ */

async function refreshCases() {
  const result = await api.mediation.list();
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to load your mediations'), 'error');
    return;
  }

  const state = getState();
  const incoming = Array.isArray(result.cases) ? result.cases.slice() : [];
  state.cases = incoming.filter((entry) => {
    const status = String(entry?.syncMetadata?.syncStatus || '').trim().toLowerCase();
    return status !== 'left' && status !== 'removed';
  });
  state.cases.sort((a, b) => {
    const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bt - at;
  });

  if (state.caseId) {
    const found = state.cases.find((entry) => entry.id === state.caseId);
    if (found) {
      state.caseData = found;
      choosePartyForCase(found);
    } else {
      state.caseId = null;
      state.caseData = null;
      state.activeSubview = null;
    }
  }

  hydrateShareContextFromCases(state.cases);
}

function deriveShareContextFromCases(cases) {
  if (!Array.isArray(cases)) return null;
  const sharedLive = cases
    .filter((entry) => getCaseSource(entry) === 'shared_remote' && !isReadOnlySharedCase(entry))
    .filter((entry) => {
      const metadata = entry?.syncMetadata;
      return metadata && typeof metadata.ownerDeviceId === 'string' && typeof metadata.grantId === 'string';
    })
    .sort((a, b) => {
      const at = Date.parse(a?.syncMetadata?.syncUpdatedAt || a?.updatedAt || a?.createdAt || '');
      const bt = Date.parse(b?.syncMetadata?.syncUpdatedAt || b?.updatedAt || b?.createdAt || '');
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });
  const first = sharedLive[0];
  if (!first) return null;
  return normalizeShareConsumeResult({
    grantId: first.syncMetadata.grantId,
    deviceId: first.syncMetadata.ownerDeviceId,
    role: 'collaborator',
    status: 'active',
    acceptedAt: first.syncMetadata.syncUpdatedAt || first.updatedAt || first.createdAt || nowIso(),
  });
}

function hydrateShareContextFromCases(cases) {
  const shareState = getShareState();
  if (shareState.consumeResult) {
    return;
  }
  const derived = deriveShareContextFromCases(cases);
  if (!derived) {
    return;
  }
  shareState.consumeResult = derived;
  persistShareConsumeResult(derived);
}

function hydrateShareContextFromStorage() {
  const shareState = getShareState();
  if (shareState.consumeResult) {
    return;
  }
  const persisted = loadPersistedShareConsumeResult();
  if (persisted) {
    shareState.consumeResult = persisted;
  }
}

async function refreshGatewayDevices(options = {}) {
  const result = await api.gateway.fetchDevices();
  if (!result || result.ok !== true) {
    if (!options.silent) {
      showToast(normalizeError(result, 'Unable to refresh shared devices'), 'error');
    }
    return;
  }

  const shareState = getShareState();
  shareState.devices = Array.isArray(result.devices) ? result.devices : [];
  shareState.devicesLoadedAt = nowIso();
}

async function loadCase(caseId, options = {}) {
  const result = await api.mediation.get(caseId);
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to load this mediation'), 'error');
    return null;
  }

  setCaseData(result.case);
  if (isSharedCase(result.case) && !isReadOnlySharedCase(result.case)) {
    const context = getRemoteContextFromCase(result.case);
    if (context) {
      const fetched = await getRemoteCaseSnapshot(context, result.case.id);
      if (fetched.ok && fetched.result.case && typeof fetched.result.case === 'object') {
        const syncedCase = await syncRemoteCaseFromResult({
          projectedCase: fetched.result.case,
          ownerDeviceId: context.ownerDeviceId,
          grantId: context.grantId,
          localPartyId: context.localPartyId || undefined,
          remoteVersion: Number.isFinite(fetched.result.remote_version) ? Number(fetched.result.remote_version) : undefined,
          syncStatus: 'live',
        });
        if (syncedCase) {
          setCaseData(syncedCase);
          if (syncedCase.syncMetadata?.localPartyId) {
            getState().partyByCase[syncedCase.id] = syncedCase.syncMetadata.localPartyId;
          }
        }
      }
    }
  }

  const state = getState();
  if (options.activeSubview !== undefined) {
    state.activeSubview = options.activeSubview;
  }

  render();
  const ownDeviceId = getOwnDeviceId();
  const isOwnerLocalCase = getCaseSource(state.caseData) === 'owner_local';
  const shareState = getShareState();
  if (
    ownDeviceId
    && isOwnerLocalCase
    && !shareState.grantsLoadingByDevice[ownDeviceId]
    && !shareState.grantsByDevice[ownDeviceId]
  ) {
    void refreshShareGrants(ownDeviceId, { silent: true });
  }
  return result.case;
}

function getShareState() {
  const state = getState();
  if (!state.share || typeof state.share !== 'object') {
    state.share = {
      consumeInput: '',
      consumeResult: null,
      devices: [],
      devicesLoadedAt: null,
      grantsByDevice: {},
      grantsLoadingByDevice: {},
      mutatingGrantIds: {},
      lastCreatedInviteByDevice: {},
      discoveredCasesByGrant: {},
      discoveringCasesByGrant: {},
      joiningCaseKeys: {},
    };
    return state.share;
  }
  state.share.devices = Array.isArray(state.share.devices) ? state.share.devices : [];
  state.share.devicesLoadedAt = typeof state.share.devicesLoadedAt === 'string' ? state.share.devicesLoadedAt : null;
  state.share.discoveredCasesByGrant = state.share.discoveredCasesByGrant || {};
  state.share.discoveringCasesByGrant = state.share.discoveringCasesByGrant || {};
  state.share.joiningCaseKeys = state.share.joiningCaseKeys || {};
  return state.share;
}

async function listRemoteCasesForShare(shareContext) {
  if (!shareContext) {
    return { ok: false, error: 'No active shared device selected' };
  }
  const envelope = buildRemoteCommandEnvelope({
    command: 'case.list',
    payload: {},
  });
  return sendGatewayMediationCommand(shareContext.ownerDeviceId, envelope);
}

async function getRemoteCaseSnapshot(context, caseId) {
  const envelope = buildRemoteCommandEnvelope({
    command: 'case.get',
    caseId,
    payload: {},
  });
  return sendGatewayMediationCommand(context.ownerDeviceId, envelope);
}

async function sendRemoteCaseCommand(input) {
  const context = input?.context || getRemoteContextFromCase(input?.caseData) || getRemoteContextFromShare();
  if (!context) {
    return { ok: false, error: 'Remote case context is unavailable' };
  }

  const envelope = buildRemoteCommandEnvelope({
    command: input.command,
    caseId: input.caseId,
    partyId: input.partyId,
    payload: input.payload || {},
  });

  const commandResult = await sendGatewayMediationCommand(context.ownerDeviceId, envelope);
  if (!commandResult.ok) {
    return commandResult;
  }

  const result = commandResult.result;
  let syncedCase = null;
  if (result.case && typeof result.case === 'object') {
    syncedCase = await syncRemoteCaseFromResult({
      projectedCase: result.case,
      ownerDeviceId: context.ownerDeviceId,
      grantId: context.grantId,
      localPartyId: input.localPartyId || context.localPartyId || '',
      remoteVersion: Number.isFinite(result.remote_version) ? Number(result.remote_version) : undefined,
      syncStatus: 'live',
    });
  }

  return {
    ok: true,
    result,
    case: syncedCase,
    context,
  };
}

async function discoverSharedCases(options = {}) {
  const shareContext = getRemoteContextFromShare();
  const shareState = getShareState();
  if (!shareContext) {
    if (!options.silent) {
      showToast('Accept a share link first.', 'error');
    }
    return;
  }

  shareState.discoveringCasesByGrant[shareContext.grantId] = true;
  if (!options.silent) render();

  try {
    const listed = await listRemoteCasesForShare(shareContext);
    if (!listed.ok) {
      if (!options.silent) {
        showToast(normalizeError(listed, 'Unable to discover remote cases'), 'error');
      }
      return;
    }

    const cases = Array.isArray(listed.result.cases) ? listed.result.cases : [];
    shareState.discoveredCasesByGrant[shareContext.grantId] = cases;

    for (const entry of cases) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const caseId = typeof entry.case_id === 'string' ? entry.case_id.trim() : '';
      const role = typeof entry.role === 'string' ? entry.role.trim() : '';
      if (!caseId || role !== 'joined') {
        continue;
      }

      const fetched = await getRemoteCaseSnapshot(shareContext, caseId);
      if (!fetched.ok) {
        continue;
      }
      const syncedCase = await syncRemoteCaseFromResult({
        projectedCase: fetched.result.case,
        ownerDeviceId: shareContext.ownerDeviceId,
        grantId: shareContext.grantId,
        remoteVersion: Number.isFinite(fetched.result.remote_version) ? Number(fetched.result.remote_version) : undefined,
      });
      if (syncedCase) {
        ensureCaseInList(syncedCase);
        if (syncedCase.syncMetadata?.localPartyId) {
          getState().partyByCase[syncedCase.id] = syncedCase.syncMetadata.localPartyId;
        }
      }
    }
  } finally {
    shareState.discoveringCasesByGrant[shareContext.grantId] = false;
    render();
  }
}

function normalizeGrantStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return 'unknown';
  return status;
}

function isRevocableGrantStatus(status) {
  return status === 'pending' || status === 'active' || status === 'suspended';
}

function extractInviteUrl(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.inviteUrl === 'string' && result.inviteUrl.trim()) return result.inviteUrl.trim();
  if (typeof result.invite_url === 'string' && result.invite_url.trim()) return result.invite_url.trim();
  if (typeof result.url === 'string' && result.url.trim()) return result.url.trim();
  return '';
}

function normalizeGrantRow(row) {
  if (!row || typeof row !== 'object') return null;
  const grantId = typeof row.grantId === 'string' && row.grantId.trim()
    ? row.grantId.trim()
    : '';
  if (!grantId) return null;

  return {
    grantId,
    deviceId: typeof row.deviceId === 'string' ? row.deviceId.trim() : '',
    caseId: typeof row.caseId === 'string'
      ? row.caseId.trim()
      : (typeof row.case_id === 'string' ? row.case_id.trim() : ''),
    granteeEmail: typeof row.granteeEmail === 'string' ? row.granteeEmail.trim() : '',
    granteeUid: typeof row.granteeUid === 'string' ? row.granteeUid.trim() : '',
    role: typeof row.role === 'string' ? row.role.trim() : '',
    status: normalizeGrantStatus(row.status),
    inviteUrl: typeof row.inviteUrl === 'string'
      ? row.inviteUrl.trim()
      : (typeof row.invite_url === 'string'
          ? row.invite_url.trim()
          : (typeof row.url === 'string' ? row.url.trim() : '')),
    grantExpiresAt: parseEpochSeconds(row.grantExpiresAt),
    acceptedAt: parseEpochSeconds(row.acceptedAt),
    createdAt: parseEpochSeconds(row.createdAt),
  };
}

function formatGrantTime(seconds) {
  if (!seconds) return 'never';
  return formatEpochSeconds(seconds) || 'just now';
}

/* ============================================================
   STATUS HELPERS
   ============================================================ */

function caseStatusLine(caseData, partyId) {
  if (!caseData) return '';

  const syncStatus = String(caseData?.syncMetadata?.syncStatus || '').trim().toLowerCase();
  if (syncStatus === 'access_revoked') return 'Access revoked';
  if (syncStatus === 'left') return 'You left this shared case';
  if (syncStatus === 'removed') return 'Case removed';

  if (caseData.phase === 'group_chat') return 'Mediation in progress';
  if (caseData.phase === 'resolved') return 'Successfully resolved';
  if (caseData.phase === 'closed') return 'Closed';

  const ownState = getPartyState(caseData, partyId);
  const otherParties = caseData.parties.filter((party) => party.id !== partyId);
  const invitedOther = otherParties.find((party) => getPartyState(caseData, party.id) === 'invited');
  const joinedOther = otherParties.find((party) => getPartyState(caseData, party.id) === 'joined');

  if (ownState === 'invited') return 'Waiting for you to join';
  if (ownState === 'joined' && invitedOther) return `Waiting for ${invitedOther.displayName}`;
  if (ownState === 'joined') return 'Preparation in progress';
  if (ownState === 'ready' && invitedOther) return `Waiting for ${invitedOther.displayName} to join`;
  if (ownState === 'ready' && joinedOther) return `Waiting for ${joinedOther.displayName} to finish`;

  return 'Active';
}

/* ============================================================
   VIEW ROUTER
   ============================================================ */

function resolveView() {
  const state = getState();
  const caseData = state.caseData;

  if (!caseData) return 'dashboard';
  if (state.activeSubview === 'private-intake') return 'private-intake';
  if (state.activeSubview === 'intake-summary') return 'intake-summary';
  if (state.activeSubview === 'group-chat') return 'group-chat';
  if (caseData.phase === 'resolved') return 'resolved';
  if (caseData.phase === 'closed') return 'closed';
  return 'case-detail';
}

/* ============================================================
   RENDER: PARTICIPANT ROW
   ============================================================ */

function renderParticipantRow(caseData, party, currentPartyId) {
  const state = getPartyState(caseData, party.id);
  const thread = getPrivateThread(caseData, party.id);
  let label = 'Waiting to join';
  if (state === 'joined') {
    label = thread.messages.length > 0 ? 'Preparing' : 'Joined';
  }
  if (state === 'ready') label = 'Ready';

  const isYou = party.id === currentPartyId;
  const avatarCls = getAvatarClass(party.id);

  return `
    <div class="participant-row">
      <div class="participant">
        <span class="avatar avatar-sm ${avatarCls}">${escapeHtml(getInitial(party.displayName))}</span>
        <strong>${escapeHtml(isYou ? `${party.displayName} (You)` : party.displayName)}</strong>
      </div>
      <span class="status-line">${escapeHtml(label)}</span>
    </div>
  `;
}

/* ============================================================
   RENDER: CASE CARD
   ============================================================ */

function renderCaseCard(caseData) {
  const state = getState();
  const currentPartyId = state.partyByCase[caseData.id]
    || (caseData.parties[0] ? caseData.parties[0].id : '');
  const status = caseStatusLine(caseData, currentPartyId);
  const source = sourceLabel(caseData);

  const avatars = caseData.parties.map((party) => {
    const cls = getAvatarClass(party.id);
    return `<span class="avatar avatar-sm ${cls}">${escapeHtml(getInitial(party.displayName))}</span>`;
  }).join('');

  const phaseClass = (caseData.phase === 'resolved' || caseData.phase === 'closed')
    ? `phase-${caseData.phase}` : '';

  return `
    <button class="case-card ${phaseClass}" data-action="open-case" data-case-id="${escapeHtml(caseData.id)}">
      <div class="case-head">
        <p class="case-topic">${escapeHtml(caseData.topic)}</p>
        <div class="row" style="gap: 8px;">
          <span class="source-pill">${escapeHtml(source)}</span>
          <span class="phase-pill ${phasePillClass(caseData.phase)}">${escapeHtml(friendlyPhase(caseData.phase))}</span>
        </div>
      </div>
      <div class="status-line">${escapeHtml(status)}</div>
      <div class="case-card-footer">
        <div class="case-avatars">${avatars}</div>
        <span class="case-meta">${escapeHtml(formatRelativeTime(caseData.updatedAt || caseData.createdAt))}</span>
      </div>
    </button>
  `;
}

/* ============================================================
   RENDER: DASHBOARD VIEW
   ============================================================ */

function renderDashboardView() {
  const state = getState();
  const shareState = getShareState();
  const consumeResult = shareState.consumeResult;
  const auth = state.auth || {};
  const email = auth.email || '';
  const userInitial = email ? email.charAt(0).toUpperCase() : 'U';
  const isOnline = isRuntimeReady(auth);
  const consumeMutating = consumeResult && consumeResult.grantId
    ? shareState.mutatingGrantIds[String(consumeResult.grantId)] === true
    : false;
  const consumeGrantId = consumeResult && typeof consumeResult.grantId === 'string'
    ? consumeResult.grantId
    : '';
  const discoveredCases = consumeGrantId && Array.isArray(shareState.discoveredCasesByGrant[consumeGrantId])
    ? shareState.discoveredCasesByGrant[consumeGrantId]
    : [];
  const discoveringCases = consumeGrantId
    ? shareState.discoveringCasesByGrant[consumeGrantId] === true
    : false;

  const createForm = state.createFormExpanded
    ? `
      <form class="panel stack" data-submit-action="create-case">
        <h3 class="section-title">Start a New Mediation</h3>
        <p class="muted small">Set up a mediation session between two parties.</p>
        <div class="grid-2">
          <label class="stack">
            <span class="small muted">Topic</span>
            <input name="topic" required placeholder="e.g. Partnership agreement dispute" />
          </label>
          <label class="stack">
            <span class="small muted">Description (optional)</span>
            <input name="description" placeholder="Brief context about the situation" />
          </label>
        </div>
        <div class="grid-2">
          <label class="stack">
            <span class="small muted">Your name</span>
            <input name="partyAName" required placeholder="Your name" />
          </label>
          <label class="stack">
            <span class="small muted">Other party's name</span>
            <input name="partyBName" required placeholder="Their name" />
          </label>
        </div>
        <div class="view-actions">
          <button type="submit" class="primary">Create Mediation</button>
          <button type="button" class="ghost" data-action="toggle-create-form">Cancel</button>
        </div>
      </form>
    `
    : '';

  const joinForm = state.joinFormExpanded
    ? `
      <form class="panel stack" data-submit-action="preview-or-consume-link">
        <h3 class="section-title">Join from Invite Link</h3>
        <label class="stack">
          <span class="small muted">Link</span>
          <input name="inviteLink" value="${escapeHtml(state.joinLinkInput || '')}" placeholder="Paste the link you received..." required />
        </label>
        <div class="view-actions">
          <button type="submit" class="primary">Continue</button>
          <button type="button" class="ghost" data-action="toggle-join-form">Cancel</button>
        </div>
      </form>
    `
    : '';

  const consumedShare = consumeResult && typeof consumeResult === 'object'
    ? `
      <div class="panel stack">
        <h3 class="section-title">Gateway Share Accepted</h3>
        <div class="small muted">Owner device: <code>${escapeHtml(String(consumeResult.deviceId || 'unknown'))}</code></div>
        <div class="small muted">Grant: <code>${escapeHtml(String(consumeResult.grantId || 'unknown'))}</code></div>
        <div class="view-actions">
          <button
            type="button"
            class="ghost"
            data-action="discover-shared-cases"
            ${discoveringCases ? 'disabled' : ''}
          >
            ${discoveringCases ? 'Discovering...' : 'Discover Cases'}
          </button>
          ${consumeResult.grantId ? `
            <button
              type="button"
              class="ghost"
              data-action="leave-share-grant"
              data-grant-id="${escapeHtml(String(consumeResult.grantId))}"
              ${consumeMutating ? 'disabled' : ''}
            >
              ${consumeMutating ? 'Leaving...' : 'Leave Share'}
            </button>
          ` : ''}
          <button type="button" class="ghost" data-action="clear-share-consume">Clear</button>
        </div>
        ${discoveredCases.length > 0 ? `
          <div class="grant-list">
            ${discoveredCases.map((entry) => {
              if (!entry || typeof entry !== 'object') return '';
              const caseId = typeof entry.case_id === 'string' ? entry.case_id.trim() : '';
              if (!caseId) return '';
              const title = typeof entry.title === 'string' ? entry.title : caseId;
              const role = typeof entry.role === 'string' ? entry.role : 'available';
              const partyRows = Array.isArray(entry.parties) ? entry.parties : [];
              const joinButtons = role === 'joined'
                ? `
                  <button
                    type="button"
                    class="ghost"
                    data-action="open-remote-case"
                    data-case-id="${escapeHtml(caseId)}"
                  >
                    Open
                  </button>
                `
                : partyRows.map((party) => {
                  if (!party || typeof party !== 'object') return '';
                  const partyId = typeof party.party_id === 'string' ? party.party_id.trim() : '';
                  const joined = party.joined === true;
                  if (!partyId || joined) return '';
                  const joinKey = `${caseId}:${partyId}`;
                  const joining = shareState.joiningCaseKeys[joinKey] === true;
                  const label = typeof party.label === 'string' ? party.label : partyId;
                  return `
                    <button
                      type="button"
                      class="ghost"
                      data-action="join-remote-case"
                      data-case-id="${escapeHtml(caseId)}"
                      data-party-id="${escapeHtml(partyId)}"
                      ${joining ? 'disabled' : ''}
                    >
                      ${joining ? 'Joining...' : `Join ${escapeHtml(label)}`}
                    </button>
                  `;
                }).join('');

              return `
                <div class="grant-row">
                  <div class="grant-main">
                    <div class="grant-email">${escapeHtml(title)}</div>
                    <div class="small muted">Phase: ${escapeHtml(String(entry.phase || 'unknown'))} · Role: ${escapeHtml(role)}</div>
                  </div>
                  <div class="row" style="gap: 6px;">
                    ${joinButtons || '<span class="small muted">No open slots</span>'}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `
    : '';

  const casesHtml = state.cases.length > 0
    ? `<div class="case-list">${state.cases.map((c) => renderCaseCard(c)).join('')}</div>`
    : `
      <div class="empty-state">
        <div class="empty-title">No mediations yet</div>
        <div class="empty-desc">Start a new mediation or accept a share link to get going.</div>
      </div>
    `;

  return `
    <div class="dashboard-grid">
      <section class="panel">
        <div class="dashboard-header">
          <div class="dashboard-brand">
            <span class="brand-name">Mediate</span>
          </div>
          <div class="dashboard-user">
            <div class="user-avatar">
              <span class="avatar avatar-a">${escapeHtml(userInitial)}</span>
              <span class="status-dot ${isOnline ? '' : 'offline'}"></span>
            </div>
            <button class="ghost" data-action="sign-out" style="font-size: var(--text-xs);">Sign Out</button>
          </div>
        </div>

        <div class="actions-row">
          <div class="action-card" data-action="toggle-create-form">
            <div class="action-title">+ New Mediation</div>
            <div class="action-desc">Start a guided mediation session</div>
          </div>
          <div class="action-card secondary" data-action="toggle-join-form">
            <div class="action-title">Join from Invite Link</div>
            <div class="action-desc">Open a shared mediation</div>
          </div>
        </div>
      </section>

      ${createForm}
      ${joinForm}
      ${consumedShare}

      <section class="panel">
        <h3 class="section-title">Your Mediations</h3>
        ${casesHtml}
      </section>
    </div>
  `;
}

/* ============================================================
   RENDER: CASE DETAIL VIEW
   ============================================================ */

function renderCaseDetailView() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return '<section class="panel">Mediation not found.</section>';

  const current = getCurrentParty(caseData);
  const currentPartyId = current ? current.partyId : '';
  const thread = current ? getPrivateThread(caseData, currentPartyId) : { messages: [], summary: '', resolved: false };
  const ownState = current ? getPartyState(caseData, currentPartyId) : 'invited';
  const readOnlyShared = isReadOnlySharedCase(caseData);
  const everyoneReady = caseData.parties.every((party) => getPartyState(caseData, party.id) === 'ready');
  const ownDeviceId = getOwnDeviceId();
  const isOwnerLocalCase = getCaseSource(caseData) === 'owner_local';
  const shareState = getShareState();
  const deviceGrantCache = ownDeviceId ? (shareState.grantsByDevice[ownDeviceId] || null) : null;
  const grantsLoading = Boolean(ownDeviceId && shareState.grantsLoadingByDevice[ownDeviceId] === true);
  const shouldCheckExistingInvites = Boolean(
    ownDeviceId
    && isOwnerLocalCase
    && !deviceGrantCache
    && !grantsLoading,
  );
  if (shouldCheckExistingInvites) {
    void refreshShareGrants(ownDeviceId, { silent: true });
  }
  const checkingExistingInvites = grantsLoading || shouldCheckExistingInvites;
  const grants = deviceGrantCache && Array.isArray(deviceGrantCache.grants) ? deviceGrantCache.grants : [];
  const matchingActiveGrant = grants
    .filter((grant) => isRevocableGrantStatus(normalizeGrantStatus(grant.status)))
    .find((grant) => {
      const grantCaseId = typeof grant.caseId === 'string' ? grant.caseId.trim() : '';
      return !grantCaseId || grantCaseId === caseData.id;
    }) || null;

  const lastGatewayInvite = ownDeviceId ? shareState.lastCreatedInviteByDevice[ownDeviceId] : null;
  const cachedInviteStatus = normalizeGrantStatus(lastGatewayInvite?.status || '');
  const hasActiveCachedInvite = Boolean(
    lastGatewayInvite
    && lastGatewayInvite.grantId
    && isRevocableGrantStatus(cachedInviteStatus),
  );

  const effectiveInvite = hasActiveCachedInvite
    ? lastGatewayInvite
    : (matchingActiveGrant
        ? {
          grantId: matchingActiveGrant.grantId,
          inviteeEmail: matchingActiveGrant.granteeEmail || matchingActiveGrant.granteeUid || 'unknown',
          inviteUrl: matchingActiveGrant.inviteUrl || '',
          status: matchingActiveGrant.status,
        }
        : null);

  const hasExistingActiveInvite = Boolean(
    effectiveInvite
    && effectiveInvite.grantId
    && isRevocableGrantStatus(normalizeGrantStatus(effectiveInvite.status || 'active')),
  );

  const inviteMutating = hasExistingActiveInvite
    ? shareState.mutatingGrantIds[String(effectiveInvite.grantId)] === true
    : false;

  const gatewayInviteSection = ownDeviceId && isOwnerLocalCase
    ? `
      <section class="panel stack">
        ${hasExistingActiveInvite ? `
          <h3 class="section-title">Invite By Email</h3>
          <div class="invite-card">
            <div class="invite-label">To: ${escapeHtml(String(effectiveInvite.inviteeEmail || 'unknown'))}</div>
            ${effectiveInvite.inviteUrl
              ? `<div class="invite-link-display">${escapeHtml(String(effectiveInvite.inviteUrl || ''))}</div>`
              : '<div class="small muted" style="margin-bottom: 8px;">Invite link already issued.</div>'}
            <div class="view-actions">
              ${effectiveInvite.inviteUrl ? `
                <button
                  type="button"
                  class="ghost"
                  data-action="copy-share-invite"
                  data-link="${escapeHtml(String(effectiveInvite.inviteUrl || ''))}"
                >
                  Copy Link
                </button>
              ` : ''}
              <button
                type="button"
                class="ghost"
                data-action="revoke-share-grant"
                data-grant-id="${escapeHtml(String(effectiveInvite.grantId || ''))}"
                data-device-id="${escapeHtml(ownDeviceId)}"
                ${inviteMutating ? 'disabled' : ''}
              >
                ${inviteMutating ? 'Revoking...' : 'Revoke'}
              </button>
            </div>
          </div>
        ` : (checkingExistingInvites && !deviceGrantCache ? `
          <div class="small muted">Checking existing invites...</div>
        ` : `
          <form class="share-invite-inline" data-submit-action="create-share-invite">
            <span class="small muted">Invite By Email</span>
            <input type="email" name="shareEmail" placeholder="name@example.com" required />
            <button type="submit" class="primary">Create Invite Link</button>
          </form>
        `)}
      </section>
    `
    : '';

  // Progress stepper
  const steps = [
    { label: 'Joined', done: ownState !== 'invited' },
    { label: 'Prepared', done: ownState === 'ready' },
    { label: 'Mediation', done: caseData.phase === 'group_chat' || caseData.phase === 'resolved' || caseData.phase === 'closed' },
    { label: 'Resolved', done: caseData.phase === 'resolved' || caseData.phase === 'closed' },
  ];
  let activeIndex = steps.findIndex((s) => !s.done);
  if (activeIndex === -1) activeIndex = steps.length;

  const stepperHtml = steps.map((step, i) => {
    const cls = step.done ? 'completed' : (i === activeIndex ? 'active' : '');
    const line = i < steps.length - 1
      ? `<div class="step-line ${i < activeIndex ? 'completed' : ''}"></div>`
      : '';
    return `<div class="step ${cls}"><span class="step-dot"></span><span class="step-label">${step.label}</span></div>${line}`;
  }).join('');

  let intakeHeading = 'Start Your Preparation';
  let intakeDesc = 'Share your perspective privately with your AI coach before the mediation begins.';
  if (ownState === 'joined' && thread.messages.length > 0 && !thread.resolved) {
    intakeHeading = 'Continue Your Preparation';
    intakeDesc = 'Pick up where you left off with your AI coach.';
  }
  if (ownState === 'ready') {
    intakeHeading = 'Review Your Preparation';
    intakeDesc = 'You\'re ready. Review your notes while waiting for the other party.';
  }

  const waitingText = ownState === 'ready' && !everyoneReady
    ? '<div class="waiting-panel">You\'re all set. Waiting for the other party to finish preparing.</div>'
    : '';

  const source = sourceLabel(caseData);
  const syncStatus = friendlySyncStatus(caseData);

  const groupCta = everyoneReady
    ? `
      <section class="cta-section">
        <div class="cta-heading">Ready to Begin</div>
        <div class="cta-desc">Both parties are prepared. Start the mediation session now.</div>
        <button class="cta" data-action="open-group">Enter Mediation</button>
      </section>
    `
    : '';

  return `
    <div class="detail-grid">
      <section class="topbar">
        <div class="row">
          <button class="back-btn" data-action="back-dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Back
          </button>
          <div>
            <h2>${escapeHtml(caseData.topic)}</h2>
            <div class="meta">${escapeHtml(caseData.description || '')}</div>
            <div class="small muted">Source: ${escapeHtml(source)} · Sync: ${escapeHtml(syncStatus)}</div>
          </div>
        </div>
        <span class="phase-pill ${phasePillClass(caseData.phase)}">${escapeHtml(friendlyPhase(caseData.phase))}</span>
      </section>

      <div class="progress-stepper">${stepperHtml}</div>

      <section class="panel stack">
        <h3 class="section-title">Participants</h3>
        <div class="participants">
          ${caseData.parties.map((party) => renderParticipantRow(caseData, party, currentPartyId)).join('')}
        </div>
      </section>

      <section class="cta-section">
        <div class="cta-heading">${escapeHtml(intakeHeading)}</div>
        <div class="cta-desc">${escapeHtml(intakeDesc)}</div>
        ${readOnlyShared
          ? '<div class="small muted">This shared case is read-only.</div>'
          : `<button class="cta" data-action="open-intake">${escapeHtml(intakeHeading)}</button>`}
      </section>

      ${waitingText}

      ${groupCta}

      ${gatewayInviteSection}
    </div>
  `;
}

/* ============================================================
   RENDER: MESSAGE BUBBLE
   ============================================================ */

function renderMessageBubble(message, caseData, currentPartyId) {
  const authorType = message.authorType || 'system';

  if (authorType === 'system') {
    return `<div class="msg-system">${escapeHtml(message.text || '')}</div>`;
  }

  if (authorType === 'mediator_llm') {
    return `
      <div class="msg-bubble msg-mediator">
        <div class="msg-header">
          <span class="avatar avatar-sm avatar-ai">M</span>
          <span class="msg-author">Mediator</span>
          <span class="msg-ai-badge">AI</span>
        </div>
        <div class="msg-content">${renderMarkdownUntrusted(message.text || '')}</div>
        <div class="msg-ts">${escapeHtml(formatTime(message.createdAt))}</div>
      </div>
    `;
  }

  if (authorType === 'party_llm') {
    return `
      <div class="msg-bubble msg-other">
        <div class="msg-header">
          <span class="avatar avatar-sm avatar-ai">C</span>
          <span class="msg-author">Your Coach</span>
          <span class="msg-ai-badge">AI</span>
        </div>
        <div class="msg-content">${renderMarkdownUntrusted(message.text || '')}</div>
        <div class="msg-ts">${escapeHtml(formatTime(message.createdAt))}</div>
      </div>
    `;
  }

  const isOwn = message.authorPartyId === currentPartyId;
  const cls = isOwn ? 'msg-own' : 'msg-other';
  const party = caseData.parties.find((p) => p.id === message.authorPartyId);
  const partyName = party?.displayName || 'Party';
  const avatarCls = getAvatarClass(message.authorPartyId);

  return `
    <div class="msg-bubble ${cls}">
      ${isOwn ? '' : `
        <div class="msg-header">
          <span class="avatar avatar-sm ${avatarCls}">${escapeHtml(getInitial(partyName))}</span>
          <span class="msg-author">${escapeHtml(partyName)}</span>
        </div>
      `}
      <div class="msg-content">${renderMarkdownUntrusted(message.text || '')}</div>
      <div class="msg-ts">${escapeHtml(formatTime(message.createdAt))}</div>
    </div>
  `;
}

/* ============================================================
   RENDER: PRIVATE INTAKE VIEW
   ============================================================ */

function renderPrivateIntakeView() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return '<section class="panel">Mediation not found.</section>';

  const current = getCurrentParty(caseData);
  if (!current) return '<section class="panel">Unable to load your session.</section>';

  const partyId = current.partyId;
  const partyState = getPartyState(caseData, partyId);
  const thread = getPrivateThread(caseData, partyId);
  const draftKey = `private:${caseData.id}:${partyId}`;
  const summaryKey = `summary:${caseData.id}:${partyId}`;
  const summaryDraft = state.chatDrafts.get(summaryKey) || thread.summary || '';
  const consent = caseData.consent?.byPartyId?.[partyId] || { allowSummaryShare: true, allowDirectQuote: false };

  const otherNotJoined = caseData.parties.some((party) => party.id !== partyId && getPartyState(caseData, party.id) === 'invited');

  const messages = thread.messages || [];
  const messageList = messages.length > 0
    ? messages.map((message) => renderMessageBubble(message, caseData, partyId)).join('')
    : '<div class="msg-system">Welcome! Share your perspective on the situation. Everything here is private and confidential.</div>';

  const ready = partyState === 'ready';
  const waitingText = ready
    ? `<div class="waiting-panel">You're all set. ${otherNotJoined ? 'Waiting for the other party to join.' : 'Waiting for the other party to finish preparing.'}</div>`
    : '';

  const draftValue = state.chatDrafts.get(draftKey) || '';

  return `
    <div class="chat-shell">
      <section class="topbar">
        <div class="row">
          <button class="back-btn" data-action="back-case">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Back
          </button>
          <div>
            <h2>${escapeHtml(caseData.topic)}</h2>
            <div class="meta">Private session with your AI coach</div>
          </div>
        </div>
        <span class="badge brand">${escapeHtml(current.party.displayName)}</span>
      </section>

      ${otherNotJoined ? '<div class="system-banner">The other party hasn\'t joined yet. You can continue preparing in the meantime.</div>' : ''}

      <section class="chat-messages" role="log" aria-live="polite">
        ${messageList}
      </section>

      ${ready ? waitingText : `
        <form class="chat-input-area" data-submit-action="send-private-message">
          <textarea data-draft-key="${escapeHtml(draftKey)}" name="privateMessage" placeholder="Share your thoughts..." rows="1">${escapeHtml(draftValue)}</textarea>
          <div class="chat-input-actions">
            ${messages.length >= 2 ? `<span class="ready-prompt-btn"><span class="ready-prompt-label">Ready to move forward?</span> <button type="button" class="primary" data-action="open-intake-summary">Summarize My Perspective</button></span>` : ''}
            <button type="submit" class="primary">Send</button>
          </div>
        </form>
      `}
    </div>
  `;
}

/* ============================================================
   RENDER: INTAKE SUMMARY (new screen)
   ============================================================ */

function renderIntakeSummaryView() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return '<section class="panel">Mediation not found.</section>';

  const current = getCurrentParty(caseData);
  if (!current) return '<section class="panel">Unable to load your session.</section>';

  const partyId = current.partyId;
  const partyState = getPartyState(caseData, partyId);
  const thread = getPrivateThread(caseData, partyId);
  const summaryKey = `summary:${caseData.id}:${partyId}`;
  const summaryDraft = state.chatDrafts.get(summaryKey) || thread.summary || '';
  const consent = caseData.consent?.byPartyId?.[partyId] || { allowSummaryShare: true, allowDirectQuote: false };
  const ready = partyState === 'ready';

  const otherNotJoined = caseData.parties.some((party) => party.id !== partyId && getPartyState(caseData, party.id) === 'invited');

  return `
    <div class="stack fade-in">
      <section class="topbar">
        <div class="row">
          <button class="back-btn" data-action="back-to-intake">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Back to Chat
          </button>
          <div>
            <h2>${escapeHtml(caseData.topic)}</h2>
            <div class="meta">Review your summary</div>
          </div>
        </div>
        <span class="badge brand">${escapeHtml(current.party.displayName)}</span>
      </section>

      ${ready ? `
        <div class="waiting-panel">You're all set. ${otherNotJoined ? 'Waiting for the other party to join.' : 'Waiting for the other party to finish preparing.'}</div>
      ` : `
        <section class="panel stack">
          <h3 class="section-title">Your Summary</h3>
          <p class="muted small">Review and edit this summary of your perspective. The mediator will use it to understand your position.</p>
          <textarea data-draft-key="${escapeHtml(summaryKey)}" name="summaryText" placeholder="Summarize your key points and what you'd like to achieve..." style="min-height: 140px;">${escapeHtml(summaryDraft)}</textarea>
          ${!summaryDraft ? `
            <button class="ghost" data-action="run-intake-template" style="align-self: flex-start;">Generate from conversation</button>
          ` : ''}
        </section>

        <section class="panel stack">
          <h3 class="section-title">Sharing Preferences</h3>
          <p class="muted small">Control what the mediator can share with the other party.</p>
          <div class="consent-settings">
            <label>
              <div class="toggle-switch">
                <input type="checkbox" id="consent-share-summary" ${consent.allowSummaryShare ? 'checked' : ''} />
                <span class="toggle-track"></span>
              </div>
              <span>Allow sharing a summary with the other party</span>
            </label>
            <label>
              <div class="toggle-switch">
                <input type="checkbox" id="consent-direct-quote" ${consent.allowDirectQuote ? 'checked' : ''} />
                <span class="toggle-track"></span>
              </div>
              <span>Allow direct quotes (otherwise paraphrase only)</span>
            </label>
          </div>
        </section>

        <section style="text-align: center; padding: var(--sp-4) 0;">
          <button class="cta" data-action="save-summary-ready">I'm Ready for Mediation</button>
        </section>
      `}
    </div>
  `;
}

/* ============================================================
   RENDER: COACH PANEL
   ============================================================ */

function findActiveDraft(caseData, partyId) {
  const state = getState();
  const explicitId = state.activeDraftByCase[caseData.id];
  if (explicitId && caseData.groupChat?.draftsById?.[explicitId]) {
    return caseData.groupChat.draftsById[explicitId];
  }

  const drafts = Object.values(caseData.groupChat?.draftsById || {});
  const draft = drafts
    .filter((entry) => entry.partyId === partyId)
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .find((entry) => entry.status === 'composing' || entry.status === 'pending_approval');

  if (draft) {
    state.activeDraftByCase[caseData.id] = draft.id;
    return draft;
  }
  return null;
}

function renderCoachPanel(caseData, partyId, overlayMode = false) {
  const state = getState();
  const draft = findActiveDraft(caseData, partyId);
  const draftInputKey = `draft:${caseData.id}:${partyId}`;
  const draftInput = state.chatDrafts.get(draftInputKey) || '';

  const composeMessages = draft
    ? draft.composeMessages.map((entry) => `
      <div class="msg-bubble ${entry.author === 'party' ? 'msg-own' : 'msg-other'}">
        ${entry.author === 'party' ? '' : `
          <div class="msg-header">
            <span class="avatar avatar-sm avatar-ai">C</span>
            <span class="msg-author">Coach</span>
            <span class="msg-ai-badge">AI</span>
          </div>
        `}
        <div class="msg-content">${renderMarkdownUntrusted(entry.text || '')}</div>
        <div class="msg-ts">${escapeHtml(formatTime(entry.createdAt))}</div>
      </div>
    `).join('')
    : '<div class="msg-system">Describe what you want to say. Your coach will help you refine it.</div>';

  const suggestedText = draft && draft.suggestedText ? draft.suggestedText : '';

  return `
    <aside class="coach-panel ${overlayMode ? 'overlay' : ''}" role="dialog" aria-modal="${overlayMode ? 'true' : 'false'}">
      <div class="row" style="justify-content:space-between;">
        <h3 class="section-title" style="margin:0;">Drafting Assistant</h3>
        <button class="ghost" data-action="close-coach-panel">Close</button>
      </div>

      <section class="chat-messages" role="log" aria-live="polite" style="min-height:200px; max-height:36vh;">
        ${composeMessages}
      </section>

      <form class="chat-input-area" data-submit-action="send-draft-message">
        <textarea data-draft-key="${escapeHtml(draftInputKey)}" name="draftMessage" placeholder="Describe what you want to say..." rows="2">${escapeHtml(draftInput)}</textarea>
        <div class="chat-input-actions">
          ${draft ? '<button type="button" class="ghost" data-action="run-draft-suggestion">Get Suggestion</button>' : ''}
          <button type="submit" class="primary">Send to Coach</button>
        </div>
      </form>

      ${suggestedText ? `
        <div class="suggestion">
          <div class="small muted" style="margin-bottom: 6px;">Suggested message</div>
          <textarea name="approvedText" id="draft-approved-text">${escapeHtml(suggestedText)}</textarea>
          <div class="view-actions" style="margin-top: 8px;">
            <button class="success" data-action="approve-draft">Send This Message</button>
            <button class="ghost" data-action="reject-draft">Keep Drafting</button>
          </div>
        </div>
      ` : ''}
    </aside>
  `;
}

/* ============================================================
   RENDER: GROUP CHAT VIEW
   ============================================================ */

function renderGroupChatView() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return '<section class="panel">Mediation not found.</section>';

  const current = getCurrentParty(caseData);
  if (!current) return '<section class="panel">Unable to load your session.</section>';

  const partyId = current.partyId;
  const messages = caseData.groupChat?.messages || [];
  const groupDraftKey = `group:${caseData.id}:${partyId}`;
  const groupDraftText = state.chatDrafts.get(groupDraftKey) || '';
  const panelOpen = state.coachPanelOpen === true;
  const overlayMode = panelOpen && window.innerWidth < 1100;

  const participantBadges = caseData.parties.map((party) => {
    const avatarCls = getAvatarClass(party.id);
    return `
      <span class="badge">
        <span class="avatar avatar-sm ${avatarCls}" style="width:20px;height:20px;font-size:10px;">${escapeHtml(getInitial(party.displayName))}</span>
        ${escapeHtml(party.displayName)}
      </span>
    `;
  }).join('');

  return `
    <div class="chat-shell">
      <section class="topbar">
        <div class="row">
          <button class="back-btn" data-action="back-case">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Back
          </button>
          <div>
            <h2>${escapeHtml(caseData.topic)}</h2>
            <div class="meta">Mediation session</div>
          </div>
        </div>
        <div class="row wrap">${participantBadges}</div>
      </section>

      <div class="chat-layout ${panelOpen && !overlayMode ? 'with-coach' : ''}">
        <div class="stack">
          <section class="chat-messages" role="log" aria-live="polite">
            ${messages.length > 0
              ? messages.map((message) => renderMessageBubble(message, caseData, partyId)).join('')
              : '<div class="msg-system">The mediation session has started. Share your thoughts openly and respectfully.</div>'}
          </section>

          <form class="chat-input-area ${panelOpen ? 'disabled' : ''}" data-submit-action="send-group-message">
            <textarea data-draft-key="${escapeHtml(groupDraftKey)}" name="groupMessage" placeholder="Type your message..." rows="2" ${panelOpen ? 'disabled' : ''}>${escapeHtml(groupDraftText)}</textarea>
            <div class="chat-input-actions">
              <button type="button" class="ghost" data-action="open-coach-panel" ${panelOpen ? 'disabled' : ''}>Draft with Coach</button>
              <button type="submit" class="primary" ${panelOpen ? 'disabled' : ''}>Send</button>
            </div>
          </form>

          <div style="display: flex; justify-content: flex-end;">
            <button class="ghost" data-action="open-resolve-prompt" style="font-size: var(--text-xs); color: var(--muted);">Resolve this mediation</button>
          </div>
        </div>

        ${panelOpen && !overlayMode ? renderCoachPanel(caseData, partyId, false) : ''}
      </div>

      ${panelOpen && overlayMode ? renderCoachPanel(caseData, partyId, true) : ''}
    </div>
  `;
}

/* ============================================================
   RENDER: RESOLVED VIEW
   ============================================================ */

function renderResolvedView() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return '<section class="panel">Mediation not found.</section>';

  const transcript = (caseData.groupChat?.messages || [])
    .map((message) => {
      const author = message.authorType === 'mediator_llm'
        ? 'Mediator'
        : (caseData.parties.find((party) => party.id === message.authorPartyId)?.displayName || message.authorType);
      return `${author}: ${message.text}`;
    })
    .join('\n\n');

  return `
    <div class="stack">
      <section class="topbar">
        <div class="row">
          <button class="back-btn" data-action="back-dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Back
          </button>
          <div>
            <h2>${escapeHtml(caseData.topic)}</h2>
            <div class="meta">Resolved on ${escapeHtml(formatShortDate(caseData.updatedAt || caseData.createdAt))}</div>
          </div>
        </div>
      </section>

      <section class="panel resolved-card">
        <div class="completion-icon">
          <svg viewBox="0 0 32 32" fill="none">
            <path d="M9 17l5 5 9-11" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h3 class="view-title" style="text-align: center;">Mediation Resolved</h3>
        <p class="view-subtitle" style="text-align: center;">Here's the resolution summary</p>
        <div class="resolution-text">${escapeHtml(caseData.resolution || 'No resolution text recorded.')}</div>
        <div class="view-actions" style="justify-content: center;">
          <button class="primary" data-action="close-case">Close Case</button>
          <button class="ghost" data-action="export-transcript">Export Transcript</button>
        </div>
      </section>

      <section class="panel stack">
        <h3 class="section-title">Conversation History</h3>
        <pre class="transcript">${escapeHtml(transcript || 'No transcript available.')}</pre>
      </section>
    </div>
  `;
}

/* ============================================================
   RENDER: CLOSED VIEW
   ============================================================ */

function renderClosedView() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return '<section class="panel">Mediation not found.</section>';

  return `
    <div class="stack">
      <section class="topbar">
        <div class="row">
          <button class="back-btn" data-action="back-dashboard">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Back
          </button>
          <div>
            <h2>${escapeHtml(caseData.topic)}</h2>
            <div class="meta">Closed</div>
          </div>
        </div>
      </section>

      <section class="panel resolved-card">
        <div class="completion-icon">
          <svg viewBox="0 0 32 32" fill="none">
            <path d="M9 17l5 5 9-11" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h3 class="view-title" style="text-align: center;">Case Closed</h3>
        <p class="view-subtitle" style="text-align: center;">This mediation was resolved on ${escapeHtml(formatShortDate(caseData.updatedAt || caseData.createdAt))}</p>
        <div class="view-actions" style="justify-content: center; margin-top: var(--sp-4);">
          <button class="ghost" data-action="export-transcript">View Transcript</button>
          <button class="primary" data-action="back-dashboard">Start New Mediation</button>
        </div>
      </section>
    </div>
  `;
}

/* ============================================================
   RENDER: MODAL
   ============================================================ */

function renderModal() {
  const state = getState();
  if (!state.modal) {
    modalRoot.innerHTML = '';
    return;
  }

  if (state.modal.type === 'resolve-case') {
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <form class="modal stack" data-submit-action="resolve-case">
          <h3 class="section-title">Resolve This Mediation</h3>
          <p class="muted small">Summarize the resolution that was agreed upon.</p>
          <textarea name="resolutionText" required placeholder="Describe the resolution..."></textarea>
          <div class="view-actions">
            <button type="submit" class="primary">Resolve</button>
            <button type="button" class="ghost" data-action="close-modal">Cancel</button>
          </div>
        </form>
      </div>
    `;
    return;
  }

  modalRoot.innerHTML = '';
}

/* ============================================================
   RENDER: MAIN
   ============================================================ */

function render() {
  const view = resolveView();

  if (view === 'dashboard') {
    appRoot.innerHTML = renderDashboardView();
  } else if (view === 'case-detail') {
    appRoot.innerHTML = renderCaseDetailView();
  } else if (view === 'private-intake') {
    appRoot.innerHTML = renderPrivateIntakeView();
  } else if (view === 'intake-summary') {
    appRoot.innerHTML = renderIntakeSummaryView();
  } else if (view === 'group-chat') {
    appRoot.innerHTML = renderGroupChatView();
  } else if (view === 'resolved') {
    appRoot.innerHTML = renderResolvedView();
  } else {
    appRoot.innerHTML = renderClosedView();
  }

  renderModal();
  renderToast();

  for (const node of appRoot.querySelectorAll('.chat-messages')) {
    node.scrollTop = node.scrollHeight;
  }
}

/* ============================================================
   CLIPBOARD
   ============================================================ */

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    showToast('Copied to clipboard', 'success');
  } catch {
    showToast('Unable to copy. Please copy manually.', 'error');
  }
}

/* ============================================================
   ACTION HANDLERS
   ============================================================ */

async function handleCreateCase(form) {
  const topic = String(form.topic.value || '').trim();
  const description = String(form.description.value || '').trim();
  const partyAName = String(form.partyAName.value || '').trim() || 'You';
  const partyBName = String(form.partyBName.value || '').trim() || 'Other Party';

  const payload = {
    topic,
    description,
    parties: [
      { id: 'party_a', displayName: partyAName, localLLM: { provider: 'claude', model: 'sonnet' } },
      { id: 'party_b', displayName: partyBName, localLLM: { provider: 'claude', model: 'sonnet' } },
    ],
    consent: {
      byPartyId: {
        party_a: { allowSummaryShare: true, allowDirectQuote: false, allowedTags: ['summary'] },
        party_b: { allowSummaryShare: true, allowDirectQuote: false, allowedTags: ['summary'] },
      },
    },
  };

  const createResult = await api.mediation.create(payload);
  if (!createResult || createResult.ok !== true) {
    showToast(normalizeError(createResult, 'Unable to create mediation'), 'error');
    return;
  }

  const createdCase = createResult.case;
  const joinResult = await api.mediation.join({
    caseId: createdCase.id,
    partyId: 'party_a',
  });

  if (!joinResult || joinResult.ok !== true) {
    showToast(normalizeError(joinResult, 'Created but unable to join automatically'), 'error');
    return;
  }

  const state = getState();
  state.partyByCase[createdCase.id] = 'party_a';
  setCaseData(joinResult.case);
  state.createFormExpanded = false;
  state.activeSubview = 'private-intake';

  await refreshCases();
  render();
}

async function refreshShareGrants(deviceId, options = {}) {
  const id = String(deviceId || '').trim();
  if (!id) return;

  const shareState = getShareState();
  shareState.grantsLoadingByDevice[id] = true;
  if (!options.silent) render();

  try {
    const result = await api.gateway.listShareGrants(id);
    if (!result || result.ok !== true) {
      if (!options.silent) {
        showToast(normalizeError(result, 'Unable to load grants'), 'error');
      }
      return;
    }

    const grants = Array.isArray(result.grants)
      ? result.grants.map((row) => normalizeGrantRow(row)).filter(Boolean)
      : [];
    shareState.grantsByDevice[id] = {
      grants,
      loadedAt: nowIso(),
    };
  } finally {
    shareState.grantsLoadingByDevice[id] = false;
    render();
  }
}

async function consumeShareInviteLink(linkValue, options = {}) {
  const state = getState();
  const parsed = parseShareTokenInput(linkValue);
  if (!parsed) {
    showToast('That does not look like a valid share link.', 'error');
    return;
  }

  const shareState = getShareState();
  shareState.consumeInput = parsed.raw;

  const result = await api.gateway.consumeShareInvite(parsed.raw);
  if (!result || result.ok !== true) {
    if (result && result.requiresAuth) {
      state.pendingInvite = { type: 'share', input: parsed.raw };
      if (!options.silent) {
        showToast('Sign in required to accept this share link.', 'info');
      }
      render();
      return;
    }

    showToast(normalizeError(result, 'Unable to accept share link'), 'error');
    render();
    return;
  }

  shareState.consumeResult = {
    grantId: typeof result.grantId === 'string' ? result.grantId : '',
    deviceId: typeof result.deviceId === 'string' ? result.deviceId : '',
    role: typeof result.role === 'string' ? result.role : '',
    status: normalizeGrantStatus(result.status || 'active'),
    acceptedAt: nowIso(),
  };
  persistShareConsumeResult(shareState.consumeResult);
  state.pendingInvite = null;
  state.joinFormExpanded = false;

  showToast('Share access granted.', 'success');
  await discoverSharedCases({ silent: true });
  render();
}

async function createShareInvite(form) {
  const state = getState();
  const ownDeviceId = getOwnDeviceId();
  if (!ownDeviceId) {
    showToast('No mediation device is available for sharing yet.', 'error');
    return;
  }

  const email = String(form.shareEmail?.value || '').trim();
  if (!email) {
    showToast('Invitee email is required.', 'error');
    return;
  }

  const payload = {
    deviceId: ownDeviceId,
    email,
  };
  const activeCaseId = state.caseData && typeof state.caseData.id === 'string'
    ? state.caseData.id.trim()
    : '';
  if (activeCaseId) {
    payload.caseId = activeCaseId;
  }

  const result = await api.gateway.createShareInvite(payload);
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to create share link'), 'error');
    return;
  }

  const shareState = getShareState();
  shareState.lastCreatedInviteByDevice[ownDeviceId] = {
    inviteUrl: extractInviteUrl(result),
    grantId: typeof result.grantId === 'string' ? result.grantId : '',
    inviteeEmail: email,
    status: normalizeGrantStatus(result.status || 'pending'),
    inviteTokenExpiresAt: parseEpochSeconds(result.inviteTokenExpiresAt),
    grantExpiresAt: parseEpochSeconds(result.grantExpiresAt),
  };

  showToast('Share link created.', 'success');
  render();
}

async function revokeShareGrant(grantId, deviceId) {
  const id = String(grantId || '').trim();
  if (!id) return;

  const resolvedDeviceId = String(deviceId || getOwnDeviceId() || '').trim();
  const shareState = getShareState();
  shareState.mutatingGrantIds[id] = true;
  render();

  try {
    const result = await api.gateway.revokeShareGrant(id);
    if (!result || result.ok !== true) {
      showToast(normalizeError(result, 'Unable to revoke grant'), 'error');
      return;
    }
    if (resolvedDeviceId) {
      const current = shareState.lastCreatedInviteByDevice[resolvedDeviceId];
      if (current && String(current.grantId || '') === id) {
        delete shareState.lastCreatedInviteByDevice[resolvedDeviceId];
      }
      const cache = shareState.grantsByDevice[resolvedDeviceId];
      if (cache && Array.isArray(cache.grants)) {
        cache.grants = cache.grants.filter((grant) => String(grant?.grantId || '') !== id);
      }
    }
    showToast('Grant revoked.', 'success');
  } finally {
    delete shareState.mutatingGrantIds[id];
    render();
  }
}

async function leaveShareGrant(grantId) {
  const id = String(grantId || '').trim();
  if (!id) return;

  const shareState = getShareState();
  shareState.mutatingGrantIds[id] = true;
  render();

  try {
    const result = await api.gateway.leaveShareGrant(id);
    if (!result || result.ok !== true) {
      showToast(normalizeError(result, 'Unable to leave share'), 'error');
      return;
    }
    if (shareState.consumeResult && shareState.consumeResult.grantId === id) {
      shareState.consumeResult = null;
    }
    showToast('Left shared access.', 'success');
  } finally {
    delete shareState.mutatingGrantIds[id];
    render();
  }
}

async function joinRemoteCase(caseId, partyId) {
  const normalizedCaseId = String(caseId || '').trim();
  const normalizedPartyId = String(partyId || '').trim();
  if (!normalizedCaseId || !normalizedPartyId) {
    return;
  }

  const shareContext = getRemoteContextFromShare();
  if (!shareContext) {
    showToast('Accept a share link first.', 'error');
    return;
  }

  const joinKey = `${normalizedCaseId}:${normalizedPartyId}`;
  const shareState = getShareState();
  shareState.joiningCaseKeys[joinKey] = true;
  render();

  try {
    const joined = await sendRemoteCaseCommand({
      context: shareContext,
      command: 'case.join',
      caseId: normalizedCaseId,
      partyId: normalizedPartyId,
      payload: {},
      localPartyId: normalizedPartyId,
    });
    if (!joined.ok) {
      showToast(normalizeError(joined, 'Unable to join remote case'), 'error');
      return;
    }

    if (joined.case) {
      const state = getState();
      ensureCaseInList(joined.case);
      state.partyByCase[joined.case.id] = normalizedPartyId;
      setCaseData(joined.case);
      state.activeSubview = 'private-intake';
      showToast('Joined remote case.', 'success');
      await refreshCases();
      return;
    }

    showToast('Joined, but case sync is pending. Refresh to continue.', 'info');
  } finally {
    delete shareState.joiningCaseKeys[joinKey];
    render();
  }
}

async function previewOrConsumeLink(linkValue) {
  await consumeShareInviteLink(linkValue);
}

async function sendPrivateMessage(form) {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const message = String(form.privateMessage.value || '').trim();
  if (!message) return;

  const partyId = current.partyId;
  const draftKey = `private:${caseData.id}:${partyId}`;

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.append_private',
      caseId: caseData.id,
      partyId,
      payload: {
        message: {
          role: 'user',
          content: message,
        },
      },
      localPartyId: partyId,
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to send message'), 'error');
      return;
    }

    const localEcho = await api.mediation.appendPrivate({
      caseId: caseData.id,
      partyId,
      authorType: 'party',
      text: message,
      tags: ['remote_private_local'],
    });

    if (localEcho && localEcho.ok === true && localEcho.case) {
      patchState({ caseData: localEcho.case });
      ensureCaseInList(localEcho.case);
    } else if (remote.case) {
      patchState({ caseData: remote.case });
      ensureCaseInList(remote.case);
    }

    state.chatDrafts.set(draftKey, '');
    render();
    return;
  }

  const appendResult = await api.mediation.appendPrivate({
    caseId: caseData.id,
    partyId,
    authorType: 'party',
    text: message,
    tags: ['intake'],
  });

  if (!appendResult || appendResult.ok !== true) {
    showToast(normalizeError(appendResult, 'Unable to send message'), 'error');
    return;
  }

  patchState({ caseData: appendResult.case });
  ensureCaseInList(appendResult.case);
  state.chatDrafts.set(draftKey, '');

  const coachResult = await api.mediation.coachReply({
    caseId: caseData.id,
    partyId,
    prompt: message,
  });

  if (coachResult && coachResult.ok === true && coachResult.case) {
    patchState({ caseData: coachResult.case });
    ensureCaseInList(coachResult.case);
  } else {
    showToast('Coach is taking a moment to respond.', 'info');
  }

  render();
}

async function runIntakeTemplate() {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  if (isSharedCase(caseData)) {
    showToast('Summary template is owner-side only for shared cases.', 'info');
    return;
  }

  const result = await api.mediation.runIntakeTemplate({
    caseId: caseData.id,
    partyId: current.partyId,
  });

  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to generate summary'), 'error');
    return;
  }

  patchState({ caseData: result.case });
  ensureCaseInList(result.case);

  const summaryKey = `summary:${caseData.id}:${current.partyId}`;
  if (typeof result.summary === 'string') {
    state.chatDrafts.set(summaryKey, result.summary);
  }

  showToast('Summary draft generated.', 'success');
  render();
}

async function saveSummaryAndReady() {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const summaryKey = `summary:${caseData.id}:${current.partyId}`;
  const summary = String(state.chatDrafts.get(summaryKey) || '').trim();
  if (!summary) {
    showToast('Please write a summary before continuing.', 'error');
    return;
  }

  const consentShareEl = document.getElementById('consent-share-summary');
  const consentQuoteEl = document.getElementById('consent-direct-quote');

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    const consentRemote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.set_consent',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: {
        consent: {
          allowSummaryShare: Boolean(consentShareEl && consentShareEl.checked),
          allowDirectQuote: Boolean(consentQuoteEl && consentQuoteEl.checked),
          allowedTags: ['summary'],
        },
      },
      localPartyId: current.partyId,
    });
    if (!consentRemote.ok) {
      showToast(normalizeError(consentRemote, 'Unable to save preferences'), 'error');
      return;
    }

    const summaryRemote = await sendRemoteCaseCommand({
      caseData: consentRemote.case || caseData,
      command: 'case.set_private_summary',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: { summary },
      localPartyId: current.partyId,
    });
    if (!summaryRemote.ok) {
      showToast(normalizeError(summaryRemote, 'Unable to save summary'), 'error');
      return;
    }

    const readyRemote = await sendRemoteCaseCommand({
      caseData: summaryRemote.case || caseData,
      command: 'case.set_ready',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: { ready: true },
      localPartyId: current.partyId,
    });
    if (!readyRemote.ok) {
      showToast(normalizeError(readyRemote, 'Unable to mark as ready'), 'error');
      return;
    }

    const updatedCase = readyRemote.case || summaryRemote.case || consentRemote.case;
    if (updatedCase) {
      patchState({ caseData: updatedCase });
      ensureCaseInList(updatedCase);
      if (updatedCase.phase === 'group_chat') {
        state.activeSubview = 'group-chat';
        showToast('Both parties are ready. Starting mediation.', 'success');
      } else {
        showToast('You\'re marked as ready!', 'success');
      }
      render();
    }
    return;
  }

  const setConsentResult = await api.mediation.setConsent({
    caseId: caseData.id,
    partyId: current.partyId,
    allowSummaryShare: Boolean(consentShareEl && consentShareEl.checked),
    allowDirectQuote: Boolean(consentQuoteEl && consentQuoteEl.checked),
  });
  if (!setConsentResult || setConsentResult.ok !== true) {
    showToast(normalizeError(setConsentResult, 'Unable to save preferences'), 'error');
    return;
  }

  const setSummaryResult = await api.mediation.setPrivateSummary({
    caseId: caseData.id,
    partyId: current.partyId,
    summary,
    resolved: true,
  });
  if (!setSummaryResult || setSummaryResult.ok !== true) {
    showToast(normalizeError(setSummaryResult, 'Unable to save summary'), 'error');
    return;
  }

  const readyResult = await api.mediation.setReady({
    caseId: caseData.id,
    partyId: current.partyId,
  });
  if (!readyResult || readyResult.ok !== true) {
    showToast(normalizeError(readyResult, 'Unable to mark as ready'), 'error');
    return;
  }

  patchState({ caseData: readyResult.case });
  ensureCaseInList(readyResult.case);

  if (readyResult.case.phase === 'group_chat') {
    state.activeSubview = 'group-chat';
    showToast('Both parties are ready. Starting mediation.', 'success');
  } else {
    showToast('You\'re marked as ready!', 'success');
  }

  render();
}

async function sendGroupMessage(form) {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const text = String(form.groupMessage.value || '').trim();
  if (!text) return;

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.send_group',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: {
        message: {
          role: 'user',
          content: text,
        },
      },
      localPartyId: current.partyId,
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to send message'), 'error');
      return;
    }

    const draftKey = `group:${caseData.id}:${current.partyId}`;
    state.chatDrafts.set(draftKey, '');
    if (remote.case) {
      patchState({ caseData: remote.case });
      ensureCaseInList(remote.case);
    }
    render();
    return;
  }

  const result = await api.mediation.sendDirect({
    caseId: caseData.id,
    partyId: current.partyId,
    text,
  });
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to send message'), 'error');
    return;
  }

  const draftKey = `group:${caseData.id}:${current.partyId}`;
  state.chatDrafts.set(draftKey, '');
  patchState({ caseData: result.case });
  ensureCaseInList(result.case);
  render();
}

async function sendDraftMessage(form) {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const text = String(form.draftMessage.value || '').trim();
  if (!text) return;

  const draftKey = `draft:${caseData.id}:${current.partyId}`;
  let draft = findActiveDraft(caseData, current.partyId);
  let latestCase = caseData;

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    if (!draft) {
      const created = await sendRemoteCaseCommand({
        caseData,
        command: 'case.create_draft',
        caseId: caseData.id,
        partyId: current.partyId,
        payload: { content: text },
        localPartyId: current.partyId,
      });
      if (!created.ok) {
        showToast(normalizeError(created, 'Unable to start draft'), 'error');
        return;
      }
      latestCase = created.case || caseData;
      draft = findActiveDraft(latestCase, current.partyId);
    } else {
      const appended = await sendRemoteCaseCommand({
        caseData,
        command: 'case.append_draft',
        caseId: caseData.id,
        partyId: current.partyId,
        payload: {
          draft_id: draft.id,
          content: text,
        },
        localPartyId: current.partyId,
      });
      if (!appended.ok) {
        showToast(normalizeError(appended, 'Unable to send draft message'), 'error');
        return;
      }
      latestCase = appended.case || caseData;
    }

    state.chatDrafts.set(draftKey, '');
    patchState({ caseData: latestCase });
    ensureCaseInList(latestCase);

    const activeDraft = findActiveDraft(latestCase, current.partyId);
    if (activeDraft) {
      const suggested = await sendRemoteCaseCommand({
        caseData: latestCase,
        command: 'case.run_draft_suggestion',
        caseId: caseData.id,
        partyId: current.partyId,
        payload: { draft_id: activeDraft.id },
        localPartyId: current.partyId,
      });
      if (suggested.ok && suggested.case) {
        patchState({ caseData: suggested.case });
        ensureCaseInList(suggested.case);
      }
    }

    render();
    return;
  }

  if (!draft) {
    const createResult = await api.mediation.createDraft({
      caseId: caseData.id,
      partyId: current.partyId,
      initialPartyMessage: text,
    });

    if (!createResult || createResult.ok !== true) {
      showToast(normalizeError(createResult, 'Unable to start draft'), 'error');
      return;
    }

    draft = createResult.draft;
    latestCase = createResult.case || caseData;
    state.activeDraftByCase[caseData.id] = draft.id;
  } else {
    const appendResult = await api.mediation.appendDraft({
      caseId: caseData.id,
      draftId: draft.id,
      author: 'party',
      text,
    });

    if (!appendResult || appendResult.ok !== true) {
      showToast(normalizeError(appendResult, 'Unable to send draft message'), 'error');
      return;
    }

    latestCase = appendResult.case;
  }

  state.chatDrafts.set(draftKey, '');
  patchState({ caseData: latestCase });
  ensureCaseInList(latestCase);

  const activeDraft = findActiveDraft(latestCase, current.partyId);
  if (activeDraft) {
    const suggestionResult = await api.mediation.runDraftSuggestion({
      caseId: caseData.id,
      draftId: activeDraft.id,
    });

    if (suggestionResult && suggestionResult.ok === true && suggestionResult.case) {
      patchState({ caseData: suggestionResult.case });
      ensureCaseInList(suggestionResult.case);
    }
  }

  render();
}

async function runDraftSuggestion() {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const draft = findActiveDraft(caseData, current.partyId);
  if (!draft) {
    showToast('Start a draft first.', 'error');
    return;
  }

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.run_draft_suggestion',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: { draft_id: draft.id },
      localPartyId: current.partyId,
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to generate suggestion'), 'error');
      return;
    }
    if (remote.case) {
      patchState({ caseData: remote.case });
      ensureCaseInList(remote.case);
      render();
    }
    return;
  }

  const result = await api.mediation.runDraftSuggestion({
    caseId: caseData.id,
    draftId: draft.id,
  });
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to generate suggestion'), 'error');
    return;
  }

  patchState({ caseData: result.case });
  ensureCaseInList(result.case);
  render();
}

async function approveDraft() {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const draft = findActiveDraft(caseData, current.partyId);
  if (!draft) {
    showToast('No draft to send.', 'error');
    return;
  }

  const approvedTextInput = document.getElementById('draft-approved-text');
  const approvedText = approvedTextInput ? String(approvedTextInput.value || '').trim() : '';

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.approve_draft',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: {
        draft_id: draft.id,
        ...(approvedText ? { approved_text: approvedText } : { use_suggestion: true }),
      },
      localPartyId: current.partyId,
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to send draft'), 'error');
      return;
    }
    if (remote.case) {
      patchState({ caseData: remote.case });
      ensureCaseInList(remote.case);
    }
    state.coachPanelOpen = false;
    delete state.activeDraftByCase[caseData.id];
    showToast('Message sent to the group.', 'success');
    render();
    return;
  }

  const result = await api.mediation.approveDraft({
    caseId: caseData.id,
    draftId: draft.id,
    approvedText: approvedText || undefined,
  });

  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to send draft'), 'error');
    return;
  }

  patchState({ caseData: result.case });
  ensureCaseInList(result.case);
  state.coachPanelOpen = false;
  delete state.activeDraftByCase[caseData.id];
  showToast('Message sent to the group.', 'success');
  render();
}

async function rejectDraft() {
  const state = getState();
  const caseData = state.caseData;
  const current = caseData ? getCurrentParty(caseData) : null;
  if (!caseData || !current) return;

  const draft = findActiveDraft(caseData, current.partyId);
  if (!draft) {
    showToast('No draft to discard.', 'error');
    return;
  }

  if (isSharedCase(caseData)) {
    if (isReadOnlySharedCase(caseData)) {
      showToast('This shared case is read-only.', 'error');
      return;
    }

    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.reject_draft',
      caseId: caseData.id,
      partyId: current.partyId,
      payload: {
        draft_id: draft.id,
        reason: 'continue_drafting',
      },
      localPartyId: current.partyId,
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to discard draft'), 'error');
      return;
    }
    if (remote.case) {
      patchState({ caseData: remote.case });
      ensureCaseInList(remote.case);
    }
    delete state.activeDraftByCase[caseData.id];
    showToast('Draft discarded. You can start a new one.', 'info');
    render();
    return;
  }

  const result = await api.mediation.rejectDraft({
    caseId: caseData.id,
    draftId: draft.id,
    reason: 'continue_drafting',
  });

  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to discard draft'), 'error');
    return;
  }

  patchState({ caseData: result.case });
  ensureCaseInList(result.case);
  delete state.activeDraftByCase[caseData.id];
  showToast('Draft discarded. You can start a new one.', 'info');
  render();
}

async function resolveCaseFromModal(form) {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return;

  const resolution = String(form.resolutionText.value || '').trim();
  if (!resolution) {
    showToast('Please describe the resolution.', 'error');
    return;
  }

  if (isSharedCase(caseData)) {
    const current = getCurrentParty(caseData);
    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.resolve',
      caseId: caseData.id,
      partyId: current ? current.partyId : '',
      payload: {
        resolution_text: resolution,
      },
      localPartyId: current ? current.partyId : '',
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to resolve'), 'error');
      return;
    }

    if (remote.case) {
      patchState({
        caseData: remote.case,
        modal: null,
        activeSubview: null,
      });
      ensureCaseInList(remote.case);
      render();
    }
    return;
  }

  const result = await api.mediation.resolve({ caseId: caseData.id, resolution });
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to resolve'), 'error');
    return;
  }

  patchState({
    caseData: result.case,
    modal: null,
    activeSubview: null,
  });
  ensureCaseInList(result.case);
  render();
}

async function closeCurrentCase() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return;

  if (isSharedCase(caseData)) {
    const current = getCurrentParty(caseData);
    const remote = await sendRemoteCaseCommand({
      caseData,
      command: 'case.close',
      caseId: caseData.id,
      partyId: current ? current.partyId : '',
      payload: {},
      localPartyId: current ? current.partyId : '',
    });
    if (!remote.ok) {
      showToast(normalizeError(remote, 'Unable to close'), 'error');
      return;
    }
    if (remote.case) {
      patchState({ caseData: remote.case, activeSubview: null });
      ensureCaseInList(remote.case);
      showToast('Case closed.', 'success');
      render();
    }
    return;
  }

  const result = await api.mediation.close({ caseId: caseData.id });
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to close'), 'error');
    return;
  }

  patchState({ caseData: result.case, activeSubview: null });
  ensureCaseInList(result.case);
  showToast('Case closed.', 'success');
  render();
}

function exportTranscript() {
  const state = getState();
  const caseData = state.caseData;
  if (!caseData) return;

  const lines = [];
  lines.push(`# ${caseData.topic}`);
  lines.push(`Phase: ${caseData.phase}`);
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');

  for (const message of caseData.groupChat?.messages || []) {
    const author = message.authorType === 'mediator_llm'
      ? 'Mediator'
      : (caseData.parties.find((party) => party.id === message.authorPartyId)?.displayName || message.authorType);
    lines.push(`[${message.createdAt}] ${author}`);
    lines.push(message.text || '');
    lines.push('');
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${caseData.id}-transcript.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ============================================================
   EVENT HANDLERS
   ============================================================ */

function handleInput(event) {
  const target = event.target;
  if (!target) return;

  if (target.matches('[data-draft-key]')) {
    const key = target.getAttribute('data-draft-key');
    if (key) getState().chatDrafts.set(key, target.value);
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form || !form.dataset || !form.dataset.submitAction) return;

  event.preventDefault();

  const action = form.dataset.submitAction;
  if (action === 'create-case') { await handleCreateCase(form); return; }
  if (action === 'preview-or-consume-link') { await previewOrConsumeLink(String(form.inviteLink.value || '')); return; }
  if (action === 'create-share-invite') { await createShareInvite(form); return; }
  if (action === 'send-private-message') { await sendPrivateMessage(form); return; }
  if (action === 'send-group-message') { await sendGroupMessage(form); return; }
  if (action === 'send-draft-message') { await sendDraftMessage(form); return; }
  if (action === 'resolve-case') { await resolveCaseFromModal(form); }
}

async function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.getAttribute('data-action');
  const state = getState();

  if (action === 'toggle-create-form') {
    state.createFormExpanded = !state.createFormExpanded;
    render();
    return;
  }

  if (action === 'toggle-join-form') {
    state.joinFormExpanded = !state.joinFormExpanded;
    if (!state.joinFormExpanded) {
      state.joinLinkInput = '';
    }
    render();
    return;
  }

  if (action === 'refresh-cases') {
    await refreshCases();
    render();
    return;
  }

  if (action === 'open-case') {
    const caseId = target.getAttribute('data-case-id');
    if (caseId) await loadCase(caseId, { activeSubview: null });
    return;
  }

  if (action === 'back-dashboard') {
    state.caseId = null;
    state.caseData = null;
    state.activeSubview = null;
    state.coachPanelOpen = false;
    render();
    return;
  }

  if (action === 'back-case') {
    state.activeSubview = null;
    state.coachPanelOpen = false;
    render();
    return;
  }

  if (action === 'open-intake') {
    state.activeSubview = 'private-intake';
    render();
    return;
  }

  if (action === 'open-group') {
    state.activeSubview = 'group-chat';
    render();
    return;
  }

  if (action === 'copy-share-invite') {
    const link = target.getAttribute('data-link') || '';
    if (link) {
      await copyToClipboard(link);
    }
    return;
  }

  if (action === 'close-modal') { state.modal = null; render(); return; }

  if (action === 'refresh-share-grants') {
    const deviceId = target.getAttribute('data-device-id') || getOwnDeviceId();
    await refreshShareGrants(deviceId);
    return;
  }

  if (action === 'revoke-share-grant') {
    const grantId = target.getAttribute('data-grant-id') || '';
    const deviceId = target.getAttribute('data-device-id') || getOwnDeviceId();
    await revokeShareGrant(grantId, deviceId);
    return;
  }

  if (action === 'leave-share-grant') {
    const grantId = target.getAttribute('data-grant-id') || '';
    await leaveShareGrant(grantId);
    return;
  }

  if (action === 'clear-share-consume') {
    getShareState().consumeResult = null;
    render();
    return;
  }

  if (action === 'discover-shared-cases') {
    await discoverSharedCases();
    return;
  }

  if (action === 'join-remote-case') {
    const caseId = target.getAttribute('data-case-id') || '';
    const partyId = target.getAttribute('data-party-id') || '';
    await joinRemoteCase(caseId, partyId);
    return;
  }

  if (action === 'open-remote-case') {
    const caseId = target.getAttribute('data-case-id') || '';
    if (caseId) {
      const existing = getState().cases.find((entry) => entry.id === caseId);
      if (!existing) {
        const context = getRemoteContextFromShare();
        if (context) {
          const fetched = await getRemoteCaseSnapshot(context, caseId);
          if (fetched.ok && fetched.result.case && typeof fetched.result.case === 'object') {
            await syncRemoteCaseFromResult({
              projectedCase: fetched.result.case,
              ownerDeviceId: context.ownerDeviceId,
              grantId: context.grantId,
              remoteVersion: Number.isFinite(fetched.result.remote_version) ? Number(fetched.result.remote_version) : undefined,
            });
            await refreshCases();
          }
        }
      }
      await loadCase(caseId, { activeSubview: null });
    }
    return;
  }

  if (action === 'run-intake-template') { await runIntakeTemplate(); return; }

  if (action === 'open-intake-summary') {
    const btn = target.closest('.ready-prompt-btn');
    if (btn) {
      btn.innerHTML = '<span class="summarizing-indicator"><span class="summarizing-spinner"></span> Summarizing...</span>';
    }
    await runIntakeTemplate();
    state.activeSubview = 'intake-summary';
    render();
    return;
  }

  if (action === 'back-to-intake') {
    state.activeSubview = 'private-intake';
    render();
    return;
  }

  if (action === 'save-summary-ready') { await saveSummaryAndReady(); return; }
  if (action === 'open-coach-panel') { state.coachPanelOpen = true; render(); return; }
  if (action === 'close-coach-panel') { state.coachPanelOpen = false; render(); return; }
  if (action === 'run-draft-suggestion') { await runDraftSuggestion(); return; }
  if (action === 'approve-draft') { await approveDraft(); return; }
  if (action === 'reject-draft') { await rejectDraft(); return; }
  if (action === 'open-resolve-prompt') { state.modal = { type: 'resolve-case' }; render(); return; }
  if (action === 'close-case') { await closeCurrentCase(); return; }
  if (action === 'export-transcript') { exportTranscript(); return; }
  if (action === 'sign-out') { await signOutFlow(); return; }
}

/* ============================================================
   REAL-TIME EVENTS
   ============================================================ */

function onAuthChanged(payload) {
  const state = getState();
  state.auth = payload;
  updateStartVisibility();

  if (isRuntimeReady(payload)) {
    void refreshCases().then(async () => {
      hydrateShareContextFromStorage();
      await refreshGatewayDevices({ silent: true });

      if (state.caseId) {
        const found = state.cases.find((entry) => entry.id === state.caseId);
        if (found) state.caseData = found;
      }

      if (state.pendingInvite && state.pendingInvite.type === 'share' && state.pendingInvite.input) {
        const pendingInput = String(state.pendingInvite.input);
        state.pendingInvite = null;
        await consumeShareInviteLink(pendingInput, { silent: true });
      }

      const shareState = getShareState();
      const consumeStatus = normalizeGrantStatus(shareState.consumeResult?.status || 'active');
      if (
        shareState.consumeResult
        && consumeStatus === 'active'
        && shareState.consumeResult.deviceId
        && shareState.consumeResult.grantId
      ) {
        await discoverSharedCases({ silent: true });
      }

      render();
    });
  } else {
    render();
  }
}

function onMediationEvent(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (
    (payload.type === 'case.updated')
    || (payload.type === 'mediation.event' && payload.event === 'case.updated')
  ) {
    if (!payload.case || typeof payload.case !== 'object') {
      return;
    }
    if (!payload.case.id && payload.case.case_id) {
      const currentCase = getState().caseData;
      const context = getRemoteContextFromCase(currentCase) || getRemoteContextFromShare();
      if (context) {
        void syncRemoteCaseFromResult({
          projectedCase: payload.case,
          ownerDeviceId: context.ownerDeviceId,
          grantId: context.grantId,
          localPartyId: context.localPartyId || '',
          remoteVersion: Number.isFinite(payload.remote_version) ? Number(payload.remote_version) : undefined,
          syncStatus: 'live',
        }).then((syncedCase) => {
          if (!syncedCase) {
            return;
          }
          ensureCaseInList(syncedCase);
          const state = getState();
          if (state.caseId === syncedCase.id) {
            state.caseData = syncedCase;
          }
          render();
        }).catch(() => undefined);
      }
      return;
    }
    const state = getState();
    const mediationCase = payload.case;
    ensureCaseInList(mediationCase);

    if (state.caseId === mediationCase.id) {
      state.caseData = mediationCase;
    }

    render();
    return;
  }

  if (payload.type === 'mediation.event' && payload.event === 'party.disconnected') {
    showToast('A participant disconnected from this shared case.', 'info', 5000);
    return;
  }

  if (payload.type === 'mediation.event' && payload.event === 'case.removed') {
    const caseId = typeof payload.case_id === 'string' ? payload.case_id.trim() : '';
    if (caseId) {
      const state = getState();
      state.cases = state.cases.filter((entry) => entry.id !== caseId);
      if (state.caseId === caseId) {
        state.caseId = null;
        state.caseData = null;
        state.activeSubview = null;
      }
    }
    showToast('This shared case is no longer available.', 'info', 5000);
    render();
    return;
  }

  if (payload.type === 'log' && payload.message) {
    const text = String(payload.message || '');
    if (text.includes('runtime start failed')) {
      showToast('Connection issue. Please restart the app.', 'error', 5000);
    }
  }
}

function onGatewayShareEvent(payload) {
  if (!payload || typeof payload !== 'object') return;

  const type = typeof payload.type === 'string' ? payload.type : '';
  const shareState = getShareState();

  if (type === 'share.consume.success') {
    const grantId = typeof payload.grantId === 'string' ? payload.grantId : '';
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';
    shareState.consumeResult = {
      grantId,
      deviceId,
      role: 'collaborator',
      status: 'active',
      acceptedAt: nowIso(),
    };
    persistShareConsumeResult(shareState.consumeResult);
    void discoverSharedCases({ silent: true });
    render();
    return;
  }

  if (type === 'share.consume.requires-auth') {
    const pending = String(shareState.consumeInput || '').trim();
    if (pending) {
      getState().pendingInvite = { type: 'share', input: pending };
    }
    render();
    return;
  }

  if (type === 'share.revoke.success' || type === 'share.leave.success') {
    let shouldRender = false;
    const grantId = typeof payload.grantId === 'string' ? payload.grantId : '';
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';
    if (type === 'share.revoke.success' && deviceId && grantId) {
      const current = shareState.lastCreatedInviteByDevice[deviceId];
      if (current && String(current.grantId || '') === grantId) {
        delete shareState.lastCreatedInviteByDevice[deviceId];
        shouldRender = true;
      }
    }
    if (grantId) {
      for (const cache of Object.values(shareState.grantsByDevice || {})) {
        if (cache && Array.isArray(cache.grants)) {
          const before = cache.grants.length;
          cache.grants = cache.grants.filter((grant) => String(grant?.grantId || '') !== grantId);
          if (cache.grants.length !== before) {
            shouldRender = true;
          }
        }
      }
    }
    if (grantId && shareState.consumeResult && shareState.consumeResult.grantId === grantId) {
      shareState.consumeResult = null;
      persistShareConsumeResult(null);
      shouldRender = true;
    }
    if (grantId) {
      const status = type === 'share.leave.success' ? 'left' : 'access_revoked';
      void api.mediation.markRemoteGrantStatus({ grantId, status })
        .then(() => refreshCases())
        .catch(() => undefined);
    }
    if (shouldRender) {
      render();
    }
    return;
  }

  if (type === 'share.create.success') {
    return;
  }

  if (type === 'access.revoked') {
    const grantId = typeof payload.grantId === 'string' ? payload.grantId : '';
    if (shareState.consumeResult && (!grantId || shareState.consumeResult.grantId === grantId)) {
      shareState.consumeResult = {
        ...shareState.consumeResult,
        status: 'revoked',
      };
      persistShareConsumeResult(shareState.consumeResult);
    }
    showToast('Access revoked by owner.', 'error', 6000);
    if (grantId) {
      void api.mediation.markRemoteGrantStatus({ grantId, status: 'access_revoked' })
        .then(() => refreshCases())
        .catch(() => undefined);
    }
    render();
    return;
  }

  if (type === 'access.left') {
    const grantId = typeof payload.grantId === 'string' ? payload.grantId : '';
    if (shareState.consumeResult && (!grantId || shareState.consumeResult.grantId === grantId)) {
      shareState.consumeResult = {
        ...shareState.consumeResult,
        status: 'left',
      };
      persistShareConsumeResult(shareState.consumeResult);
    }
    showToast('You left this shared device.', 'info', 5000);
    if (grantId) {
      void api.mediation.markRemoteGrantStatus({ grantId, status: 'left' })
        .then(() => refreshCases())
        .catch(() => undefined);
    }
    render();
  }
}

/* ============================================================
   BOOTSTRAP
   ============================================================ */

async function bootstrap() {
  appRoot.addEventListener('click', (event) => { void handleClick(event); });
  modalRoot.addEventListener('click', (event) => { void handleClick(event); });
  appRoot.addEventListener('submit', (event) => { void handleSubmit(event); });
  modalRoot.addEventListener('submit', (event) => { void handleSubmit(event); });
  appRoot.addEventListener('input', handleInput);

  startButton.addEventListener('click', () => { void startFlow(); });

  api.auth.onAuthChanged((payload) => { onAuthChanged(payload); });
  api.mediation.onMediationEvent((payload) => { onMediationEvent(payload); });
  api.gateway.onShareEvent((payload) => { onGatewayShareEvent(payload); });

  patchState({ startMessage: '' });

  const launchLinkInput = extractLaunchLinkInput();
  if (launchLinkInput) {
    patchState({
      joinFormExpanded: true,
      joinLinkInput: launchLinkInput,
    });
  }

  await refreshAuthStatus({ silent: true });

  if (isRuntimeReady(getState().auth)) {
    hydrateShareContextFromStorage();
    await refreshCases();
    await refreshGatewayDevices({ silent: true });

    const shareState = getShareState();
    const consumeStatus = normalizeGrantStatus(shareState.consumeResult?.status || 'active');
    if (
      shareState.consumeResult
      && consumeStatus === 'active'
      && shareState.consumeResult.deviceId
      && shareState.consumeResult.grantId
    ) {
      await discoverSharedCases({ silent: true });
    }
  }

  if (launchLinkInput) {
    await previewOrConsumeLink(launchLinkInput);
  }

  updateStartVisibility();
  render();
}

void bootstrap().catch((err) => {
  showToast(normalizeError(err, 'Unable to start. Please restart the app.'), 'error', 6000);
});
