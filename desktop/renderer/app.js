import { getState, patchState, resetState, upsertCase, setToast, removeToast } from './state.js';
import { escapeHtml, renderMarkdownUntrusted } from './markdown.js';

const api = window.mediationDesktop;

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
   INVITE LINK PARSING
   ============================================================ */

function parseInviteLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    const caseId = url.searchParams.get('caseId') || '';
    const token = url.searchParams.get('token') || '';
    if (!caseId || !token) return null;
    return {
      caseId,
      token,
      ownerDeviceId: url.searchParams.get('ownerDeviceId') || '',
      gatewayUrl: url.searchParams.get('gatewayUrl') || '',
      raw,
    };
  } catch {
    const tokenMatch = raw.match(/token=([^&\s]+)/i);
    const caseMatch = raw.match(/caseId=([^&\s]+)/i);
    if (!tokenMatch || !caseMatch) return null;

    const ownerMatch = raw.match(/ownerDeviceId=([^&\s]+)/i);
    const gatewayMatch = raw.match(/gatewayUrl=([^&\s]+)/i);

    return {
      caseId: decodeURIComponent(caseMatch[1]),
      token: decodeURIComponent(tokenMatch[1]),
      ownerDeviceId: ownerMatch ? decodeURIComponent(ownerMatch[1]) : '',
      gatewayUrl: gatewayMatch ? decodeURIComponent(gatewayMatch[1]) : '',
      raw,
    };
  }
}

function enrichInviteLink(baseLink) {
  const ownDeviceId = getOwnDeviceId();
  const state = getState();
  const gatewayUrl = state.auth && typeof state.auth.gatewayUrl === 'string' ? state.auth.gatewayUrl : '';

  try {
    const url = new URL(baseLink);
    if (ownDeviceId) url.searchParams.set('ownerDeviceId', ownDeviceId);
    if (gatewayUrl) url.searchParams.set('gatewayUrl', gatewayUrl);
    return url.toString();
  } catch {
    return baseLink;
  }
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
  state.cases = Array.isArray(result.cases) ? result.cases.slice() : [];
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
}

async function loadCase(caseId, options = {}) {
  const result = await api.mediation.get(caseId);
  if (!result || result.ok !== true) {
    showToast(normalizeError(result, 'Unable to load this mediation'), 'error');
    return null;
  }

  setCaseData(result.case);

  const state = getState();
  if (options.activeSubview !== undefined) {
    state.activeSubview = options.activeSubview;
  }

  render();
  return result.case;
}

/* ============================================================
   STATUS HELPERS
   ============================================================ */

function caseStatusLine(caseData, partyId) {
  if (!caseData) return '';

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
        <span class="phase-pill ${phasePillClass(caseData.phase)}">${escapeHtml(friendlyPhase(caseData.phase))}</span>
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
  const auth = state.auth || {};
  const email = auth.email || '';
  const userInitial = email ? email.charAt(0).toUpperCase() : 'U';
  const isOnline = isRuntimeReady(auth);

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
      <form class="panel stack" data-submit-action="preview-invite">
        <h3 class="section-title">Join a Mediation</h3>
        <p class="muted small">Paste the invite link you received.</p>
        <label class="stack">
          <span class="small muted">Invite link</span>
          <input name="inviteLink" value="${escapeHtml(state.joinLinkInput || '')}" placeholder="Paste your invite link here..." required />
        </label>
        <div class="view-actions">
          <button type="submit" class="primary">Continue</button>
          <button type="button" class="ghost" data-action="toggle-join-form">Cancel</button>
        </div>
      </form>
    `
    : '';

  const preview = state.joinPreview
    ? `
      <div class="join-preview panel">
        <h4 style="margin: 0 0 8px; font-size: var(--text-base);">You've been invited</h4>
        <div class="muted small">Topic: <strong style="color: var(--ink);">${escapeHtml(state.joinPreview.topic || '(unknown)')}</strong></div>
        <label class="stack" style="margin-top: 8px;">
          <span class="small muted">Join as</span>
          <select name="joinParty" id="join-party-select">
            ${(state.joinPreview.parties || []).map((party) => {
              const disabled = party.state === 'ready' ? 'disabled' : '';
              const selected = state.joinPartyId === party.id ? 'selected' : '';
              return `<option value="${escapeHtml(party.id)}" ${disabled} ${selected}>${escapeHtml(party.displayName)}${party.state === 'ready' ? ' (already joined)' : ''}</option>`;
            }).join('')}
          </select>
        </label>
        <div class="view-actions" style="margin-top: 8px;">
          <button type="button" class="primary" data-action="join-preview">Join Mediation</button>
        </div>
      </div>
    `
    : '';

  const casesHtml = state.cases.length > 0
    ? `<div class="case-list">${state.cases.map((c) => renderCaseCard(c)).join('')}</div>`
    : `
      <div class="empty-state">
        <div class="empty-title">No mediations yet</div>
        <div class="empty-desc">Start a new mediation or join one from an invite link to get going.</div>
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
            <div class="action-title">Join from Invite</div>
            <div class="action-desc">Have an invite link? Join here</div>
          </div>
        </div>
      </section>

      ${createForm}
      ${joinForm}
      ${preview}

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
  const everyoneReady = caseData.parties.every((party) => getPartyState(caseData, party.id) === 'ready');
  const anyoneInvited = caseData.parties.some((party) => getPartyState(caseData, party.id) === 'invited');
  const inviteLink = enrichInviteLink(caseData.inviteLink?.url || '');

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
        <button class="cta" data-action="open-intake">${escapeHtml(intakeHeading)}</button>
        ${waitingText}
      </section>

      ${groupCta}

      ${anyoneInvited ? `
        <section class="panel stack">
          <h3 class="section-title">Invite the Other Party</h3>
          <p class="muted small">Share this link so the other party can join.</p>
          <div class="invite-card">
            <div class="invite-link-display">${escapeHtml(inviteLink)}</div>
            <div class="view-actions">
              <button class="primary" data-action="copy-invite">Copy Link</button>
              <button class="ghost" data-action="open-share-modal">Share</button>
            </div>
          </div>
        </section>
      ` : ''}
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
            <button type="submit" class="primary">Send</button>
          </div>
        </form>

        ${messages.length >= 2 ? `
          <section class="ready-prompt">
            <span class="ready-prompt-text">Ready to move forward?</span>
            <button class="primary" data-action="open-intake-summary">Summarize My Perspective</button>
          </section>
        ` : ''}
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

  if (state.modal.type === 'share-invite') {
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal stack">
          <h3 class="section-title">Share Invite Link</h3>
          <p class="muted small">Send this link to the other party so they can join the mediation.</p>
          <div class="invite-box">${escapeHtml(state.modal.link || '')}</div>
          <div class="view-actions">
            <button class="primary" data-action="copy-modal-invite">Copy Link</button>
            <button class="ghost" data-action="close-modal">Done</button>
          </div>
        </div>
      </div>
    `;
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
   GATEWAY CORRELATION
   ============================================================ */

function extractCorrelationId(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.correlationId === 'string' && payload.correlationId.trim()) return payload.correlationId.trim();
  if (typeof payload.correlation_id === 'string' && payload.correlation_id.trim()) return payload.correlation_id.trim();

  const nested = payload.payload;
  if (nested && typeof nested === 'object') {
    if (typeof nested.correlationId === 'string' && nested.correlationId.trim()) return nested.correlationId.trim();
    if (typeof nested.correlation_id === 'string' && nested.correlation_id.trim()) return nested.correlation_id.trim();
    if (nested.message && typeof nested.message === 'object') {
      if (typeof nested.message.correlationId === 'string' && nested.message.correlationId.trim()) return nested.message.correlationId.trim();
      if (typeof nested.message.correlation_id === 'string' && nested.message.correlation_id.trim()) return nested.message.correlation_id.trim();
    }
  }
  return '';
}

function waitForGatewayReply(deviceId, correlationId, timeoutMs = 30_000) {
  const state = getState();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      state.waitingGatewayReplies.delete(correlationId);
      reject(new Error('The other device did not respond.'));
    }, timeoutMs);

    state.waitingGatewayReplies.set(correlationId, {
      deviceId,
      resolve: (payload) => {
        clearTimeout(timeoutId);
        resolve(payload);
      },
    });
  });
}

async function notifyOwnerDeviceJoin(parsedInvite, partyId) {
  if (!parsedInvite || !parsedInvite.ownerDeviceId) return;

  const ownerDeviceId = String(parsedInvite.ownerDeviceId || '').trim();
  if (!ownerDeviceId) return;
  if (ownerDeviceId === getOwnDeviceId()) return;

  const message = [
    'MEDIATION_JOIN_REQUEST',
    `case_id: ${parsedInvite.caseId}`,
    `invite_token: ${parsedInvite.token}`,
    `party_id: ${partyId}`,
    `joined_at: ${nowIso()}`,
    'Reply with case details and current phase.',
  ].join('\n');

  const correlationId = `join_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const sendResult = await api.gateway.sendMessage(ownerDeviceId, message, correlationId);
  if (!sendResult || sendResult.ok !== true) {
    showToast(normalizeError(sendResult, 'Unable to notify the other device'), 'error');
    return;
  }

  try {
    await waitForGatewayReply(ownerDeviceId, correlationId, 30_000);
    showToast('Connected successfully.', 'success');
  } catch (err) {
    showToast('Joined, but the other device hasn\'t responded yet.', 'info');
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
    inviteToken: createdCase.inviteLink.token,
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

  const inviteLink = enrichInviteLink(createdCase.inviteLink.url || '');
  state.modal = { type: 'share-invite', link: inviteLink };

  await refreshCases();
  render();
}

async function previewInvite(linkValue) {
  const state = getState();
  state.joinLinkInput = linkValue;

  const parsed = parseInviteLink(linkValue);
  if (!parsed) {
    state.joinPreview = null;
    state.joinPartyId = '';
    showToast('That doesn\'t look like a valid invite link.', 'error');
    render();
    return;
  }

  const result = await api.mediation.peekInvite({
    caseId: parsed.caseId,
    inviteToken: parsed.token,
  });

  if (!result || result.ok !== true) {
    state.joinPreview = null;
    state.joinPartyId = '';
    showToast(normalizeError(result, 'Unable to find this mediation'), 'error');
    render();
    return;
  }

  const preview = result.preview || {};
  state.joinPreview = { ...preview, parsedInvite: parsed };

  const available = Array.isArray(preview.availablePartyIds) ? preview.availablePartyIds : [];
  state.joinPartyId = available[0]
    || (Array.isArray(preview.parties) && preview.parties[0] ? preview.parties[0].id : '');

  render();
}

async function joinFromPreview() {
  const state = getState();
  const preview = state.joinPreview;
  if (!preview) {
    showToast('Please preview the invite first.', 'error');
    return;
  }

  const partyId = state.joinPartyId || '';
  if (!partyId) {
    showToast('Please select which party to join as.', 'error');
    return;
  }

  const parsed = preview.parsedInvite;
  const joinResult = await api.mediation.join({
    caseId: preview.caseId,
    partyId,
    inviteToken: parsed.token,
  });

  if (!joinResult || joinResult.ok !== true) {
    showToast(normalizeError(joinResult, 'Unable to join'), 'error');
    return;
  }

  state.partyByCase[preview.caseId] = partyId;
  state.joinFormExpanded = false;
  state.joinPreview = null;
  state.joinPartyId = '';
  state.joinLinkInput = '';
  state.caseId = preview.caseId;
  state.caseData = joinResult.case;
  state.activeSubview = 'private-intake';

  await notifyOwnerDeviceJoin(parsed, partyId);
  await refreshCases();
  render();
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

  if (target.id === 'join-party-select') {
    getState().joinPartyId = target.value;
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form || !form.dataset || !form.dataset.submitAction) return;

  event.preventDefault();

  const action = form.dataset.submitAction;
  if (action === 'create-case') { await handleCreateCase(form); return; }
  if (action === 'preview-invite') { await previewInvite(String(form.inviteLink.value || '')); return; }
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
      state.joinPreview = null;
      state.joinPartyId = '';
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

  if (action === 'copy-invite') {
    const caseData = state.caseData;
    if (caseData?.inviteLink?.url) await copyToClipboard(enrichInviteLink(caseData.inviteLink.url));
    return;
  }

  if (action === 'open-share-modal') {
    const caseData = state.caseData;
    if (caseData?.inviteLink?.url) {
      state.modal = { type: 'share-invite', link: enrichInviteLink(caseData.inviteLink.url) };
      render();
    }
    return;
  }

  if (action === 'close-modal') { state.modal = null; render(); return; }
  if (action === 'copy-modal-invite') {
    if (state.modal && state.modal.link) await copyToClipboard(state.modal.link);
    return;
  }

  if (action === 'join-preview') { await joinFromPreview(); return; }
  if (action === 'run-intake-template') { await runIntakeTemplate(); return; }

  if (action === 'open-intake-summary') {
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
    void refreshCases().then(() => {
      if (state.caseId) {
        const found = state.cases.find((entry) => entry.id === state.caseId);
        if (found) state.caseData = found;
      }
      render();
    });
  } else {
    render();
  }
}

function onMediationEvent(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.type === 'case.updated' && payload.case && typeof payload.case === 'object') {
    const state = getState();
    const mediationCase = payload.case;
    ensureCaseInList(mediationCase);

    if (state.caseId === mediationCase.id) {
      state.caseData = mediationCase;
    }

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

function onGatewayChat(payload) {
  const correlationId = extractCorrelationId(payload);
  if (!correlationId) return;

  const state = getState();
  const pending = state.waitingGatewayReplies.get(correlationId);
  if (!pending) return;

  if (pending.deviceId && payload && payload.deviceId && payload.deviceId !== pending.deviceId) return;

  state.waitingGatewayReplies.delete(correlationId);
  pending.resolve(payload);
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
  api.gateway.onChatEvent((payload) => { onGatewayChat(payload); });

  patchState({ startMessage: '' });

  try {
    const params = new URLSearchParams(window.location.search);
    const caseId = params.get('caseId') || '';
    const token = params.get('token') || '';
    if (caseId && token) {
      const baseHref = String(window.location.href || '').split('?')[0];
      const inviteUrl = `${baseHref}?caseId=${encodeURIComponent(caseId)}&token=${encodeURIComponent(token)}`;
      patchState({
        joinFormExpanded: true,
        joinLinkInput: inviteUrl,
      });
      void previewInvite(inviteUrl);
    }
  } catch {
    // ignore invalid launch params
  }

  await refreshAuthStatus({ silent: true });

  if (isRuntimeReady(getState().auth)) {
    await refreshCases();
  }

  updateStartVisibility();
  render();
}

void bootstrap().catch((err) => {
  showToast(normalizeError(err, 'Unable to start. Please restart the app.'), 'error', 6000);
});
