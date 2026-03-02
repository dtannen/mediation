import { CH } from './ipc/channel-manifest';

interface IpcRendererLike {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  send?: (channel: string, payload?: unknown) => void;
}

type GatewayShareCreateInvitePayload = {
  deviceId: string;
  email: string;
  caseId?: string;
  grantExpiresAt?: number;
  inviteTokenTtlSeconds?: number;
};

type GatewayShareEventType =
  | 'share.consume.success'
  | 'share.consume.requires-auth'
  | 'share.consume.error'
  | 'share.create.success'
  | 'share.create.error'
  | 'share.revoke.success'
  | 'share.revoke.error'
  | 'share.leave.success'
  | 'share.leave.error'
  | 'access.revoked'
  | 'access.left';

type GatewayShareEventPayload = {
  type: GatewayShareEventType;
  source?: string;
  deviceId?: string | null;
  grantId?: string | null;
  error?: string;
};

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
      sendMediationCommand: (payload: {
        deviceId: string;
        command: Record<string, unknown>;
        timeoutMs?: number;
        maxRetries?: number;
        authContext?: {
          requesterUid: string;
          requesterDeviceId: string;
          grantId: string;
          role?: 'owner' | 'collaborator';
          grantStatus?: 'active' | 'revoked';
        };
      }) => ipcRenderer.invoke(CH.GW_MEDIATION_COMMAND, payload),
      endSession: (deviceId: string) => ipcRenderer.invoke(CH.GW_END_SESSION, { deviceId }),
      consumeShareInvite: (input: string) => ipcRenderer.invoke(CH.GW_SHARE_CONSUME, { input }),
      createShareInvite: (payload: GatewayShareCreateInvitePayload) => ipcRenderer.invoke(CH.GW_SHARE_CREATE, payload),
      listShareGrants: (deviceId: string) => ipcRenderer.invoke(CH.GW_SHARE_LIST_GRANTS, { deviceId }),
      revokeShareGrant: (grantId: string) => ipcRenderer.invoke(CH.GW_SHARE_REVOKE, { grantId }),
      leaveShareGrant: (grantId: string) => ipcRenderer.invoke(CH.GW_SHARE_LEAVE, { grantId }),
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
      onShareEvent: (handler: (payload: GatewayShareEventPayload) => void) => {
        if (typeof handler !== 'function') {
          return () => {};
        }
        const listener = (_event: unknown, payload: unknown) => handler(payload as GatewayShareEventPayload);
        ipcRenderer.on(CH.OUT_GATEWAY_SHARE_EVENT, listener);
        return () => ipcRenderer.removeListener(CH.OUT_GATEWAY_SHARE_EVENT, listener);
      },
    },

    templates: {
      listCategories: () => ipcRenderer.invoke(CH.TPL_LIST_CATEGORIES),
      createCategory: (payload: { name: string; description?: string; actorId?: string }) => ipcRenderer.invoke(CH.TPL_CREATE_CATEGORY, payload),
      updateCategory: (payload: { categoryId: string; name?: string; description?: string; actorId?: string }) => ipcRenderer.invoke(CH.TPL_UPDATE_CATEGORY, payload),
      deleteCategory: (payload: { categoryId: string; actorId?: string }) => ipcRenderer.invoke(CH.TPL_DELETE_CATEGORY, payload),
      list: (categoryId?: string) => ipcRenderer.invoke(CH.TPL_LIST, categoryId ? { categoryId } : {}),
      get: (templateId: string) => ipcRenderer.invoke(CH.TPL_GET, { templateId }),
      create: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.TPL_CREATE, payload),
      updateMeta: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.TPL_UPDATE_META, payload),
      createVersion: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.TPL_CREATE_VERSION, payload),
      setStatus: (payload: { templateId: string; status: 'active' | 'archived'; actorId?: string }) => ipcRenderer.invoke(CH.TPL_SET_STATUS, payload),
      delete: (payload: string | { templateId: string; actorId?: string }) => {
        const p = typeof payload === 'string' ? { templateId: payload } : payload;
        return ipcRenderer.invoke(CH.TPL_DELETE, p);
      },
    },

    mediation: {
      create: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_CREATE, payload),
      get: (caseId: string) => ipcRenderer.invoke(CH.MEDIATION_GET, { caseId }),
      list: () => ipcRenderer.invoke(CH.MEDIATION_LIST),
      join: (payload: { caseId: string; partyId: string }) => ipcRenderer.invoke(CH.MEDIATION_JOIN, payload),
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
      setMainTopic: (payload: {
        caseId: string;
        topic: string;
        description?: string;
        categoryId: string;
        templateId: string;
        templateVersion: number;
        partyId: string;
      }) => ipcRenderer.invoke(CH.MEDIATION_SET_MAIN_TOPIC, payload),
      setTemplateSelection: (payload: {
        caseId: string;
        categoryId: string;
        templateId: string;
        templateVersion: number;
        actorId: string;
        adminOverride?: boolean;
      }) => ipcRenderer.invoke(CH.MEDIATION_SET_TEMPLATE_SELECTION, payload),
      draftCoachTurn: (payload: {
        caseId: string;
        draftId: string;
        partyId: string;
        userMessage: string;
        composeText?: string;
      }) => ipcRenderer.invoke(CH.MEDIATION_DRAFT_COACH_TURN, payload),
      setDraftReadiness: (payload: {
        caseId: string;
        draftId: string;
        readinessConfirmed: boolean;
      }) => ipcRenderer.invoke(CH.MEDIATION_SET_DRAFT_READINESS, payload),
      resolve: (payload: { caseId: string; resolution: string }) => ipcRenderer.invoke(CH.MEDIATION_RESOLVE, payload),
      close: (payload: { caseId: string }) => ipcRenderer.invoke(CH.MEDIATION_CLOSE, payload),
      remoteCommand: (payload: Record<string, unknown>) => ipcRenderer.invoke(CH.MEDIATION_REMOTE_COMMAND, payload),
      grantRemoteCaseAccess: (payload: { grantId: string; caseId: string }) => ipcRenderer.invoke(CH.MEDIATION_REMOTE_GRANT_CASE, payload),
      terminateRemoteGrant: (payload: { grantId: string; mode: 'revoke' | 'leave' }) => ipcRenderer.invoke(CH.MEDIATION_REMOTE_TERMINATE_GRANT, payload),
      syncRemoteCase: (payload: {
        projectedCase: Record<string, unknown>;
        ownerDeviceId: string;
        grantId: string;
        accessRole: 'owner' | 'collaborator';
        localPartyId?: string;
        remoteVersion?: number;
        syncStatus?: string;
      }) => ipcRenderer.invoke(CH.MEDIATION_SYNC_REMOTE_CASE, payload),
      markRemoteGrantStatus: (payload: {
        grantId: string;
        status: 'access_revoked' | 'left';
      }) => ipcRenderer.invoke(CH.MEDIATION_MARK_REMOTE_GRANT_STATUS, payload),
      removeRemoteCase: (payload: {
        grantId: string;
        caseId: string;
      }) => ipcRenderer.invoke(CH.MEDIATION_REMOVE_REMOTE_CASE, payload),
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
