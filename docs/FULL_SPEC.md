# Mediation App Full Specification (v1)

Status: Draft v1
Date: 2026-02-25
Codebase: `/Users/dtannen/Code/mediation`
Source baseline for reused components: `/Users/dtannen/Code/commands-com-agent`

## 1. Goal

Build a standalone mediation application where:

1. Each party works privately with their own local LLM.
2. Party LLMs exchange approved context through gateway transport.
3. Both parties join a shared room with a mediator LLM for final resolution.

The mediation app is a separate product and separate repo, but it reuses proven transport, security, and orchestration patterns from `commands-com-agent`.

## 2. Non-Goals (v1)

1. Real-time video/audio mediation.
2. Legal advice or legal determination features.
3. Autonomous enforcement of legal contracts.
4. Multi-tenant enterprise admin panel.
5. Cross-case memory that leaks context between mediation cases.

## 3. Product Scope

### 3.1 Core Use Cases

1. Two-party conflict mediation with private intake and guided resolution.
2. Multi-party (3+) dispute mediation with the same phase model.
3. Optional human moderator co-pilot mode in addition to mediator LLM.
4. End-to-end auditable resolution timeline.

### 3.2 User Roles

1. `party`: human participant in the dispute.
2. `party_llm`: local model selected by each party.
3. `mediator_llm`: shared model used in joint room.
4. `system`: platform lifecycle and policy events.

## 4. Inherited Security and Trust Invariants

The mediation app inherits these as mandatory invariants from the source project architecture:

1. Renderer/UI process must never receive bearer tokens, private keys, or ciphertext session keys.
2. Authentication, gateway I/O, and cryptographic operations stay in trusted runtime/main process.
3. Untrusted origins fail closed.
4. Invalid or expired auth fails closed.
5. Replay protection and monotonic sequencing are required for encrypted relay messages.
6. Audit logs must be append-only and redact secrets.
7. Policy violations stop progression to next phase unless explicitly overridden by authorized user action.

## 5. High-Level Architecture

```text
Party A Device (local LLM A)
  -> private intake thread A (local only)
  -> approved summary A
                        \            E2EE gateway relay            /
                         -> cross-agent dialogue (A LLM <-> B LLM) ->
                        /                                           \
Party B Device (local LLM B)
  -> private intake thread B (local only)
  -> approved summary B

Then:
Both parties + mediator LLM join joint mediation room
```

### 5.1 Logical Subsystems

1. `case-service`: case lifecycle, state transitions, consent enforcement.
2. `policy-engine`: sharing permissions and redaction transforms.
3. `transport-adapter`: gateway relay and session management.
4. `local-llm-adapter`: party LLM bridge requests/responses.
5. `room-engine`: joint room orchestration and mediator turn policy.
6. `audit-service`: immutable timeline with structured events.

## 6. Phase Model

### 6.1 States

1. `private_intake`
2. `cross_agent_dialogue`
3. `joint_mediation`
4. `resolved`
5. `closed`

### 6.2 Allowed Transitions

1. `private_intake -> cross_agent_dialogue`
2. `private_intake -> closed`
3. `cross_agent_dialogue -> joint_mediation`
4. `cross_agent_dialogue -> closed`
5. `joint_mediation -> resolved`
6. `joint_mediation -> closed`
7. `resolved -> closed`

### 6.3 Transition Guards

1. `private_intake -> cross_agent_dialogue`: every party has `resolved=true` and non-empty intake summary.
2. `cross_agent_dialogue -> joint_mediation`: cross-agent stage marked complete.
3. `joint_mediation -> resolved`: mediator summary exists and parties accepted final terms (or override policy event recorded).

## 7. Detailed Functional Requirements

### 7.1 Private Intake

1. Each party has a separate private thread.
2. Party chooses local model/provider.
3. No private intake message is shared until consent rules approve it.
4. System generates structured private summary per party.

### 7.2 Cross-Agent Dialogue

1. Each party summary is transformed by consent policy.
2. LLM-to-LLM exchange uses gateway transport with correlation IDs.
3. Dialogue is bounded by turn and duration limits.
4. Output is a shared consensus draft plus unresolved-items list.

### 7.3 Joint Mediation

1. Opens shared room with both parties and mediator LLM.
2. Mediator establishes goals, ground rules, and agenda.
3. Mediator proposes options and tradeoffs.
4. Room ends with either `resolved` or `closed` with reason.

### 7.4 Resolution and Closure

1. Resolution captures final terms, rationale, and follow-up checkpoints.
2. Any closure without resolution must include terminal reason code.
3. Complete event timeline remains queryable for audit.

## 8. Consent and Data-Sharing Policy

### 8.1 Consent Grant Schema

Per party:

1. `allowSummaryShare: boolean`
2. `allowDirectQuote: boolean`
3. `allowedTags: string[]`

### 8.2 Policy Rules

1. If `allowSummaryShare=false`, no private content may leave intake thread.
2. If `allowDirectQuote=false`, policy engine paraphrases summary before sharing.
3. Only content tags in `allowedTags` may be forwarded.
4. Denied shares must produce explicit system message and audit event.

### 8.3 Policy Decision Logging

Each share decision logs:

1. party id
2. source message id(s)
3. policy result (`allow`, `deny`, `transform`)
4. reason string
5. transformed output hash (when transformed)

## 9. Data Model (Canonical)

### 9.1 Core Entities

1. `MediationCase`
2. `Party`
3. `ConsentGrant`
4. `ThreadMessage`
5. `PrivateIntakeThread`
6. `SharedDialogueThread`
7. `JointMediationRoom`

### 9.2 Required Fields

`MediationCase` minimum:

1. `id`, `title`, `issue`
2. `createdAt`, `updatedAt`
3. `phase`
4. `parties[]`
5. `consent`
6. `privateIntakeByPartyId`
7. `sharedDialogue`
8. `jointRoom`
9. optional `resolution`

### 9.3 Persistence (v1)

1. Start with in-memory store for dev/testing.
2. Upgrade to SQL (SQLite then Postgres) with append-only event table.
3. Keep message payload and metadata separated for policy redaction support.

## 10. API and Event Contracts

### 10.1 REST/IPC Commands

1. `createCase`
2. `appendPrivateMessage`
3. `setPrivateSummary`
4. `runCrossAgentDialogue`
5. `transitionPhase`
6. `appendJointMessage`
7. `setMediatorSummary`
8. `resolveCase`
9. `closeCase`
10. `getCase`
11. `listCases`

### 10.2 Event Types

1. `case.created`
2. `phase.changed`
3. `private.message.appended`
4. `private.summary.updated`
5. `share.decision`
6. `cross_dialogue.message`
7. `joint_room.message`
8. `case.resolved`
9. `case.closed`
10. `policy.violation`

### 10.3 Error Shape

All service/domain failures use:

```json
{
  "code": "string",
  "message": "human-readable",
  "recoverable": true
}
```

## 11. Limits and Safety Controls

### 11.1 Defaults

1. `maxTurns`: 12 for cross-agent stage, 30 for joint room.
2. `maxDurationMs`: 45 min per stage.
3. `maxFailures`: 3 consecutive hard failures before pause/stop.
4. `tokenBudget`: optional, off by default.

### 11.2 Manual Overrides

1. `pause`
2. `resume`
3. `stop`
4. `take_over` (human sends directly)
5. `force_transition` (requires elevated permission and audit record)

## 12. Full Reuse Inventory from commands-com-agent

This section is the complete inventory of components and standards to be taken from the source project.

### 12.1 Reuse Modes

1. `AS_IS`: copy with minimal namespace/path changes.
2. `ADAPT`: preserve behavior, alter data model or API surface.
3. `REFERENCE_ONLY`: use as design precedent; do not copy code directly.

### 12.2 Core Runtime and Transport Reuse

| Source Path | Mode | What Is Taken | Mediation Target |
|---|---|---|---|
| `src/crypto.ts` | ADAPT | Frame encryption/decryption primitives, nonce discipline | `src/security/crypto.ts` |
| `src/handshake.ts` | ADAPT | Session key negotiation flow and replay protections | `src/transport/handshake.ts` |
| `src/gateway.ts` | ADAPT | Gateway protocol client patterns | `src/transport/gateway-client.ts` |
| `src/oauth.ts` | ADAPT | OAuth token lifecycle model | `src/auth/oauth.ts` |
| `src/runtime.ts` | REFERENCE_ONLY | Runtime control loop structure | `src/runtime/mediation-runtime.ts` |
| `src/types.ts` | REFERENCE_ONLY | Canonical error/result contracts style | `src/contracts/common.ts` |
| `src/config.ts` | ADAPT | Config loading and env normalization pattern | `src/config/index.ts` |
| `src/audit.ts` | ADAPT | Structured audit append format | `src/audit/audit-service.ts` |

### 12.3 Local LLM Bridge and Orchestration Reuse

| Source Path | Mode | What Is Taken | Mediation Target |
|---|---|---|---|
| `src/local-prompt-bridge.ts` | ADAPT | Request/response framing with correlation IDs | `src/llm/local-prompt-bridge.ts` |
| `desktop/agent-runtime/local-prompt-bridge.js` | ADAPT | Desktop runtime bridge mechanics | `desktop/runtime/local-prompt-bridge.ts` |
| `desktop/orchestration-manager.js` | ADAPT | Orchestration state machine, safety limits, manual/semi/full modes | `src/orchestration/cross-dialogue-manager.ts` |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS (normative) | Loop rules, stop conditions, local bridge contract | `docs/reference/spec-05-agent-to-agent-shared.md` |

### 12.4 Room Engine Reuse

| Source Path | Mode | What Is Taken | Mediation Target |
|---|---|---|---|
| `desktop/room/room-runtime.js` | ADAPT | Generic room lifecycle, hook queue, stop precedence | `src/room/joint-room-runtime.ts` |
| `desktop/room/plugin-registry.js` | ADAPT | Plugin descriptor contract and loading model | `src/room/plugin-registry.ts` |
| `desktop/lib/room-contracts.js` | ADAPT | Validation patterns, room errors, limits parsing | `src/room/contracts.ts` |
| `desktop/room/review-cycle-plugin.js` | REFERENCE_ONLY | Multi-agent plugin style and metrics schema | `src/room/plugins/mediation-plugin.ts` |
| `desktop/room/war-room-plugin.js` | REFERENCE_ONLY | Parallel fan-out and planning cycles | `src/room/plugins/mediation-plugin.ts` |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS (normative) | External plugin trust boundary requirements | `docs/reference/spec-16-room-external-plugins.md` |

### 12.5 Provider and Model Integration Reuse

| Source Path | Mode | What Is Taken | Mediation Target |
|---|---|---|---|
| `src/provider-registry.ts` | ADAPT | Agent-side provider registry contract | `src/llm/provider-registry.ts` |
| `src/providers/claude-provider.ts` | ADAPT | Claude provider shape | `src/llm/providers/claude-provider.ts` |
| `src/providers/ollama-provider.ts` | ADAPT | Ollama provider shape | `src/llm/providers/ollama-provider.ts` |
| `src/providers/index.ts` | ADAPT | Provider bootstrap pattern | `src/llm/providers/index.ts` |
| `desktop/lib/provider-registry.js` | ADAPT | Desktop provider registry and validation hooks | `desktop/lib/provider-registry.ts` |
| `docs/complete/spec-12-v2-future-llm-provider-plugins.md` | REFERENCE_ONLY | Extended plugin roadmap guidance | `docs/reference/spec-12-provider-plugins.md` |

### 12.6 Desktop Security and Auth Reuse

| Source Path | Mode | What Is Taken | Mediation Target |
|---|---|---|---|
| `desktop/auth.js` | ADAPT | OAuth + token refresh handling in trusted process | `desktop/auth.ts` |
| `desktop/gateway-client.js` | ADAPT | REST/SSE client boundaries and retry behavior | `desktop/transport/gateway-client.ts` |
| `desktop/session-manager.js` | ADAPT | E2EE session state machine and conversation/session IDs | `desktop/transport/session-manager.ts` |
| `desktop/lib/credentials.js` | AS_IS | Secure credential storage pattern | `desktop/lib/credentials.ts` |
| `desktop/lib/trusted-origins.js` | AS_IS | origin allowlist enforcement | `desktop/lib/trusted-origins.ts` |
| `desktop/lib/validation.js` | ADAPT | shared validation helpers | `desktop/lib/validation.ts` |
| `desktop/lib/errors.js` | AS_IS | stable error shaping helper patterns | `desktop/lib/errors.ts` |
| `desktop/lib/orchestration-utils.js` | ADAPT | append audit + wait-for-session helper | `desktop/lib/orchestration-utils.ts` |
| `desktop/lib/audit-reader.js` | ADAPT | audit read/stream helpers | `desktop/lib/audit-reader.ts` |
| `desktop/lib/permission-profile-storage.js` | ADAPT | policy profile storage structure | `desktop/policy/profile-storage.ts` |

### 12.7 IPC and UI Contract Reuse

| Source Path | Mode | What Is Taken | Mediation Target |
|---|---|---|---|
| `desktop/ipc/channel-manifest.js` | ADAPT | strongly named IPC channel map pattern | `desktop/ipc/channel-manifest.ts` |
| `desktop/ipc/orchestration-ipc.js` | ADAPT | orchestration IPC handler style | `desktop/ipc/mediation-ipc.ts` |
| `desktop/ipc/room-ipc.js` | ADAPT | room runtime IPC boundary | `desktop/ipc/joint-room-ipc.ts` |
| `desktop/preload.cjs` | ADAPT | strict exposed API surface | `desktop/preload.ts` |
| `desktop/renderer/state.js` | REFERENCE_ONLY | event-driven frontend state updates | `desktop/renderer/state.ts` |
| `desktop/renderer/views/agent-chat.js` | REFERENCE_ONLY | orchestration controls UX behavior | `desktop/renderer/views/mediation-chat.ts` |
| `desktop/renderer/views/room-create.js` | REFERENCE_ONLY | room creation flow conventions | `desktop/renderer/views/joint-room-create.ts` |
| `desktop/renderer/views/room-dashboard.js` | REFERENCE_ONLY | dashboard/timeline rendering approach | `desktop/renderer/views/joint-room-dashboard.ts` |

### 12.8 Normative Specs and Standards Reuse

| Source Document | Mode | What Is Taken |
|---|---|---|
| `docs/README.md` | AS_IS (normative) | global security requirements and error contract style |
| `docs/complete/spec-03-multi-agent-runtime.md` | REFERENCE_ONLY | multi-agent runtime constraints |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS (normative) | agent-loop policy and stop controls |
| `docs/complete/spec-14-war-room-orchestrator.md` | REFERENCE_ONLY | orchestrator plugin lifecycle design |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS (normative) | plugin trust boundary and allowlist/integrity model |
| `docs/VISION.md` | REFERENCE_ONLY | desktop trust boundaries and architecture conventions |

### 12.9 Explicitly Not Reused

1. Existing app-specific business flows unrelated to mediation (share links UX, non-mediation dashboards).
2. Legacy naming tied to "agent hub" branding.
3. Any assumptions that one user owns all participants.

## 13. Target Repository Structure

```text
mediation/
  docs/
    FULL_SPEC.md
    reference/
  src/
    app/
    auth/
    audit/
    config/
    contracts/
    domain/
    llm/
    orchestration/
    policy/
    room/
    security/
    store/
    transport/
  desktop/
    ipc/
    renderer/
    runtime/
```

## 14. Joint Room Behavior Contract

### 14.1 Mediator Responsibilities

1. Summarize each party's interests before proposing options.
2. Keep language neutral and non-judgmental.
3. Maintain unresolved issue list until explicit closeout.
4. Emit structured final summary with action items.

### 14.2 Human Interaction Rules

1. Parties can pause autonomous mode at any time.
2. Parties can redact or retract previously shared snippets before final resolution.
3. Mediator must confirm each party acknowledges final terms.

## 15. Observability and Audit

### 15.1 Audit Event Minimum Fields

1. `event_id`
2. `ts`
3. `case_id`
4. `phase`
5. `actor_type`
6. `actor_id`
7. `event_type`
8. `message_id` (if applicable)
9. `policy_decision` (if applicable)
10. `error` (if applicable)

### 15.2 Metrics

1. time spent per phase
2. transitions by reason code
3. share-denial rate
4. resolution rate
5. average turns to resolution
6. manual override rate

## 16. Security Requirements

1. All gateway traffic encrypted in transit and E2EE where applicable.
2. Session keys are memory-only and rotated per session.
3. Private intake data is never forwarded without consent policy permit.
4. Logs redact secrets, tokens, and unapproved private content.
5. Plugin loading must enforce allowlist + optional integrity hashes.
6. Unknown plugin/version mismatch fails closed.

## 17. Testing Strategy

### 17.1 Unit Tests

1. phase transition guards
2. consent policy allow/deny/transform
3. summary and message validation
4. error code stability

### 17.2 Integration Tests

1. private intake to cross-dialogue happy path
2. denied share path
3. joint room open/resume/stop path
4. token budget and timeout handling
5. gateway disconnect recovery

### 17.3 Security Tests

1. replay attack rejection
2. correlation mismatch rejection
3. unauthorized share attempt rejection
4. renderer secret leakage checks
5. plugin tampering/integrity failure checks

## 18. Delivery Plan

### Phase 1: Foundation

1. Complete domain + policy + phase engine in service layer.
2. Add persistent storage abstraction and audit event schema.
3. Add API surface for all lifecycle commands.

### Phase 2: Transport and LLM Integration

1. Integrate local prompt bridge adapters per party.
2. Integrate gateway relay for cross-agent exchange.
3. Add mediator LLM adapter and joint room runtime.

### Phase 3: Desktop UX

1. Build case creation and intake views.
2. Build cross-agent transcript and policy decision feed.
3. Build joint room dashboard and resolution handoff.

### Phase 4: Hardening

1. Complete full test matrix and security checks.
2. Add plugin allowlist/integrity controls.
3. Add migration and backup strategy for persistent storage.

## 19. Open Questions

1. Should parties be allowed to approve content per-message in addition to tag-based policy?
2. Should mediator LLM be local-only, remote-only, or configurable per case?
3. Do we require both parties to sign final resolution text digitally?
4. What retention policy applies to private intake messages?

## 20. Immediate Implementation Notes for Current Scaffold

The current scaffold in `/Users/dtannen/Code/mediation/src` already covers:

1. core domain types
2. consent policy primitives
3. phase engine
4. in-memory store
5. baseline mediation service
6. demo execution path

Next direct coding target is transport adapter wiring with real local LLM and gateway sessions, using the reuse inventory above.
