# Mediation App Full Specification (v1)

Status: Implementation-Ready v1
Date: 2026-02-25
Codebase: `/Users/dtannen/Code/mediation`
Source baseline for reuse: `/Users/dtannen/Code/commands-com-agent`
Gateway reference: `/Users/dtannen/Code/commands-com-api-gateway`
Authoritative implementation baseline for this specification: `src/` (**`dist/` is non-authoritative and may be stale**).

---

## 0. Implementation Boundary and Status Legend

This document contains both **currently implemented scaffold contracts** and **target architecture contracts**.

- **CURRENT (implemented in `src/`)**
  - Domain types (`src/domain/types.ts`)
  - Domain service/orchestration (`src/app/mediation-service.ts`)
  - Phase guards (`src/engine/phase-engine.ts`)
  - Consent enforcement (`src/policy/consent.ts`)
  - In-memory case storage (`src/store/in-memory-store.ts`)
  - Transport adapter **interfaces only** (`src/transport/contracts.ts`)

- **TARGET (future scope, not yet implemented in `src/`)**
  - Desktop/Electron UI and IPC layers
  - Auth/OAuth runtime
  - E2EE handshake/session transport
  - Gateway runtime integrations
  - Persistent encrypted storage/history
  - Real provider/LLM adapter implementations
  - Room/plugin runtime and external interface stack
  - Full observability/audit pipeline

When a section is target-only, it is explicitly marked as such.

## 1. Product Goal

Build a standalone mediation app with three AI roles:

1. **Coach A LLM** (private to Party A)
2. **Coach B LLM** (private to Party B)
3. **Neutral Mediator LLM** (shared in group chat)

Flow:

1. Mediation is created with topic and invite link.
2. Each party completes fully private intake with their own coach.
3. Each party marks `ready`.
4. Group chat opens with neutral mediator.
5. Each party can either send directly or optionally use coach draft + approval before sending.

## 2. Canonical User Flow

1. Create case with topic.
2. System generates invite link.
3. Parties join with invite token.
4. Private intake runs independently per party and is not publicly visible.
5. Each party sets `ready` after private summary is complete.
6. On all-ready, group chat opens.
7. Neutral mediator posts introductions using approved coach summaries.
8. During group chat, each outgoing party message supports two modes:
   - direct send
   - optional coach draft -> user approval -> send
9. Mediator guides discussion to resolution or controlled closure.

## 3. Non-Goals (v1)

1. Legal advice or legal determination
2. Audio/video conferencing
3. Autonomous legal enforcement
4. Enterprise tenant administration
5. Self-hosted or custom gateway URLs (v1 uses hardcoded trusted-origin allowlist only)
6. Persistent encrypted chat history (v1 state is in-memory only)
7. External image rendering in chat (blocked for security)
8. Generic multi-provider interface plugins (v1 is Slack-only for external interfaces)
9. Rich template-driven MCP management UI (v1 uses filesystem toggle + raw JSON config)

## 4. Lifecycle Model

### 4.1 Phases

```typescript
type MediationPhase =
  | 'awaiting_join'
  | 'private_intake'
  | 'group_chat'
  | 'resolved'
  | 'closed';
```

### 4.2 Allowed Transitions (normative)

```typescript
const ALLOWED_TRANSITIONS: Record<MediationPhase, Set<MediationPhase>> = {
  awaiting_join: new Set(['private_intake', 'closed']),
  private_intake: new Set(['group_chat', 'closed']),
  group_chat: new Set(['resolved', 'closed']),
  resolved: new Set(['closed']),
  closed: new Set(),   // terminal
};
```

### 4.3 Transition Guards

| From | To | Guard (current implementation) |
|---|---|---|
| `awaiting_join` | `private_intake` | All parties have `state === 'joined'` or `state === 'ready'` |
| `private_intake` | `group_chat` | All parties have `state === 'ready'` AND `privateIntakeByPartyId[partyId].resolved === true` AND `summary.trim().length > 0` |
| `group_chat` | `resolved` | No additional guard in `validateTransition`; edge is allowed by `ALLOWED_TRANSITIONS`. `resolveCase()` enforces `group_chat` phase, performs transition, then stores `resolution.trim()`. |
| `resolved` | `closed` | No additional guard in `validateTransition`; edge is allowed by `ALLOWED_TRANSITIONS`. |
| `awaiting_join` / `private_intake` / `group_chat` | `closed` | Allowed by `ALLOWED_TRANSITIONS` (no additional guard logic in `validateTransition`). |

### 4.4 Participation States

Per party:

```typescript
type PartyParticipationState = 'invited' | 'joined' | 'ready';
```

`ready` requires: valid join + resolved private summary with non-empty text.

## 5. Messaging Model

### 5.1 Message Author Types

```typescript
type MessageAuthorType = 'party' | 'party_llm' | 'mediator_llm' | 'system';
```

### 5.2 Visibility

```typescript
type MessageVisibility = 'private' | 'group' | 'system';
```

### 5.3 Group Delivery Modes

```typescript
type GroupMessageDeliveryMode = 'direct' | 'coach_approved' | 'system';
```

### 5.4 Coach-Draft Workflow (Optional)

Draft status lifecycle:

```typescript
type GroupDraftStatus = 'composing' | 'pending_approval' | 'approved' | 'rejected';
```

Flow:

1. Party creates a coach draft with initial message text. Status: `composing`.
2. Multi-turn private conversation between party and coach (author: `'party'` | `'party_llm'`).
3. Coach provides a suggested final draft via `setCoachDraftSuggestion`: a compose message is appended with `author: 'party_llm'`, `suggestedText` is set, and status transitions to `pending_approval`.
4. Party can continue iterating after seeing a suggested draft: appending a party compose message while status is `pending_approval` moves status back to `composing` and clears `suggestedText`.
5. Party approves via `approveCoachDraftAndSend`: status becomes `approved`, `approvedText`, `approvedAt`, and `sentMessageId` are set; a group message is posted with `deliveryMode: 'coach_approved'`, `tags: ['coach_draft']`, and `sourceDraftId` set to the draft ID.
6. Party rejects via `rejectCoachDraft`: status becomes `rejected`, `rejectedAt` is set, and optional `rejectionReason` is stored as trimmed text (or omitted).
7. Direct send remains available for every turn (bypasses draft entirely).

### 5.5 Media Content Policy (TARGET architecture; not currently implemented in `src/`)

Implementation status: **TARGET**. The current scaffold has no markdown rendering/sanitization module yet.

Planned control model:

- External images are blocked.
- Marked.js custom renderer replaces all `image()` calls with `<span class="md-image-blocked" title="External images blocked">[blocked]</span>`.
- HTML sanitizer removes `<img>`, `<script>`, `<iframe>`, `<embed>`, `<form>`, `<style>`, `<link>`, `<base>`, `<meta>` tags.
- Only `https:` and `mailto:` URI schemes are allowed in links; all others are blocked with `#blocked:` prefix.
- All `on*` event handler attributes are stripped.
- `javascript:`, `data:`, `vbscript:` URI schemes are blocked on `href`, `src`, `action` attributes.

Future scope: if image support is required, define safe fetch/proxy model, content-type validation, size limits, and CSP controls before enabling.

## 6. Functional Requirements

### 6.1 Case Creation and Invites

1. Case requires topic (non-empty string) and 2+ parties.
2. Each party must have `id`, `displayName`, and `localLLM` (provider + model).
3. Invite token is generated by internal helper `makeId('invite')` (timestamp + random suffix; not UUID v4 in current implementation).
4. Invite URL is generated as: `${inviteBaseUrl}?caseId=${encodeURIComponent(caseId)}&token=${encodeURIComponent(inviteToken)}`. Default `inviteBaseUrl` is `https://mediation.local/join` when omitted.
5. Invite token is validated on join (exact match).
6. Case starts in `awaiting_join`.

### 6.2 Private Intake

1. Per-party private thread stored in `privateIntakeByPartyId[partyId]`.
2. Messages restricted to `private_intake` phase.
3. Party must have `state === 'joined'` or `state === 'ready'` to append messages.
4. Thread must exist for the given party (validated against case parties).
5. Intake concludes with `setPrivateSummary` (sets `summary` + `resolved` flag).
6. Private transcript is never auto-exposed to mediator or other party.

### 6.3 Group Open and Introductions

1. Group opens only when all parties ready (automatic transition).
2. `groupChat.opened` set to `true` on first entry.
3. Neutral mediator posts two messages:
   - **Introduction**: Topic context + each party's coach summary (subject to consent rules).
   - **Guidance**: Structured opening questions to both parties.
4. `introductionsSent` flag prevents duplicate posting.

### 6.4 Group Discussion

1. Party can send direct at any turn via `sendDirectGroupMessage`.
2. Party can optionally use coach draft path via `createCoachDraft` -> `appendCoachDraftMessage` -> `setCoachDraftSuggestion` -> `approveCoachDraftAndSend` | `rejectCoachDraft`.
3. Mediator keeps neutrality and process discipline through active questioning.
4. Mediator asks follow-up and clarifying questions to identify overlap, constraints, and option sets.

### 6.4.1 Messaging Method Semantics (normative, current implementation)

| Method | Preconditions / Guards | Message & state effects | Method-specific error conditions |
|---|---|---|---|
| `sendDirectGroupMessage(caseId, partyId, text, tags?)` | Requires `phase === 'group_chat'` and `partyId` exists in `mediationCase.parties`; `text.trim()` must be non-empty | Appends a `ThreadMessage` via `makeMessage('party', finalText, 'group', partyId, tags, { deliveryMode: 'direct' })`.<br>Resulting message has `authorType: 'party'`, `visibility: 'group'`, `deliveryMode: 'direct'`, and no `sourceDraftId`. | `invalid_phase`, `party_not_found`, `invalid_group_message` |
| `createCoachDraft(caseId, partyId, initialPartyMessage)` | Requires `phase === 'group_chat'`; party must exist; `initialPartyMessage.trim()` non-empty | Creates `GroupMessageDraft` with `status: 'composing'` and initial compose message `{ author: 'party', text: trimmedInitial }`; stores at `groupChat.draftsById[draft.id]`. | `invalid_phase`, `party_not_found`, `invalid_intent` |
| `appendCoachDraftMessage(caseId, draftId, author, text)` | Requires `phase === 'group_chat'`; draft must exist; draft must not be `approved` or `rejected`; `text.trim()` non-empty | Appends compose message with supplied `author` and trimmed text. If `author === 'party'` and prior status was `pending_approval`, status is reset to `composing` and `suggestedText` is cleared (`undefined`). | `invalid_phase`, `draft_not_found`, `draft_closed`, `invalid_compose_message` |
| `setCoachDraftSuggestion(caseId, draftId, suggestedText)` | Requires `phase === 'group_chat'`; draft must exist; draft must not be `approved` or `rejected`; `suggestedText.trim()` non-empty | Appends compose message `{ author: 'party_llm', text: finalSuggestion }`, sets `draft.suggestedText = finalSuggestion`, and sets `draft.status = 'pending_approval'`. | `invalid_phase`, `draft_not_found`, `draft_closed`, `invalid_suggested_text` |
| `approveCoachDraftAndSend(caseId, draftId, approvedText?)` | Requires `phase === 'group_chat'`; draft must exist; draft status must be exactly `pending_approval`; final text computed as `(approvedText || draft.suggestedText || '').trim()` must be non-empty | Sets draft fields: `status = 'approved'`, `approvedText`, `approvedAt`, `updatedAt`.<br>Appends group message via `makeMessage('party', finalText, 'group', draft.partyId, ['coach_draft'], { deliveryMode: 'coach_approved', sourceDraftId: draft.id })` and stores `draft.sentMessageId` to that message ID. | `invalid_phase`, `draft_not_found`, `draft_not_pending`, `invalid_approved_text` |
| `rejectCoachDraft(caseId, draftId, reason?)` | Requires `phase === 'group_chat'`; draft must exist; draft must not be `approved` or `rejected` | Sets `status = 'rejected'`, sets `rejectedAt`, and stores `rejectionReason = (reason || '').trim() || undefined`. | `invalid_phase`, `draft_not_found`, `draft_closed` |
| `appendGroupMessage(input)` | Requires `phase === 'group_chat'`.<br>If `input.authorType === 'party'`: `input.partyId` is required and method delegates to `sendDirectGroupMessage`.<br>If non-party author type: no partyId requirement and no trim/empty validation on text in current implementation. | Party-author path results in same message semantics as `sendDirectGroupMessage` (`deliveryMode: 'direct'`).<br>Non-party path appends via `makeMessage(input.authorType, input.text, 'group', input.partyId, input.tags ?? [], { deliveryMode: 'system' })` with `visibility: 'group'`, `deliveryMode: 'system'`, and no `sourceDraftId`. | Always: `invalid_phase`.<br>Party-author delegated path may also throw `missing_party`, `party_not_found`, `invalid_group_message`. |

### 6.5 Resolution

1. `resolveCase` is only valid during `group_chat`; it transitions to `resolved` and then stores `resolution.trim()`.
2. Current implementation does not enforce non-empty resolution text before storing.
3. `closeCase` can close from any non-terminal phase.
4. Full message timeline serves as audit trail.

## 7. Data Model (Normative TypeScript)

All types below are normative. Implementation MUST match these shapes exactly.

### 7.1 Core Types

```typescript
interface LLMChoice {
  provider: string;   // e.g. "claude", "ollama"
  model: string;      // e.g. "claude-sonnet-4-20250514"
}

interface Party {
  id: string;
  displayName: string;
  localLLM: LLMChoice;
}

interface PartyParticipation {
  partyId: string;
  state: PartyParticipationState;  // 'invited' | 'joined' | 'ready'
  invitedAt: string;               // ISO 8601
  joinedAt?: string;               // ISO 8601
  readyAt?: string;                // ISO 8601
}

interface InviteLink {
  token: string;
  url: string;
  createdAt: string;      // ISO 8601
  expiresAt?: string;     // ISO 8601 (optional, for future TTL)
}

interface ConsentGrant {
  allowSummaryShare: boolean;
  allowDirectQuote: boolean;
  allowedTags: string[];  // empty array = all tags allowed
}

interface CaseConsent {
  byPartyId: Record<string, ConsentGrant>;
}
```

### 7.2 Message Types

```typescript
interface ThreadMessage {
  id: string;
  createdAt: string;               // ISO 8601
  authorType: MessageAuthorType;
  authorPartyId?: string;
  text: string;
  tags: string[];
  visibility: MessageVisibility;
  deliveryMode?: GroupMessageDeliveryMode;
  sourceDraftId?: string;
}

interface PrivateIntakeThread {
  partyId: string;
  resolved: boolean;
  summary: string;
  messages: ThreadMessage[];
}

type CoachComposeAuthor = 'party' | 'party_llm';

interface CoachComposeMessage {
  id: string;
  createdAt: string;       // ISO 8601
  author: CoachComposeAuthor;
  text: string;
}

interface GroupMessageDraft {
  id: string;
  partyId: string;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  status: GroupDraftStatus;  // 'composing' | 'pending_approval' | 'approved' | 'rejected'
  composeMessages: CoachComposeMessage[];
  suggestedText?: string;
  approvedText?: string;
  approvedAt?: string;     // ISO 8601
  rejectedAt?: string;     // ISO 8601
  rejectionReason?: string;
  sentMessageId?: string;
}
```

### 7.3 Aggregate Root

```typescript
interface GroupChatRoom {
  opened: boolean;
  introductionsSent: boolean;
  mediatorSummary: string;
  messages: ThreadMessage[];
  draftsById: Record<string, GroupMessageDraft>;
}

interface MediationCase {
  id: string;
  topic: string;
  description: string;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
  phase: MediationPhase;
  parties: Party[];
  inviteLink: InviteLink;
  partyParticipationById: Record<string, PartyParticipation>;
  consent: CaseConsent;
  privateIntakeByPartyId: Record<string, PrivateIntakeThread>;
  groupChat: GroupChatRoom;
  resolution?: string;
}
```

### 7.4 Input Types

```typescript
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

## 8. Consent and Privacy Policy

### 8.1 Grant Fields

Per party:

| Field | Type | Effect |
|---|---|---|
| `allowSummaryShare` | `boolean` | If `false`, mediator receives no summary for that party |
| `allowDirectQuote` | `boolean` | If `false`, summary text is paraphrased using first-36-word truncation semantics |
| `allowedTags` | `string[]` | Only messages with matching tags are shareable. Empty = all tags allowed |

### 8.2 Enforcement Rules (normative, exact current implementation)

Implemented in `src/policy/consent.ts`:

```typescript
interface ShareCandidate {
  partyId: string;
  text: string;
  tags: string[];
}

interface ShareResult {
  allowed: boolean;
  text: string;
  reason?: string;
}

function allTagsAllowed(candidateTags: string[], allowedTags: string[]): boolean {
  if (allowedTags.length === 0) {
    return true;
  }
  const allowSet = new Set(allowedTags.map((tag) => tag.trim()).filter(Boolean));
  return candidateTags.every((tag) => allowSet.has(tag));
}

function toParaphrasedSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const words = normalized.split(' ');
  const clipped = words.slice(0, 36).join(' ');
  return words.length > 36 ? `${clipped}...` : clipped;
}

function enforceShareGrant(grant: ConsentGrant, candidate: ShareCandidate): ShareResult {
  if (!grant.allowSummaryShare) {
    return {
      allowed: false,
      text: '',
      reason: `party '${candidate.partyId}' disallowed sharing from private intake`,
    };
  }

  if (!allTagsAllowed(candidate.tags, grant.allowedTags)) {
    return {
      allowed: false,
      text: '',
      reason: `party '${candidate.partyId}' disallowed one or more content tags`,
    };
  }

  if (grant.allowDirectQuote) {
    return {
      allowed: true,
      text: candidate.text,
    };
  }

  return {
    allowed: true,
    text: toParaphrasedSummary(candidate.text),
  };
}
```

Normative behavior summary:
1. Deny when `allowSummaryShare === false`.
2. Deny when candidate tags are not allowed by `allowedTags` (with `allowedTags` normalized by trimming and filtering empty entries; candidate tags are checked as-provided).
3. If `allowDirectQuote === true`, return original `candidate.text` unchanged.
4. If `allowDirectQuote === false`, return paraphrased text:
   - collapse whitespace,
   - take first 36 words,
   - append `...` **only when** source text exceeds 36 words,
   - return empty string when normalized input is empty.

### 8.3 Consent in Group Opening (`emitMediatorOpenMessages`)

Current implementation behavior:

```typescript
const shareResult = enforceShareGrant(grant, {
  partyId: party.id,
  text: thread.summary,
  tags: ['summary'],
});
```

- If `shareResult.allowed === false`, mediator intro line is:
  - `${party.displayName}: summary remains private and was not shared.`
- If `shareResult.allowed === true`, mediator intro line is:
  - `${party.displayName} coach summary: ${shareResult.text}`

This ensures private intake summaries are only introduced into group context via explicit consent filtering.

## 9. Service/API Contract

### 9.1 Operations

All operations are methods on `MediationService` (`src/app/mediation-service.ts`):

| # | Operation | Signature | Returns |
|---|---|---|---|
| 1 | `createCase` | `(input: CreateCaseInput)` | `MediationCase` |
| 2 | `getCase` | `(caseId: string)` | `MediationCase` |
| 3 | `listCases` | `()` | `MediationCase[]` |
| 4 | `getInviteLink` | `(caseId: string)` | `{ token: string; url: string }` |
| 5 | `joinWithInvite` | `(caseId: string, partyId: string, inviteToken: string)` | `MediationCase` |
| 6 | `appendPrivateMessage` | `(input: AppendMessageInput)` | `MediationCase` |
| 7 | `setPrivateSummary` | `(caseId: string, partyId: string, summary: string, resolved?: boolean)` | `MediationCase` |
| 8 | `setPartyReady` | `(caseId: string, partyId: string)` | `MediationCase` |
| 9 | `transition` | `(caseId: string, targetPhase: MediationPhase)` | `MediationCase` |
| 10 | `sendDirectGroupMessage` | `(caseId: string, partyId: string, text: string, tags?: string[])` | `MediationCase` |
| 11 | `createCoachDraft` | `(caseId: string, partyId: string, initialPartyMessage: string)` | `GroupMessageDraft` |
| 12 | `appendCoachDraftMessage` | `(caseId: string, draftId: string, author: CoachComposeAuthor, text: string)` | `MediationCase` |
| 13 | `setCoachDraftSuggestion` | `(caseId: string, draftId: string, suggestedText: string)` | `MediationCase` |
| 14 | `approveCoachDraftAndSend` | `(caseId: string, draftId: string, approvedText?: string)` | `MediationCase` |
| 15 | `rejectCoachDraft` | `(caseId: string, draftId: string, reason?: string)` | `MediationCase` |
| 16 | `appendGroupMessage` | `(input: AppendMessageInput)` | `MediationCase` |
| 17 | `setMediatorSummary` | `(caseId: string, summary: string)` | `MediationCase` |
| 18 | `resolveCase` | `(caseId: string, resolution: string)` | `MediationCase` |
| 19 | `closeCase` | `(caseId: string)` | `MediationCase` |

### 9.2 Error Contract

The mediation domain uses `DomainError` for all business rule violations:

```typescript
class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
```

**Domain error codes (normative, exhaustive):**

| Code | Thrown By | Meaning |
|---|---|---|
| `invalid_topic` | `createCase` | Mediation topic is required (empty/missing topic) |
| `invalid_party_count` | `createCase` | A mediation case requires at least 2 parties |
| `duplicate_party_id` | `createCase` | Duplicate party ID in case parties list |
| `missing_consent` | `createCase` | Missing consent policy for a party |
| `case_not_found` | `getCase` | Case ID does not exist |
| `invalid_invite_token` | `joinWithInvite` | Token does not match case invite |
| `party_not_found` | join, intake, summary, and group operations | Party ID not in case |
| `party_not_joined` | intake, ready | Party must join before this action |
| `invalid_phase` | private/group operations and ready/summary transitions | Operation not valid in current phase |
| `missing_private_summary` | `setPartyReady` | Summary must be resolved before ready |
| `invalid_transition` | `transition` | Phase transition not allowed |
| `invalid_group_message` | `sendDirectGroupMessage` | Empty message text |
| `draft_not_found` | draft operations | Draft ID not found |
| `draft_closed` | `appendCoachDraftMessage`, `setCoachDraftSuggestion`, `rejectCoachDraft` | Draft already approved/rejected |
| `draft_not_pending` | `approveCoachDraftAndSend` | Draft not in `pending_approval` state |
| `invalid_intent` | `createCoachDraft` | Empty initial message |
| `invalid_compose_message` | `appendCoachDraftMessage` | Empty compose message |
| `invalid_suggested_text` | `setCoachDraftSuggestion` | Empty suggestion |
| `invalid_approved_text` | `approveCoachDraftAndSend` | Empty approved text |
| `missing_party` | `appendPrivateMessage`, `appendGroupMessage` (when `authorType === 'party'`) | `partyId` required |

**Error precedence:** Error-check order is method-specific and follows each method’s control flow in `src/app/mediation-service.ts`. Consumers should not assume one global precedence order across all operations.

### 9.3 IPC Error Contract (Desktop Layer — TARGET, not currently implemented in `src/`)

This section defines the **target desktop IPC boundary contract**. The current scaffold does not include a desktop/Electron runtime yet.

Normative v1 target shapes:

| IPC Layer | Error Shape | Example |
|---|---|---|
| Mediation domain IPC | `{ ok: false, error: { code: string, message: string } }` | `{ ok: false, error: { code: 'case_not_found', message: "case 'abc' was not found" } }` |
| Group chat / room IPC | `{ ok: false, error: { code: string, message: string, recoverable: boolean } }` | `{ ok: false, error: { code: 'internal_error', message: '...', recoverable: false } }` |
| Gateway send IPC | `{ ok: false, error: { code: string, message: string, recoverable: boolean, status?: number, details?: object } }` | `{ ok: false, error: { code: 'rate_limit_exceeded', message: '...', recoverable: true } }` |
| Gateway general IPC | `{ ok: false, error: string }` | `{ ok: false, error: 'Invalid deviceId' }` |
| Auth IPC | `{ ok: false, error: string }` | `{ ok: false, error: 'Sign in failed' }` |

Migration target (v2):

```typescript
interface IpcError {
  code: string;
  message: string;
  recoverable: boolean;
  status?: number;
  details?: Record<string, unknown>;
}

// All IPC responses:
type IpcResult<T> = { ok: true } & T | { ok: false; error: IpcError };
```

Migration steps:
1. Add `normalizeIpcError(err)` utility that coerces string errors into `{ code: 'unknown', message: err, recoverable: true }`.
2. Wrap all IPC handlers with the normalizer at the boundary.
3. Update renderer to accept both shapes during migration window.
4. Remove legacy string-error paths after all handlers are migrated.

## 10. Transport Contracts (LLM Adapters)

Implementation status:
- **CURRENT**: interface contracts in `src/transport/contracts.ts` (Sections 10.1–10.3).
- **TARGET**: concrete adapter implementations (local coach provider, mediator provider, gateway runtime wiring) are not yet implemented in `src/`.
- **TARGET**: Section 10.4 local prompt bridge reuse contract is future integration work.

### 10.1 Coach LLM Adapter

```typescript
interface LocalCoachSummaryRequest {
  partyId: string;
  caseId: string;
  privateConversation: string;
}

interface LocalCoachSummaryResponse {
  summary: string;
  readyForGroupChat: boolean;
}

interface LocalCoachConversationTurn {
  author: 'party' | 'party_llm';
  text: string;
}

interface LocalCoachDraftRequest {
  partyId: string;
  caseId: string;
  conversationTurns: LocalCoachConversationTurn[];
}

interface LocalCoachDraftResponse {
  suggestedText: string;
  rationale?: string;
}

interface LocalCoachAdapter {
  summarizePrivateIntake(request: LocalCoachSummaryRequest): Promise<LocalCoachSummaryResponse>;
  createGroupDraft(request: LocalCoachDraftRequest): Promise<LocalCoachDraftResponse>;
}
```

### 10.2 Mediator LLM Adapter

```typescript
interface MediatorOpenRequest {
  caseId: string;
  topic: string;
  approvedCoachSummaries: string[];
}

interface MediatorTurnRequest {
  caseId: string;
  topic: string;
  groupTranscript: string;
}

interface MediatorLLMAdapter {
  buildOpeningMessages(request: MediatorOpenRequest): Promise<{ intro: string; guidance: string }>;
  nextFacilitationTurn(request: MediatorTurnRequest): Promise<{ message: string }>;
}
```

### 10.3 Gateway Group Message Adapter

```typescript
interface GatewayGroupMessageRequest {
  caseId: string;
  fromPartyId: string;
  payload: string;
  correlationId: string;
}

interface GatewayGroupMessageAdapter {
  sendGroupMessage(request: GatewayGroupMessageRequest): Promise<void>;
}
```

### 10.4 Local Prompt Bridge Reuse (TARGET, not currently implemented in `src/`)

Reused from `src/local-prompt-bridge.ts` (ADAPT mode). Key frame protocol:

**Request frame** (stdin JSON):
```json
{
  "type": "desktop.local_prompt.request",
  "request_id": "string (required)",
  "profile_id": "string (optional)",
  "session_id": "string (optional — session context for multi-turn)",
  "resume_session_id": "string (optional — resume a previous provider session)",
  "turn_index": "number (optional — current turn index in multi-turn flow)",
  "mode": "\"manual\" | \"semi_auto\" | \"full_auto\" (optional, default: \"manual\")",
  "objective": "string (optional — high-level goal for multi-turn mode)",
  "remote_message": "string (optional — message from a remote agent)",
  "text": "string (optional — direct prompt text)",
  "history": [
    { "role": "\"local_agent\" | \"remote_agent\"", "text": "string" }
  ],
  "history_summary": "string (optional — summary of prior turns)",
  "correlation_id": "string (optional — echoed in response)",
  "probe": "boolean (optional — if true, validates connectivity without execution)",
  "constraints": {
    "max_output_chars": 12000,
    "allow_tool_use": false,
    "max_history_turns": 6,
    "max_history_chars": 24000,
    "max_tool_rounds": 3,
    "local_turn_timeout_ms": 60000
  }
}
```

**Constraint defaults and bounds:**
- `max_output_chars`: default 12000, range [64, 200000]
- `allow_tool_use`: default false
- `max_history_turns`: default 6, range [0, 100]
- `max_history_chars`: default 24000, range [0, 200000]
- `max_tool_rounds`: default 3, range [1, 500]
- `local_turn_timeout_ms`: default 60000 (60s) when tools disabled, 3600000 (1hr) when tools enabled

**Response frame** (stdout JSON):
```json
{
  "type": "desktop.local_prompt.response",
  "request_id": "string",
  "status": "\"ok\" | \"error\"",
  "correlation_id": "string (optional — echoed from request)",
  "provider_session_id": "string (optional — provider-assigned session ID for resume)",
  "draft_message": "string (optional — result text on success)",
  "reason": "string (optional — human-readable error description on failure)",
  "code": "string (optional — machine-readable error code on failure)",
  "metrics": {
    "latency_ms": 0,
    "turns": 0,
    "cost_usd": 0,
    "model": "string"
  }
}
```

**Error recovery:** On `status: "error"`, the `code` field provides a machine-readable error category (e.g., `"provider_error"`, `"timeout"`, `"invalid_request"`). The `reason` field provides a human-readable description. The caller can use `resume_session_id` on the next request to resume from the last successful provider state.

## 11. Security and Trust Invariants (TARGET architecture; not fully implemented in current `src/` scaffold)

This section defines target security/runtime controls for planned desktop/runtime layers. The current scaffold only implements domain-level consent checks and in-memory state transitions.

### 11.1 Inherited Mandatory Controls

1. Renderer/UI never receives long-lived secrets or private keys.
2. Auth, gateway IO, and crypto stay in trusted runtime (main process).
3. Untrusted origins fail closed.
4. Invalid auth fails closed.
5. Replay/correlation checks on transport are mandatory.
6. Logs are append-only. **Current state in source baseline:** (`src/runtime.ts`, `src/audit.ts`) writes prompts and requester metadata in plaintext. Redaction is a **v2 requirement** — v1 implementations MUST NOT assume logs are redacted. v2 work items: (a) define redaction rules for PII and prompt content, (b) implement `redactAuditEntry()` filter, (c) add tests for redaction completeness.
7. Consent violations block unsafe sharing.

### 11.2 Gateway Host Allowlist (v1 Normative Target)

Gateway connections use a hardcoded trusted-origin allowlist in the target desktop runtime:

```typescript
const TRUSTED_ORIGINS = new Set([
  'https://api.commands.com',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);
```

Behavior:
- `validateTrustedOrigin(url)`: throws if URL origin not trusted.
- HTTPS enforced for non-localhost origins.
- `normalizeTrustedUrl(value, fallbackUrl)`: returns trusted normalized URL or fallback.
- Desktop-side gateway operations call `validateTrustedOrigin()` before outbound requests.

Mediation requirement (target runtime hardening): add `validateTrustedOrigin()` enforcement in agent runtime gateway client (`src/transport/gateway-client.ts`) before outbound network requests.

### 11.3 E2EE Session Protocol (TARGET)

Reused from `src/crypto.ts` + `src/handshake.ts` (ADAPT mode):

- Key exchange: Ed25519 identity keys + X25519 ephemeral keys.
- Encryption: AES-256-GCM with nonce = 4-byte direction prefix + 8-byte BE sequence.
- Direction prefixes: `c2a\0` and `a2c\0`.
- Sequence numbers: positive integers starting at 1.
- Replay protection: strict monotonic sequence enforcement.
- Session key zeroing on cleanup.

### 11.4 Markdown Sanitization (TARGET)

Planned defense-in-depth:

1. Marked.js custom renderer blocks images and escapes raw HTML.
2. DOMParser sanitizer removes dangerous tags, strips event handlers, blocks dangerous URI schemes.

## 12. Storage Model (v1)

### 12.1 Case Storage (CURRENT)

v1 scaffold uses an in-memory store:

```typescript
class InMemoryMediationStore {
  private readonly cases = new Map<string, MediationCase>();
  save(mediationCase: MediationCase): void;
  get(caseId: string): MediationCase | undefined;
  list(): MediationCase[];
}
```

Current limitations:
- All case state is volatile; lost on process restart.
- No encryption-at-rest.
- No persistence to disk or database.

### 12.2 Chat/Session Persistence (TARGET architecture; not currently implemented in `src/`)

Target v1 behavior (when runtime layer is added): in-memory-only sessions/messages with no durable persistence.

Future scope (v2): durable encrypted local history:
1. Storage path: `~/.mediation/cases/{caseId}/` with `case.enc` + `messages.enc`.
2. Keying: per-case AES-256-GCM key via HKDF from user credential.
3. Retention: configurable TTL (default 90 days).
4. Migration: version header in encrypted blobs.
5. Tests: round-trip, key rotation, TTL expiry, corrupt-file recovery.

### 12.3 Credential Persistence (TARGET architecture; not currently implemented in `src/`)

Planned reuse from `desktop/lib/credentials.js`:

- Sensitive fields extracted from config and encrypted via Electron `safeStorage.encryptString()`.
- Written to `credentials.enc` with `0o600` permissions on Unix.
- `config.json` redacted with `_credentialsSecured: true`.
- Profile support via `profileId`.

## 13. External Interface Provider (TARGET v1 architecture: Slack only; not currently implemented in `src/`)

### 13.1 Scope

Target v1 external interface scope is Slack-only:

- IPC channel: `INTERFACES_CREATE_SLACK`.
- Gateway route creation uses `interface_type: 'slack'`.
- Token auth mode `'path'`.
- Slack-specific signature verification/posting/purge behavior.

### 13.2 Slack Integration Architecture (TARGET)

```
Party Device <-> Desktop App (tunnel client)
                    |
                    v (WebSocket tunnel)
              Gateway (integration route)
                    |
                    v (HTTPS webhook)
              Slack API
```

### 13.3 Gateway Integration Route API (TARGET)

**POST `/gateway/v1/integrations/routes`** - Create integration route

Request (snake_case):
```json
{
  "interface_type": "slack",
  "token_auth_mode": "path",
  "route_token": "string (optional, min 43 chars, [A-Za-z0-9_-])",
  "deadline_ms": 2500,
  "max_body_bytes": 10485760,
  "token_max_age_days": 90,
  "interface_id": "string",
  "device_id": "string"
}
```

Response (201):
```json
{
  "route": {
    "route_id": "rt_<hex32>",
    "interface_id": "string",
    "interface_type": "slack",
    "token_auth_mode": "path",
    "status": "provisioned",
    "deadline_ms": 2500,
    "max_body_bytes": 10485760,
    "token_max_age_days": 90,
    "token_expires_at": "2026-05-26T00:00:00Z",
    "created_at": "2026-02-25T00:00:00Z",
    "updated_at": "2026-02-25T00:00:00Z"
  },
  "public_url": "https://<hooks_domain>/integrations/<route_id>/<token>",
  "route_token": "string (plaintext, shown once)"
}
```

Other target endpoints:
- `PUT /gateway/v1/integrations/routes/:route_id`
- `DELETE /gateway/v1/integrations/routes/:route_id`
- `POST /gateway/v1/integrations/routes/:route_id/rotate-token`

Gateway integration error shape:
```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

### 13.4 Tunnel Protocol (TARGET)

Client → Gateway frames:
- `tunnel.activate`
- `tunnel.deactivate`
- `tunnel.response`

Gateway → Client frames:
- `tunnel.connected`
- `tunnel.activate.result`
- `tunnel.deactivate.result`
- `tunnel.request`
- `tunnel.route_deactivated`
- `tunnel.error`

`body_base64` is the canonical body field name.

### 13.5 Future Scope: Generic Provider Plugins

Not implemented in target v1; planned for later:
1. Provider plugin contract.
2. Provider-agnostic IPC channels.
3. Secret storage abstraction per provider.
4. Slack-specific migration path.

## 14. Gateway Session API (TARGET architecture; not currently implemented in `src/`)

### 14.1 Naming Convention

Target gateway REST/WebSocket frames use snake_case field names.

### 14.2 Session Lifecycle (TARGET)

Target flow:
- Handshake init → poll → SSE subscribe → ready.
- Send encrypted frame to `POST /gateway/v1/sessions/{session_id}/messages`.
- Sequence numbers start at 1 and are strictly monotonic.

Message shape:
```json
{
  "type": "session.message",
  "session_id": "string",
  "conversation_id": "string",
  "message_id": "string",
  "handshake_id": "string",
  "encrypted": true,
  "alg": "aes-256-gcm",
  "direction": "client_to_agent",
  "seq": 1,
  "nonce": "base64",
  "ciphertext": "base64",
  "tag": "base64"
}
```

### 14.3 SSE Event Types (TARGET)

Guaranteed event classes in target runtime:
- `session.progress`
- `session.result`
- `session.error`

Completion signal: `session.result` or `session.error`.

### 14.4 Device/Identity API (TARGET)

- `PUT /gateway/v1/devices/{device_id}/identity-key`
- `GET /gateway/v1/devices`

### 14.5 Share/Invite API (TARGET)

Share endpoints and expected payloads are defined for future gateway integration:
- `POST /gateway/v1/shares/invites`
- `POST /gateway/v1/shares/invites/accept`
- `GET /gateway/v1/shares/devices/:device_id/grants`
- `POST /gateway/v1/shares/grants/:grant_id/revoke`
- `POST /gateway/v1/shares/grants/:grant_id/leave`

## 15. MCP Configuration (TARGET v1 scope; not currently implemented in `src/`)

### 15.1 Target v1 Behavior

Target MCP configuration capabilities:
1. Filesystem toggle per profile.
2. Raw JSON server config.
3. `stdio` and `sse`/`http` server types.
4. Wrapped/direct parser support.
5. File-loading helper support.

### 15.2 Not Implemented in v1

- Template-driven MCP management UI.
- MCP server health dashboard.
- Provider-aware MCP recommendations.

## 16. Room Plugin Contract (TARGET architecture; not currently implemented in `src/`)

When mediation extends to room/plugin runtime, these target rules apply.

### 16.1 Plugin Manifest Schema

Allowed top-level fields:

```json
{
  "id": "string (required, unique)",
  "name": "string (required)",
  "version": "string (required, semver)",
  "orchestratorType": "string (required, unique across plugins)",
  "roles": {
    "required": ["string"],
    "optional": ["string"],
    "forbidden": ["string"],
    "minCount": { "role_name": 1 }
  },
  "description": "string",
  "supportsQuorum": false,
  "dashboard": {},
  "limits": {},
  "endpointConstraints": {},
  "display": {},
  "report": {}
}
```

### 16.2 Limits Schema

Room config limits are numbers (`maxCycles`, `maxTurns`, `maxDurationMs`, `maxFailures`, `agentTimeoutMs`, `pluginHookTimeoutMs`, `llmTimeoutMs`).

Plugin manifest limits use bounded objects (`default`, `min`, `max`) plus string fields `turnFloorRole`, `turnFloorFormula`.

### 16.3 Collision Rules

- Duplicate `orchestratorType` rejected.
- Duplicate plugin `id` rejected.
- `index.js` manifest export must match `manifest.json`.

### 16.4 Integrity and Security

- SHA256 over plugin files.
- Symlink rejection in integrity mode.
- `manifest.json` and `index.js` must be regular files.

### 16.5 Allowlist Mechanism

`room-plugins-allowed.json` format:

```json
{
  "allowed": [
    "plugin-name",
    { "name": "plugin-name", "sha256": "hex-hash" }
  ]
}
```

### 16.6 Dev Mode Bypass

```javascript
const isDev = process.env.COMMANDS_AGENT_DEV === '1';
const trustAll = isDev && (
  process.env.COMMANDS_AGENT_TRUST_ALL_PLUGINS === '1' ||
  desktopSettings.trustAllPlugins === true
);
```

Both dev mode and trust-all signal are required.

## 17. Provider Registry Contract (TARGET architecture; not currently implemented in `src/`)

### 17.1 Plugin Interface

```typescript
interface ProviderCapabilities {
  supportsTools: boolean;
  supportsSessionResume: boolean;
  supportsPolicy: boolean;
}

interface ProviderRunInput {
  prompt: string;
  cwd: string;
  model: string;
  systemPrompt?: string;
  maxTurns?: number;
  allowToolUse?: boolean;
  resumeSessionId?: string;
  mcpServers?: AgentMcpServers;
  policy?: AgentPolicy;
  providerConfig: Record<string, string>;
}

interface ProviderRunResult {
  result: string;
  turns: number;
  costUsd: number;
  model?: string;
  sessionId?: string;
}

interface ProviderPlugin {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;
  runPrompt(input: ProviderRunInput): Promise<ProviderRunResult>;
}
```

### 17.2 External Plugin Loading

Target loading flow:
1. Read plugin `package.json`.
2. Validate commands metadata.
3. Verify plugin via security verifier.
4. Load module entry (`index.js`/`index.mjs`).
5. Apply env config `PROVIDER_<PROVIDER_ID>_*`.

## 18. Observability (TARGET architecture; not currently implemented in `src/`)

### 18.1 Audit Event Fields

Target minimum audit fields:
- `event_id`, `ts`, `case_id`, `phase`, `actor_type`, `actor_id`, `event_type`
- optional: `policy_decision`, `delivery_mode`, `error`

### 18.2 Core Metrics

Target metrics:
1. time-to-join
2. time-to-ready
3. group-chat duration
4. direct-vs-coach-approved ratio
5. share-deny rate
6. resolution rate

## 19. Testing and Verification Status

### 19.1 Current verification commands (implemented in this repo)

Use package scripts from `package.json`:

- `npm run build` — compile TypeScript (`tsc -p tsconfig.json`)
- `npm run typecheck` — static type check (`tsc -p tsconfig.json --noEmit`)
- `npm run demo` — build + run demo workflow (`npm run build && npm run start`)

There is currently **no automated test suite** and no `npm test` script in this scaffold.

### 19.2 Target domain logic tests (future scope)

| # | Test Area | Key Assertions |
|---|---|---|
| 1 | Invite token join | Valid token accepts; invalid token throws `invalid_invite_token` |
| 2 | Private visibility isolation | Private messages only accessible to owning party |
| 3 | All-ready gate | Transition to `group_chat` blocked until all parties `ready` with summaries |
| 4 | Mediator opening | Two opening messages posted; `introductionsSent` flag set; consent applied to summaries |
| 5 | Coach-draft approve/reject | Status transitions: composing → pending → approved/rejected; re-iteration resets to composing |
| 6 | Direct send | Message posted with `deliveryMode: 'direct'`; empty text rejected |
| 7 | Consent allow/deny/transform | `enforceShareGrant()` returns correct `allowed`/`text` for all grant combinations |
| 8 | Transition guards | All illegal transitions throw `invalid_transition` |
| 9 | Resolve/close | Terminal phases are final; `closed` has empty transition set |
| 10 | Phase enforcement | Operations reject with `invalid_phase` outside their allowed phases |

### 19.3 Target transport tests (future scope)

| # | Test Area | Key Assertions |
|---|---|---|
| 1 | Replay/correlation enforcement | Out-of-order sequence numbers rejected; correlation ID echoed |
| 2 | Trusted origin validation | Non-allowlisted URLs rejected; HTTPS enforced for non-localhost |
| 3 | Session lifecycle | Handshake → ready → send → end; keys zeroed on cleanup |
| 4 | IPC error normalization | Each channel returns its documented error shape |

### 19.4 Target consent policy tests (future scope)

| # | Test Area | Key Assertions |
|---|---|---|
| 1 | Share denied | `allowSummaryShare: false` → `{ allowed: false }` |
| 2 | Tags filtered | Candidate tags not in `allowedTags` → denied |
| 3 | Direct quote | `allowDirectQuote: true` → original text returned |
| 4 | Paraphrase | `allowDirectQuote: false` → first 36 words + ellipsis |

## 20. Full Reuse Inventory from `commands-com-agent` (TARGET migration plan; not yet fully executed)

Reuse modes:

1. `AS_IS` — copy directly, no modifications needed.
2. `ADAPT` — copy and modify for mediation domain.
3. `REFERENCE_ONLY` — use as design reference, do not copy.

### 20.1 Runtime + Transport

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/crypto.ts` | ADAPT | E2EE frame crypto + nonce discipline | `src/security/crypto.ts` |
| `src/handshake.ts` | ADAPT | handshake + replay protections | `src/transport/handshake.ts` |
| `src/gateway.ts` | ADAPT | gateway client protocol shape | `src/transport/gateway-client.ts` |
| `src/oauth.ts` | ADAPT | OAuth lifecycle handling | `src/auth/oauth.ts` |
| `src/config.ts` | ADAPT | config/env normalization | `src/config/index.ts` |
| `src/audit.ts` | ADAPT | structured audit format | `src/audit/audit-service.ts` |
| `src/runtime.ts` | REFERENCE_ONLY | runtime guard and loop patterns | `src/runtime/mediation-runtime.ts` |
| `src/types.ts` | REFERENCE_ONLY | common result/error conventions | `src/contracts/common.ts` |

### 20.2 Local Prompt Bridge + Orchestration

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/local-prompt-bridge.ts` | ADAPT | request/response framing + correlation | `src/llm/local-prompt-bridge.ts` |
| `desktop/agent-runtime/local-prompt-bridge.js` | ADAPT | desktop-local bridge behavior | `desktop/runtime/local-prompt-bridge.ts` |
| `desktop/orchestration-manager.js` | ADAPT | orchestration states, limits, pause/resume/stop | `src/orchestration/mediation-orchestrator.ts` |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS | normative loop safety/stop policy | `docs/reference/spec-05-agent-to-agent-shared.md` |

### 20.3 Room Runtime + Plugins

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `desktop/room/room-runtime.js` | ADAPT | room lifecycle + stop precedence | `src/room/group-chat-runtime.ts` |
| `desktop/room/plugin-registry.js` | ADAPT | plugin registry contract | `src/room/plugin-registry.ts` |
| `desktop/lib/room-contracts.js` | ADAPT | room validation contracts | `src/room/contracts.ts` |
| `desktop/room/review-cycle-plugin.js` | REFERENCE_ONLY | plugin lifecycle style | `src/room/plugins/mediation-plugin.ts` |
| `desktop/room/war-room-plugin.js` | REFERENCE_ONLY | coordination/fan-out patterns | `src/room/plugins/mediation-plugin.ts` |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS | plugin trust boundary rules | `docs/reference/spec-16-room-external-plugins.md` |

### 20.4 Provider Layer

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/provider-registry.ts` | ADAPT | provider registry contract | `src/llm/provider-registry.ts` |
| `src/provider.ts` | ADAPT | provider plugin interface | `src/llm/provider.ts` |
| `src/providers/claude-provider.ts` | ADAPT | provider template | `src/llm/providers/claude-provider.ts` |
| `src/providers/ollama-provider.ts` | ADAPT | provider template | `src/llm/providers/ollama-provider.ts` |
| `src/providers/index.ts` | ADAPT | provider bootstrap | `src/llm/providers/index.ts` |
| `desktop/lib/provider-registry.js` | ADAPT | desktop provider config/validation | `desktop/lib/provider-registry.ts` |

### 20.5 Desktop Security/Auth/IPC

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `desktop/auth.js` | ADAPT | secure auth/token handling | `desktop/auth.ts` |
| `desktop/gateway-client.js` | ADAPT | REST/SSE client boundaries | `desktop/transport/gateway-client.ts` |
| `desktop/session-manager.js` | ADAPT | session state + E2EE message lifecycle | `desktop/transport/session-manager.ts` |
| `desktop/lib/credentials.js` | AS_IS | credential persistence pattern | `desktop/lib/credentials.ts` |
| `desktop/lib/trusted-origins.js` | AS_IS | origin allowlist enforcement | `desktop/lib/trusted-origins.ts` |
| `desktop/lib/orchestration-utils.js` | ADAPT | audit/readiness helper patterns | `desktop/lib/orchestration-utils.ts` |
| `desktop/lib/validation.js` | ADAPT | validation helpers | `desktop/lib/validation.ts` |
| `desktop/lib/errors.js` | AS_IS | stable error-shape helpers | `desktop/lib/errors.ts` |
| `desktop/lib/pkce.js` | AS_IS | PKCE code challenge/verifier utilities | `desktop/lib/pkce.ts` |
| `desktop/lib/sse-parser.js` | AS_IS | SSE stream parsing for gateway events | `desktop/lib/sse-parser.ts` |
| `desktop/lib/sleep-with-abort.js` | AS_IS | AbortSignal-aware sleep utility | `desktop/lib/sleep-with-abort.ts` |
| `desktop/ipc/channel-manifest.js` | ADAPT | channel naming/registration model | `desktop/ipc/channel-manifest.ts` |
| `desktop/ipc/orchestration-ipc.js` | ADAPT | orchestration IPC boundary style | `desktop/ipc/mediation-ipc.ts` |
| `desktop/ipc/room-ipc.js` | ADAPT | room IPC boundary style | `desktop/ipc/group-chat-ipc.ts` |
| `desktop/ipc/interfaces-ipc.js` | ADAPT | interface management IPC handlers | `desktop/ipc/interfaces-ipc.ts` |
| `desktop/preload.cjs` | ADAPT | strict preload API discipline | `desktop/preload.ts` |

### 20.6 Desktop Interface/Integration Services

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `desktop/interfaces-service.js` | ADAPT | Slack integration, tunnel management, webhook handling | `desktop/interfaces-service.ts` |
| `desktop/lib/interface-secret-store.js` | ADAPT | per-interface encrypted secret storage | `desktop/lib/interface-secret-store.ts` |

### 20.7 Normative Source Docs

| Source Doc | Mode | What To Reuse |
|---|---|---|
| `docs/README.md` | AS_IS | security and error invariants |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS | loop control/safety norms |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS | plugin trust boundary |
| `docs/VISION.md` | REFERENCE_ONLY | process-boundary architecture guidance |
| `docs/complete/spec-03-multi-agent-runtime.md` | REFERENCE_ONLY | runtime conventions |
| `docs/complete/spec-14-war-room-orchestrator.md` | REFERENCE_ONLY | orchestrator lifecycle patterns |

### 20.8 Explicitly Not Reused

1. Non-mediation share-link UX from generic agent hub.
2. Unrelated dashboard/business flows.
3. Single-owner assumptions across all participants.

## 21. Target Repository Layout (planned architecture; not current tree)

```text
mediation/
  docs/
    FULL_SPEC.md
    reference/
      spec-05-agent-to-agent-shared.md
      spec-16-room-external-plugins.md
  src/
    app/
      mediation-service.ts
    auth/
      oauth.ts
    audit/
      audit-service.ts
    config/
      index.ts
    contracts/
      common.ts
    domain/
      types.ts
      errors.ts
    engine/
      phase-engine.ts
    llm/
      local-prompt-bridge.ts
      provider-registry.ts
      provider.ts
      providers/
        claude-provider.ts
        ollama-provider.ts
        index.ts
    orchestration/
      mediation-orchestrator.ts
    policy/
      consent.ts
    room/
      group-chat-runtime.ts
      plugin-registry.ts
      contracts.ts
      plugins/
        mediation-plugin.ts
    security/
      crypto.ts
    store/
      in-memory-store.ts
    transport/
      contracts.ts
      gateway-client.ts
      handshake.ts
  desktop/
    auth.ts
    preload.ts
    ipc/
      channel-manifest.ts
      mediation-ipc.ts
      group-chat-ipc.ts
      interfaces-ipc.ts
    interfaces-service.ts
    lib/
      credentials.ts
      trusted-origins.ts
      errors.ts
      orchestration-utils.ts
      validation.ts
      provider-registry.ts
      interface-secret-store.ts
      pkce.ts
      sse-parser.ts
      sleep-with-abort.ts
    renderer/
    runtime/
      local-prompt-bridge.ts
    transport/
      gateway-client.ts
      session-manager.ts
```

## 22. Current Scaffold Alignment (authoritative current-state implementation map)

The table below is the **current shipped status in `src/`**. Any capability not marked implemented here should be treated as target/future scope.

| Feature | Status | Location |
|---|---|---|
| Invite-based join and all-joined gate | Implemented | `mediation-service.ts`, `phase-engine.ts` |
| Private intake per party with ready gate | Implemented | `mediation-service.ts` |
| Consent enforcement (share/deny/paraphrase) | Implemented | `policy/consent.ts` |
| Neutral mediator opening messages | Implemented | `mediation-service.ts` |
| Optional coach draft flow (approve/reject) | Implemented | `mediation-service.ts` |
| Always-available direct send path | Implemented | `mediation-service.ts` |
| Mediator facilitation + resolution lifecycle | Implemented | `mediation-service.ts` |
| Phase transition validation | Implemented | `engine/phase-engine.ts` |
| Domain error codes | Implemented | `domain/errors.ts` |
| In-memory store | Implemented | `store/in-memory-store.ts` |
| Transport adapter contracts (interfaces only) | Implemented | `transport/contracts.ts` |
| Real local coach/mediator adapter implementations | Not yet | Planned under `src/llm/**` |
| Gateway runtime integrations | Not yet | Planned under `src/transport/**` |
| Auth/OAuth runtime | Not yet | Planned under `src/auth/**` |
| E2EE transport | Not yet | Planned under `src/security/**`, `src/transport/**` |
| Persistent storage/history | Not yet | Planned future storage layer |
| Desktop/Electron layer (UI + IPC + preload) | Not yet | Planned under `desktop/**` |
| Room/plugin runtime | Not yet | Planned under `src/room/**` |
| Provider registry/runtime | Not yet | Planned under `src/llm/**` |
| Audit/observability service | Not yet | Planned under `src/audit/**` |

## 23. Audit-Closure and Consistency Checklist

This section closes the audit loop for `FULL_SPEC.md`.

### 23.1 Normative statement closure rule

Every normative statement in this document MUST be one of:

1. **CURRENT**: implemented in `src/` and traceable to one or more concrete modules, or
2. **TARGET**: explicitly marked future scope / planned architecture.

### 23.2 Current verification reality (repo-accurate)

- Implemented verification commands:
  - `npm run build`
  - `npm run typecheck`
  - `npm run demo`
- There is currently **no automated test suite** and no `npm test` script.
- Test matrices in Section 19 are target requirements, not current CI coverage.

### 23.3 Documentation consistency checks

- `docs/README.md` points to:
  - `docs/FULL_SPEC.md` (canonical spec)
  - `docs/FULL_SPEC_AUDIT.md` (traceability audit)
- Root `README.md` reflects current script reality and explicitly notes no automated tests yet.
- `src/` remains authoritative; `dist/` remains non-authoritative for contract decisions.

### 23.4 Traceability pointer

For line-by-line source-vs-spec reconciliation, see:
- `docs/FULL_SPEC_AUDIT.md`
