import { CH } from './channel-manifest';
import { DomainError } from '../../src/domain/errors';

interface IpcRegistry {
  handle: (ipcMain: unknown, channel: string, handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>) => void;
}

interface MediationService {
  createCase: (input: Record<string, unknown>) => Record<string, unknown>;
  getCase: (caseId: string) => Record<string, unknown>;
  listCases: () => Record<string, unknown>[];
  joinWithInvite: (caseId: string, partyId: string, inviteToken: string) => Record<string, unknown>;
  appendPrivateMessage: (input: Record<string, unknown>) => Record<string, unknown>;
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

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    mediationService: MediationService;
    runIntakeTemplate?: (input: { caseId: string; partyId: string }) => Promise<Record<string, unknown>>;
  },
): void {
  const r = deps.registry;
  const svc = deps.mediationService;

  r.handle(ipcMain, CH.MEDIATION_CREATE, async (_event, payload) => {
    try {
      return ok({ case: svc.createCase(payload || {}) });
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
      return ok({ case: svc.joinWithInvite(String(payload?.caseId || ''), String(payload?.partyId || ''), String(payload?.inviteToken || '')) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPEND_PRIVATE, async (_event, payload) => {
    try {
      return ok({ case: svc.appendPrivateMessage(payload || {}) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_PRIVATE_SUMMARY, async (_event, payload) => {
    try {
      return ok({
        case: svc.setPrivateSummary(
          String(payload?.caseId || ''),
          String(payload?.partyId || ''),
          String(payload?.summary || ''),
          payload?.resolved !== false,
        ),
      });
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
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_READY, async (_event, payload) => {
    try {
      return ok({ case: svc.setPartyReady(String(payload?.caseId || ''), String(payload?.partyId || '')) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SEND_DIRECT, async (_event, payload) => {
    try {
      return ok({
        case: svc.sendDirectGroupMessage(
          String(payload?.caseId || ''),
          String(payload?.partyId || ''),
          String(payload?.text || ''),
          Array.isArray(payload?.tags) ? payload.tags : [],
        ),
      });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_CREATE_DRAFT, async (_event, payload) => {
    try {
      return ok({
        draft: svc.createCoachDraft(
          String(payload?.caseId || ''),
          String(payload?.partyId || ''),
          String(payload?.initialPartyMessage || ''),
        ),
      });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPEND_DRAFT, async (_event, payload) => {
    try {
      return ok({
        case: svc.appendCoachDraftMessage(
          String(payload?.caseId || ''),
          String(payload?.draftId || ''),
          payload?.author === 'party_llm' ? 'party_llm' : 'party',
          String(payload?.text || ''),
        ),
      });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SUGGEST_DRAFT, async (_event, payload) => {
    try {
      return ok({ case: svc.setCoachDraftSuggestion(String(payload?.caseId || ''), String(payload?.draftId || ''), String(payload?.suggestedText || '')) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPROVE_DRAFT, async (_event, payload) => {
    try {
      return ok({
        case: svc.approveCoachDraftAndSend(
          String(payload?.caseId || ''),
          String(payload?.draftId || ''),
          typeof payload?.approvedText === 'string' ? payload.approvedText : undefined,
        ),
      });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_REJECT_DRAFT, async (_event, payload) => {
    try {
      return ok({ case: svc.rejectCoachDraft(String(payload?.caseId || ''), String(payload?.draftId || ''), typeof payload?.reason === 'string' ? payload.reason : undefined) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_RESOLVE, async (_event, payload) => {
    try {
      return ok({ case: svc.resolveCase(String(payload?.caseId || ''), String(payload?.resolution || '')) });
    } catch (err) {
      return fail(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_CLOSE, async (_event, payload) => {
    try {
      return ok({ case: svc.closeCase(String(payload?.caseId || '')) });
    } catch (err) {
      return fail(err);
    }
  });
}
