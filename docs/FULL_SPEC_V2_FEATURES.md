# Mediation App Full Specification (v2 Feature Set)

Status: Implementation-ready specification (v2 delta)
Date: 2026-02-27
Codebase: `/Users/dtannen/Code/mediation`
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
  templateSelection?: TemplateSelection;
  mainTopicConfig?: MainTopicConfig;
}
```

Rules:

- A case is "topic-configured" when `mainTopicConfig` exists and `topic` is non-empty.
- A case is "template-configured" when `templateSelection` exists and references an active template version.
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
  changeNote: string;
  globalGuidance: string;
  intakeCoachInstructions: string;
  draftCoachInstructions: string;
  mediatorInstructions: string;
}
```

---

## 5. Prompt Assembly Architecture (Normative)

## 5.1 Prompt Sources

For each AI role, the runtime prompt must be composed from:

- Role fixed preamble (safety and format requirements).
- Template `globalGuidance`.
- Template role-specific instructions.
- Case topic and description from `mainTopicConfig`.
- Relevant transcript context.

## 5.2 Context Rules

- Draft coach generation must include full group chat context for the case.
- If raw transcript exceeds provider input limits, runtime must run a deterministic compression pass over the entire transcript first, then include:
- Compression output representing the full transcript.
- The most recent raw turns (minimum 30 turns) unchanged.
- The draft compose history unchanged.

This preserves full-context grounding while remaining provider-compatible.

## 5.3 Output Rules

- Intake coach output remains private to the party.
- Draft coach output never auto-sends to group chat.
- Mediator output remains neutral, facilitative, and template-informed.

---

## 6. Functional Requirements

## 6.1 F-01 Conversational Draft Coach

Goal: convert "Draft with Coach" from immediate drafting to guided articulation.

Requirements:

1. Opening Draft Coach initializes or resumes a draft in `coachMeta.phase = 'exploring'`.
2. First coach turn asks what the user wants to communicate and desired outcome.
3. Coach asks clarifying questions until it can summarize intent, constraints, and ask for readiness confirmation.
4. Coach must not generate final formal draft text until user explicitly confirms readiness.
5. After readiness confirmation, coach generates one formal draft and sets `coachMeta.phase = 'formal_draft_ready'`.
6. User can edit draft text and approve or return to exploration.
7. If user edits or adds new exploratory input after formal draft generation, phase resets to `exploring`.
8. Full group chat context and draft compose history must be included per Section 5.2.
9. Existing approve/reject semantics remain; approved send path still emits group message with `deliveryMode = 'coach_approved'`.

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

Acceptance criteria:

- All three surfaces (intake, group, coach panel) use same timestamp and markdown rules.
- Copy action works on desktop clipboard and shows success toast.
- Typing indicator appears within 300ms of generation start and clears on response or timeout.

## 6.3 F-03 Coaching Template System

Goal: predictable, context-aware AI behavior by mediation type.

Requirements:

1. User must select category first, then template.
2. Selected template/version is attached to the case before intake chat.
3. Intake Coach, Draft Coach, and Mediator prompt builders must use template instructions.
4. If selected template version is archived after case creation, the case continues using pinned version.
5. Cases without explicit selection must fallback to a configured system default template/version.

Template application rules:

- `globalGuidance` is always prepended before role-specific instructions.
- Role-specific instructions are appended in this order:
- intake coach: `intakeCoachInstructions`
- draft coach: `draftCoachInstructions`
- mediator: `mediatorInstructions`

Acceptance criteria:

- Prompt logs for each role include template ID and version metadata.
- Switching template before intake immediately affects new AI turns.
- Switching template after group chat start is blocked unless explicit admin override is used.

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
3. Role instructions editable: intake, draft, mediator, and global guidance.
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

## 7.1 New IPC Channels (proposed naming)

- `desktop:templates:list-categories`
- `desktop:templates:list`
- `desktop:templates:get`
- `desktop:templates:create`
- `desktop:templates:update-meta`
- `desktop:templates:create-version`
- `desktop:templates:set-status`
- `desktop:templates:delete`
- `desktop:mediation:set-main-topic`
- `desktop:mediation:set-template-selection`
- `desktop:mediation:draft-coach-turn`
- `desktop:mediation:set-draft-readiness`

## 7.2 Updated Existing Flows

- `desktop:mediation:run-draft-suggestion` becomes compatibility alias and forwards to `desktop:mediation:draft-coach-turn`.
- `desktop:mediation:create` response includes `mainTopicConfig` and `templateSelection` (possibly unset).
- `desktop:mediation:list/get` must include template/version references for each case.

## 7.3 New Error Codes

- `template_not_found`
- `template_inactive`
- `template_version_not_found`
- `template_in_use`
- `main_topic_required`
- `main_topic_not_configured`
- `draft_readiness_required`
- `invalid_template_category`

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
- Else if `case.mainTopicConfig` missing, route to `main-topic`.
- Else standard phase-based routing applies.

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

- Add migration version marker to case payload.
- For cases without `templateSelection`, assign default active template/version during load.
- For cases without `mainTopicConfig`, backfill from existing `topic`/`description` and default template.

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
