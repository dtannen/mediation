# Mediation App Full Specification (v2 Feature Set)

Status: Implementation-ready specification (v2 delta)
Date: 2026-02-27
Codebase: repository root (`mediation/`)
Baseline docs: `docs/FULL_SPEC.md` (v1), `docs/UI_UX_SPEC.md` (baseline UI)
Authoritative implementation baseline for current behavior: `src/` and `desktop/`

---

## 0. Purpose

This document expands the v2 feature summary into implementation-ready product and technical requirements for:

- F-01 Conversational Draft Coach
- F-02 Message Window Formatting
- F-03 Coaching Template System
- F-04 Post-close "New Mediation" Navigation
- F-05 Template Management System
- F-06 New Issue -> Main Topic Screen Flow

This is a delta spec. Existing contracts in `docs/FULL_SPEC.md` remain valid unless explicitly replaced here.

---

## 1. Scope

## 1.1 In Scope

- Group-chat draft flow change from one-shot suggestion to guided coaching conversation.
- Unified chat presentation improvements across private intake, group chat, and coach panel.
- Structured category/template selection that drives Intake Coach, Draft Coach, and Mediator behavior.
- Admin-facing template CRUD, role prompt editing, and template versioning.
- Navigation fixes for closed-case exit behavior.
- New issue creation flow that requires Main Topic setup before entering chat.

## 1.2 Out of Scope

- Billing, tenant RBAC, and org-wide policy management.
- Mobile-native clients.
- Changes to gateway cryptography, handshake, or transport protocol.
- Legal policy and compliance workflows beyond existing consent controls.

## 1.3 Minimal Admin Authorization Policy (v2)

While full RBAC is out of scope for v2, several features depend on admin-only actions (template CRUD, template override after group chat start, system default configuration). The following minimal authorization model applies to v2:

**Admin identity source:**

- An admin is identified by an `isAdmin: boolean` flag on the local user profile record.
- For v2, admin status is set during app configuration/setup and stored in the local user profile.
- The flag is not editable through the standard UI; it requires direct configuration or a setup wizard.

**Enforcement layer:**

- All admin-gated IPC channels (template CRUD channels, `desktop:mediation:set-template-selection` with `adminOverride: true`) must validate that the `actorId` in the request resolves to a profile with `isAdmin === true`.
- If validation fails, the channel must return `IpcErrorResponse` with code `unauthorized_admin_action` and a human-readable message.

**Admin-gated actions:**

| Action | Gate |
|---|---|
| Create template | `isAdmin` required |
| Update template metadata | `isAdmin` required |
| Create template version | `isAdmin` required |
| Archive/activate template | `isAdmin` required |
| Delete template (soft) | `isAdmin` required |
| Override template selection after group start | `isAdmin` required via `adminOverride` flag |
| Configure system default template | `isAdmin` required |

**Non-admin actions (all users):**

- Select category/template for own new case (from active templates only)
- Set main topic on own case
- Use Draft Coach, approve/reject drafts
- View template metadata (read-only)

**Audit logging:**

- Every admin-gated action must emit a structured audit event containing: `actorId`, `action`, `targetId` (template/case), timestamp, and outcome (success/denied).
- Denied attempts must also be logged for security review.

**Future extensibility:**

- When full RBAC is introduced, the `isAdmin` flag will be superseded by a role/permission system. The enforcement layer should be implemented as a pluggable guard so that the v2 boolean check can be replaced without refactoring channel handlers.

---

## 2. Product Outcomes and Success Criteria

## 2.1 Outcomes

- Parties articulate messages more clearly before sending in mediation.
- AI behavior is predictable by dispute type through explicit templates.
- Users do not get lost in closed-case or premature chat navigation paths.
- Intake and group conversations feel like modern chat products.

## 2.2 Success Criteria

- At least 80% of drafted group messages go through at least one clarifying coach turn before approval.
- At least 95% of new cases have a category and template selected before first private intake message.
- Zero known routes where "Start New Mediation" leaves users inside a closed case.
- Chat UX parity for markdown, timestamps, copy action, and auto-scroll across all chat surfaces.

---

## 3. Current Baseline and Required Delta

## 3.1 Baseline (already present)

- Existing optional draft flow (`createDraft` -> `appendDraft` -> `runDraftSuggestion` -> `approve/reject`).
- Existing markdown renderer in renderer layer.
- Existing closed-case screen with "Start New Mediation" button.
- Existing intake template runner and hardcoded prompt builders in `desktop/main.ts`.

## 3.2 Delta (required by v2)

- Draft coach must lead exploration and readiness confirmation before producing formal draft text.
- Prompt behavior must be driven by selected coaching templates, not hardcoded static prompts.
- Main Topic step must become a required setup screen for new issues.
- Template lifecycle and version management must be user-manageable through admin tooling.

---

## 4. Domain Model Additions (Normative for v2)

## 4.1 Case-level Template and Topic Configuration

```ts
type CoachingRole = 'intake_coach' | 'draft_coach' | 'mediator';

interface TemplateSelection {
  categoryId: string;
  templateId: string;
  templateVersion: number;
  selectedAt: string; // ISO8601
}

interface MainTopicConfig {
  topic: string;
  description: string;
  categoryId: string;
  templateId: string;
  templateVersion: number;
  configuredAt: string; // ISO8601
  configuredByPartyId?: string;
}

interface MediationCaseV2Fields {
  schemaVersion: number;   // migration version marker; v2 cases start at 2
  templateSelection?: TemplateSelection;
  mainTopicConfig?: MainTopicConfig;
}
```

Rules:

- A case is "topic-configured" when `mainTopicConfig` exists and `topic` is non-empty.
- A case is "template-configured" when `templateSelection` exists and references a resolvable template version (active **or** archived). The "active" status requirement applies only when a user is making a **new** template selection; once pinned, a case retains its template-configured status regardless of subsequent template or version archival.
- Private intake and group chat entry points must be blocked until both are configured for newly created cases.

## 4.2 Draft Coach Conversation State

```ts
type DraftCoachPhase = 'exploring' | 'confirm_ready' | 'formal_draft_ready';

interface DraftCoachMetadata {
  phase: DraftCoachPhase;
  readinessConfirmedAt?: string; // ISO8601
  explorationSummary?: string;
  formalDraftText?: string;
  formalDraftGeneratedAt?: string; // ISO8601
}
```

`GroupMessageDraft` is extended with optional `coachMeta: DraftCoachMetadata`.

### 4.2.1 Draft Coach Phase Transition Table (Normative)

| Current Phase | Trigger | Actor | Guard | Next Phase | Side Effects |
|---|---|---|---|---|---|
| *(none)* | User opens Draft Coach | User (via UI) | Draft exists or is created | `exploring` | Initialize `coachMeta` with `phase: 'exploring'` |
| `exploring` | User sends exploratory message | User | — | `exploring` | Append to coach conversation; AI responds with coaching analysis |
| `exploring` | User clicks "Ready to Draft" | User (via UI) | At least one coach exchange has occurred | `confirm_ready` | Set `coachMeta.readinessConfirmedAt` to current timestamp |
| `confirm_ready` | User clicks "Generate Formal Draft" | User (via UI) | `phase === 'confirm_ready'` | `formal_draft_ready` | AI generates formal draft; set `coachMeta.formalDraftText` and `formalDraftGeneratedAt` |
| `confirm_ready` | User sends new exploratory input | User | — | `exploring` | Clear `readinessConfirmedAt`; continue coaching |
| `formal_draft_ready` | User approves draft | User (via UI) | `formalDraftText` is non-empty | *(draft lifecycle ends)* | Emit group message with `deliveryMode = 'coach_approved'` |
| `formal_draft_ready` | User edits draft or sends new input | User | — | `exploring` | Clear `formalDraftText`, `formalDraftGeneratedAt`, `readinessConfirmedAt`; resume exploration |
| `formal_draft_ready` | User rejects draft | User (via UI) | — | `exploring` | Clear `formalDraftText`, `formalDraftGeneratedAt`; resume exploration |

**Transition IPC payloads:**

```ts
// Request: desktop:mediation:set-draft-readiness
interface SetDraftReadinessRequest {
  caseId: string;
  draftId: string;
  readinessConfirmed: boolean; // true = move to confirm_ready; false = reset to exploring
}

// Response data: desktop:mediation:set-draft-readiness
// Wrapped in standard IpcResponse<SetDraftReadinessResponseData> envelope (Section 7.0).
// Errors use the shared IpcErrorResponse shape with codes from IpcErrorCode.
interface SetDraftReadinessResponseData {
  phase: DraftCoachPhase;
}
```

**Guards:**
- Transition from `exploring` → `confirm_ready` requires at least one completed coach exchange (user message + AI response pair).
- Transition from `confirm_ready` → `formal_draft_ready` is only triggered by the "Generate Formal Draft" UI action, never automatically.
- All transitions are user-initiated; the AI never autonomously changes the phase.

## 4.3 Template Catalog Model

```ts
interface CoachingCategory {
  id: string;             // stable slug, e.g. "workplace"
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
}

interface CoachingTemplate {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  currentVersion: number;
  createdAt: string;      // ISO8601
  updatedAt: string;      // ISO8601
  deletedAt?: string;     // soft delete marker
}

interface CoachingTemplateVersion {
  templateId: string;
  version: number;
  createdAt: string;      // ISO8601
  createdByActorId: string; // immutable — identity of the actor who created this version
  createdByActorDisplay?: string; // optional human-readable display name, immutable
  changeNote: string;
  intakeCoachPreamble?: string;
  draftCoachPreamble?: string;
  mediatorPreamble?: string;
  globalGuidance: string;
  intakeCoachInstructions?: string;
  draftCoachInstructions?: string;
  mediatorInstructions?: string;
}
```

---

## 5. Prompt Assembly Architecture (Normative)

## 5.1 Prompt Sources

For each AI role, the runtime prompt must be composed from:

- Role preamble (safety and format requirements), resolved as:
- template role preamble override when provided (`{role}Preamble`)
- otherwise runtime default role preamble
- Template `globalGuidance`.
- Template role-specific instructions (optional).
- Case topic and description from `mainTopicConfig`.
- Relevant transcript context.

Role preamble overrides must be editable in template version management UI.

## 5.2 Context Rules

- Draft coach generation must include full context for the acting party and case, including:
- private intake conversation(s) for the acting party
- full group chat / joint coaching conversation for the case
- draft coach conversation history for the current draft thread
- If user launches Draft Coach from a group chat compose action, that compose text is injected as the initial user message in the draft coach thread automatically.
- If raw transcript exceeds provider input limits, runtime must run a deterministic compression pass. The compression algorithm is as follows:

### 5.2.1 Transcript Compression Algorithm (Normative)

**Token budget allocation:**

1. Compute `maxContextTokens` from the provider model's documented context window minus a reserved output buffer (default: 4096 tokens for response).
2. Reserve space for immutable segments (see below). Remaining budget is the **compression budget**.

**Immutable segments (never compressed):**

- The most recent **30 raw turns** (or all turns if fewer than 30), including the launch compose message when present.
- The full draft compose history for the current draft thread.
- The assembled prompt (preamble, guidance, instructions, topic).

**Compression pass for remaining turns:**

1. Group older turns (before the 30-turn recency window) into sequential blocks of 10 turns.
2. For each block, generate a deterministic extractive summary: retain the first and last turn verbatim; for intermediate turns, extract one sentence per turn capturing the key assertion or question.
3. Prefix each compressed block with a `[Compressed: turns N–M]` marker.
4. Token-count the result. If the total (immutable + compressed) fits within `maxContextTokens`, use it.

**Fallback when constraints still exceed model context:**

5. If still over budget after step 4, increase block size to 20 turns and reduce intermediate turns to subject-line-only extracts (≤15 tokens each).
6. If still over budget, truncate the oldest compressed blocks entirely, retaining a single `[Transcript truncated: turns 1–N omitted]` marker, until the total fits.
7. If the immutable segments alone exceed `maxContextTokens`, emit a runtime error `context_budget_exceeded` with diagnostic metadata (required tokens, available tokens, turn counts) and abort the AI generation. The UI must surface this error to the user with a message indicating the conversation is too long for AI processing.

This preserves full-context grounding while remaining provider-compatible.

## 5.3 Output Rules

- Intake coach output remains private to the party.
- Draft coach output never auto-sends to group chat.
- Draft coach response must include:
- suggested edits / improved draft text
- analysis explaining why the message can be improved and how the suggested changes improve clarity, tone, and mediation outcome
- Mediator output remains neutral, facilitative, and template-informed.

## 5.4 Model Requirement

- Intake Coach, Draft Coach, and Mediator must use ChatGPT as the model family for v2 runtime generation.
- Runtime configuration must default all three roles to ChatGPT unless explicitly overridden by a future feature flag.

**Model resolution precedence (highest to lowest):**

1. **Feature flag override** — runtime feature flag forcing a specific model (reserved for future use; not set in v2 initial release).
2. **Template-level override** — if a future template schema extension specifies a model, it takes precedence over defaults (reserved; not present in v2 schema).
3. **Runtime default** — ChatGPT for all three roles (the v2 normative default).
4. **Per-party `localLLM` config** (baseline) — **deprecated for v2 AI roles**. Existing per-party `localLLM` fields in baseline contracts are ignored for Intake Coach, Draft Coach, and Mediator generation. They remain in the schema for backward compatibility but have no effect on v2 role model selection.

**Migration behavior:**

- On v2 migration, existing per-party `localLLM` values are preserved in storage but are not consulted during prompt generation for the three AI roles.
- If a future version re-enables per-party model selection, it must be introduced as a new field with explicit opt-in semantics rather than re-activating the deprecated `localLLM` field.

---

## 6. Functional Requirements

## 6.1 F-01 Conversational Draft Coach

Goal: convert "Draft with Coach" from immediate drafting to guided articulation.

Requirements:

1. Opening Draft Coach initializes or resumes a draft in `coachMeta.phase = 'exploring'`.
2. If Draft Coach is launched from a typed group-chat compose message, that message must be auto-inserted as the initial user input to coach (no re-entry required).
3. Conversational coaching behavior (question ordering, clarifications, and intent discovery flow) is prompt-driven via template and role instructions, not hardcoded in product logic.
4. Coach must not generate final formal draft text until user explicitly confirms readiness.
5. After readiness confirmation, coach generates one formal draft and sets `coachMeta.phase = 'formal_draft_ready'`.
6. Draft coach response contracts are split by phase:
   - **`exploring` phase responses** must include:
     - coaching analysis: identification of tone, clarity, or framing issues
     - clarifying questions to help the user articulate their intent
     - directional suggestions describing *how* the message could improve (but **not** formal send-ready draft text)
   - **`confirm_ready` phase** (transitional): no AI response is generated in this phase; it is a UI-only gate before the user triggers formal draft generation.
   - **`formal_draft_ready` phase responses** must include:
     - one formal send-ready draft text suitable for group chat delivery
     - analysis of the original message quality and rationale for the improvements in the formal draft
7. User can edit draft text and approve or return to exploration.
8. If user edits or adds new exploratory input after formal draft generation, phase resets to `exploring`.
9. Intake, group/joint, and draft-coach context must be included per Section 5.2.
10. **Approve semantics** remain unchanged from baseline: the approved send path emits exactly one group message with `deliveryMode = 'coach_approved'`. **Reject semantics are intentionally changed in v2:** in the baseline, reject was terminal (closed the draft). In v2, reject from `formal_draft_ready` transitions the draft back to `exploring` (see Section 4.2.1 transition table), clearing `formalDraftText` and `formalDraftGeneratedAt` but preserving the coaching conversation history. This allows the user to continue refining with the coach rather than starting over. The baseline terminal-reject behavior is **no longer active** for drafts that have `coachMeta` present. Drafts without `coachMeta` (legacy pre-v2 drafts) retain the original terminal reject behavior for backward compatibility.

UX behavior:

- Button label in group chat remains "Draft with Coach".
- Coach panel title changes to "Conversation Draft Coach".
- Panel shows status chip: `Exploring`, `Ready to Draft`, or `Draft Ready`.
- "Generate Formal Draft" button is enabled only in `confirm_ready` phase.

Acceptance criteria:

- No formal draft appears before explicit user readiness.
- Draft coaching transcript remains private to the acting party.
- Approve flow continues to create exactly one group message linked to source draft.

## 6.2 F-02 Message Window Formatting

Goal: consistent modern chat UX across intake, group chat, and coach panel.

Requirements:

1. Markdown rendering must be enabled in all chat message bodies.
2. Message bubbles must be role-based with stable alignment and color semantics.
3. Typing indicator must show while AI turn is pending and while remote party emits typing signal.
4. Auto-scroll must keep user at latest when already near bottom.
5. If user has scrolled away from bottom, new messages must not force-jump; show "Jump to latest".
6. Every message must render a timestamp.
7. Copy action must exist on each message (hover or action menu) and copy raw text content.

Rendering contract:

- `party` (current user): right aligned, primary accent.
- `party` (other user): left aligned, neutral accent.
- `party_llm`: left aligned, coach accent, "AI" badge.
- `mediator_llm`: left aligned, mediator accent, "Mediator" badge.
- `system`: centered, subdued.

### 6.2.1 Typing Indicator Signaling Protocol (Normative)

**Event contract:**

```ts
interface TypingIndicatorEvent {
  type: 'typing_start' | 'typing_stop';
  sourceType: 'ai_generation' | 'remote_party';
  sourceId: string;           // party ID or AI role identifier
  caseId: string;
  chatSurface: 'intake' | 'group' | 'coach_panel';
  timestamp: string;          // ISO8601
}
```

**Transport:** Typing events are emitted on the existing renderer event bus. For AI generation, the main process emits events via the IPC bridge. For remote party typing, the gateway relays typing signals to the renderer.

**Timing guarantees:**

| Concern | Requirement |
|---|---|
| Show latency | Typing indicator must appear within **300ms** of the triggering event (AI generation start or remote typing signal receipt). |
| AI generation stop | `typing_stop` is emitted when the AI response is fully received **or** when generation fails/times out. |
| Remote party debounce | Remote party `typing_start` events are debounced with a **2-second** window: repeated signals within 2s do not re-trigger the indicator. |
| TTL / auto-clear | If no `typing_stop` is received within **15 seconds** of the last `typing_start`, the indicator is automatically hidden (timeout fallback). |
| Response arrival clear | On receipt of a new message from the typing source, the indicator is immediately hidden regardless of whether `typing_stop` was received. |

**Clear/hide conditions (any one triggers hide):**

1. Explicit `typing_stop` event received.
2. New message arrives from the typing source.
3. TTL of 15 seconds expires since last `typing_start`.
4. Chat surface is navigated away from (unmounted).

**UI rendering:**

- Typing indicator shows animated dots with label: "AI is thinking…" for `ai_generation` or "{Party name} is typing…" for `remote_party`.
- Only one indicator per source is shown at a time; concurrent AI and remote party indicators may coexist.

Acceptance criteria:

- All three surfaces (intake, group, coach panel) use same timestamp and markdown rules.
- Copy action works on desktop clipboard and shows success toast.
- Typing indicator appears within 300ms of generation start and clears on response or timeout.
- Typing indicator auto-clears after 15 seconds if no stop signal is received.

## 6.3 F-03 Coaching Template System

Goal: predictable, context-aware AI behavior by mediation type.

Requirements:

1. User must select category first, then template.
2. Selected template/version is attached to the case before intake chat.
3. Intake Coach, Draft Coach, and Mediator prompt builders must use template instructions.
4. If selected template version is archived after case creation, the case continues using pinned version.
5. **Fallback to system default template/version** applies **only** to the following recovery paths:
   - **Legacy migration**: pre-v2 cases loaded without a `templateSelection` are auto-assigned the system default during migration (see Section 9.2).
   - **Data recovery**: cases where `templateSelection` references a hard-deleted or corrupted template/version record are reassigned the system default with a warning log event.
   - **New cases must not use fallback**: all newly created cases (v2+) are required to go through explicit category/template selection per F-06 before intake entry. The system default is never silently applied to new cases.

Template application rules:

- Role preambles are resolved first (template override, otherwise runtime default), then `globalGuidance`, then optional role-specific instructions.
- Role-specific instructions are appended in this order when present:
- intake coach: `intakeCoachInstructions`
- draft coach: `draftCoachInstructions`
- mediator: `mediatorInstructions`
- Empty role-specific instructions are valid; `globalGuidance` alone is sufficient when role-specific fields are omitted.

Acceptance criteria:

- Prompt logs for each role include template ID and version metadata.
- Switching template before intake immediately affects new AI turns.
- Switching template after group chat start is blocked unless explicit admin override is used.
- Soft-deleted or archived templates/versions referenced by existing cases must remain resolvable at runtime. Soft delete and archive operations hide records from the **selection UI only** (category/template picker for new or reconfigured cases) but must **never** remove or invalidate version records from storage. Runtime prompt builders must be able to resolve any pinned `templateId + version` regardless of the template's current `status` or `deletedAt` marker.

## 6.4 F-04 Post-close "New Mediation" Navigation

Goal: prevent users from staying in closed-case context when starting new work.

Requirements:

1. Clicking "Start New Mediation" from closed view must route to dashboard/root context.
2. Closed-case `caseId` and `caseData` must be cleared from active renderer state.
3. Create-new panel should auto-open after navigation to reduce extra clicks.
4. Browser-style back navigation must not re-open closed-case view unless user explicitly selects that case again.

Acceptance criteria:

- After click, URL/router state resolves to dashboard route.
- First visible primary action is new mediation creation UI.
- No controls from closed case remain interactive.

## 6.5 F-05 Template Management System

Goal: allow runtime prompt system evolution without code changes.

Requirements:

1. Admin UI supports create, read, update, archive, and soft delete template records.
2. Metadata fields editable: name, category, description, status.
3. Prompt elements editable: intake/draft/mediator preambles, global guidance, and optional role instructions (intake/draft/mediator).
4. Publishing edits creates a new immutable version record.
5. Previous versions remain viewable and can be restored as current version.
6. Deleting a template in active use is blocked; only archive is allowed.

Versioning rules:

- `currentVersion` points to one immutable `CoachingTemplateVersion`.
- Editing instruction text creates `version = prior + 1`.
- Restoring older version creates new version copied from old content.

Acceptance criteria:

- Every version has `changeNote`, timestamp, and actor ID.
- Cases always reference a concrete template version.
- Runtime prompt builders can resolve template/version without network calls.

## 6.6 F-06 New Issue -> Main Topic Screen Flow

Goal: force issue framing before free-form chat.

Requirements:

1. New issue creation routes to `Main Topic` screen, not private intake or group chat.
2. Main Topic screen requires topic, category, and template selection before continuing.
3. Description remains optional but recommended.
4. Continue action persists `mainTopicConfig` and `templateSelection`.
5. Only after successful save does user enter private intake.
6. Deep link and invite join paths must honor missing Main Topic configuration and route accordingly.

Acceptance criteria:

- New cases cannot send private intake messages before Main Topic completion.
- Returning to an unconfigured case always opens Main Topic first.
- Cases created pre-v2 are auto-migrated with default category/template and remain accessible.

---

## 7. IPC and Service Contract Changes

All channel names below are **normative** (not proposed). All request/response payloads use the TypeScript interfaces defined in this section. Every response is wrapped in a standard envelope.

### 7.0 Standard IPC Envelope

```ts
interface IpcSuccessResponse<T> {
  success: true;
  data: T;
}

interface IpcErrorResponse {
  success: false;
  error: {
    code: IpcErrorCode;
    message: string;         // human-readable diagnostic
    details?: Record<string, unknown>; // optional structured context
  };
}

type IpcResponse<T> = IpcSuccessResponse<T> | IpcErrorResponse;
```

## 7.1 New IPC Channels

### Template Channels

**`desktop:templates:list-categories`**

```ts
// Request
interface ListCategoriesRequest {} // no params

// Response data
type ListCategoriesResponseData = CoachingCategory[];
```

**`desktop:templates:list`**

```ts
// Request
interface ListTemplatesRequest {
  categoryId?: string;        // optional filter
  includeArchived?: boolean;  // default false
}

// Response data
type ListTemplatesResponseData = CoachingTemplate[];
```

**`desktop:templates:get`**

```ts
// Request
interface GetTemplateRequest {
  templateId: string;
  version?: number;           // if omitted, returns current version
}

// Response data
interface GetTemplateResponseData {
  template: CoachingTemplate;
  version: CoachingTemplateVersion;
}
```

**`desktop:templates:create`**

```ts
// Request
interface CreateTemplateRequest {
  categoryId: string;
  name: string;
  description: string;
  globalGuidance: string;
  intakeCoachPreamble?: string;
  draftCoachPreamble?: string;
  mediatorPreamble?: string;
  intakeCoachInstructions?: string;
  draftCoachInstructions?: string;
  mediatorInstructions?: string;
  changeNote: string;
  actorId: string;
}

// Response data
interface CreateTemplateResponseData {
  template: CoachingTemplate;
  version: CoachingTemplateVersion;
}
```

**`desktop:templates:update-meta`**

```ts
// Request
interface UpdateTemplateMetaRequest {
  templateId: string;
  name?: string;
  description?: string;
  categoryId?: string;
  actorId: string;
}

// Response data
interface UpdateTemplateMetaResponseData {
  template: CoachingTemplate;
}
```

**`desktop:templates:create-version`**

```ts
// Request
interface CreateVersionRequest {
  templateId: string;
  globalGuidance: string;
  intakeCoachPreamble?: string;
  draftCoachPreamble?: string;
  mediatorPreamble?: string;
  intakeCoachInstructions?: string;
  draftCoachInstructions?: string;
  mediatorInstructions?: string;
  changeNote: string;
  actorId: string;
  restoreFromVersion?: number; // if set, copies content from this version
}

// Response data
interface CreateVersionResponseData {
  version: CoachingTemplateVersion;
  template: CoachingTemplate; // updated with new currentVersion
}
```

**`desktop:templates:set-status`**

```ts
// Request
interface SetTemplateStatusRequest {
  templateId: string;
  status: 'active' | 'archived';
  actorId: string;
}

// Response data
interface SetTemplateStatusResponseData {
  template: CoachingTemplate;
}
// Error: template_in_use when archiving a template that is the only active template in its category
```

**`desktop:templates:delete`**

```ts
// Request
interface DeleteTemplateRequest {
  templateId: string;
  actorId: string;
}

// Response data
interface DeleteTemplateResponseData {
  templateId: string;
  deletedAt: string; // ISO8601
}
// Error: template_in_use when template is referenced by active (non-closed) cases
```

### Mediation Channels

**`desktop:mediation:set-main-topic`**

```ts
// Request
interface SetMainTopicRequest {
  caseId: string;
  topic: string;              // required, non-empty
  description?: string;
  categoryId: string;
  templateId: string;
  templateVersion: number;
  partyId: string;
}

// Response data
interface SetMainTopicResponseData {
  mainTopicConfig: MainTopicConfig;
  templateSelection: TemplateSelection;
}
```

**`desktop:mediation:set-template-selection`**

```ts
// Request
interface SetTemplateSelectionRequest {
  caseId: string;
  categoryId: string;
  templateId: string;
  templateVersion: number;
  actorId: string;
  adminOverride?: boolean;    // required true if case has started group chat
}

// Response data
interface SetTemplateSelectionResponseData {
  templateSelection: TemplateSelection;
}
// Error: template_inactive if the selected template/version is not active (for new selections)
```

**`desktop:mediation:draft-coach-turn`**

```ts
// Request
interface DraftCoachTurnRequest {
  caseId: string;
  draftId: string;
  partyId: string;
  userMessage: string;
  composeText?: string;       // injected from group chat compose when launching
}

// Response data
interface DraftCoachTurnResponseData {
  draftId: string;
  phase: DraftCoachPhase;
  coachResponse: string;      // AI response text (coaching or formal draft per phase)
  coachMeta: DraftCoachMetadata;
}
```

**`desktop:mediation:set-draft-readiness`**

```ts
// Request: see SetDraftReadinessRequest in Section 4.2.1

// Response data: see SetDraftReadinessResponseData in Section 4.2.1
// Returns IpcResponse<SetDraftReadinessResponseData> per standard envelope (Section 7.0).
```

## 7.2 Updated Existing Flows

- `desktop:mediation:run-draft-suggestion` becomes a **compatibility alias** that forwards to `desktop:mediation:draft-coach-turn`. The following translation rules apply:

  **Alias translation rules for `run-draft-suggestion`:**

  Legacy callers typically provide only `{ caseId, draftId }`. The alias handler must load the `GroupMessageDraft` record by `draftId` from the case's `groupChat.draftsById` and derive the additional fields required by `DraftCoachTurnRequest` as follows:

  | `DraftCoachTurnRequest` field | Derivation from legacy call |
  |---|---|
  | `caseId` | Passed through directly from legacy request. The alias handler must verify that the resolved draft belongs to this `caseId`; if not, return `IpcErrorResponse` with code `draft_not_found`. |
  | `draftId` | Passed through directly from legacy request. |
  | `partyId` | Read from `draft.partyId`. If the draft cannot be found or `partyId` is missing, return `IpcErrorResponse` with code `draft_not_found`. |
  | `userMessage` | Derived from the draft's `composeMessages` array (type `CoachComposeMessage[]`). The alias handler selects the **last entry** in `composeMessages` where `author === 'party'` and uses its `text` value. If `composeMessages` is empty or contains no `party`-authored entry, the handler falls back to `draft.suggestedText` (the most recent coach suggestion). If both are absent, return `IpcErrorResponse` with code `draft_readiness_required`. |
  | `composeText` | Set to `undefined` (not applicable for legacy calls). |

  **Alias-specific error behavior:**
  - If `draftId` does not resolve in `groupChat.draftsById`: return `IpcErrorResponse` with code `draft_not_found`.
  - If the resolved draft's parent case does not match the provided `caseId`: return `IpcErrorResponse` with code `draft_not_found`.
  - If `draft.partyId` is missing or unresolvable: return `IpcErrorResponse` with code `draft_not_found` (corrupt draft record).
  - If no usable text can be derived (no `party`-authored `composeMessages` entry **and** `suggestedText` is absent/empty): return `IpcErrorResponse` with code `draft_readiness_required`.
  - All other errors propagate from the underlying `draft-coach-turn` handler unchanged.
  - The alias response shape matches `IpcResponse<DraftCoachTurnResponseData>` (same as the target channel).

  **Deprecation:** This alias is provided for backward compatibility only and will be removed in a future major version. New callers must use `desktop:mediation:draft-coach-turn` directly.

- `desktop:mediation:create` response includes `mainTopicConfig` and `templateSelection` (possibly unset) in its data envelope.
- `desktop:mediation:list/get` must include `templateSelection` and `mainTopicConfig` for each case in response data.

## 7.3 Error Codes (Normative)

```ts
type IpcErrorCode =
  | 'template_not_found'
  | 'template_inactive'
  | 'template_version_not_found'
  | 'template_in_use'
  | 'main_topic_required'
  | 'main_topic_not_configured'
  | 'draft_readiness_required'
  | 'invalid_template_category'
  | 'invalid_phase_transition'
  | 'no_coach_exchanges'
  | 'draft_not_found'
  | 'context_budget_exceeded'
  | 'admin_override_required'
  | 'unauthorized_admin_action'
  | 'internal_error';           // reserved for unexpected/system errors on any channel
```

**Default error set:** All channels may additionally return generic transport/system errors not listed in `IpcErrorCode` (e.g., serialization failures, unexpected exceptions). Implementations should catch these and return `IpcErrorResponse` with a descriptive `message` and a `code` of `'internal_error'`. The `internal_error` code is reserved for this purpose and is implicitly valid for every channel — it is not repeated in the per-channel table below.

**Per-channel error mappings (exhaustive):**

| Channel | Possible Error Codes |
|---|---|
| `desktop:templates:list-categories` | *(no channel-specific errors; returns empty array if none exist)* |
| `desktop:templates:list` | `invalid_template_category` |
| `desktop:templates:get` | `template_not_found`, `template_version_not_found` |
| `desktop:templates:create` | `invalid_template_category`, `unauthorized_admin_action` |
| `desktop:templates:update-meta` | `template_not_found`, `invalid_template_category`, `unauthorized_admin_action` |
| `desktop:templates:create-version` | `template_not_found`, `template_version_not_found`, `unauthorized_admin_action` |
| `desktop:templates:set-status` | `template_not_found`, `template_in_use`, `unauthorized_admin_action` |
| `desktop:templates:delete` | `template_not_found`, `template_in_use`, `unauthorized_admin_action` |
| `desktop:mediation:set-main-topic` | `template_not_found`, `template_inactive`, `template_version_not_found`, `invalid_template_category` |
| `desktop:mediation:set-template-selection` | `template_not_found`, `template_inactive`, `template_version_not_found`, `admin_override_required`, `unauthorized_admin_action` |
| `desktop:mediation:draft-coach-turn` | `draft_not_found`, `main_topic_not_configured`, `context_budget_exceeded` |
| `desktop:mediation:set-draft-readiness` | `draft_not_found`, `no_coach_exchanges`, `invalid_phase_transition` |
| `desktop:mediation:run-draft-suggestion` *(alias)* | `draft_not_found`, `draft_readiness_required`, `main_topic_not_configured`, `context_budget_exceeded` |

---

## 8. Navigation and View Contract

## 8.1 New/Updated Views

- `dashboard` (existing, updated quick-create behavior)
- `main-topic` (new, required for new issue path)
- `private-intake` (existing, blocked until main topic configured)
- `group-chat` (existing, updated draft coach panel and chat formatting)
- `resolved` (existing)
- `closed` (existing, updated start-new routing)
- `template-admin` (new)

## 8.2 View Resolution Rules

- If `case.phase === 'closed'`, route to `closed`.
- Else if `case.mainTopicConfig` missing **or** `case.templateSelection` missing or invalid (references a non-resolvable version), route to `main-topic`.
- Else standard phase-based routing applies.

**Validation detail:** `templateSelection` is considered invalid if `templateId` or `templateVersion` cannot be resolved from the template store. This covers cases where migration assigned a default that was subsequently hard-deleted (an error condition). The `main-topic` view must allow the user to re-select a valid category/template before proceeding.

## 8.3 Closed-to-New Routing Rule

Clicking Start New from `closed` must execute:

```ts
state.caseId = null;
state.caseData = null;
state.activeSubview = null;
state.coachPanelOpen = false;
state.createFormExpanded = true;
```

Then render dashboard create flow.

---

## 9. Storage and Migration

## 9.1 Template Storage

- Introduce local template catalog store with durable file-backed persistence.
- Suggested path: app user-data directory, separate from case JSON.
- Store must support atomic write and version history append semantics.

## 9.2 Case Migration

- The `schemaVersion` field (defined in `MediationCaseV2Fields`, Section 4.1) serves as the migration version marker.
  - Pre-v2 cases loaded without a `schemaVersion` field are treated as `schemaVersion: 1`.
  - On migration, the loader sets `schemaVersion: 2` after applying all v2 backfill steps below.
  - Future spec revisions increment `schemaVersion` and define their own migration steps keyed to the new version number.
- For cases without `templateSelection`, assign the system default active template/version during load (legacy fallback per F-03 rule 5).
- For cases without `mainTopicConfig`, backfill from existing `topic`/`description` fields and the assigned default template.

## 9.3 Backward Compatibility

- Existing cases remain readable without manual intervention.
- Existing draft records remain valid if `coachMeta` is absent.
- Existing IPC callers can continue using `run-draft-suggestion` alias temporarily.

---

## 10. Observability

Emit structured events for:

- `template.selected`
- `template.version.pinned`
- `main_topic.saved`
- `draft_coach.phase_changed`
- `draft_coach.formal_generated`
- `draft_coach.approved`
- `chat.copy_message`
- `chat.typing_indicator.shown`

Each event should include `case_id`, `party_id` when applicable, `template_id`, and `template_version`.

---

## 11. Test Plan (Required)

## 11.1 Unit

- Template store CRUD, versioning, and soft delete constraints.
- Prompt assembly for all three roles with category/template injection.
- Draft coach phase transitions and readiness gating.
- Main Topic gating logic.

## 11.2 Integration

- Renderer navigation: new issue -> main topic -> intake.
- Closed view start-new action returns to dashboard with create panel open.
- Message formatting and markdown rendering consistency across three chat surfaces.
- Typing indicator lifecycle and copy-to-clipboard behavior.

## 11.3 Regression

- Existing direct-send and approve-draft send paths unchanged.
- Existing consent filtering and case projection unchanged.
- Existing remote collaborator sync remains functional with template metadata.

---

## 12. Rollout Plan

## 12.1 Phase 1

- Ship data model, template store, and read-path fallback defaults.
- Keep legacy draft suggestion behavior behind compatibility alias.

## 12.2 Phase 2

- Enable Main Topic gating and template selection UI for all new cases.
- Enable conversational draft coach flow.

## 12.3 Phase 3

- Enable template admin UI and version management.
- Remove direct dependency on hardcoded prompt builders once all roles resolve through template system.

---

## 13. File-Level Implementation Targets

- `src/domain/types.ts`: add template/topic and draft coach metadata fields.
- `src/app/mediation-service.ts`: add topic/template setters and gating checks.
- `desktop/main.ts`: replace hardcoded role prompt builders with template-aware prompt assembly.
- `desktop/ipc/channel-manifest.ts`: add template and main-topic channels.
- `desktop/ipc/mediation-ipc.ts`: register new channels and compatibility alias.
- `desktop/preload.ts`: expose new template and mediation APIs.
- `desktop/renderer/app.js`: add Main Topic and Template Admin views, update closed routing and draft coach UX.
- `desktop/renderer/styles/chat.css`: finalize role bubble styles, typing indicator, jump-to-latest affordance.
- `desktop/renderer/markdown.js`: ensure unified markdown capabilities across all chat surfaces.

---

## 14. Definition of Done

v2 is complete when all conditions are true:

1. F-01 through F-06 acceptance criteria are passing.
2. Automated tests cover new template/version and navigation behavior.
3. Existing v1 case and messaging behavior has no regressions in regression suite.
4. Docs are updated to reference this v2 spec as active delta for implementation.
