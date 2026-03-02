import { CH } from './channel-manifest';
import { DomainError } from '../../src/domain/errors';
import { ipcSuccess, ipcError } from '../../src/contracts/common';

interface IpcRegistry {
  handle: (ipcMain: unknown, channel: string, handler: (event: unknown, payload: any) => Promise<unknown> | unknown) => void;
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
  setMainTopicConfig: (caseId: string, config: Record<string, unknown>) => Record<string, unknown>;
  setTemplateSelection: (caseId: string, selection: Record<string, unknown>) => Record<string, unknown>;
  setDraftReadiness: (caseId: string, draftId: string, ready: boolean) => Record<string, unknown>;
  initializeDraftCoachMeta: (caseId: string, draftId: string) => Record<string, unknown>;
  setFormalDraftReady: (caseId: string, draftId: string, formalText: string) => Record<string, unknown>;
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function emitCaseUpdateRaw(
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

/** Check whether a case has valid main topic + template config (c2_5: validate all required fields) */
function isCaseConfigured(mediationCase: Record<string, unknown>): boolean {
  const mainTopic = mediationCase.mainTopicConfig as Record<string, unknown> | undefined;
  const templateSel = mediationCase.templateSelection as Record<string, unknown> | undefined;
  if (!mainTopic || !templateSel) return false;
  const topic = typeof mainTopic.topic === 'string' ? mainTopic.topic.trim() : '';
  const templateId = typeof templateSel.templateId === 'string' ? templateSel.templateId.trim() : '';
  const templateVersion = typeof templateSel.templateVersion === 'number' ? templateSel.templateVersion : 0;
  return topic.length > 0 && templateId.length > 0 && templateVersion > 0;
}

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    mediationService: MediationService;
    runIntakeTemplate?: (input: { caseId: string; partyId: string }) => Promise<Record<string, unknown>>;
    runCoachReply?: (input: { caseId: string; partyId: string; prompt: string }) => Promise<Record<string, unknown>>;
    runDraftSuggestion?: (input: { caseId: string; draftId: string }) => Promise<Record<string, unknown>>;
    runDraftCoachTurn?: (input: { caseId: string; draftId: string; partyId: string; userMessage: string; composeText?: string }) => Promise<Record<string, unknown>>;
    runMediatorTurn?: (input: { caseId: string; partyId: string; content: string }) => Promise<Record<string, unknown>>;
    emitMediationEvent?: (payload: Record<string, unknown>) => void;
    emitStructuredLog?: (event: string, fields?: Record<string, unknown>) => void;
    isAdmin?: (actorId: string) => boolean;
    /** Validate whether a templateId + templateVersion is resolvable in the store (c3_1) */
    isTemplateResolvable?: (templateId: string, templateVersion: number) => boolean;
  },
): void {
  const r = deps.registry;
  const svc = deps.mediationService;

  /**
   * Augment case data with a computed `templateValid` flag (c3_1 / c4_1).
   * Renderer uses this to enforce main-topic routing for stale/corrupt pins.
   * Uses strict validation (no default fallback) per c4_1.
   */
  function augmentCaseWithTemplateValidity(mediationCase: Record<string, unknown>): Record<string, unknown> {
    const templateSel = mediationCase.templateSelection as Record<string, unknown> | undefined;
    if (!templateSel) return mediationCase;
    const templateId = typeof templateSel.templateId === 'string' ? templateSel.templateId : '';
    const templateVersion = typeof templateSel.templateVersion === 'number' ? templateSel.templateVersion : 0;
    if (!templateId || templateVersion <= 0) {
      return { ...mediationCase, templateValid: false };
    }
    if (typeof deps.isTemplateResolvable === 'function') {
      return { ...mediationCase, templateValid: deps.isTemplateResolvable(templateId, templateVersion) };
    }
    // No validator available — assume valid
    return { ...mediationCase, templateValid: true };
  }

  /** Augment a runner result's embedded `case` field with templateValid (c4_1). */
  function augmentResultCase(result: Record<string, unknown>): Record<string, unknown> {
    if (result.case && typeof result.case === 'object') {
      return { ...result, case: augmentCaseWithTemplateValidity(result.case as Record<string, unknown>) };
    }
    return result;
  }

  /**
   * Local wrapper that augments case data with templateValid before emitting (c4_1).
   * Ensures every case.updated event carries the templateValid flag consistently.
   */
  function emitCaseUpdate(
    emitDeps: { emitMediationEvent?: (payload: Record<string, unknown>) => void },
    action: string,
    mediationCase: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ): void {
    if (!mediationCase || typeof mediationCase !== 'object') return;
    emitCaseUpdateRaw(emitDeps, action, augmentCaseWithTemplateValidity(mediationCase), extra);
  }

  r.handle(ipcMain, CH.MEDIATION_CREATE, async (_event, payload) => {
    try {
      const mediationCase = svc.createCase(payload || {});
      emitCaseUpdate(deps, 'create', mediationCase);
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_GET, async (_event, payload) => {
    try {
      const mediationCase = svc.getCase(String(payload?.caseId || ''));
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_LIST, async () => {
    try {
      const cases = svc.listCases().map((c) => augmentCaseWithTemplateValidity(c));
      return ipcSuccess({ cases });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_JOIN, async (_event, payload) => {
    try {
      const mediationCase = svc.joinParty(String(payload?.caseId || ''), String(payload?.partyId || ''));
      emitCaseUpdate(deps, 'join', mediationCase, { partyId: String(payload?.partyId || '') });
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPEND_PRIVATE, async (_event, payload) => {
    try {
      // F-06 gating: block private intake if case not configured
      const caseId = String(payload?.caseId || '');
      if (caseId) {
        try {
          const caseData = svc.getCase(caseId);
          if (!isCaseConfigured(caseData as Record<string, unknown>)) {
            throw new DomainError('main_topic_not_configured', 'Main topic and template must be configured before private intake');
          }
        } catch (gateErr) {
          if (gateErr instanceof DomainError && gateErr.code === 'main_topic_not_configured') {
            throw gateErr;
          }
          // case_not_found or other errors - let appendPrivateMessage handle
        }
      }

      const mediationCase = svc.appendPrivateMessage(payload || {});
      emitCaseUpdate(deps, 'append_private', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_COACH_REPLY, async (_event, payload) => {
    try {
      const runner = deps.runCoachReply;
      if (typeof runner !== 'function') {
        return ipcError(new DomainError('internal_error', 'coach reply runner is not configured'));
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
      return ipcSuccess(augmentResultCase(result));
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_RUN_INTAKE_TEMPLATE, async (_event, payload) => {
    try {
      const runner = deps.runIntakeTemplate;
      if (typeof runner !== 'function') {
        return ipcError(new DomainError('internal_error', 'intake template runner is not configured'));
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
      return ipcSuccess(augmentResultCase(result));
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_READY, async (_event, payload) => {
    try {
      const mediationCase = svc.setPartyReady(String(payload?.caseId || ''), String(payload?.partyId || ''));
      emitCaseUpdate(deps, 'set_ready', mediationCase, {
        partyId: String(payload?.partyId || ''),
      });
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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

      const runner = deps.runMediatorTurn;
      const caseId = String(payload?.caseId || '');
      const partyId = String(payload?.partyId || '');
      const content = String(payload?.text || '');
      if (typeof runner === 'function' && caseId && partyId && content.trim()) {
        void runner({
          caseId,
          partyId,
          content,
        }).then((result) => {
          if (result.case && typeof result.case === 'object') {
            emitCaseUpdate(deps, 'mediator_turn', result.case as Record<string, unknown>, {
              partyId,
            });
          }
        }).catch((err) => {
          deps.emitStructuredLog?.('mediation.mediator_turn.error', {
            case_id: caseId,
            party_id: partyId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ draft, case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  /* ============================================================
     V2: run-draft-suggestion is now a compatibility alias
     that forwards to draft-coach-turn (Spec Section 7.2)
     ============================================================ */
  r.handle(ipcMain, CH.MEDIATION_RUN_DRAFT_SUGGESTION, async (_event, payload) => {
    try {
      const caseId = String(payload?.caseId || '');
      const draftId = String(payload?.draftId || '');
      if (!caseId || !draftId) {
        return ipcError(new DomainError('draft_not_found', 'caseId and draftId are required'));
      }

      // Load the draft to derive fields for draft-coach-turn
      const mediationCase = svc.getCase(caseId) as Record<string, unknown>;
      const groupChat = mediationCase.groupChat as Record<string, unknown>;
      const draftsById = groupChat?.draftsById as Record<string, Record<string, unknown>> || {};
      const draft = draftsById[draftId];

      if (!draft) {
        return ipcError(new DomainError('draft_not_found', `draft '${draftId}' not found in case`));
      }

      // Verify draft belongs to this case (always true if found in groupChat.draftsById)
      const partyId = typeof draft.partyId === 'string' ? draft.partyId : '';
      if (!partyId) {
        return ipcError(new DomainError('draft_not_found', 'draft record is corrupt: missing partyId'));
      }

      // Derive userMessage: last party-authored composeMessage, fallback to suggestedText
      let userMessage = '';
      const composeMessages = Array.isArray(draft.composeMessages) ? draft.composeMessages as Array<Record<string, unknown>> : [];
      for (let i = composeMessages.length - 1; i >= 0; i--) {
        if (composeMessages[i].author === 'party') {
          userMessage = typeof composeMessages[i].text === 'string' ? (composeMessages[i].text as string) : '';
          break;
        }
      }
      if (!userMessage && typeof draft.suggestedText === 'string') {
        userMessage = draft.suggestedText as string;
      }
      if (!userMessage) {
        return ipcError(new DomainError('draft_readiness_required', 'no usable text found for draft coach turn'));
      }

      // Forward to draft-coach-turn runner
      const runner = deps.runDraftCoachTurn;
      if (typeof runner !== 'function') {
        // Fallback to legacy suggestion if no coach turn runner
        const legacyRunner = deps.runDraftSuggestion;
        if (typeof legacyRunner !== 'function') {
          return ipcError(new DomainError('internal_error', 'draft coach turn runner is not configured'));
        }
        const result = await legacyRunner({ caseId, draftId });
        if (result.case && typeof result.case === 'object') {
          emitCaseUpdate(deps, 'run_draft_suggestion', result.case as Record<string, unknown>, {
            draftId,
          });
        }
        return ipcSuccess(augmentResultCase(result));
      }

      const result = await runner({
        caseId,
        draftId,
        partyId,
        userMessage,
        composeText: undefined,
      });
      if (result.case && typeof result.case === 'object') {
        emitCaseUpdate(deps, 'run_draft_suggestion', result.case as Record<string, unknown>, {
          draftId,
        });
      }
      return ipcSuccess(augmentResultCase(result));
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_APPROVE_DRAFT, async (_event, payload) => {
    try {
      const caseId = String(payload?.caseId || '');
      const draftId = String(payload?.draftId || '');
      const mediationCase = svc.approveCoachDraftAndSend(
        caseId,
        draftId,
        typeof payload?.approvedText === 'string' ? payload.approvedText : undefined,
      );
      deps.emitStructuredLog?.('draft_coach.approved', { case_id: caseId, draft_id: draftId });
      emitCaseUpdate(deps, 'approve_draft', mediationCase, {
        draftId,
      });
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_RESOLVE, async (_event, payload) => {
    try {
      const mediationCase = svc.resolveCase(String(payload?.caseId || ''), String(payload?.resolution || ''));
      emitCaseUpdate(deps, 'resolve', mediationCase);
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_CLOSE, async (_event, payload) => {
    try {
      const mediationCase = svc.closeCase(String(payload?.caseId || ''));
      emitCaseUpdate(deps, 'close', mediationCase);
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ case: augmentCaseWithTemplateValidity(mediationCase) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ cases: cases.map((c) => augmentCaseWithTemplateValidity(c)) });
    } catch (err) {
      return ipcError(err);
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
      return ipcSuccess({ removed: true, caseId });
    } catch (err) {
      return ipcError(err);
    }
  });

  /* ============================================================
     V2: Main Topic, Template Selection, Draft Coach Turn,
         Draft Readiness — using spec field names
     ============================================================ */

  r.handle(ipcMain, CH.MEDIATION_SET_MAIN_TOPIC, async (_event, payload) => {
    try {
      const caseId = String(payload?.caseId || '');
      const topic = String(payload?.topic || '');
      const description = String(payload?.description || '');
      const categoryId = String(payload?.categoryId || '');
      const templateId = String(payload?.templateId || '');
      const templateVersion = typeof payload?.templateVersion === 'number' ? payload.templateVersion : undefined;
      const partyId = String(payload?.partyId || '');

      // V2 IPC contract enforcement: required fields (Section 7)
      if (!caseId) {
        throw new DomainError('invalid_payload', 'caseId is required');
      }
      if (!topic.trim()) {
        throw new DomainError('main_topic_required', 'topic is required');
      }
      if (!templateId) {
        throw new DomainError('invalid_payload', 'templateId is required for main topic configuration');
      }
      if (templateVersion === undefined) {
        throw new DomainError('invalid_payload', 'templateVersion is required for main topic configuration');
      }
      if (!partyId) {
        throw new DomainError('invalid_payload', 'partyId is required for main topic configuration');
      }

      const mediationCase = svc.setMainTopicConfig(
        caseId,
        {
          topic,
          description,
          categoryId,
          templateId,
          templateVersion,
          configuredByPartyId: partyId || undefined,
        },
      );

      // Also set template selection if templateId provided
      if (templateId && templateVersion !== undefined) {
        svc.setTemplateSelection(caseId, {
          categoryId,
          templateId,
          templateVersion,
          selectedAt: new Date().toISOString(),
        });
      }

      deps.emitStructuredLog?.('main_topic.saved', { case_id: caseId });
      emitCaseUpdate(deps, 'set_main_topic', svc.getCase(caseId));

      const updatedCase = svc.getCase(caseId) as Record<string, unknown>;
      return ipcSuccess({
        mainTopicConfig: updatedCase.mainTopicConfig,
        templateSelection: updatedCase.templateSelection,
      });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_TEMPLATE_SELECTION, async (_event, payload) => {
    try {
      const caseId = String(payload?.caseId || '');
      const categoryId = String(payload?.categoryId || '');
      const templateId = String(payload?.templateId || '');
      const templateVersion = typeof payload?.templateVersion === 'number'
        ? payload.templateVersion
        : (typeof payload?.versionId === 'string' ? Number(payload.versionId) || 0 : 0);
      const actorId = String(payload?.actorId || '');
      const adminOverride = payload?.adminOverride === true;

      // If adminOverride is requested, check admin authorization
      if (adminOverride) {
        const isAdminFn = deps.isAdmin;
        if (typeof isAdminFn !== 'function' || !isAdminFn(actorId)) {
          deps.emitStructuredLog?.('admin.audit', {
            action: 'set_template_selection',
            actor_id: actorId,
            target_id: caseId,
            outcome: 'denied',
            error: 'unauthorized',
          });
          throw new DomainError('unauthorized_admin_action', 'admin access required for template override');
        }
      }

      // Check if case already has group chat started (requires adminOverride)
      const caseData = svc.getCase(caseId) as Record<string, unknown>;
      const groupChat = caseData.groupChat as Record<string, unknown> | undefined;
      if (groupChat?.opened === true && !adminOverride) {
        throw new DomainError('admin_override_required', 'template change after group chat start requires admin override');
      }

      const mediationCase = svc.setTemplateSelection(
        caseId,
        {
          categoryId,
          templateId,
          templateVersion,
          selectedAt: new Date().toISOString(),
        },
      );

      // Audit admin override on template selection change (Section 1.3)
      if (adminOverride) {
        deps.emitStructuredLog?.('admin.audit', {
          action: 'set_template_selection',
          actor_id: actorId,
          target_id: caseId,
          outcome: 'success',
          template_id: templateId,
          template_version: templateVersion,
        });
      }

      deps.emitStructuredLog?.('template.selected', {
        case_id: caseId,
        template_id: templateId,
        template_version: templateVersion,
      });
      emitCaseUpdate(deps, 'set_template_selection', mediationCase);

      const updated = svc.getCase(caseId) as Record<string, unknown>;
      return ipcSuccess({
        templateSelection: updated.templateSelection,
      });
    } catch (err) {
      // Audit all denied paths for admin-override requests (Section 1.3)
      if (payload?.adminOverride === true) {
        const errIsAuthDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
        // Auth-denied was already audited above; audit other failures here
        if (!errIsAuthDenied) {
          deps.emitStructuredLog?.('admin.audit', {
            action: 'set_template_selection',
            actor_id: String(payload?.actorId || ''),
            target_id: String(payload?.caseId || ''),
            outcome: 'denied',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_DRAFT_COACH_TURN, async (_event, payload) => {
    try {
      const caseId = String(payload?.caseId || '');
      const draftId = String(payload?.draftId || '');
      const partyId = String(payload?.partyId || '');
      const userMessage = String(payload?.userMessage || payload?.message || '');
      const composeText = typeof payload?.composeText === 'string' ? payload.composeText : undefined;

      // Check main topic configuration
      const caseData = svc.getCase(caseId) as Record<string, unknown>;
      if (!isCaseConfigured(caseData)) {
        throw new DomainError('main_topic_not_configured', 'Main topic and template must be configured');
      }

      const runner = deps.runDraftCoachTurn;
      if (typeof runner !== 'function') {
        return ipcError(new DomainError('internal_error', 'draft coach turn runner is not configured'));
      }

      const result = await runner({
        caseId,
        draftId,
        partyId,
        userMessage,
        composeText,
      });

      const resultPhase = typeof result.phase === 'string' ? result.phase : 'exploring';
      deps.emitStructuredLog?.('draft_coach.phase_changed', { case_id: caseId, draft_id: draftId, phase: resultPhase });
      if (resultPhase === 'formal_draft_ready') {
        deps.emitStructuredLog?.('draft_coach.formal_generated', { case_id: caseId, draft_id: draftId });
      }
      if (result.case && typeof result.case === 'object') {
        emitCaseUpdate(deps, 'draft_coach_turn', result.case as Record<string, unknown>);
      }

      // V2 IPC: Include coachMeta in response (Section 7)
      const updatedForMeta = svc.getCase(caseId) as Record<string, unknown>;
      const gcForMeta = updatedForMeta.groupChat as Record<string, unknown>;
      const draftsMeta = gcForMeta?.draftsById as Record<string, Record<string, unknown>> || {};
      const draftForMeta = draftsMeta[draftId];
      const coachMeta = draftForMeta?.coachMeta || null;

      return ipcSuccess({ ...result, coachMeta });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.MEDIATION_SET_DRAFT_READINESS, async (_event, payload) => {
    try {
      const caseId = String(payload?.caseId || '');
      const draftId = String(payload?.draftId || '');
      // Spec uses `readinessConfirmed`, fallback to `ready` for compat
      const readinessConfirmed = payload?.readinessConfirmed !== undefined
        ? payload.readinessConfirmed === true
        : payload?.ready !== false;

      const mediationCase = svc.setDraftReadiness(caseId, draftId, readinessConfirmed);
      deps.emitStructuredLog?.('draft_coach.phase_changed', {
        case_id: caseId,
        draft_id: draftId,
        phase: readinessConfirmed ? 'confirm_ready' : 'exploring',
      });
      emitCaseUpdate(deps, 'set_draft_readiness', mediationCase);

      const updated = svc.getCase(caseId) as Record<string, unknown>;
      const groupChat = updated.groupChat as Record<string, unknown>;
      const draftsById = groupChat?.draftsById as Record<string, Record<string, unknown>> || {};
      const draft = draftsById[draftId];
      const coachMeta = draft?.coachMeta as Record<string, unknown> | undefined;
      const phase = typeof coachMeta?.phase === 'string' ? coachMeta.phase : 'exploring';

      return ipcSuccess({ phase });
    } catch (err) {
      return ipcError(err);
    }
  });
}
