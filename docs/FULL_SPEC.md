# Mediation App Full Specification (v1)

Status: Draft v1
Date: 2026-02-25
Codebase: `/Users/dtannen/Code/mediation`
Source baseline for reuse: `/Users/dtannen/Code/commands-com-agent`

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

1. legal advice or legal determination
2. audio/video conferencing
3. autonomous legal enforcement
4. enterprise tenant administration

## 4. Lifecycle Model

### 4.1 Phases

1. `awaiting_join`
2. `private_intake`
3. `group_chat`
4. `resolved`
5. `closed`

### 4.2 Transition Guards

1. `awaiting_join -> private_intake`: all invited parties joined.
2. `private_intake -> group_chat`: all parties are `ready` and have completed private summary.
3. `group_chat -> resolved`: resolution accepted and recorded.
4. any non-terminal phase -> `closed` with reason.

### 4.3 Participation States

Per party:

1. `invited`
2. `joined`
3. `ready`

`ready` requires valid join + resolved private summary.

## 5. Messaging Model

### 5.1 Message Types

1. `party`
2. `party_llm` (coach)
3. `mediator_llm`
4. `system`

### 5.2 Group Delivery Modes

1. `direct`
2. `coach_approved`
3. `system`

### 5.3 Coach-Draft Workflow (Optional)

1. Party can have a multi-turn private conversation with their coach before producing a final draft.
2. Conversation can include clarifying questions, reframing, tone adjustments, and negotiation strategy.
3. Coach provides a suggested final draft only when the party asks for one.
4. Party can continue iterating after seeing a suggested draft (returns to composing).
5. Only party-approved text is posted publicly.
6. Direct send remains available for every turn.

## 6. Functional Requirements

### 6.1 Case Creation and Invites

1. Case requires topic and 2+ parties.
2. Invite token + URL are generated.
3. Invite token is validated on join.
4. Case starts in `awaiting_join`.

### 6.2 Private Intake

1. Per-party private thread.
2. Thread includes full private context for that party's coach.
3. Intake concludes with private summary + resolved flag.
4. Private transcript is not auto-exposed to mediator or other party.

### 6.3 Group Open and Introductions

1. Group opens only when all parties ready.
2. Neutral mediator posts opening context.
3. Opening includes each coach summary under consent rules.
4. Mediator starts by asking explicit opening questions to both parties.

### 6.4 Group Discussion

1. Party can send direct at any turn.
2. Party can optionally use coach draft path.
3. Mediator keeps neutrality and process discipline through active questioning.
4. Mediator asks follow-up and clarifying questions to identify overlap, constraints, and option sets.

### 6.5 Resolution

1. Store mediator summary and final resolution text.
2. Capture unresolved closure reason when not resolved.
3. Keep full audit timeline.

## 7. Data Model

Primary entities:

1. `MediationCase`
2. `Party`
3. `InviteLink`
4. `PartyParticipation`
5. `PrivateIntakeThread`
6. `GroupChatRoom`
7. `GroupMessageDraft`
8. `ThreadMessage`
9. `ConsentGrant`

Critical fields in `GroupChatRoom`:

1. `introductionsSent`
2. `messages[]`
3. `draftsById`
4. `mediatorSummary`

## 8. Consent and Privacy Policy

Per party grant:

1. `allowSummaryShare`
2. `allowDirectQuote`
3. `allowedTags`

Rules:

1. if summary sharing disallowed, mediator gets no summary for that party
2. if direct quote disallowed, summary is transformed/paraphrased
3. only allowed tags are shareable
4. every allow/deny/transform event is logged

## 9. Service/API Contract

Required operations:

1. `createCase`
2. `getInviteLink`
3. `joinWithInvite`
4. `appendPrivateMessage`
5. `setPrivateSummary`
6. `setPartyReady`
7. `sendDirectGroupMessage`
8. `createCoachDraft`
9. `appendCoachDraftMessage`
10. `setCoachDraftSuggestion`
11. `approveCoachDraftAndSend`
12. `rejectCoachDraft`
13. `appendGroupMessage` (mediator/system/general path)
14. `setMediatorSummary`
15. `resolveCase`
16. `closeCase`
17. `getCase`
18. `listCases`

Error contract:

```json
{
  "code": "string",
  "message": "string",
  "recoverable": true
}
```

## 10. Security and Trust Invariants

Inherited mandatory controls:

1. renderer/UI never receives long-lived secrets or private keys
2. auth, gateway IO, and crypto stay in trusted runtime
3. untrusted origins fail closed
4. invalid auth fails closed
5. replay/correlation checks on transport are mandatory
6. logs are append-only and redacted
7. consent violations block unsafe sharing

## 11. Observability

Minimum audit fields:

1. `event_id`
2. `ts`
3. `case_id`
4. `phase`
5. `actor_type`
6. `actor_id`
7. `event_type`
8. `policy_decision` (if relevant)
9. `delivery_mode` (for group messages)
10. `error` (if relevant)

Core metrics:

1. time-to-join
2. time-to-ready
3. group-chat duration
4. direct-vs-coach-approved ratio
5. share-deny rate
6. resolution rate

## 12. Testing Requirements

1. invite token join validation
2. private-only visibility isolation
3. all-ready gate behavior
4. mediator opening sequence behavior
5. optional coach-draft approve/reject/send behavior
6. direct send path behavior
7. consent allow/deny/transform behavior
8. transition guard enforcement
9. resolve/close terminal behavior
10. transport replay/correlation enforcement

## 13. Full Reuse Inventory from `commands-com-agent`

Reuse modes:

1. `AS_IS`
2. `ADAPT`
3. `REFERENCE_ONLY`

### 13.1 Runtime + Transport

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

### 13.2 Local Prompt Bridge + Orchestration

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/local-prompt-bridge.ts` | ADAPT | request/response framing + correlation | `src/llm/local-prompt-bridge.ts` |
| `desktop/agent-runtime/local-prompt-bridge.js` | ADAPT | desktop-local bridge behavior | `desktop/runtime/local-prompt-bridge.ts` |
| `desktop/orchestration-manager.js` | ADAPT | orchestration states, limits, pause/resume/stop | `src/orchestration/mediation-orchestrator.ts` |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS | normative loop safety/stop policy | `docs/reference/spec-05-agent-to-agent-shared.md` |

### 13.3 Room Runtime + Plugins

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `desktop/room/room-runtime.js` | ADAPT | room lifecycle + stop precedence | `src/room/group-chat-runtime.ts` |
| `desktop/room/plugin-registry.js` | ADAPT | plugin registry contract | `src/room/plugin-registry.ts` |
| `desktop/lib/room-contracts.js` | ADAPT | room validation contracts | `src/room/contracts.ts` |
| `desktop/room/review-cycle-plugin.js` | REFERENCE_ONLY | plugin lifecycle style | `src/room/plugins/mediation-plugin.ts` |
| `desktop/room/war-room-plugin.js` | REFERENCE_ONLY | coordination/fan-out patterns | `src/room/plugins/mediation-plugin.ts` |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS | plugin trust boundary rules | `docs/reference/spec-16-room-external-plugins.md` |

### 13.4 Provider Layer

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/provider-registry.ts` | ADAPT | provider registry contract | `src/llm/provider-registry.ts` |
| `src/providers/claude-provider.ts` | ADAPT | provider template | `src/llm/providers/claude-provider.ts` |
| `src/providers/ollama-provider.ts` | ADAPT | provider template | `src/llm/providers/ollama-provider.ts` |
| `src/providers/index.ts` | ADAPT | provider bootstrap | `src/llm/providers/index.ts` |
| `desktop/lib/provider-registry.js` | ADAPT | desktop provider config/validation | `desktop/lib/provider-registry.ts` |

### 13.5 Desktop Security/Auth/IPC

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
| `desktop/ipc/channel-manifest.js` | ADAPT | channel naming/registration model | `desktop/ipc/channel-manifest.ts` |
| `desktop/ipc/orchestration-ipc.js` | ADAPT | orchestration IPC boundary style | `desktop/ipc/mediation-ipc.ts` |
| `desktop/ipc/room-ipc.js` | ADAPT | room IPC boundary style | `desktop/ipc/group-chat-ipc.ts` |
| `desktop/preload.cjs` | ADAPT | strict preload API discipline | `desktop/preload.ts` |

### 13.6 Normative Source Docs

| Source Doc | Mode | What To Reuse |
|---|---|---|
| `docs/README.md` | AS_IS | security and error invariants |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS | loop control/safety norms |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS | plugin trust boundary |
| `docs/VISION.md` | REFERENCE_ONLY | process-boundary architecture guidance |
| `docs/complete/spec-03-multi-agent-runtime.md` | REFERENCE_ONLY | runtime conventions |
| `docs/complete/spec-14-war-room-orchestrator.md` | REFERENCE_ONLY | orchestrator lifecycle patterns |

### 13.7 Explicitly Not Reused

1. non-mediation share-link UX from generic agent hub
2. unrelated dashboard/business flows
3. single-owner assumptions across all participants

## 14. Target Repository Layout

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

## 15. Current Scaffold Alignment

Current scaffold in `/Users/dtannen/Code/mediation/src` now supports:

1. invite-based join and all-joined gate
2. private intake per party with ready gate
3. neutral mediator opening messages from approved coach summaries
4. optional coach draft flow with explicit approve/reject
5. always-available direct send path
6. mediator facilitation + resolution lifecycle
