import type { MediationCase, ConsentGrant } from '../domain/types';
import { DomainError } from '../domain/errors';
import { IdempotencyStore, commandFingerprint } from './idempotency-store';
import {
  COMMAND_REQUIREMENTS,
  type GatewayAuthContext,
  type MediationCommandEnvelope,
  type MediationCommandName,
  type MediationEventEnvelope,
  type MediationResult,
  type MediationResultEnvelope,
  validateAndNormalizeCommand,
} from './protocol';
import { projectCaseForActor } from './projection';

type BindingStatus = 'active' | 'revoked' | 'left';

export interface PartyBinding {
  actorUid: string;
  actorDeviceId: string;
  grantId: string;
  boundAt: string;
  status: BindingStatus;
}

interface GrantCaseAccess {
  defaultPolicy: 'deny';
  allowedCaseIds: Set<string>;
}

interface MediationServiceLike {
  getCase: (caseId: string) => MediationCase;
  listCases: () => MediationCase[];
  joinParty: (caseId: string, partyId: string) => MediationCase;
  appendPrivateMessage: (input: {
    caseId: string;
    partyId: string;
    authorType: 'party' | 'party_llm' | 'mediator_llm' | 'system';
    text: string;
    tags?: string[];
  }) => MediationCase;
  setPartyConsent: (
    caseId: string,
    partyId: string,
    input: {
      allowSummaryShare: boolean;
      allowDirectQuote: boolean;
      allowedTags?: string[];
    },
  ) => MediationCase;
  setPrivateSummary: (caseId: string, partyId: string, summary: string, resolved?: boolean) => MediationCase;
  setPartyReady: (caseId: string, partyId: string) => MediationCase;
  sendDirectGroupMessage: (caseId: string, partyId: string, text: string, tags?: string[]) => MediationCase;
  createCoachDraft: (caseId: string, partyId: string, initialPartyMessage: string) => { id: string };
  appendCoachDraftMessage: (caseId: string, draftId: string, author: 'party' | 'party_llm', text: string) => MediationCase;
  setCoachDraftSuggestion: (caseId: string, draftId: string, suggestedText: string) => MediationCase;
  approveCoachDraftAndSend: (caseId: string, draftId: string, approvedText?: string) => MediationCase;
  rejectCoachDraft: (caseId: string, draftId: string, reason?: string) => MediationCase;
  resolveCase: (caseId: string, resolution: string) => MediationCase;
  closeCase: (caseId: string) => MediationCase;
}

export interface PersistedRouterState {
  grantCaseAccess: Array<{ grantId: string; allowedCaseIds: string[] }>;
  caseBindings: Array<{ caseId: string; bindings: Array<{ partyId: string; binding: PartyBinding }> }>;
  caseRemoteVersions: Array<{ caseId: string; version: number }>;
  savedAt: string;
}

export interface RouterStatePersistence {
  load(): PersistedRouterState | null;
  save(state: PersistedRouterState): void;
}

interface RouterDeps {
  mediationService: MediationServiceLike;
  idempotencyStore: IdempotencyStore;
  runDraftSuggestion?: (input: { caseId: string; draftId: string }) => Promise<{ case: MediationCase; suggestedText: string }>;
  persistence?: RouterStatePersistence;
}

interface HandleResult {
  result: MediationResult;
  events: MediationEventEnvelope[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asString(entry))
    .filter((entry) => entry.length > 0);
}

function asTrimmedStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      return null;
    }
    out.push(trimmed);
  }
  return out;
}

function isMutating(command: MediationCommandName): boolean {
  return COMMAND_REQUIREMENTS[command].mutating;
}

function errorEnvelope(
  requestId: string,
  code: string,
  message: string,
  recoverable = false,
): MediationResult {
  return {
    type: 'mediation.result',
    schema_version: 1,
    request_id: requestId,
    ok: false,
    error: {
      code,
      message,
      recoverable,
    },
  };
}

function domainToRemoteError(requestId: string, err: unknown): MediationResult {
  if (err instanceof DomainError) {
    switch (err.code) {
      case 'case_not_found':
        return errorEnvelope(requestId, 'case_not_found', err.message);
      case 'case_not_visible':
        return errorEnvelope(requestId, 'case_not_visible', err.message);
      case 'party_not_found':
        return errorEnvelope(requestId, 'party_not_found', err.message);
      case 'party_not_joined':
        return errorEnvelope(requestId, 'not_joined', err.message);
      case 'invalid_phase':
      case 'invalid_transition':
        return errorEnvelope(requestId, 'invalid_phase', err.message, true);
      case 'missing_consent':
      case 'missing_private_summary':
        return errorEnvelope(requestId, 'consent_required', err.message, true);
      case 'draft_not_found':
        return errorEnvelope(requestId, 'draft_not_found', err.message);
      case 'draft_closed':
      case 'draft_not_pending':
        return errorEnvelope(requestId, 'draft_finalized', err.message);
      case 'draft_already_active':
        return errorEnvelope(requestId, 'draft_already_active', err.message, true);
      default:
        return errorEnvelope(requestId, String(err.code || 'invalid_payload'), err.message);
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return errorEnvelope(requestId, 'session_error', message, true);
}

function cloned<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class RemoteMediationRouter {
  private readonly caseBindings = new Map<string, Map<string, PartyBinding>>();
  private readonly grantCaseAccess = new Map<string, GrantCaseAccess>();
  private readonly caseRemoteVersions = new Map<string, number>();
  private readonly draftSuggestionInFlight = new Set<string>();

  constructor(private readonly deps: RouterDeps) {
    this.rehydrateState();
  }

  private rehydrateState(): void {
    const persistence = this.deps.persistence;
    if (!persistence) {
      return;
    }
    const saved = persistence.load();
    if (!saved) {
      return;
    }

    // Rehydrate grant-to-case access
    if (Array.isArray(saved.grantCaseAccess)) {
      for (const entry of saved.grantCaseAccess) {
        if (entry.grantId && Array.isArray(entry.allowedCaseIds)) {
          const access: GrantCaseAccess = {
            defaultPolicy: 'deny',
            allowedCaseIds: new Set(entry.allowedCaseIds),
          };
          this.grantCaseAccess.set(entry.grantId, access);
        }
      }
    }

    // Rehydrate party bindings
    if (Array.isArray(saved.caseBindings)) {
      for (const caseEntry of saved.caseBindings) {
        if (caseEntry.caseId && Array.isArray(caseEntry.bindings)) {
          const bindings = new Map<string, PartyBinding>();
          for (const bindingEntry of caseEntry.bindings) {
            if (bindingEntry.partyId && bindingEntry.binding) {
              bindings.set(bindingEntry.partyId, {
                actorUid: String(bindingEntry.binding.actorUid || ''),
                actorDeviceId: String(bindingEntry.binding.actorDeviceId || ''),
                grantId: String(bindingEntry.binding.grantId || ''),
                boundAt: String(bindingEntry.binding.boundAt || ''),
                status: (['active', 'revoked', 'left'].includes(bindingEntry.binding.status)
                  ? bindingEntry.binding.status
                  : 'active') as BindingStatus,
              });
            }
          }
          if (bindings.size > 0) {
            this.caseBindings.set(caseEntry.caseId, bindings);
          }
        }
      }
    }

    // Rehydrate remote version counters
    if (Array.isArray(saved.caseRemoteVersions)) {
      for (const entry of saved.caseRemoteVersions) {
        if (entry.caseId && typeof entry.version === 'number' && entry.version > 0) {
          this.caseRemoteVersions.set(entry.caseId, entry.version);
        }
      }
    }
  }

  private persistState(): void {
    const persistence = this.deps.persistence;
    if (!persistence) {
      return;
    }

    const grantCaseAccessArr: PersistedRouterState['grantCaseAccess'] = [];
    for (const [grantId, access] of this.grantCaseAccess.entries()) {
      grantCaseAccessArr.push({
        grantId,
        allowedCaseIds: [...access.allowedCaseIds],
      });
    }

    const caseBindingsArr: PersistedRouterState['caseBindings'] = [];
    for (const [caseId, bindings] of this.caseBindings.entries()) {
      const bindingEntries: Array<{ partyId: string; binding: PartyBinding }> = [];
      for (const [partyId, binding] of bindings.entries()) {
        bindingEntries.push({ partyId, binding: { ...binding } });
      }
      if (bindingEntries.length > 0) {
        caseBindingsArr.push({ caseId, bindings: bindingEntries });
      }
    }

    const caseRemoteVersionsArr: PersistedRouterState['caseRemoteVersions'] = [];
    for (const [caseId, version] of this.caseRemoteVersions.entries()) {
      caseRemoteVersionsArr.push({ caseId, version });
    }

    persistence.save({
      grantCaseAccess: grantCaseAccessArr,
      caseBindings: caseBindingsArr,
      caseRemoteVersions: caseRemoteVersionsArr,
      savedAt: nowIso(),
    });
  }

  grantCaseVisibility(grantId: string, caseId: string): void {
    if (!grantId || !caseId) {
      return;
    }
    const access = this.ensureGrantAccess(grantId);
    access.allowedCaseIds.add(caseId);
    this.persistState();
  }

  revokeGrant(grantId: string): MediationEventEnvelope[] {
    return this.terminateGrant(grantId, 'revoked', 'grant_revoked');
  }

  leaveGrant(grantId: string): MediationEventEnvelope[] {
    return this.terminateGrant(grantId, 'left', 'collaborator_left');
  }

  async handleCommand(auth: GatewayAuthContext, raw: unknown): Promise<HandleResult> {
    const validated = validateAndNormalizeCommand(raw);
    if (!validated.ok) {
      return {
        result: validated.error,
        events: [],
      };
    }

    const envelope = validated.envelope;
    if (auth.grantStatus !== 'active') {
      return {
        result: errorEnvelope(envelope.request_id, 'grant_revoked', 'grant is no longer active'),
        events: [],
      };
    }

    if (auth.role === 'collaborator' && !auth.grantId) {
      return {
        result: errorEnvelope(envelope.request_id, 'unauthorized', 'grant_id is required for collaborator'),
        events: [],
      };
    }

    const idemKey = this.extractIdempotencyKey(envelope);
    if (isMutating(envelope.command) && !idemKey) {
      return {
        result: errorEnvelope(envelope.request_id, 'invalid_payload', 'idempotency_key is required'),
        events: [],
      };
    }

    if (isMutating(envelope.command) && idemKey) {
      const scopeGrantId = auth.grantId || `owner:${auth.requesterUid}`;
      const fp = commandFingerprint({
        command: envelope.command,
        caseId: envelope.case_id,
        partyId: envelope.party_id,
        payload: envelope.payload,
      });
      const idem = this.deps.idempotencyStore.get(scopeGrantId, idemKey, fp);
      if ('conflict' in idem && idem.conflict) {
        return {
          result: errorEnvelope(envelope.request_id, 'idempotency_conflict', 'idempotency key reused with different request'),
          events: [],
        };
      }
      if ('hit' in idem && idem.hit) {
        const replayed = cloned(idem.response);
        if (replayed.ok === true) {
          (replayed as MediationResultEnvelope).request_id = envelope.request_id;
          (replayed as MediationResultEnvelope).replayed = true;
        } else {
          replayed.request_id = envelope.request_id;
        }
        return {
          result: replayed,
          events: [],
        };
      }
    }

    const outcome = await this.dispatch(auth, envelope);
    if (isMutating(envelope.command) && idemKey && outcome.result.ok) {
      const scopeGrantId = auth.grantId || `owner:${auth.requesterUid}`;
      const fp = commandFingerprint({
        command: envelope.command,
        caseId: envelope.case_id,
        partyId: envelope.party_id,
        payload: envelope.payload,
      });
      this.deps.idempotencyStore.set(scopeGrantId, idemKey, fp, outcome.result);
    }

    return outcome;
  }

  private async dispatch(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): Promise<HandleResult> {
    try {
      switch (envelope.command) {
        case 'case.list':
          return this.handleCaseList(auth, envelope);
        case 'case.get':
          return this.handleCaseGet(auth, envelope);
        case 'case.join':
          return this.handleCaseJoin(auth, envelope);
        case 'case.append_private':
          return this.handleAppendPrivate(auth, envelope);
        case 'case.set_consent':
          return this.handleSetConsent(auth, envelope);
        case 'case.set_private_summary':
          return this.handleSetPrivateSummary(auth, envelope);
        case 'case.set_ready':
          return this.handleSetReady(auth, envelope);
        case 'case.send_group':
          return this.handleSendGroup(auth, envelope);
        case 'case.create_draft':
          return this.handleCreateDraft(auth, envelope);
        case 'case.append_draft':
          return this.handleAppendDraft(auth, envelope);
        case 'case.run_draft_suggestion':
          return this.handleRunDraftSuggestion(auth, envelope);
        case 'case.submit_suggestion':
          return this.handleSubmitSuggestion(auth, envelope);
        case 'case.approve_draft':
          return this.handleApproveDraft(auth, envelope);
        case 'case.reject_draft':
          return this.handleRejectDraft(auth, envelope);
        case 'case.resolve':
          return this.handleResolve(auth, envelope);
        case 'case.close':
          return this.handleClose(auth, envelope);
        default:
          return {
            result: errorEnvelope(envelope.request_id, 'invalid_payload', 'unsupported command'),
            events: [],
          };
      }
    } catch (err) {
      return {
        result: domainToRemoteError(envelope.request_id, err),
        events: [],
      };
    }
  }

  private handleCaseList(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const visible = this.visibleCasesForGrant(auth);
    const cases = this.deps.mediationService.listCases()
      .filter((entry) => auth.role === 'owner' || visible.has(entry.id))
      .map((entry) => {
        const boundParty = this.findBoundParty(entry.id, auth);
        return {
          case_id: entry.id,
          title: entry.topic,
          phase: entry.phase,
          created_at: entry.createdAt,
          parties: entry.parties.map((party) => ({
            party_id: party.id,
            label: party.displayName,
            joined: this.isPartyJoined(entry, party.id),
            is_self: boundParty === party.id,
          })),
          role: boundParty ? 'joined' : 'available',
        };
      });

    return {
      result: {
        type: 'mediation.result',
        schema_version: 1,
        request_id: envelope.request_id,
        ok: true,
        cases,
      },
      events: [],
    };
  }

  private handleCaseGet(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    this.assertCaseVisible(auth, caseId);
    const mediationCase = this.deps.mediationService.getCase(caseId);
    const actorPartyId = auth.role === 'collaborator'
      ? this.requireBoundParty(caseId, auth)
      : null;
    const projected = projectCaseForActor(mediationCase, actorPartyId, auth.role);
    const remoteVersion = this.currentRemoteVersion(caseId);

    return {
      result: {
        type: 'mediation.result',
        schema_version: 1,
        request_id: envelope.request_id,
        ok: true,
        case: projected,
        remote_version: remoteVersion,
      },
      events: [],
    };
  }

  private handleCaseJoin(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = envelope.party_id || '';
    this.assertCaseVisible(auth, caseId);
    this.assertCasePhase(caseId, ['awaiting_join', 'private_intake']);
    this.assertPartyUnbound(caseId, partyId, auth);

    const mediationCase = this.deps.mediationService.joinParty(caseId, partyId);
    if (auth.role === 'collaborator') {
      this.bindParty(caseId, partyId, auth);
      this.ensureGrantAccess(auth.grantId).allowedCaseIds.add(caseId);
    }

    const remoteVersion = this.bumpRemoteVersion(caseId);
    const actorPartyId = auth.role === 'collaborator' ? partyId : null;
    const projected = projectCaseForActor(mediationCase, actorPartyId, auth.role);
    const event = this.caseUpdatedEvent(caseId, projected, remoteVersion);

    return {
      result: {
        type: 'mediation.result',
        schema_version: 1,
        request_id: envelope.request_id,
        ok: true,
        case: projected,
        remote_version: remoteVersion,
      },
      events: [event],
    };
  }

  private handleAppendPrivate(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['private_intake']);
    const message = (envelope.payload.message && typeof envelope.payload.message === 'object')
      ? (envelope.payload.message as Record<string, unknown>)
      : {};
    const role = asString(message.role);
    if (role !== 'user') {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'message.role must be user'), events: [] };
    }
    const content = asString(message.content);
    if (!content) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'message.content is required'), events: [] };
    }
    if (content.length > 10_000) {
      return { result: errorEnvelope(envelope.request_id, 'message_too_long', 'message exceeds max length', true), events: [] };
    }

    const mediationCase = this.deps.mediationService.appendPrivateMessage({
      caseId,
      partyId,
      authorType: 'party',
      text: content,
      tags: ['remote'],
    });
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);

    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleSetConsent(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['private_intake']);
    const consent = (envelope.payload.consent && typeof envelope.payload.consent === 'object')
      ? (envelope.payload.consent as Record<string, unknown>)
      : null;
    if (!consent) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_consent_fields', 'consent object is required', true), events: [] };
    }

    const allowSummaryShare = consent.allowSummaryShare;
    const allowDirectQuote = consent.allowDirectQuote;
    const allowedTags = asTrimmedStringArray(consent.allowedTags);
    if (typeof allowSummaryShare !== 'boolean' || typeof allowDirectQuote !== 'boolean') {
      return { result: errorEnvelope(envelope.request_id, 'invalid_consent_fields', 'consent fields are invalid', true), events: [] };
    }
    if (!allowedTags) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_consent_fields', 'consent.allowedTags must be a string array', true), events: [] };
    }

    const mediationCase = this.deps.mediationService.setPartyConsent(caseId, partyId, {
      allowSummaryShare: asBoolean(allowSummaryShare),
      allowDirectQuote: asBoolean(allowDirectQuote),
      allowedTags: [...allowedTags],
    });
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);

    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleSetPrivateSummary(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['private_intake']);
    const summary = asString(envelope.payload.summary);
    if (!summary) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'summary is required'), events: [] };
    }
    if (summary.length > 5_000) {
      return { result: errorEnvelope(envelope.request_id, 'summary_too_long', 'summary exceeds max length', true), events: [] };
    }

    const mediationCase = this.deps.mediationService.setPrivateSummary(caseId, partyId, summary, true);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleSetReady(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    if (!asBoolean(envelope.payload.ready ?? true)) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'ready must be true'), events: [] };
    }
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['private_intake']);
    const mediationCase = this.deps.mediationService.getCase(caseId);
    const consent = mediationCase.consent.byPartyId[partyId];
    const hasValidConsent = Boolean(
      consent
      && typeof consent.allowSummaryShare === 'boolean'
      && typeof consent.allowDirectQuote === 'boolean'
      && Array.isArray(consent.allowedTags),
    );
    if (!hasValidConsent) {
      return { result: errorEnvelope(envelope.request_id, 'consent_required', 'valid consent grant is required before ready', true), events: [] };
    }
    const updatedCase = this.deps.mediationService.setPartyReady(caseId, partyId);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(updatedCase, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleSendGroup(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const message = (envelope.payload.message && typeof envelope.payload.message === 'object')
      ? (envelope.payload.message as Record<string, unknown>)
      : {};
    const role = asString(message.role);
    if (role !== 'user') {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'message.role must be user'), events: [] };
    }
    const content = asString(message.content);
    if (!content) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'message.content is required'), events: [] };
    }
    if (content.length > 10_000) {
      return { result: errorEnvelope(envelope.request_id, 'message_too_long', 'message exceeds max length', true), events: [] };
    }

    const mediationCase = this.deps.mediationService.sendDirectGroupMessage(caseId, partyId, content, ['remote']);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleCreateDraft(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const content = asString(envelope.payload.content);
    if (!content) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'content is required'), events: [] };
    }
    if (content.length > 10_000) {
      return { result: errorEnvelope(envelope.request_id, 'message_too_long', 'content exceeds max length', true), events: [] };
    }
    const existingCase = this.deps.mediationService.getCase(caseId);
    const hasActiveDraft = Object.values(existingCase.groupChat.draftsById)
      .some((draft) => draft.partyId === partyId && draft.status !== 'approved' && draft.status !== 'rejected');
    if (hasActiveDraft) {
      return { result: errorEnvelope(envelope.request_id, 'draft_already_active', 'party already has an active draft', true), events: [] };
    }
    const draft = this.deps.mediationService.createCoachDraft(caseId, partyId, content);
    const mediationCase = this.deps.mediationService.getCase(caseId);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);

    return {
      result: {
        ...(this.okCaseResult(envelope.request_id, projected, remoteVersion) as MediationResultEnvelope),
        draft_id: asString(draft.id),
      },
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleAppendDraft(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const draftId = asString(envelope.payload.draft_id);
    const content = asString(envelope.payload.content);
    if (!draftId || !content) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'draft_id and content are required'), events: [] };
    }
    this.assertDraftOwnership(caseId, draftId, partyId);
    const mediationCase = this.deps.mediationService.appendCoachDraftMessage(caseId, draftId, 'party', content);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private async handleRunDraftSuggestion(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): Promise<HandleResult> {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const draftId = asString(envelope.payload.draft_id);
    if (!draftId) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'draft_id is required'), events: [] };
    }
    if (!this.deps.runDraftSuggestion) {
      return { result: errorEnvelope(envelope.request_id, 'llm_error', 'owner draft suggestion runner is unavailable', true), events: [] };
    }
    const draft = this.assertDraftOwnership(caseId, draftId, partyId);
    const originalContent = this.latestDraftText(draft);
    const inFlightKey = `${caseId}::${draftId}`;
    if (this.draftSuggestionInFlight.has(inFlightKey)) {
      return { result: errorEnvelope(envelope.request_id, 'suggestion_in_progress', 'suggestion is already in progress', true), events: [] };
    }

    this.draftSuggestionInFlight.add(inFlightKey);
    let result: { case: MediationCase; suggestedText: string };
    try {
      result = await this.deps.runDraftSuggestion({ caseId, draftId });
    } finally {
      this.draftSuggestionInFlight.delete(inFlightKey);
    }
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(result.case, partyId, auth.role);
    return {
      result: {
        ...(this.okCaseResult(envelope.request_id, projected, remoteVersion) as MediationResultEnvelope),
        suggestion: {
          suggestion_id: `sug_${draftId}_${remoteVersion}`,
          draft_id: draftId,
          original_content: originalContent,
          suggested_content: result.suggestedText,
          rationale: 'Generated by owner-side coaching model',
        },
      },
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleSubmitSuggestion(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const draftId = asString(envelope.payload.draft_id);
    const suggested = asString(envelope.payload.suggested_content);
    if (!draftId || !suggested) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'draft_id and suggested_content are required'), events: [] };
    }
    if (suggested.length > 10_000) {
      return { result: errorEnvelope(envelope.request_id, 'message_too_long', 'suggested_content exceeds max length', true), events: [] };
    }
    this.assertDraftOwnership(caseId, draftId, partyId);

    const mediationCase = this.deps.mediationService.setCoachDraftSuggestion(caseId, draftId, suggested);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(mediationCase, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleApproveDraft(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const draftId = asString(envelope.payload.draft_id);
    if (!draftId) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'draft_id is required'), events: [] };
    }
    const draft = this.assertDraftOwnership(caseId, draftId, partyId);
    const approvedTextInput = asString(envelope.payload.approved_text);
    const useSuggestion = asBoolean(envelope.payload.use_suggestion);
    if (!approvedTextInput && useSuggestion && !asString(draft.suggestedText)) {
      return { result: errorEnvelope(envelope.request_id, 'no_suggestion_available', 'no suggestion available', true), events: [] };
    }

    const approvedText = approvedTextInput
      || (useSuggestion ? asString(draft.suggestedText) : this.latestDraftText(draft));
    const updated = this.deps.mediationService.approveCoachDraftAndSend(caseId, draftId, approvedText);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(updated, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleRejectDraft(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    const caseId = envelope.case_id || '';
    const partyId = this.requireActingParty(auth, envelope);
    this.assertCasePhase(caseId, ['group_chat']);
    const draftId = asString(envelope.payload.draft_id);
    if (!draftId) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'draft_id is required'), events: [] };
    }
    this.assertDraftOwnership(caseId, draftId, partyId);
    const reason = asString(envelope.payload.reason) || 'remote_reject';
    const updated = this.deps.mediationService.rejectCoachDraft(caseId, draftId, reason);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(updated, partyId, auth.role);
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleResolve(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    if (auth.role !== 'owner') {
      return { result: errorEnvelope(envelope.request_id, 'not_authorized_to_resolve', 'only owner can resolve'), events: [] };
    }
    const caseId = envelope.case_id || '';
    this.assertCasePhase(caseId, ['group_chat']);

    // Spec requires at least one group message before resolving
    const mediationCase = this.deps.mediationService.getCase(caseId);
    if (!mediationCase.groupChat.messages || mediationCase.groupChat.messages.length === 0) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_phase', 'at least one group message is required before resolving', true), events: [] };
    }

    const resolutionText = asString(envelope.payload.resolution_text);
    if (!resolutionText) {
      return { result: errorEnvelope(envelope.request_id, 'invalid_payload', 'resolution_text is required'), events: [] };
    }
    if (resolutionText.length > 10_000) {
      return { result: errorEnvelope(envelope.request_id, 'message_too_long', 'resolution_text exceeds max length', true), events: [] };
    }
    const updated = this.deps.mediationService.resolveCase(caseId, resolutionText);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(updated, null, 'owner');
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private handleClose(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): HandleResult {
    if (auth.role !== 'owner') {
      return { result: errorEnvelope(envelope.request_id, 'not_authorized_to_close', 'only owner can close'), events: [] };
    }
    const caseId = envelope.case_id || '';
    this.assertCasePhase(caseId, ['resolved']);
    const updated = this.deps.mediationService.closeCase(caseId);
    const remoteVersion = this.bumpRemoteVersion(caseId);
    const projected = projectCaseForActor(updated, null, 'owner');
    return {
      result: this.okCaseResult(envelope.request_id, projected, remoteVersion),
      events: [this.caseUpdatedEvent(caseId, projected, remoteVersion)],
    };
  }

  private okCaseResult(requestId: string, projectedCase: Record<string, unknown>, remoteVersion: number): MediationResult {
    return {
      type: 'mediation.result',
      schema_version: 1,
      request_id: requestId,
      ok: true,
      case: projectedCase,
      remote_version: remoteVersion,
    };
  }

  private caseUpdatedEvent(caseId: string, projectedCase: Record<string, unknown>, remoteVersion: number): MediationEventEnvelope {
    return {
      type: 'mediation.event',
      schema_version: 1,
      event: 'case.updated',
      case_id: caseId,
      case: projectedCase,
      remote_version: remoteVersion,
    };
  }

  private assertCasePhase(caseId: string, allowed: MediationCase['phase'][]): void {
    const mediationCase = this.deps.mediationService.getCase(caseId);
    if (allowed.includes(mediationCase.phase)) {
      return;
    }
    throw new DomainError('invalid_phase', `command is only allowed in phase(s): ${allowed.join(', ')}`);
  }

  private assertDraftOwnership(caseId: string, draftId: string, partyId: string): MediationCase['groupChat']['draftsById'][string] {
    const mediationCase = this.deps.mediationService.getCase(caseId);
    const draft = mediationCase.groupChat.draftsById[draftId];
    if (!draft || draft.partyId !== partyId) {
      throw new DomainError('draft_not_found', `draft '${draftId}' not found`);
    }
    if (draft.status === 'approved' || draft.status === 'rejected') {
      throw new DomainError('draft_closed', `draft '${draftId}' is already ${draft.status}`);
    }
    return draft;
  }

  private latestDraftText(draft: MediationCase['groupChat']['draftsById'][string]): string {
    if (!draft.composeMessages.length) {
      return '';
    }
    return asString(draft.composeMessages[draft.composeMessages.length - 1]?.text || '');
  }

  private ensureGrantAccess(grantId: string): GrantCaseAccess {
    let entry = this.grantCaseAccess.get(grantId);
    if (!entry) {
      entry = {
        defaultPolicy: 'deny',
        allowedCaseIds: new Set<string>(),
      };
      this.grantCaseAccess.set(grantId, entry);
    }
    return entry;
  }

  private visibleCasesForGrant(auth: GatewayAuthContext): Set<string> {
    if (auth.role === 'owner') {
      return new Set(this.deps.mediationService.listCases().map((entry) => entry.id));
    }
    return new Set(this.ensureGrantAccess(auth.grantId).allowedCaseIds);
  }

  private assertCaseVisible(auth: GatewayAuthContext, caseId: string): void {
    if (auth.role === 'owner') {
      return;
    }
    const access = this.ensureGrantAccess(auth.grantId);
    if (!access.allowedCaseIds.has(caseId)) {
      throw new DomainError('case_not_visible', `case '${caseId}' is not visible to this grant`);
    }
  }

  private getBindingsForCase(caseId: string): Map<string, PartyBinding> {
    let bindings = this.caseBindings.get(caseId);
    if (!bindings) {
      bindings = new Map<string, PartyBinding>();
      this.caseBindings.set(caseId, bindings);
    }
    return bindings;
  }

  private bindParty(caseId: string, partyId: string, auth: GatewayAuthContext): void {
    const bindings = this.getBindingsForCase(caseId);
    bindings.set(partyId, {
      actorUid: auth.requesterUid,
      actorDeviceId: auth.requesterDeviceId,
      grantId: auth.grantId,
      boundAt: nowIso(),
      status: 'active',
    });
    this.persistState();
  }

  private assertPartyUnbound(caseId: string, partyId: string, auth: GatewayAuthContext): void {
    if (auth.role !== 'collaborator') {
      return;
    }
    const bindings = this.getBindingsForCase(caseId);
    const existing = bindings.get(partyId);
    if (!existing) {
      return;
    }
    if (existing.status !== 'active') {
      return;
    }
    if (
      existing.actorUid === auth.requesterUid
      && existing.grantId === auth.grantId
      && existing.actorDeviceId === auth.requesterDeviceId
    ) {
      return;
    }
    throw new DomainError('party_already_bound', `party '${partyId}' is already bound`);
  }

  private requireBoundParty(caseId: string, auth: GatewayAuthContext): string {
    const found = this.findBoundParty(caseId, auth);
    if (!found) {
      throw new DomainError('not_joined', 'actor is not joined to this case');
    }
    return found;
  }

  private findBoundParty(caseId: string, auth: GatewayAuthContext): string | null {
    const bindings = this.getBindingsForCase(caseId);
    for (const [partyId, binding] of bindings.entries()) {
      if (binding.status !== 'active') {
        continue;
      }
      if (
        binding.actorUid === auth.requesterUid
        && binding.grantId === auth.grantId
        && binding.actorDeviceId === auth.requesterDeviceId
      ) {
        return partyId;
      }
    }
    return null;
  }

  private requireActingParty(auth: GatewayAuthContext, envelope: MediationCommandEnvelope): string {
    const caseId = envelope.case_id || '';
    const envelopePartyId = envelope.party_id || '';
    this.assertCaseVisible(auth, caseId);

    if (auth.role !== 'collaborator') {
      return envelopePartyId;
    }

    if (envelope.command === 'case.join') {
      return envelopePartyId;
    }

    const boundParty = this.requireBoundParty(caseId, auth);
    if (boundParty !== envelopePartyId) {
      throw new DomainError('not_joined', 'party_id does not match bound actor party');
    }
    return boundParty;
  }

  private isPartyJoined(mediationCase: MediationCase, partyId: string): boolean {
    const state = mediationCase.partyParticipationById[partyId]?.state;
    return state === 'joined' || state === 'ready';
  }

  private extractIdempotencyKey(envelope: MediationCommandEnvelope): string {
    if (!isMutating(envelope.command)) {
      return '';
    }
    return asString(envelope.payload.idempotency_key);
  }

  currentRemoteVersion(caseId: string): number {
    return this.caseRemoteVersions.get(caseId) || 0;
  }

  /**
   * Atomically increment and return the next remote version for a case.
   * Use this for owner-initiated push sync events so collaborator devices
   * always receive a monotonically increasing version and don't reject
   * the update as stale.
   */
  nextRemoteVersionForSync(caseId: string): number {
    return this.bumpRemoteVersion(caseId);
  }

  private bumpRemoteVersion(caseId: string): number {
    const next = this.currentRemoteVersion(caseId) + 1;
    this.caseRemoteVersions.set(caseId, next);
    this.persistState();
    return next;
  }

  private terminateGrant(grantId: string, status: BindingStatus, reason: string): MediationEventEnvelope[] {
    const events: MediationEventEnvelope[] = [];
    for (const [caseId, bindings] of this.caseBindings.entries()) {
      for (const [partyId, binding] of bindings.entries()) {
        if (binding.grantId !== grantId) {
          continue;
        }
        binding.status = status;
        const remoteVersion = this.bumpRemoteVersion(caseId);
        events.push({
          type: 'mediation.event',
          schema_version: 1,
          event: 'party.disconnected',
          case_id: caseId,
          party_id: partyId,
          reason,
          remote_version: remoteVersion,
        });
      }
    }

    const access = this.grantCaseAccess.get(grantId);
    if (access) {
      access.allowedCaseIds.clear();
    }

    this.persistState();
    return events;
  }

  /**
   * Returns all active bound collaborator sessions for a given case.
   * Used for outbound event fanout from owner to collaborators.
   */
  getActiveBoundCollaborators(caseId: string): Array<{ partyId: string; grantId: string; actorDeviceId: string; actorUid: string }> {
    const bindings = this.caseBindings.get(caseId);
    if (!bindings) {
      return [];
    }
    const result: Array<{ partyId: string; grantId: string; actorDeviceId: string; actorUid: string }> = [];
    for (const [partyId, binding] of bindings.entries()) {
      if (binding.status === 'active' && binding.grantId) {
        result.push({
          partyId,
          grantId: binding.grantId,
          actorDeviceId: binding.actorDeviceId,
          actorUid: binding.actorUid,
        });
      }
    }
    return result;
  }

  /**
   * Returns all case IDs that have active collaborator bindings.
   */
  getCasesWithActiveCollaborators(): string[] {
    const result: string[] = [];
    for (const [caseId, bindings] of this.caseBindings.entries()) {
      for (const binding of bindings.values()) {
        if (binding.status === 'active' && binding.grantId) {
          result.push(caseId);
          break;
        }
      }
    }
    return result;
  }
}
