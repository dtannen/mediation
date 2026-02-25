# FULL_SPEC.md Audit Against `src/` (Authoritative)

Date: 2026-02-25  
Audited file: `docs/FULL_SPEC.md`  
Authoritative implementation baseline: `src/`  
Non-authoritative artifacts: `dist/` (**stale; do not use for contract decisions**)

---

## 1) Audit Scope and Method

This audit cross-checked `docs/FULL_SPEC.md` against the following source-of-truth implementation files:

- `src/domain/types.ts`
- `src/app/mediation-service.ts`
- `src/engine/phase-engine.ts`
- `src/policy/consent.ts`
- `src/store/in-memory-store.ts`
- `src/transport/contracts.ts`

**Important:** `dist/` currently contains older type/method names (`cross_agent_dialogue`, `joint_mediation`, etc.). It is stale and must not be treated as authoritative.

---

## 2) Executive Summary

- **Core domain model, service API names, phase names, consent model, and adapter contracts are mostly aligned** with `src/`.
- There are **targeted drifts** in `FULL_SPEC.md` that should be corrected before calling the spec fully implementation-synced.
- A large portion of the spec (desktop/gateway/security/plugin/runtime details) is **forward-looking** and not yet represented in `src/`.

### Status Buckets

- ✅ **Aligned with source**: Core types (Section 7), major service operation names (Section 9.1), transition shape (Section 4.2), consent function behavior (Section 8.2), in-memory store API (Section 12.1), transport adapter interfaces (Section 10.1–10.3).
- ⚠️ **Drifted / outdated**: Resolution transition guard wording, invite token generation details, invite URL wording, intro copy exact text, error-precedence claim.
- ❓ **Ambiguous / underspecified**: Some input validation expectations vs actual method behavior (empty message handling for some paths, author-type constraints in private intake, mutable store semantics).
- 🧭 **Future architecture (not implemented in `src/`)**: Most of Sections 9.3, 10.4, 11, 12.2–12.3, 13–18, 20–21.

---

## 3) Structured Gap Matrix (Section-by-Section)

| FULL_SPEC Section | Status | Gap Type | Finding vs `src/` | Recommended Update |
|---|---|---|---|---|
| 4.1 Phases | Aligned | — | Phase union matches `src/domain/types.ts` exactly: `awaiting_join`, `private_intake`, `group_chat`, `resolved`, `closed`. | Keep as-is. |
| 4.2 Allowed transitions | Aligned | — | `ALLOWED_TRANSITIONS` matches `src/engine/phase-engine.ts`. | Keep as-is. |
| 4.3 Transition guards | Drifted | Behavioral drift | Spec says `group_chat -> resolved` requires “resolution text accepted and stored.” In code, `validateTransition()` does **not** inspect resolution text. `resolveCase()` performs transition first, then sets `resolution = resolution.trim()` (can be empty). | Update guard wording to match actual implementation, or tighten code to enforce non-empty resolution before transition. |
| 5.1–5.4 Messaging + draft lifecycle | Aligned | — | Author, visibility, delivery mode, draft statuses, and lifecycle behavior match service implementation. | Keep as-is. |
| 5.5 Media content policy | Not implemented in `src/` | Scope mismatch | Markdown/image sanitization logic described here is not present in this repository’s current `src/`. | Mark as future/port-required, not currently implemented in scaffold. |
| 6.1 Case creation & invites (item 3) | Drifted | Implementation drift | Spec says invite token is UUID v4 / crypto-random equivalent. Code uses `makeId('invite')` = timestamp + `Math.random()` string fragment. | Update spec to current behavior or update implementation to crypto-grade token generation. |
| 6.1 Case creation & invites (item 4) | Drifted | Wording drift | Spec says invite URL is `inviteBaseUrl + token`. Code builds `inviteBaseUrl?caseId=<...>&token=<...>`. | Update spec with exact URL shape. |
| 6.2 Private intake | Mostly aligned | Ambiguity | Phase and join-state gates are implemented; thread existence validation implemented. However, `appendPrivateMessage()` does not restrict `authorType` to only `'party' | 'party_llm'`, and does not reject empty `text`. | Clarify accepted author types and text validation policy in spec (or enforce in code). |
| 6.3 Group open & introductions | Aligned | Minor copy drift | Behavior aligns. Minor string drift: spec example includes bracketed `[partyName]`; code emits `"${party.displayName}: summary remains private and was not shared."` (no brackets). | Use non-normative wording example or align exact string. |
| 6.5 Resolution | Partial drift | Validation drift | Resolution is stored during `resolveCase()`, but no non-empty enforcement exists. | Clarify if empty resolution is allowed. |
| 7.1–7.4 Data model | Aligned | — | `MediationCase`, `ThreadMessage`, `GroupMessageDraft`, `CaseConsent`, `CreateCaseInput`, `AppendMessageInput` match `src/domain/types.ts`. | Keep as-is. |
| 8.1–8.2 Consent policy | Aligned | Minor nuance | Core rules match `enforceShareGrant()`. Nuance: allowed tags are trimmed in grant set; candidate tags are compared as provided. | Optionally document candidate-tag exact-match behavior. |
| 8.3 Consent in group opening | Mostly aligned | Minor copy drift | Flow matches service behavior. See intro line text mismatch noted above. | Optional wording sync. |
| 9.1 Service operations | Aligned | — | Method set and signatures match `MediationService`. | Keep as-is. |
| 9.2 Error contract | Mostly aligned | Ambiguity/drift | Error codes list matches implementation. But precedence statement is too strict globally; actual check order differs by method (often phase check occurs before some existence checks). | Reframe precedence as per-method behavior, not universal order. |
| 9.3 IPC error contract | Not implemented in `src/` | Scope mismatch | No desktop IPC layer exists in this scaffold. | Mark as future architecture contract. |
| 10.1–10.3 Adapter contracts | Aligned | — | Interfaces match `src/transport/contracts.ts`. | Keep as-is. |
| 10.4 Local prompt bridge reuse | Not implemented in `src/` | Scope mismatch | Bridge implementation not present in current scaffold. | Mark as future/port target. |
| 11 Security/trust invariants | Not implemented in `src/` | Scope mismatch | Most controls reference baseline desktop/runtime modules not present in this repo yet. | Mark as future implementation requirements. |
| 12.1 In-memory store | Aligned + underspecified | Ambiguity | API matches class exactly. Undocumented behavior: store returns mutable object references (no cloning/immutability). | Document mutable-reference semantics or change store behavior. |
| 12.2–12.3 Persistence/credentials | Not implemented in `src/` | Scope mismatch | Session persistence and credential storage modules are not in current scaffold. | Mark as future architecture. |
| 13 External interfaces (Slack) | Not implemented in `src/` | Scope mismatch | No Slack/desktop interface code in current scaffold. | Mark as future architecture. |
| 14 Gateway session API | Not implemented in `src/` | Scope mismatch | No gateway client/session stack implemented in scaffold `src/`. | Mark as future architecture. |
| 15 MCP config | Not implemented in `src/` | Scope mismatch | No MCP parsing/config modules currently in scaffold. | Mark as future architecture. |
| 16 Room plugin contract | Not implemented in `src/` | Scope mismatch | No room runtime/plugin loader in current scaffold. | Mark as future architecture. |
| 17 Provider registry contract | Not implemented in `src/` | Scope mismatch | No provider-registry implementation in scaffold yet. | Mark as future architecture. |
| 18 Observability | Not implemented in `src/` | Scope mismatch | No audit service/metrics implementation in scaffold yet. | Mark as future architecture. |
| 19 Testing requirements | Not implemented in repo | Scope mismatch | No tests or test script currently exist. | Keep as requirements; explicitly mark as pending. |
| 20 Reuse inventory | Forward-looking | Planning vs implementation | Reuse map is planning-level and mostly not yet executed in current tree. | Mark as migration plan rather than “implemented” behavior. |
| 21 Target layout | Forward-looking | Planning vs implementation | Target directories/modules listed are mostly absent from current repo. | Label as target blueprint. |
| 22 Current scaffold alignment | Mostly aligned | Missing qualification | Table correctly says many systems are not yet implemented. Should additionally state `dist/` is stale and non-authoritative. | Add explicit non-authoritative `dist/` note. |

---

## 4) Authoritative Current Contracts (from `src/`)

This section restates the currently implemented contracts that downstream edits should treat as source-of-truth.

### 4.1 Domain Types (requested subset)

```ts
type MediationPhase =
  | 'awaiting_join'
  | 'private_intake'
  | 'group_chat'
  | 'resolved'
  | 'closed';

interface CaseConsent {
  byPartyId: Record<string, ConsentGrant>;
}

interface ThreadMessage {
  id: string;
  createdAt: string;
  authorType: MessageAuthorType;
  authorPartyId?: string;
  text: string;
  tags: string[];
  visibility: MessageVisibility;
  deliveryMode?: GroupMessageDeliveryMode;
  sourceDraftId?: string;
}

interface GroupMessageDraft {
  id: string;
  partyId: string;
  createdAt: string;
  updatedAt: string;
  status: GroupDraftStatus;
  composeMessages: CoachComposeMessage[];
  suggestedText?: string;
  approvedText?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  sentMessageId?: string;
}

interface MediationCase {
  id: string;
  topic: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  phase: MediationPhase;
  parties: Party[];
  inviteLink: InviteLink;
  partyParticipationById: Record<string, PartyParticipation>;
  consent: CaseConsent;
  privateIntakeByPartyId: Record<string, PrivateIntakeThread>;
  groupChat: GroupChatRoom;
  resolution?: string;
}

interface CreateCaseInput {
  topic: string;
  description?: string;
  parties: Party[];
  consent: CaseConsent;
  inviteBaseUrl?: string;
}

interface AppendMessageInput {
  caseId: string;
  partyId?: string;
  authorType: MessageAuthorType;
  text: string;
  tags?: string[];
}
```

### 4.2 `MediationService` API (implemented)

```ts
class MediationService {
  createCase(input: CreateCaseInput): MediationCase;
  getCase(caseId: string): MediationCase;
  listCases(): MediationCase[];
  getInviteLink(caseId: string): { token: string; url: string };
  joinWithInvite(caseId: string, partyId: string, inviteToken: string): MediationCase;
  appendPrivateMessage(input: AppendMessageInput): MediationCase;
  setPrivateSummary(caseId: string, partyId: string, summary: string, resolved?: boolean): MediationCase;
  setPartyReady(caseId: string, partyId: string): MediationCase;
  transition(caseId: string, targetPhase: MediationPhase): MediationCase;
  sendDirectGroupMessage(caseId: string, partyId: string, text: string, tags?: string[]): MediationCase;
  createCoachDraft(caseId: string, partyId: string, initialPartyMessage: string): GroupMessageDraft;
  appendCoachDraftMessage(caseId: string, draftId: string, author: CoachComposeAuthor, text: string): MediationCase;
  setCoachDraftSuggestion(caseId: string, draftId: string, suggestedText: string): MediationCase;
  approveCoachDraftAndSend(caseId: string, draftId: string, approvedText?: string): MediationCase;
  rejectCoachDraft(caseId: string, draftId: string, reason?: string): MediationCase;
  appendGroupMessage(input: AppendMessageInput): MediationCase;
  setMediatorSummary(caseId: string, summary: string): MediationCase;
  resolveCase(caseId: string, resolution: string): MediationCase;
  closeCase(caseId: string): MediationCase;
}
```

### 4.3 Transition Engine (implemented)

```ts
const ALLOWED_TRANSITIONS: Record<MediationPhase, Set<MediationPhase>> = {
  awaiting_join: new Set(['private_intake', 'closed']),
  private_intake: new Set(['group_chat', 'closed']),
  group_chat: new Set(['resolved', 'closed']),
  resolved: new Set(['closed']),
  closed: new Set(),
};
```

Additional guards in `validateTransition()`:

- `targetPhase === 'private_intake'` requires all parties joined/ready.
- `targetPhase === 'group_chat'` requires all parties `ready` plus resolved, non-empty private summaries.

### 4.4 Consent Function (implemented)

```ts
enforceShareGrant(grant: ConsentGrant, candidate: ShareCandidate): ShareResult
```

Behavior:

1. Deny if `allowSummaryShare === false`.
2. Deny if candidate tags violate `allowedTags` policy (when `allowedTags` non-empty).
3. Return original text if `allowDirectQuote === true`.
4. Else return paraphrased text (first 36 words, `...` if truncated).

### 4.5 Store Behavior (implemented)

```ts
class InMemoryMediationStore {
  private readonly cases = new Map<string, MediationCase>();
  save(mediationCase: MediationCase): void;
  get(caseId: string): MediationCase | undefined;
  list(): MediationCase[];
}
```

Behavior note: object references are stored/returned directly (mutable in-place updates).

### 4.6 Adapter Contracts (implemented)

```ts
interface LocalCoachAdapter {
  summarizePrivateIntake(request: LocalCoachSummaryRequest): Promise<LocalCoachSummaryResponse>;
  createGroupDraft(request: LocalCoachDraftRequest): Promise<LocalCoachDraftResponse>;
}

interface MediatorLLMAdapter {
  buildOpeningMessages(request: MediatorOpenRequest): Promise<{ intro: string; guidance: string }>;
  nextFacilitationTurn(request: MediatorTurnRequest): Promise<{ message: string }>;
}

interface GatewayGroupMessageAdapter {
  sendGroupMessage(request: GatewayGroupMessageRequest): Promise<void>;
}
```

---

## 5) Suggested Follow-up Sequence for Remaining Workers

1. **Task 2 (domain/workflow rebuild)**: Update Sections 4, 6, 7, and 9 using Section 4 contracts above as normative source.
2. **Task 3 (policy/guardrails/messaging)**: Sync Section 8 and related messaging copy; resolve textual and validation ambiguities listed in matrix.
3. **Task 4 (architecture boundaries/status)**: Mark Sections 9.3, 10.4, 11–21 explicitly as forward-looking architecture unless/until code lands.
4. **Task 5 (final consistency pass)**: Ensure all normative statements are either implemented in `src/` or explicitly tagged as future scope.

---

## 6) Non-Authoritative Build Artifact Warning

`dist/` currently reflects an older contract set and should be ignored for specification alignment decisions.

Example stale artifacts include old phase names (`cross_agent_dialogue`, `joint_mediation`) that do not match current `src/domain/types.ts`.
