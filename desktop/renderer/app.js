(function () {
  const api = window.mediationDesktop;
  const output = document.getElementById('output');
  const authResult = document.getElementById('auth-result');
  const caseSelect = document.getElementById('case-select');
  const caseStatus = document.getElementById('case-status');
  const inviteLinkOutput = document.getElementById('invite-link-output');
  const inviteLinkInput = document.getElementById('invite-link-input');
  const joinCaseIdInput = document.getElementById('join-case-id');
  const joinTokenInput = document.getElementById('join-token');
  const joinPartySelect = document.getElementById('join-party-id');
  const intakePartySelect = document.getElementById('intake-party-id');
  const privateSummaryInput = document.getElementById('private-summary');
  const defaultDeviceInput = document.getElementById('default-device-id');
  const gatewayMessageInput = document.getElementById('gateway-message');

  const DEFAULT_DEVICE_KEY = 'mediation.default_device_id';

  const state = {
    cases: [],
    currentCaseId: '',
  };

  function write(label, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    output.value = `[${new Date().toISOString()}] ${label}\n${text}\n\n${output.value}`;
  }

  function getSavedDeviceId() {
    try {
      return localStorage.getItem(DEFAULT_DEVICE_KEY) || '';
    } catch {
      return '';
    }
  }

  function saveDeviceId(deviceId) {
    try {
      localStorage.setItem(DEFAULT_DEVICE_KEY, deviceId);
    } catch {
      // ignore
    }
  }

  function setAuthStatus(ok, text) {
    authResult.textContent = text;
    authResult.className = `status ${ok ? 'ok' : 'err'}`;
  }

  function getCurrentCase() {
    return state.cases.find((item) => item.id === state.currentCaseId) || null;
  }

  function upsertCase(nextCase) {
    if (!nextCase || typeof nextCase !== 'object' || !nextCase.id) {
      return;
    }
    const index = state.cases.findIndex((item) => item.id === nextCase.id);
    if (index >= 0) {
      state.cases[index] = nextCase;
    } else {
      state.cases.unshift(nextCase);
    }
    state.currentCaseId = nextCase.id;
    renderCaseList();
    renderCaseStatus();
  }

  function summarizeCase(mediationCase) {
    if (!mediationCase) {
      return 'No case selected.';
    }

    const lines = [];
    lines.push(`Case: ${mediationCase.id}`);
    lines.push(`Topic: ${mediationCase.topic}`);
    lines.push(`Phase: ${mediationCase.phase}`);
    lines.push(`Created: ${mediationCase.createdAt}`);
    lines.push('');
    lines.push('Participation:');
    for (const party of mediationCase.parties || []) {
      const status = mediationCase.partyParticipationById?.[party.id];
      const intake = mediationCase.privateIntakeByPartyId?.[party.id] || {};
      const summary = intake.summary || '';
      const resolved = intake.resolved === true;
      lines.push(
        `- ${party.displayName} (${party.id}): ${status?.state || 'unknown'}`
        + ` | summary=${summary.trim() ? 'yes' : 'no'}`
        + ` | resolved=${resolved ? 'yes' : 'no'}`,
      );
    }
    lines.push('');
    lines.push(`Invite Link: ${mediationCase.inviteLink?.url || '(none)'}`);
    return lines.join('\n');
  }

  function parseInviteLink(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      const caseId = parsed.searchParams.get('caseId') || '';
      const token = parsed.searchParams.get('token') || '';
      if (caseId && token) {
        return { caseId, token };
      }
    } catch {
      // ignore and try fallback parsing
    }

    const tokenMatch = trimmed.match(/token=([^&\s]+)/i);
    const caseMatch = trimmed.match(/caseId=([^&\s]+)/i);
    if (tokenMatch && caseMatch) {
      return {
        caseId: decodeURIComponent(caseMatch[1]),
        token: decodeURIComponent(tokenMatch[1]),
      };
    }

    return null;
  }

  function createInviteLinkForEmail(baseLink, email) {
    try {
      const parsed = new URL(baseLink);
      parsed.searchParams.set('email', email);
      return parsed.toString();
    } catch {
      const sep = baseLink.includes('?') ? '&' : '?';
      return `${baseLink}${sep}email=${encodeURIComponent(email)}`;
    }
  }

  function updatePartySelect(selectEl, mediationCase, options) {
    const withAll = options && options.includeAllStates === true;
    const onlyJoinedLike = options && options.onlyJoinedLike === true;
    const currentValue = selectEl.value;

    if (!mediationCase || !Array.isArray(mediationCase.parties)) {
      selectEl.innerHTML = '';
      return;
    }

    const rows = [];
    for (const party of mediationCase.parties) {
      const stateForParty = mediationCase.partyParticipationById?.[party.id]?.state || 'invited';
      if (onlyJoinedLike && stateForParty !== 'joined' && stateForParty !== 'ready') {
        continue;
      }
      if (!withAll && stateForParty !== 'invited') {
        continue;
      }
      rows.push({ id: party.id, label: `${party.displayName} (${stateForParty})` });
    }

    if (rows.length === 0 && withAll) {
      for (const party of mediationCase.parties) {
        const stateForParty = mediationCase.partyParticipationById?.[party.id]?.state || 'invited';
        rows.push({ id: party.id, label: `${party.displayName} (${stateForParty})` });
      }
    }

    selectEl.innerHTML = rows.map((row) => `<option value="${row.id}">${row.label}</option>`).join('');

    if (currentValue && rows.some((row) => row.id === currentValue)) {
      selectEl.value = currentValue;
    }
  }

  function renderCaseList() {
    const current = state.currentCaseId;
    caseSelect.innerHTML = state.cases
      .map((mediationCase) => (
        `<option value="${mediationCase.id}">${mediationCase.topic} [${mediationCase.phase}]</option>`
      ))
      .join('');

    if (current && state.cases.some((item) => item.id === current)) {
      caseSelect.value = current;
      return;
    }

    if (state.cases.length > 0) {
      state.currentCaseId = state.cases[0].id;
      caseSelect.value = state.currentCaseId;
    } else {
      state.currentCaseId = '';
    }
  }

  function renderCaseStatus() {
    const mediationCase = getCurrentCase();
    caseStatus.textContent = summarizeCase(mediationCase);
    updatePartySelect(joinPartySelect, mediationCase, { includeAllStates: false });
    updatePartySelect(intakePartySelect, mediationCase, { includeAllStates: true, onlyJoinedLike: true });
  }

  async function refreshAuth() {
    const result = await api.auth.getStatus();
    setAuthStatus(Boolean(result && result.ok), JSON.stringify(result));
    write('auth.status', result);
  }

  async function refreshCases(preferredCaseId) {
    const result = await api.mediation.list();
    write('mediation.list', result);
    if (!(result && result.ok && Array.isArray(result.cases))) {
      return;
    }

    state.cases = result.cases;
    if (preferredCaseId && state.cases.some((item) => item.id === preferredCaseId)) {
      state.currentCaseId = preferredCaseId;
    } else if (!state.currentCaseId && state.cases.length > 0) {
      state.currentCaseId = state.cases[0].id;
    }

    renderCaseList();
    renderCaseStatus();
  }

  async function loadCase(caseId) {
    const result = await api.mediation.get(caseId);
    write('mediation.get', result);
    if (result && result.ok && result.case) {
      upsertCase(result.case);
      return result.case;
    }
    return null;
  }

  async function runIntakeTemplateForCurrent(partyId) {
    const mediationCase = getCurrentCase();
    if (!mediationCase) {
      write('intake', 'No case selected.');
      return;
    }

    const result = await api.mediation.runIntakeTemplate({
      caseId: mediationCase.id,
      partyId,
    });
    write('mediation.runIntakeTemplate', result);

    if (result && result.ok && result.case) {
      upsertCase(result.case);
      privateSummaryInput.value = result.summary || '';
    }
  }

  document.getElementById('auth-status').addEventListener('click', refreshAuth);

  document.getElementById('auth-signin').addEventListener('click', async () => {
    try {
      const result = await api.auth.signIn();
      setAuthStatus(Boolean(result && result.ok), JSON.stringify(result));
      write('auth.signIn', result);
    } catch (err) {
      setAuthStatus(false, String(err));
      write('auth.signIn.error', String(err));
    }
  });

  document.getElementById('auth-signout').addEventListener('click', async () => {
    const result = await api.auth.signOut();
    setAuthStatus(Boolean(result && result.ok), JSON.stringify(result));
    write('auth.signOut', result);
  });

  document.getElementById('save-default-device').addEventListener('click', () => {
    const deviceId = defaultDeviceInput.value.trim();
    saveDeviceId(deviceId);
    write('device.saved', { deviceId });
  });

  document.getElementById('gateway-devices').addEventListener('click', async () => {
    const result = await api.gateway.fetchDevices();
    write('gateway.devices', result);
  });

  document.getElementById('gateway-start-session').addEventListener('click', async () => {
    const deviceId = defaultDeviceInput.value.trim();
    if (!deviceId) {
      write('gateway.startSession', 'Set and save a default mediation device id first.');
      return;
    }
    const result = await api.gateway.startSession(deviceId);
    write('gateway.startSession', result);
  });

  document.getElementById('gateway-end-session').addEventListener('click', async () => {
    const deviceId = defaultDeviceInput.value.trim();
    if (!deviceId) {
      write('gateway.endSession', 'Set and save a default mediation device id first.');
      return;
    }
    const result = await api.gateway.endSession(deviceId);
    write('gateway.endSession', result);
  });

  document.getElementById('gateway-send').addEventListener('click', async () => {
    const deviceId = defaultDeviceInput.value.trim();
    const text = gatewayMessageInput.value.trim();
    if (!deviceId) {
      write('gateway.sendMessage', 'Set and save a default mediation device id first.');
      return;
    }
    if (!text) {
      write('gateway.sendMessage', 'Message text is required.');
      return;
    }

    const result = await api.gateway.sendMessage(deviceId, text);
    write('gateway.sendMessage', result);
  });

  document.getElementById('create-case').addEventListener('click', async () => {
    const topic = document.getElementById('topic').value.trim();
    const description = document.getElementById('description').value.trim();
    const partyAName = document.getElementById('party-a-name').value.trim() || 'Alex';
    const partyBName = document.getElementById('party-b-name').value.trim() || 'Blair';

    if (!topic) {
      write('mediation.create', 'Topic is required.');
      return;
    }

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

    const result = await api.mediation.create(payload);
    write('mediation.create', result);
    if (result && result.ok && result.case) {
      upsertCase(result.case);
      inviteLinkOutput.value = result.case.inviteLink?.url || '';
      inviteLinkInput.value = result.case.inviteLink?.url || '';
      await refreshCases(result.case.id);
    }
  });

  document.getElementById('list-cases').addEventListener('click', async () => {
    await refreshCases(state.currentCaseId);
  });

  caseSelect.addEventListener('change', async () => {
    const caseId = caseSelect.value;
    if (!caseId) {
      return;
    }
    state.currentCaseId = caseId;
    renderCaseStatus();
    await loadCase(caseId);
  });

  document.getElementById('create-invite-link').addEventListener('click', async () => {
    const mediationCase = getCurrentCase();
    if (!mediationCase) {
      write('invite', 'Select a case first.');
      return;
    }

    const email = document.getElementById('invite-email').value.trim();
    if (!email || !email.includes('@')) {
      write('invite', 'Valid invite email is required.');
      return;
    }

    const inviteLink = createInviteLinkForEmail(mediationCase.inviteLink?.url || '', email);
    inviteLinkOutput.value = inviteLink;
    inviteLinkInput.value = inviteLink;

    write('invite.generated', {
      email,
      caseId: mediationCase.id,
      inviteLink,
    });
  });

  document.getElementById('parse-invite-link').addEventListener('click', async () => {
    const parsed = parseInviteLink(inviteLinkInput.value);
    if (!parsed) {
      write('invite.parse', 'Invalid invite link.');
      return;
    }

    joinCaseIdInput.value = parsed.caseId;
    joinTokenInput.value = parsed.token;

    const loaded = await loadCase(parsed.caseId);
    if (loaded) {
      state.currentCaseId = loaded.id;
      renderCaseList();
      renderCaseStatus();
    }
    write('invite.parse', parsed);
  });

  document.getElementById('join-case').addEventListener('click', async () => {
    const caseId = joinCaseIdInput.value.trim();
    const inviteToken = joinTokenInput.value.trim();
    const partyId = joinPartySelect.value;

    if (!caseId || !inviteToken || !partyId) {
      write('mediation.join', 'caseId, token, and party are required.');
      return;
    }

    const joinResult = await api.mediation.join({
      caseId,
      partyId,
      inviteToken,
    });
    write('mediation.join', joinResult);

    if (joinResult && joinResult.ok && joinResult.case) {
      upsertCase(joinResult.case);
      await refreshCases(caseId);
      intakePartySelect.value = partyId;
      await runIntakeTemplateForCurrent(partyId);
    }
  });

  document.getElementById('run-intake-template').addEventListener('click', async () => {
    const partyId = intakePartySelect.value;
    if (!partyId) {
      write('intake', 'Select a joined party first.');
      return;
    }
    await runIntakeTemplateForCurrent(partyId);
  });

  document.getElementById('save-private-summary').addEventListener('click', async () => {
    const mediationCase = getCurrentCase();
    const partyId = intakePartySelect.value;
    const summary = privateSummaryInput.value.trim();
    if (!mediationCase || !partyId) {
      write('mediation.setPrivateSummary', 'Select case and party first.');
      return;
    }
    if (!summary) {
      write('mediation.setPrivateSummary', 'Summary is required.');
      return;
    }

    const result = await api.mediation.setPrivateSummary({
      caseId: mediationCase.id,
      partyId,
      summary,
      resolved: true,
    });
    write('mediation.setPrivateSummary', result);
    if (result && result.ok && result.case) {
      upsertCase(result.case);
      await refreshCases(mediationCase.id);
    }
  });

  document.getElementById('mark-ready').addEventListener('click', async () => {
    const mediationCase = getCurrentCase();
    const partyId = intakePartySelect.value;
    if (!mediationCase || !partyId) {
      write('mediation.setReady', 'Select case and party first.');
      return;
    }

    const result = await api.mediation.setReady({
      caseId: mediationCase.id,
      partyId,
    });
    write('mediation.setReady', result);
    if (result && result.ok && result.case) {
      upsertCase(result.case);
      await refreshCases(mediationCase.id);
    }
  });

  api.auth.onAuthChanged(function (payload) {
    write('event.authChanged', payload);
    setAuthStatus(Boolean(payload && payload.ok), JSON.stringify(payload));
  });

  api.gateway.onChatEvent(function (payload) {
    write('event.gatewayChat', payload);
  });

  api.room.onRoomEvent(function (payload) {
    write('event.room', payload);
  });

  api.mediation.onMediationEvent(function (payload) {
    write('event.mediation', payload);
  });

  defaultDeviceInput.value = getSavedDeviceId();
  refreshAuth();
  refreshCases();
})();
