import { CH } from './channel-manifest';
import { DomainError } from '../../src/domain/errors';

interface IpcRegistry {
  handle: (ipcMain: unknown, channel: string, handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>) => void;
}

interface MediationService {
  createCase: (input: Record<string, unknown>) => Record<string, unknown>;
  getCase: (caseId: string) => Record<string, unknown>;
  listCases: () => Record<string, unknown>[];
  joinParty: (caseId: string, partyId: string) => Record<string, unknown>;
  appendPrivateMessage: (input: Record<string, unknown>) => Record<string, unknown>;
  setPartyConsent: (
    caseId: string,
    partyId: string,
    input: { allowSummaryShare: boolean; allowDirectQuote: boolean },
  ) => Record<string, unknown>;
  setPrivateSummary: (caseId: string, partyId: string, summary: string, resolved?: boolean) => Record<string, unknown>;
  setPartyReady: (caseId: string, partyId: string) => Record<string, unknown>;
  sendDirectGroupMessage: (caseId: string, partyId: string, text: string, tags?: string[]) => Record<string, unknown>;
  createCoachDraft: (caseId: string, partyId: string, initialPartyMessage: string) => Record<string, unknown>;
  appendCoachDraftMessage: (caseId: string, draftId: string, author: 'party' | 'party_llm', text: string) => Record<string, unknown>;
  setCoachDraftSuggestion: (caseId: string, draftId: string, suggestedText: string) => Record<string, unknown>;
  approveCoachDraftAndSend: (caseId: string, draftId: string, approvedText?: string) => Record<string, unknown>;
  rejectCoachDraft: (caseId: string, draftId: string, reason?: string) => Record<string, unknown>;
  resolveCase: (caseId: string, resolution: string) => Record<string, unknown>;
  closeCase: (caseId: string) => Record<string, unknown>;
  upsertRemoteCaseSnapshot: (input: {
    projectedCase: Record<string, unknown>;
    ownerDeviceId: string;
    grantId: string;
    accessRole: 'owner' | 'collaborator';
    localPartyId?: string;
    remoteVersion?: number;
    syncStatus?: string;
  }) => Record<string, unknown>;
  markRemoteGrantStatus: (grantId: string, status: 'access_revoked' | 'left') => Record<string, unknown>[];
  markRemoteCaseRemoved: (grantId: string, caseId: string) => void;
}

function toError(err: unknown): Record<string, unknown> {
  if (err instanceof DomainError) {
    return { code: err.code, message: err.message, recoverable: true };
  }
  return {
    code: 'internal_error',
    message: err instanceof Error ? err.message : String(err),
    recoverable: false,
  };
}

function ok(data: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, ...data };
}

function fail(err: unknown): Record<string, unknown> {
  return { ok: false, error: toError(err) };
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function emitCaseUpdate(
  deps: {
    emitMediationEvent?: (payload: Record<string, unknown>) => void;
  },
  action: string,
  mediationCase: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): void {
  if (!mediationCase || typeof mediationCase !== 'object') {
    return;
  }

  deps.emitMediationEvent?.({
    type: 'case.updated',
    action,
    caseId: pickString(mediationCase.id),
    case: mediationCase,
    ...extra,
  });
}

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    mediationService: MediationService;
    runIntakeTemplate?: (input: { caseId: string; partyId: string }) => Promise<Record<string, unknown>>;
    runCoachReply?: (input: { caseId: string; partyId: string; prompt: string }) => Promise<Record<string, unknown>>;
    runDraftSuggestion?: (input: { caseId: string; draftId: string }) => Promise<Record<string, unknown>>;
    emitMediationEvent?: (payload: Record<string, unknown>) => void;
    emitStructuredLog?: (event: string, fields?: Record<string, unknown>) => void;
  },
): void {
  const r = deps.registry;
  const svc = deps.mediationService;

  r.handle(ipcMain, CH.MEDIATION_CREATE, async (_event, payload) => {
    try {
      const mediationCase = svc.createCase(payload || {});
      emitCaseUpdate(deps, 'create', mediationCase);
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_GET, async (_event, payload) => {
    try {
      return ok({ case: svc.getCase(String(payload?.caseId || '')) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_LIST, async () => {
    try {
      return ok({ cases: svc.listCases() });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_JOIN, async (_event, payload) => {
    try {
      const mediationCase = svc.joinParty(String(payload?.caseId || ''), String(payload?.partyId || ''));
      emitCaseUpdate(deps, 'join', mediationCase, { partyId: String(payload?.partyId || '') });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPEND_PRIVATE, async (_event, payload) => {
    try {
      const mediationCase = svc.appendPrivateMessage(payload || {});
      emitCaseUpdate(deps, 'append_private', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_COACH_REPLY, async (_event, payload) => {
    try {
      const runner = deps.runCoachReply;
      if (typeof runner !== 'function') {
        return fail(new DomainError('internal_error', 'coach reply runner is not configured'));
      }
      const result = await runner({
        caseId: String(payload?.caseId || ''),
        partyId: String(payload?.partyId || ''),
        prompt: String(payload?.prompt || ''),
      });
      if (result.case && typeof result.case === 'object') {
        emitCaseUpdate(deps, 'coach_reply', result.case as Record<string, unknown>, {
          partyId: String(payload?.partyId || ''),
        });
      }
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_CONSENT, async (_event, payload) => {
    try {
      const mediationCase = svc.setPartyConsent(
        String(payload?.caseId || ''),
        String(payload?.partyId || ''),
        {
          allowSummaryShare: payload?.allowSummaryShare === true,
          allowDirectQuote: payload?.allowDirectQuote === true,
        },
      );
      emitCaseUpdate(deps, 'set_consent', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_PRIVATE_SUMMARY, async (_event, payload) => {
    try {
      const mediationCase = svc.setPrivateSummary(
        String(payload?.caseId || ''),
        String(payload?.partyId || ''),
        String(payload?.summary || ''),
        payload?.resolved !== false,
      );
      emitCaseUpdate(deps, 'set_private_summary', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_RUN_INTAKE_TEMPLATE, async (_event, payload) => {
    try {
      const runner = deps.runIntakeTemplate;
      if (typeof runner !== 'function') {
        return fail(new DomainError('internal_error', 'intake template runner is not configured'));
      }
      const result = await runner({
        caseId: String(payload?.caseId || ''),
        partyId: String(payload?.partyId || ''),
      });
      if (result.case && typeof result.case === 'object') {
        emitCaseUpdate(deps, 'intake_template', result.case as Record<string, unknown>, {
          partyId: String(payload?.partyId || ''),
        });
      }
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_READY, async (_event, payload) => {
    try {
      const mediationCase = svc.setPartyReady(String(payload?.caseId || ''), String(payload?.partyId || ''));
      emitCaseUpdate(deps, 'set_ready', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SEND_DIRECT, async (_event, payload) => {
    try {
      const mediationCase = svc.sendDirectGroupMessage(
        String(payload?.caseId || ''),
        String(payload?.partyId || ''),
        String(payload?.text || ''),
        Array.isArray(payload?.tags) ? payload.tags : [],
      );
      emitCaseUpdate(deps, 'send_direct', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_CREATE_DRAFT, async (_event, payload) => {
    try {
      const draft = svc.createCoachDraft(
        String(payload?.caseId || ''),
        String(payload?.partyId || ''),
        String(payload?.initialPartyMessage || ''),
      );
      const mediationCase = svc.getCase(String(payload?.caseId || ''));
      emitCaseUpdate(deps, 'create_draft', mediationCase, {
        partyId: String(payload?.partyId || ''),
        draftId: String(draft.id || ''),
      });
      return ok({ draft, case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPEND_DRAFT, async (_event, payload) => {
    try {
      const mediationCase = svc.appendCoachDraftMessage(
        String(payload?.caseId || ''),
        String(payload?.draftId || ''),
        payload?.author === 'party_llm' ? 'party_llm' : 'party',
        String(payload?.text || ''),
      );
      emitCaseUpdate(deps, 'append_draft', mediationCase, {
        draftId: String(payload?.draftId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SUGGEST_DRAFT, async (_event, payload) => {
    try {
      const mediationCase = svc.setCoachDraftSuggestion(
        String(payload?.caseId || ''),
        String(payload?.draftId || ''),
        String(payload?.suggestedText || ''),
      );
      emitCaseUpdate(deps, 'suggest_draft', mediationCase, {
        draftId: String(payload?.draftId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_RUN_DRAFT_SUGGESTION, async (_event, payload) => {
    try {
      const runner = deps.runDraftSuggestion;
      if (typeof runner !== 'function') {
        return fail(new DomainError('internal_error', 'draft suggestion runner is not configured'));
      }
      const result = await runner({
        caseId: String(payload?.caseId || ''),
        draftId: String(payload?.draftId || ''),
      });
      if (result.case && typeof result.case === 'object') {
        emitCaseUpdate(deps, 'run_draft_suggestion', result.case as Record<string, unknown>, {
          draftId: String(payload?.draftId || ''),
        });
      }
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPROVE_DRAFT, async (_event, payload) => {
    try {
      const mediationCase = svc.approveCoachDraftAndSend(
        String(payload?.caseId || ''),
        String(payload?.draftId || ''),
        typeof payload?.approvedText === 'string' ? payload.approvedText : undefined,
      );
      emitCaseUpdate(deps, 'approve_draft', mediationCase, {
        draftId: String(payload?.draftId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_REJECT_DRAFT, async (_event, payload) => {
    try {
      const mediationCase = svc.rejectCoachDraft(
        String(payload?.caseId || ''),
        String(payload?.draftId || ''),
        typeof payload?.reason === 'string' ? payload.reason : undefined,
      );
      emitCaseUpdate(deps, 'reject_draft', mediationCase, {
        draftId: String(payload?.draftId || ''),
      });
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_RESOLVE, async (_event, payload) => {
    try {
      const mediationCase = svc.resolveCase(String(payload?.caseId || ''), String(payload?.resolution || ''));
      emitCaseUpdate(deps, 'resolve', mediationCase);
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_CLOSE, async (_event, payload) => {
    try {
      const mediationCase = svc.closeCase(String(payload?.caseId || ''));
      emitCaseUpdate(deps, 'close', mediationCase);
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SYNC_REMOTE_CASE, async (_event, payload) => {
    try {
      if (!payload || typeof payload !== 'object') {
        throw new DomainError('invalid_payload', 'payload is required');
      }
      const projectedCase = payload.projectedCase && typeof payload.projectedCase === 'object'
        ? payload.projectedCase as Record<string, unknown>
        : null;
      if (!projectedCase) {
        throw new DomainError('invalid_payload', 'projectedCase is required');
      }

      const mediationCase = svc.upsertRemoteCaseSnapshot({
        projectedCase,
        ownerDeviceId: String(payload.ownerDeviceId || ''),
        grantId: String(payload.grantId || ''),
        accessRole: payload.accessRole === 'owner' ? 'owner' : 'collaborator',
        localPartyId: typeof payload.localPartyId === 'string' ? payload.localPartyId : undefined,
        remoteVersion: Number.isFinite(payload.remoteVersion) ? Number(payload.remoteVersion) : undefined,
        syncStatus: typeof payload.syncStatus === 'string' ? payload.syncStatus : undefined,
      });
      const incomingVersion = Number.isFinite(payload.remoteVersion) ? Number(payload.remoteVersion) : 0;
      const persistedVersion = Number((mediationCase as any)?.syncMetadata?.remoteVersion || 0);
      const projectedCaseId = pickString((projectedCase as Record<string, unknown>).case_id);
      const syncedCaseId = pickString((mediationCase as Record<string, unknown>).id);
      const eventCaseId = projectedCaseId || syncedCaseId;
      if (incomingVersion > 0 && persistedVersion > 0 && incomingVersion < persistedVersion) {
        deps.emitStructuredLog?.('mediation.sync.conflict', {
          case_id: eventCaseId,
          grant_id: String(payload.grantId || ''),
          remote_version: incomingVersion,
          local_remote_version: persistedVersion,
        });
      }
      deps.emitStructuredLog?.('mediation.case.synced', {
        case_id: eventCaseId,
        grant_id: String(payload.grantId || ''),
        remote_version: persistedVersion > 0 ? persistedVersion : undefined,
      });
      emitCaseUpdate(deps, 'sync_remote_case', mediationCase);
      return ok({ case: mediationCase });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_MARK_REMOTE_GRANT_STATUS, async (_event, payload) => {
    try {
      const grantId = pickString(payload?.grantId);
      const status = pickString(payload?.status);
      if (!grantId || (status !== 'access_revoked' && status !== 'left')) {
        throw new DomainError('invalid_payload', 'grantId and status are required');
      }
      const cases = svc.markRemoteGrantStatus(grantId, status);
      for (const mediationCase of cases) {
        emitCaseUpdate(deps, 'mark_remote_grant_status', mediationCase, { grantId, status });
      }
      return ok({ cases });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_REMOVE_REMOTE_CASE, async (_event, payload) => {
    try {
      const grantId = pickString(payload?.grantId);
      const caseId = pickString(payload?.caseId);
      if (!grantId || !caseId) {
        throw new DomainError('invalid_payload', 'grantId and caseId are required');
      }
      svc.markRemoteCaseRemoved(grantId, caseId);
      deps.emitMediationEvent?.({
        type: 'mediation.event',
        event: 'case.removed',
        case_id: caseId,
        reason: 'owner_removed_visibility',
      });
      return ok({ removed: true, caseId });
    } catch (err) {
      return fail(err);
    }
  });
}
