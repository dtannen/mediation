# Mediation App Full Specification (v1)

Status: Implementation-Ready v1
Date: 2026-02-25
Codebase: `/Users/dtannen/Code/mediation`
Source baseline for reuse: `/Users/dtannen/Code/commands-com-agent`
Gateway reference: `/Users/dtannen/Code/commands-com-api-gateway`

---

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

| From | To | Guard |
|---|---|---|
| `awaiting_join` | `private_intake` | All parties have `state === 'joined'` or `state === 'ready'` |
| `private_intake` | `group_chat` | All parties have `state === 'ready'` AND `privateIntakeByPartyId[partyId].resolved === true` AND `summary.trim().length > 0` |
| `group_chat` | `resolved` | Resolution text accepted and stored |
| any non-terminal | `closed` | Always allowed (no reason required) |

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
3. Coach provides a suggested final draft. Status transitions to `pending_approval`, `suggestedText` is set.
4. Party can continue iterating after seeing a suggested draft: appending a party message moves status back to `composing` and clears `suggestedText`.
5. Party approves: status becomes `approved`, `approvedText` and `sentMessageId` are set, message posted to group with `deliveryMode: 'coach_approved'`.
6. Party rejects: status becomes `rejected`, optional `rejectionReason` stored.
7. Direct send remains available for every turn (bypasses draft entirely).

### 5.5 Media Content Policy (v1)

**External images are blocked.** Markdown image syntax `![alt](url)` is replaced with a blocked indicator span. This is a deliberate security control inherited from the source baseline:

- Marked.js custom renderer replaces all `image()` calls with `<span class="md-image-blocked" title="External images blocked">[blocked]</span>`.
- HTML sanitizer removes `<img>`, `<script>`, `<iframe>`, `<embed>`, `<form>`, `<style>`, `<link>`, `<base>`, `<meta>` tags.
- Only `https:` and `mailto:` URI schemes are allowed in links; all others are blocked with `#blocked:` prefix.
- All `on*` event handler attributes are stripped.
- `javascript:`, `data:`, `vbscript:` URI schemes are blocked on `href`, `src`, `action` attributes.

**Future scope:** If image support is required, it must define a safe fetch/proxy model, content-type validation, size limits, and CSP controls before enabling.

## 6. Functional Requirements

### 6.1 Case Creation and Invites

1. Case requires topic (non-empty string) and 2+ parties.
2. Each party must have `id`, `displayName`, and `localLLM` (provider + model).
3. Invite token is a UUID v4 (or crypto-random equivalent).
4. Invite URL is generated from `inviteBaseUrl` + token.
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

### 6.5 Resolution

1. `resolveCase` transitions from `group_chat` to `resolved` and stores resolution text.
2. `closeCase` can close from any non-terminal phase.
3. Full message timeline serves as audit trail.

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
| `allowDirectQuote` | `boolean` | If `false`, summary is paraphrased (first 36 words + ellipsis) |
| `allowedTags` | `string[]` | Only messages with matching tags are shareable. Empty = all allowed |

### 8.2 Enforcement Rules (normative)

Implemented in `src/policy/consent.ts` → `enforceShareGrant()`:

1. If `allowSummaryShare === false`: returns `{ allowed: false, text: '', reason }`.
2. If candidate tags are not all in `allowedTags` (when non-empty): returns `{ allowed: false, text: '', reason }`.
3. If `allowDirectQuote === true`: returns `{ allowed: true, text: <original> }`.
4. If `allowDirectQuote === false`: returns `{ allowed: true, text: <paraphrased> }` where paraphrase is first 36 words with ellipsis.

### 8.3 Consent in Group Opening

During `emitMediatorOpenMessages`:
- Each party's summary is passed through `enforceShareGrant()`.
- If sharing is disallowed, mediator introduction states: `"[partyName]: summary remains private and was not shared."`.
- If sharing is allowed, mediator uses the (possibly paraphrased) text.

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
| 9 | `sendDirectGroupMessage` | `(caseId: string, partyId: string, text: string, tags?: string[])` | `MediationCase` |
| 10 | `createCoachDraft` | `(caseId: string, partyId: string, initialPartyMessage: string)` | `GroupMessageDraft` |
| 11 | `appendCoachDraftMessage` | `(caseId: string, draftId: string, author: CoachComposeAuthor, text: string)` | `MediationCase` |
| 12 | `setCoachDraftSuggestion` | `(caseId: string, draftId: string, suggestedText: string)` | `MediationCase` |
| 13 | `approveCoachDraftAndSend` | `(caseId: string, draftId: string, approvedText?: string)` | `MediationCase` |
| 14 | `rejectCoachDraft` | `(caseId: string, draftId: string, reason?: string)` | `MediationCase` |
| 15 | `appendGroupMessage` | `(input: AppendMessageInput)` | `MediationCase` |
| 16 | `setMediatorSummary` | `(caseId: string, summary: string)` | `MediationCase` |
| 17 | `resolveCase` | `(caseId: string, resolution: string)` | `MediationCase` |
| 18 | `closeCase` | `(caseId: string)` | `MediationCase` |

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
| `party_not_found` | join, intake, draft, summary | Party ID not in case |
| `party_not_joined` | intake, ready | Party must join before this action |
| `invalid_phase` | intake, ready, summary | Operation not valid in current phase |
| `missing_private_summary` | `setPartyReady` | Summary must be resolved before ready |
| `invalid_transition` | `transition` | Phase transition not allowed |
| `invalid_group_message` | `sendDirectGroupMessage` | Empty message text |
| `draft_not_found` | draft operations | Draft ID not found |
| `draft_closed` | `appendCoachDraftMessage`, etc. | Draft already approved/rejected |
| `draft_not_pending` | `approveCoachDraftAndSend` | Draft not in `pending_approval` state |
| `invalid_intent` | `createCoachDraft` | Empty initial message |
| `invalid_compose_message` | `appendCoachDraftMessage` | Empty compose message |
| `invalid_suggested_text` | `setCoachDraftSuggestion` | Empty suggestion |
| `invalid_approved_text` | `approveCoachDraftAndSend` | Empty approved text |
| `missing_party` | `appendGroupMessage` | `partyId` required for party messages |

**Error precedence per operation:** Errors are checked in order: input validation (topic, party count, duplicates, consent) → existence checks (case, party) → state checks (phase, join status) → business rules (summary, draft status).

### 9.3 IPC Error Contract (Desktop Layer)

When the mediation app adds a desktop/Electron layer, IPC channels MUST follow the per-channel error shape conventions documented below. This reflects the actual implementation patterns in the source baseline.

**Normative v1 per-channel shapes:**

| IPC Layer | Error Shape | Example |
|---|---|---|
| Mediation domain IPC | `{ ok: false, error: { code: string, message: string } }` | `{ ok: false, error: { code: 'case_not_found', message: "case 'abc' was not found" } }` |
| Group chat / room IPC | `{ ok: false, error: { code: string, message: string, recoverable: boolean } }` | `{ ok: false, error: { code: 'internal_error', message: '...', recoverable: false } }` |
| Gateway send IPC | `{ ok: false, error: { code: string, message: string, recoverable: boolean, status?: number, details?: object } }` | `{ ok: false, error: { code: 'rate_limit_exceeded', message: '...', recoverable: true } }` |
| Gateway general IPC | `{ ok: false, error: string }` | `{ ok: false, error: 'Invalid deviceId' }` |
| Auth IPC | `{ ok: false, error: string }` | `{ ok: false, error: 'Sign in failed' }` |

**Migration target (v2):** All channels SHOULD converge to the structured shape:

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

**Migration steps:**
1. Add `normalizeIpcError(err)` utility that coerces string errors into `{ code: 'unknown', message: err, recoverable: true }`.
2. Wrap all IPC handlers with the normalizer at the boundary.
3. Update renderer to accept both shapes during migration window.
4. Remove legacy string-error paths after all handlers are migrated.

## 10. Transport Contracts (LLM Adapters)

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

### 10.4 Local Prompt Bridge Reuse

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

## 11. Security and Trust Invariants

### 11.1 Inherited Mandatory Controls

1. Renderer/UI never receives long-lived secrets or private keys.
2. Auth, gateway IO, and crypto stay in trusted runtime (main process).
3. Untrusted origins fail closed.
4. Invalid auth fails closed.
5. Replay/correlation checks on transport are mandatory.
6. Logs are append-only. **Current state:** Source baseline (`src/runtime.ts`, `src/audit.ts`) writes prompts and requester metadata in plaintext. Redaction is a **v2 requirement** — v1 implementations MUST NOT assume logs are redacted. v2 work items: (a) define redaction rules for PII and prompt content, (b) implement `redactAuditEntry()` filter, (c) add tests for redaction completeness.
7. Consent violations block unsafe sharing.

### 11.2 Gateway Host Allowlist (v1 Normative)

Gateway connections use a **hardcoded trusted-origin allowlist**. This is the actual v1 behavior, not configurable self-host:

```typescript
// Normative v1 allowlist (from desktop/lib/trusted-origins.js):
const TRUSTED_ORIGINS = new Set([
  'https://api.commands.com',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
]);
```

**Behavior:**
- `validateTrustedOrigin(url)`: Throws if URL origin is not in the trusted set.
- HTTPS is enforced for non-localhost origins (HTTP only for `localhost`/`127.0.0.1`).
- `normalizeTrustedUrl(value, fallbackUrl)`: Returns normalized URL if trusted, falls back to default otherwise.
- All gateway client operations call `validateTrustedOrigin()` before any network request.

**Gateway URL resolution — two distinct paths:**

**Path 1: Desktop IPC / Gateway Client** (used by auth service, session manager, interfaces service):
1. Auth service maintains `_gatewayUrl` state, initialized to `DEFAULT_GATEWAY_URL`.
2. On sign-in, the gateway URL can be overridden if explicitly provided and trusted.
3. On config fallback load, uses `normalizeTrustedUrl(config.gatewayUrl, DEFAULT_GATEWAY_URL)`.
4. `getGatewayUrl()` always returns the current state normalized through `normalizeTrustedUrl()`.
5. All desktop-side gateway operations call `getGatewayUrl()` from the auth service.

**Path 2: Spawned Agent Runtime** (used when launching agent CLI processes):
1. `getCredentialsForAgent()` returns `{ gatewayUrl, accessToken, refreshToken, ... }`.
2. These credentials are synced into the agent's `config.json` before spawn.
3. The agent runtime reads `config.gatewayUrl` from its own config file.
4. **Current state:** The source baseline agent runtime (`src/config.ts`, `src/gateway.ts`, `src/oauth.ts`) does NOT independently enforce `validateTrustedOrigin()`. It trusts whatever gateway URL is provided in its config. The desktop process pre-validates the URL before writing it to config, so in practice only trusted URLs reach the agent — but the agent itself has no runtime guard.

**Security invariant (desktop path only):** The desktop IPC / gateway client path enforces `validateTrustedOrigin()` on all network requests. The spawned agent runtime relies on the desktop process to supply only pre-validated URLs.

**Mediation implementation requirement:** The mediation app MUST add `validateTrustedOrigin()` enforcement in the agent runtime's gateway client (`src/transport/gateway-client.ts`) before any outbound network request, to close this defense-in-depth gap. This is a normative v1 requirement for the mediation codebase even though the source baseline lacks it.

**Future scope:** To enable self-hosted gateways, the allowlist must be made configurable via signed config or admin-only settings, with certificate pinning and origin verification tests.

### 11.3 E2EE Session Protocol

Reused from `src/crypto.ts` + `src/handshake.ts` (ADAPT mode):

- **Key exchange:** Ed25519 identity keys + X25519 ephemeral keys per session.
- **Encryption:** AES-256-GCM with deterministic nonce = `direction_prefix(4 bytes) || sequence_number(8 bytes BE)`.
- **Direction prefixes:** `c2a\0` (`0x63 0x32 0x61 0x00`, client-to-agent), `a2c\0` (`0x61 0x32 0x63 0x00`, agent-to-client).
- **Nonce construction:** `Buffer.alloc(12)` → copy 4-byte direction prefix at offset 0 → `writeBigUInt64BE(seq, 4)`. Total: 12 bytes (GCM nonce size).
- **Sequence numbers:** Must be positive integers starting at 1 (not 0). `validateSeq()` rejects `seq <= 0`.
- **Key derivation:** HKDF-SHA256 with salt from transcript hash of handshake parameters.
- **Replay protection:** Strict monotonic sequence numbers; out-of-order frames rejected.
- **Key zeroing:** Session keys are explicitly zeroed on session end.

### 11.4 Markdown Sanitization

Defense-in-depth with two layers:

1. **Marked.js custom renderer:** Blocks images, escapes raw HTML in markdown.
2. **DOMParser sanitizer:** Removes dangerous tags (`script`, `iframe`, `object`, `embed`, `form`, `style`, `link`, `base`, `meta`, `img`), strips event handlers, blocks dangerous URI schemes.

## 12. Storage Model (v1)

### 12.1 Case Storage

v1 uses an in-memory store:

```typescript
class InMemoryMediationStore {
  private readonly cases = new Map<string, MediationCase>();
  save(mediationCase: MediationCase): void;
  get(caseId: string): MediationCase | undefined;
  list(): MediationCase[];
}
```

**v1 limitations:**
- All case state is volatile; lost on process restart.
- No encryption-at-rest.
- No persistence to disk or database.

### 12.2 Chat/Session Persistence (v1 Scope)

**v1: In-memory only.** Chat messages, session state, and conversation IDs are stored in Maps and are lost on app restart. This matches the source baseline behavior:

- Sessions stored in `Map<deviceId, session>` (volatile).
- Conversation IDs tracked in `Map<deviceId, conversationId>` (volatile).
- Session keys zeroed on cleanup.
- Max 20 concurrent sessions.
- No file or database persistence in v1.

**Future scope (v2):** Durable encrypted local history requires:
1. Storage path: `~/.mediation/cases/{caseId}/` with `case.enc` + `messages.enc` files.
2. Keying: Per-case AES-256-GCM key derived from user credential via HKDF.
3. Retention: Configurable TTL per case (default 90 days).
4. Migration: Store version header in encrypted blob; version-aware loader.
5. Tests: Round-trip encrypt/decrypt, key rotation, TTL expiry, corrupt-file recovery.

### 12.3 Credential Persistence

Reused AS_IS from `desktop/lib/credentials.js`:

- Sensitive fields (`deviceToken`, `refreshToken`, identity private keys) extracted from config.
- Encrypted via Electron `safeStorage.encryptString()`.
- Written to `credentials.enc` with file permissions `0o600` on Unix.
- Config.json is redacted with `_credentialsSecured: true` flag.
- Profile support via `profileId` parameter.

## 13. External Interface Provider (v1: Slack Only)

### 13.1 Scope

v1 supports **Slack as the only external interface provider**. The implementation is Slack-specific throughout:

- IPC channel: `INTERFACES_CREATE_SLACK` (not generic create).
- Gateway route creation requires `interface_type: 'slack'` (gateway rejects all others).
- Token auth mode must be `'path'` for Slack routes.
- Slack-specific operations: signature verification (HMAC-SHA256), bot token posting, message purge.
- Secret storage: Slack signing secret + bot token per interface.

### 13.2 Slack Integration Architecture

```
Party Device <-> Desktop App (tunnel client)
                    |
                    v (WebSocket tunnel)
              Gateway (integration route)
                    |
                    v (HTTPS webhook)
              Slack API
```

### 13.3 Gateway Integration Route API

**POST `/gateway/v1/integrations/routes`** - Create integration route

Request (snake_case, all fields):
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

**PUT `/gateway/v1/integrations/routes/:route_id`** - Update route

Request fields (all optional): `deadline_ms`, `max_body_bytes`, `token_auth_mode`, `status`, `device_id`.

**DELETE `/gateway/v1/integrations/routes/:route_id`** - Delete route

**POST `/gateway/v1/integrations/routes/:route_id/rotate-token`** - Rotate token

Request: `{ "grace_seconds": <0..1800> }` (optional; bounds enforced by gateway, 0 = immediate rotation)

**Gateway integration error shape:**
```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": { }
  }
}
```

Error codes:

| Code | HTTP Status | Endpoint(s) | Meaning |
|---|---|---|---|
| `unauthorized` | 401 | all | Missing or invalid auth token |
| `invalid_request` | 400 | all | Malformed request body or invalid field values |
| `forbidden` | 403 | all | Authenticated but not authorized for this resource |
| `route_not_found` | 404 | PUT/DELETE routes, rotate-token | Route ID does not exist or is not owned by caller |
| `token_validation_failed` | 422 | POST create | Route token format/length validation failed |
| `invalid_route_update` | 400 | PUT routes | Invalid status value (e.g., `"active"` which can only be set via tunnel activation) |
| `deletion_failed` | 500 | DELETE routes | Route storage deletion failed; route may still be active — client should retry |
| `internal_error` | 500 | all | Unrecoverable server error |

Clients MUST handle unknown error codes defensively (treat any unrecognized code as a retriable error with the returned HTTP status).

### 13.4 Tunnel Protocol (WebSocket JSON Frames)

**Client → Gateway frames:**

| Frame Type | Fields |
|---|---|
| `tunnel.activate` | `routes: [{ route_id }]` or `routes: ["route_id_string"]`, optional `request_id` |
| `tunnel.deactivate` | `routes: [{ route_id }]`, optional `request_id` |
| `tunnel.response` | `request_id`, `status` (int), `headers` (`[[key, value], ...]`), `body_base64` (base64-encoded body) |

**Gateway → Client frames:**

| Frame Type | Fields |
|---|---|
| `tunnel.connected` | `device_id`, `at` (ISO 8601) |
| `tunnel.activate.result` | `request_id`, `results: [{ route_id, status, activation?, error? }]` — see below |
| `tunnel.deactivate.result` | `request_id`, `results: [{ route_id, status, error? }]` — see below |
| `tunnel.request` | `request_id`, `route_id`, `method`, `scheme`, `host`, `external_url`, `raw_target`, `raw_target_base64`, `path`, `query`, `headers` (`[[key, value], ...]`), `body_base64`, `received_at` (ISO 8601), `deadline_ms` (int) |
| `tunnel.route_deactivated` | `route_id`, `reason`, `at` (ISO 8601) |
| `tunnel.error` | `error` (string code: `"invalid_json"`, `"unknown_frame_type"`, etc.) |

**`tunnel.activate.result` per-route result variants:**

| `status` | Meaning | Extra Fields |
|---|---|---|
| `"active"` | Route successfully activated | `activation`: `"clean"` (first activation) or `"superseded"` (took over from another tunnel) |
| `"rejected"` | Activation denied | `error: { code, message }` — codes: `route_not_found`, `route_not_owned`, `device_mismatch`, `token_revoked`, `registration_failed` |

**`tunnel.deactivate.result` per-route result variants:**

| `status` | Meaning | Extra Fields |
|---|---|---|
| `"inactive"` | Route successfully deactivated | — |
| `"rejected"` | Deactivation denied | `error: { code, message }` — code: `route_not_found` (route not active on this tunnel) |

**Important:** The body field is named `body_base64` (not `body`). Response frames use the same `body_base64` field name with base64-encoded content and `status` as an integer HTTP status code.

### 13.5 Future Scope: Generic Provider Plugins

Generic interface-provider plugins are **not implemented in v1**. Future deliverable requires:
1. Provider plugin contract (register, validate, activate, deactivate).
2. Provider-agnostic IPC channels replacing Slack-specific ones.
3. Secret storage abstraction per provider type.
4. Migration path from Slack-specific to generic.

## 14. Gateway Session API (Field Reference)

### 14.1 Naming Convention

All gateway REST and WebSocket frames use **snake_case** field names. This is normative.

### 14.2 Session Lifecycle

**Start session** (desktop → gateway):

Handshake init → handshake poll → SSE subscribe → ready.

**Send message** (desktop → gateway):

POST encrypted frame to `POST /gateway/v1/sessions/{session_id}/messages`:
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

**Sequence numbers:** `seq` MUST be a positive integer (≥ 1). The first message in a session uses `seq: 1`. Sequence numbers are strictly monotonically increasing. `seq: 0` is invalid and will be rejected by the crypto layer (`validateSeq()` requires `seq > 0`).

**Decrypted plaintext payload:**
```json
{
  "session_id": "string",
  "conversation_id": "string",
  "message_id": "string",
  "prompt": "string",
  "origin_agent_device_id": "string (optional)",
  "trace_id": "string (optional)",
  "orchestrator_profile_id": "string (optional)",
  "hop_count": 0
}
```

### 14.3 SSE Event Types (gateway → desktop)

The gateway emits all session events as SSE event type `session.event`. The client disambiguates based on the decrypted payload content. The three **guaranteed** event types emitted by the agent runtime are:

| Event (payload-derived) | Encrypted | Decrypted Payload Fields | Status |
|---|---|---|---|
| `session.progress` | yes | `status: "running"` | **Guaranteed** — emitted during active processing |
| `session.result` | yes | `result: string`, `message_id`, `conversation_id?`, `turns: number`, `cost_usd: number`, `model: string`, `session_id`, `correlation_id?`, `usage?: { input_tokens, output_tokens }` | **Guaranteed** — emitted on successful completion |
| `session.error` | yes | `error: string`, `message_id`, `correlation_id?` | **Guaranteed** — emitted on failure |

**Optional/compatibility events** (NOT guaranteed to be emitted by current agent runtime):

| Event | Encrypted | Notes |
|---|---|---|
| `session.ended` | no | Not a guaranteed emitted frame from current agent runtime. Clients MUST treat `session.result` or `session.error` as authoritative session completion signals. |
| `session.processing` | no | Not a guaranteed emitted frame. Clients SHOULD NOT depend on this for state tracking. |

**`session.result` field notes:** The runtime (`src/runtime.ts`) emits `result`, `turns`, `cost_usd`, `model`, `session_id`, `message_id`, and optionally `conversation_id`. The `usage` field (`{ input_tokens, output_tokens }`) is **optional** — it is NOT emitted by the current agent runtime. Desktop consumer logic (`session-manager.js`) treats `usage` as optional. Clients MUST NOT depend on `usage` being present.

**Authoritative completion detection:** A session is complete when either `session.result` or `session.error` is received. Clients MUST NOT wait for `session.ended` as the sole completion signal. The desktop session manager (`session-manager.js`) checks `decrypted.result !== undefined` or `decrypted.error` to determine completion.

**Gateway SSE transport:** The gateway relays all events using SSE event name `session.event` with `writeSSEDataWithID()`. The event ID is set when available for resume support.

### 14.4 Device/Identity API

**PUT `/gateway/v1/devices/{device_id}/identity-key`** - Register identity:
```json
{
  "algorithm": "ed25519",
  "public_key": "<base64 raw 32-byte Ed25519 public key>",
  "display_name": "string (optional)"
}
```

Notes:
- `algorithm` is optional; defaults to `"ed25519"`. Only `"ed25519"` is supported; other values return HTTP 400.
- `public_key` is a **raw 32-byte Ed25519 public key** encoded as base64 (NOT SPKI-wrapped). The gateway validates the key via `gatewaycrypto.ValidateEd25519PublicKey()`.
- `display_name` is optional; if omitted and the device already exists, the existing display name is preserved.

**GET `/gateway/v1/devices`** - List devices:
```json
{ "devices": [{ "device_id", "status", "display_name", "last_seen_at" }] }
```

### 14.5 Share/Invite API

All share endpoints use **camelCase** for request/response fields (exception to the general snake_case convention):

**POST `/gateway/v1/shares/invites`** — Create share invite

Request:
```json
{ "deviceId": "string", "email": "string", "grantExpiresAt": 0, "inviteTokenTtlSeconds": 0 }
```
- `grantExpiresAt` (optional, unix epoch seconds) — when the grant expires. Must be in the future, max 365 days.
- `inviteTokenTtlSeconds` (optional) — TTL for the invite token in seconds. Defaults to server-side default if omitted or ≤ 0. Maximum: 7,776,000 (90 days); values exceeding this return HTTP 400.

Response (201):
```json
{ "grantId": "gr_<hex>", "status": "pending", "inviteUrl": "string", "inviteTokenExpiresAt": 0, "grantExpiresAt": 0 }
```
- Note: No `deviceId` or plaintext `inviteToken` in response. The `inviteUrl` contains the token embedded in the URL.
- `inviteTokenExpiresAt` is the expiry field (not `inviteExpiresAt`).

**POST `/gateway/v1/shares/invites/accept`** — Accept share invite

Request: `{ "token": "string" }`

Response (200):
```json
{ "grantId": "string", "deviceId": "string", "role": "collaborator", "status": "active" }
```

**GET `/gateway/v1/shares/devices/:device_id/grants`** — List grants for a device

Response (200):
```json
{
  "deviceId": "string",
  "grants": [{
    "grantId": "string", "granteeEmail": "string", "granteeUid": "string",
    "role": "string", "status": "string",
    "grantExpiresAt": 0, "acceptedAt": 0, "createdAt": 0
  }]
}
```
- `status` is computed at query time from grant state and expiry (`effectiveShareGrantStatus()`).

**POST `/gateway/v1/shares/grants/:grant_id/revoke`** — Revoke a grant (owner action)

Response (200):
```json
{ "grantId": "string", "status": "revoked" }
```
- Idempotent: if already revoked, returns the same response shape without error.

**POST `/gateway/v1/shares/grants/:grant_id/leave`** — Leave a grant (grantee action)

Response (200):
```json
{ "grantId": "string", "status": "revoked" }
```
- Only valid from `active` state. If already revoked, returns the same response shape without error.

**Path parameters:**
- `:device_id` — the target device identifier (validated via `validateDeviceID()`)
- `:grant_id` — the share grant identifier

**Grant statuses:** `pending` (invite sent, not accepted), `active` (accepted), `suspended`, `revoked`, `expired` (computed at query time by `effectiveShareGrantStatus()`).

**`expired` computation rules:**
- A `pending`, `active`, or `suspended` grant becomes `expired` when `grantExpiresAt > 0` and `now > grantExpiresAt`.
- A `pending` grant (unaccepted invite) also becomes `expired` when `inviteTokenExpiresAt > 0` and `now > inviteTokenExpiresAt`.
- `revoked` grants are never overridden to `expired` — revocation is terminal.

## 15. MCP Configuration (v1 Scope)

### 15.1 Implemented Behavior

v1 MCP configuration supports:

1. **Filesystem toggle**: Enable/disable MCP per profile.
2. **Raw JSON config**: MCP servers defined via JSON file or inline config.
3. **Server types**: `stdio` (command + args + env) and `sse`/`http` (url + headers).
4. **Parsing**: `parseMcpServers()` accepts both wrapped (`{ mcpServers: {...} }`) and direct formats.
5. **File loading**: `loadMcpServersFromFile()` reads JSON from disk path.

### 15.2 Not Implemented in v1

- Template-driven MCP management UI (catalog browsing, one-click install).
- MCP server health monitoring dashboard.
- Provider-aware MCP recommendations.

## 16. Room Plugin Contract (Normative)

When the mediation app extends to use the room/plugin architecture from the source baseline, these rules are normative.

### 16.1 Plugin Manifest Schema

Allowed top-level fields (ONLY these; unknown fields cause validation failure):

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

Role fields: ONLY `required`, `optional`, `forbidden`, `minCount` allowed. Unknown role fields are rejected.

### 16.2 Limits Schema

**Room config limits** (user-supplied in room configuration) are plain numbers:

| Field | Type | Description |
|---|---|---|
| `maxCycles` | `number` | Max orchestration cycles |
| `maxTurns` | `number` | Max turns per cycle |
| `maxDurationMs` | `number` | Max wall-clock time |
| `maxFailures` | `number` | Max consecutive failures |
| `agentTimeoutMs` | `number` | Per-agent response timeout |
| `pluginHookTimeoutMs` | `number` | Plugin hook timeout |
| `llmTimeoutMs` | `number` | LLM call timeout |

Unknown limit fields cause validation failure.

**Plugin manifest limits** use a different schema — each numeric limit is an object with bounds, not a plain number:

```json
{
  "limits": {
    "maxCycles": { "default": 10 },
    "maxTurns": { "default": 80, "min": 3, "max": 1000 },
    "maxDurationMs": { "default": 300000 },
    "maxFailures": { "default": 5 },
    "agentTimeoutMs": { "default": 60000 },
    "pluginHookTimeoutMs": { "default": 30000 },
    "llmTimeoutMs": { "default": 120000 },
    "turnFloorRole": "string (role name for minimum turn calculation)",
    "turnFloorFormula": "\"1 + N\" | \"2 + N\""
  }
}
```

Each numeric limit field in a plugin manifest MUST be an object with optional keys:
- `default` (finite number) — default value if user omits the limit.
- `min` (finite number) — minimum bound enforced on user-supplied values.
- `max` (finite number) — maximum bound enforced on user-supplied values.
- If `min` and `max` are both present, `min` must be ≤ `max`.
- Unknown fields inside a limit object (anything other than `default`, `min`, `max`) cause validation failure.

`turnFloorRole` and `turnFloorFormula` are plain string fields (not objects).

### 16.3 Collision Rules

1. Two plugins registering the same `orchestratorType` → error (reports existing plugin ID).
2. Duplicate `id` across plugins → rejected.
3. Exported manifest from `index.js` must exactly match `manifest.json` on disk.

### 16.4 Integrity and Security

- **SHA256 hashing**: All plugin files (including node_modules) hashed with relative paths.
- **Symlink rejection**: Symlinks in plugin directories are rejected in integrity mode.
- **Entry points**: `manifest.json` and `index.js` must be regular files (not symlinks).

### 16.5 Allowlist Mechanism

File: `room-plugins-allowed.json` (one directory above plugin directory).

Format (MUST be an object with an `allowed` array, NOT a top-level array):
```json
{
  "allowed": [
    "plugin-name",
    { "name": "plugin-name", "sha256": "hex-hash" }
  ]
}
```

The loader (`plugin-registry.js → loadAllowlist()`) validates:
1. Parsed JSON must be a non-null object with `Array.isArray(parsed.allowed)`.
2. If the schema is invalid (e.g., a top-level array), all external plugins are skipped with a warning.
3. Each entry in `allowed` can be a plain string (plugin name) or an object with `name` and optional `sha256`.

- If `sha256` specified, computed hash must match exactly.
- If `node_modules` present but no `sha256` entry, a warning is logged (deps not verified).

### 16.6 Dev Mode Bypass

Trust bypass requires **dev mode AND a trust-all signal** (both conditions must be true):

```javascript
// Exact logic from plugin-registry.js and main.js:
const isDev = process.env.COMMANDS_AGENT_DEV === '1';
const trustAll = isDev && (
  process.env.COMMANDS_AGENT_TRUST_ALL_PLUGINS === '1' ||
  desktopSettings.trustAllPlugins === true
);
```

**Required conditions (AND, not OR):**
1. `isDev` must be true — set via `COMMANDS_AGENT_DEV=1` environment variable, or `devMode: true` in `~/.commands-agent/desktop-settings.json`.
2. AND one of:
   - `COMMANDS_AGENT_TRUST_ALL_PLUGINS=1` environment variable, OR
   - `trustAllPlugins: true` in `~/.commands-agent/desktop-settings.json`.

**Important:** `devMode: true` alone does NOT bypass allowlist/integrity checks. The trust-all flag is additionally required. The settings UI disables the `trustAllPlugins` checkbox when `devMode` is false.

When `trustAll` is true, allowlist loading and SHA-256 integrity verification are both skipped entirely.

## 17. Provider Registry Contract

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
  readonly id: string;       // /^[a-z][a-z0-9_-]{0,63}$/
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: ProviderCapabilities;
  runPrompt(input: ProviderRunInput): Promise<ProviderRunResult>;
}
```

### 17.2 External Plugin Loading

1. Read `package.json` from plugin directory.
2. Check `commands.providerId` and `commands.defaultModel` fields.
3. Verify plugin via async security verifier.
4. Load `index.js` or `index.mjs`.
5. Config via environment variables: `PROVIDER_<PROVIDER_ID>_*`.

## 18. Observability

### 18.1 Audit Event Fields

Minimum audit fields per event:

| Field | Type | Required | Description |
|---|---|---|---|
| `event_id` | `string` | yes | Unique event identifier |
| `ts` | `string` | yes | ISO 8601 timestamp |
| `case_id` | `string` | yes | Mediation case ID |
| `phase` | `MediationPhase` | yes | Current phase at event time |
| `actor_type` | `string` | yes | `'party'`, `'party_llm'`, `'mediator_llm'`, `'system'` |
| `actor_id` | `string` | yes | Party ID or system identifier |
| `event_type` | `string` | yes | Operation name (e.g. `'join'`, `'send_direct'`, `'approve_draft'`) |
| `policy_decision` | `string` | no | Consent enforcement result if relevant |
| `delivery_mode` | `string` | no | `'direct'`, `'coach_approved'`, `'system'` for group messages |
| `error` | `string` | no | Error code if operation failed |

### 18.2 Core Metrics

1. time-to-join: invite creation → last party joined
2. time-to-ready: join → all parties ready
3. group-chat duration: group open → resolved/closed
4. direct-vs-coach-approved ratio: count of direct sends / coach-approved sends
5. share-deny rate: consent denials / total share attempts
6. resolution rate: resolved cases / total cases

## 19. Testing Requirements

### 19.1 Domain Logic Tests

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

### 19.2 Transport Tests

| # | Test Area | Key Assertions |
|---|---|---|
| 1 | Replay/correlation enforcement | Out-of-order sequence numbers rejected; correlation ID echoed |
| 2 | Trusted origin validation | Non-allowlisted URLs rejected; HTTPS enforced for non-localhost |
| 3 | Session lifecycle | Handshake → ready → send → end; keys zeroed on cleanup |
| 4 | IPC error normalization | Each channel returns its documented error shape |

### 19.3 Consent Policy Tests

| # | Test Area | Key Assertions |
|---|---|---|
| 1 | Share denied | `allowSummaryShare: false` → `{ allowed: false }` |
| 2 | Tags filtered | Candidate tags not in `allowedTags` → denied |
| 3 | Direct quote | `allowDirectQuote: true` → original text returned |
| 4 | Paraphrase | `allowDirectQuote: false` → first 36 words + ellipsis |

## 20. Full Reuse Inventory from `commands-com-agent`

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

## 21. Target Repository Layout

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

## 22. Current Scaffold Alignment

Current scaffold in `/Users/dtannen/Code/mediation/src` implements:

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
| Transport adapter contracts | Defined | `transport/contracts.ts` |
| LLM adapter implementations | Not yet | Requires provider setup |
| Desktop/Electron layer | Not yet | Requires desktop scaffold |
| E2EE transport | Not yet | Requires crypto/handshake port |
| Gateway client | Not yet | Requires gateway-client port |
| Auth/OAuth | Not yet | Requires auth port |
| Audit service | Not yet | Requires audit port |
