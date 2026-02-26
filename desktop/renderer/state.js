const initialState = {
  auth: null,
  cases: [],
  caseId: null,
  caseData: null,
  activeSubview: null,
  partyByCase: {},
  createFormExpanded: false,
  joinFormExpanded: false,
  joinLinkInput: '',
  pendingInvite: null,
  coachPanelOpen: false,
  activeDraftByCase: {},
  summaryPanelExpanded: false,
  chatDrafts: new Map(),
  share: {
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
  },
  modal: null,
  toast: null,
  startBusy: false,
  startMessage: '',
};

const state = structuredClone(initialState);

export function getState() {
  return state;
}

export function resetState() {
  const keys = Object.keys(state);
  for (const key of keys) {
    delete state[key];
  }
  Object.assign(state, structuredClone(initialState));
}

export function patchState(patch) {
  Object.assign(state, patch);
  return state;
}

export function upsertCase(nextCase) {
  if (!nextCase || typeof nextCase !== 'object' || !nextCase.id) {
    return;
  }

  const index = state.cases.findIndex((entry) => entry.id === nextCase.id);
  if (index >= 0) {
    state.cases[index] = nextCase;
  } else {
    state.cases.unshift(nextCase);
  }

  if (state.caseId === nextCase.id || !state.caseId) {
    state.caseData = nextCase;
  }
}

export function removeToast() {
  state.toast = null;
}

export function setToast(message, level = 'info') {
  state.toast = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    level,
    message: String(message || ''),
    createdAt: Date.now(),
  };
}
