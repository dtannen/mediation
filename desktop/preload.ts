import { CH } from './ipc/channel-manifest';

interface IpcRendererLike {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  send?: (channel: string, payload?: unknown) => void;
}

export function createPreloadApi(ipcRenderer: IpcRendererLike): Record<string, unknown> {
  return {
    auth: {
      signIn: (payload?: Record<string, unknown>) => ipcRenderer.invoke(CH.AUTH_SIGN_IN, payload || {}),
      signOut: () => ipcRenderer.invoke(CH.AUTH_SIGN_OUT),
      getStatus: () => ipcRenderer.invoke(CH.AUTH_STATUS),
      onAuthChanged: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_AUTH_CHANGED, listener);
        return () => ipcRenderer.removeListener(CH.OUT_AUTH_CHANGED, listener);
      },
    },

    gateway: {
      fetchDevices: () => ipcRenderer.invoke(CH.GW_DEVICES),
      startSession: (deviceId: string) => ipcRenderer.invoke(CH.GW_START_SESSION, { deviceId }),
      sendMessage: (deviceId: string, text: string, correlationId?: string) => ipcRenderer.invoke(
        CH.GW_SEND_MESSAGE,
        { deviceId, text, ...(correlationId ? { correlationId } : {}) },
      ),
      endSession: (deviceId: string) => ipcRenderer.invoke(CH.GW_END_SESSION, { deviceId }),
      onChatEvent: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_GATEWAY_CHAT_EVENT, listener);
        return () => ipcRenderer.removeListener(CH.OUT_GATEWAY_CHAT_EVENT, listener);
      },
      onDeviceEvent: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_GATEWAY_DEVICE_EVENT, listener);
        return () => ipcRenderer.removeListener(CH.OUT_GATEWAY_DEVICE_EVENT, listener);
      },
      onShareEvent: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_GATEWAY_SHARE_EVENT, listener);
        return () => ipcRenderer.removeListener(CH.OUT_GATEWAY_SHARE_EVENT, listener);
      },
    },

    mediation: {
      create: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_CREATE, payload),
      get: (caseId: string) => ipcRenderer.invoke(CH.MEDIATION_GET, { caseId }),
      list: () => ipcRenderer.invoke(CH.MEDIATION_LIST),
      peekInvite: (payload: { caseId: string; inviteToken: string }) => ipcRenderer.invoke(CH.MEDIATION_PEEK_INVITE, payload),
      join: (payload: { caseId: string; partyId: string; inviteToken: string }) => ipcRenderer.invoke(CH.MEDIATION_JOIN, payload),
      appendPrivate: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_APPEND_PRIVATE, payload),
      coachReply: (payload: { caseId: string; partyId: string; prompt: string }) => ipcRenderer.invoke(CH.MEDIATION_COACH_REPLY, payload),
      setConsent: (payload: {
        caseId: string;
        partyId: string;
        allowSummaryShare: boolean;
        allowDirectQuote: boolean;
      }) => ipcRenderer.invoke(CH.MEDIATION_SET_CONSENT, payload),
      setPrivateSummary: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_SET_PRIVATE_SUMMARY, payload),
      runIntakeTemplate: (payload: { caseId: string; partyId: string }) => ipcRenderer.invoke(CH.MEDIATION_RUN_INTAKE_TEMPLATE, payload),
      setReady: (payload: { caseId: string; partyId: string }) => ipcRenderer.invoke(CH.MEDIATION_SET_READY, payload),
      sendDirect: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_SEND_DIRECT, payload),
      createDraft: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_CREATE_DRAFT, payload),
      appendDraft: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_APPEND_DRAFT, payload),
      suggestDraft: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_SUGGEST_DRAFT, payload),
      runDraftSuggestion: (payload: { caseId: string; draftId: string }) => ipcRenderer.invoke(CH.MEDIATION_RUN_DRAFT_SUGGESTION, payload),
      approveDraft: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_APPROVE_DRAFT, payload),
      rejectDraft: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_REJECT_DRAFT, payload),
      resolve: (payload: { caseId: string; resolution: string }) => ipcRenderer.invoke(CH.MEDIATION_RESOLVE, payload),
      close: (payload: { caseId: string }) => ipcRenderer.invoke(CH.MEDIATION_CLOSE, payload),
      onMediationEvent: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_MEDIATION_EVENT, listener);
        return () => ipcRenderer.removeListener(CH.OUT_MEDIATION_EVENT, listener);
      },
    },

    room: {
      create: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.ROOM_CREATE, payload),
      pause: (roomId: string) => ipcRenderer.invoke(CH.ROOM_PAUSE, { roomId }),
      resume: (roomId: string) => ipcRenderer.invoke(CH.ROOM_RESUME, { roomId }),
      stop: (roomId: string, reason?: string) => ipcRenderer.invoke(CH.ROOM_STOP, { roomId, reason }),
      status: (roomId?: string) => ipcRenderer.invoke(CH.ROOM_STATUS, roomId ? { roomId } : {}),
      editState: (roomId: string, edits: Record<string, unknown>) => ipcRenderer.invoke(CH.ROOM_EDIT_STATE, { roomId, edits }),
      approve: (roomId: string) => ipcRenderer.invoke(CH.ROOM_APPROVE, { roomId }),
      pluginList: () => ipcRenderer.invoke(CH.ROOM_PLUGIN_LIST),
      onRoomEvent: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_ROOM_EVENT, listener);
        return () => ipcRenderer.removeListener(CH.OUT_ROOM_EVENT, listener);
      },
      onRoomMetrics: (handler: (payload: unknown) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload);
        ipcRenderer.on(CH.OUT_ROOM_METRICS, listener);
        return () => ipcRenderer.removeListener(CH.OUT_ROOM_METRICS, listener);
      },
    },

    interfaces: {
      list: (profileId?: string) => ipcRenderer.invoke(CH.INTERFACES_LIST, { profileId }),
      createSlack: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.INTERFACES_CREATE_SLACK, payload),
      update: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.INTERFACES_UPDATE, payload),
      remove: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.INTERFACES_DELETE, payload),
      rotateToken: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.INTERFACES_ROTATE_TOKEN, payload),
      getWebhookUrl: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.INTERFACES_GET_WEBHOOK_URL, payload),
      runtimeStatus: () => ipcRenderer.invoke(CH.INTERFACES_RUNTIME_STATUS),
      sync: () => ipcRenderer.invoke(CH.INTERFACES_SYNC),
    },
  };
}
