# Mediation App Full Specification (v1)

Status: Draft v1
Date: 2026-02-25
Codebase: `/Users/dtannen/Code/mediation`
Source baseline for reuse: `/Users/dtannen/Code/commands-com-agent`

## 1. Product Goal

Build a standalone mediation app where a mediation is created with a topic and invite link, each participant does a fully private intake with their local LLM, each participant explicitly reaches `ready`, then both participants enter a shared group chat where the mediator LLM introduces both positions and guides the discussion.

## 2. Canonical User Flow

1. Create mediation case with topic.
2. System generates invite link.
3. Invitees join through link.
4. Each party has a fully private local-LLM intake thread.
5. Each party completes intake summary and marks themselves `ready`.
6. When all parties are `ready`, group chat opens.
7. Mediator LLM posts introductions with each party position.
8. Mediator LLM guides discussion and option exploration.
9. Case resolves or closes with terminal reason.

## 3. Non-Goals (v1)

1. Legal decisioning or legal representation.
2. Audio/video conferencing.
3. Automatic contract enforcement.
4. Multi-organization tenant admin.

## 4. Core Lifecycle Model

### 4.1 Phases

1. `awaiting_join`
2. `private_intake`
3. `group_chat`
4. `resolved`
5. `closed`

### 4.2 Transition Rules

1. `awaiting_join -> private_intake`: all invited parties must join.
2. `private_intake -> group_chat`: all parties are `ready` and each has resolved private summary.
3. `group_chat -> resolved`: mediator summary + accepted resolution path.
4. Any non-terminal phase -> `closed` with reason.
5. `resolved -> closed` allowed for archival closure.

### 4.3 Party Participation States

Per party:

1. `invited`
2. `joined`
3. `ready`

`ready` requires:

1. party joined via valid invite token
2. private intake summary present
3. private intake marked resolved

## 5. Functional Requirements

### 5.1 Case Creation + Invite

1. Case creation requires `topic` and at least 2 parties.
2. System generates invite token and invite URL.
3. Invite URL is shareable but token-validated.
4. Case starts in `awaiting_join`.

### 5.2 Private Intake (Fully Private)

1. Each party has separate private thread.
2. Private thread is never visible in group chat directly.
3. Party chooses local provider/model.
4. Thread concludes with party position summary.

### 5.3 Ready Gate

1. `ready` is explicit action per party.
2. Party cannot mark ready without completed private summary.
3. Group chat does not open until all parties are `ready`.

### 5.4 Group Chat + Mediator Guidance

On open:

1. Mediator LLM posts intro message with topic.
2. Mediator LLM introduces each party position from private summaries under consent rules.
3. Mediator LLM posts discussion guide and turn structure.

During chat:

1. Mediator keeps focus on goals, constraints, overlap, and options.
2. Mediator proposes options and checks acceptability.
3. Mediator tracks unresolved points and next steps.

### 5.5 Resolution

1. Resolution stores final agreement summary.
2. Mediator summary stored separately from final resolution text.
3. If unresolved, closure reason is required.

## 6. Data Model (Canonical)

## 6.1 Primary Entities

1. `MediationCase`
2. `Party`
3. `InviteLink`
4. `PartyParticipation`
5. `PrivateIntakeThread`
6. `GroupChatRoom`
7. `ThreadMessage`
8. `ConsentGrant`

### 6.2 Required `MediationCase` fields

1. `id`
2. `topic`
3. `description`
4. `phase`
5. `inviteLink`
6. `partyParticipationById`
7. `privateIntakeByPartyId`
8. `groupChat`
9. `createdAt`, `updatedAt`
10. optional `resolution`

## 7. Consent and Privacy Policy

### 7.1 Consent Grant

Per party:

1. `allowSummaryShare`
2. `allowDirectQuote`
3. `allowedTags`

### 7.2 Policy enforcement

1. If summary share disabled, party position is withheld from group intro.
2. If direct quote disabled, private summary is transformed/paraphrased.
3. Only allowed tags can be included in shared output.
4. Every allow/deny/transform decision is logged.

## 8. API Contract (Service Layer)

Required operations:

1. `createCase`
2. `getInviteLink`
3. `joinWithInvite`
4. `appendPrivateMessage`
5. `setPrivateSummary`
6. `setPartyReady`
7. `appendGroupMessage`
8. `setMediatorSummary`
9. `resolveCase`
10. `closeCase`
11. `getCase`
12. `listCases`

Error shape:

```json
{
  "code": "string",
  "message": "string",
  "recoverable": true
}
```

## 9. Security and Trust Invariants

Inherited as mandatory from source architecture patterns:

1. UI/renderer never receives long-lived auth tokens or private keys.
2. Auth, gateway IO, and crypto stay in trusted runtime/main process.
3. Invalid auth and untrusted origins fail closed.
4. Replay protection and correlation checks are enforced on transport.
5. Audit logs are append-only and redacted.
6. Policy violations block unsafe phase progression.

## 10. Observability and Audit

Minimum audit fields:

1. `event_id`
2. `ts`
3. `case_id`
4. `phase`
5. `actor_type`
6. `actor_id`
7. `event_type`
8. `policy_decision` (if applicable)
9. `error` (if applicable)

Core metrics:

1. time to all parties joined
2. time to all parties ready
3. group-chat duration
4. resolution rate
5. share-deny rate
6. manual override rate

## 11. Testing Requirements

1. invite token validation and join flow
2. private-only visibility constraints
3. ready gating behavior
4. mediator intro generation behavior
5. consent allow/deny/transform outputs
6. transition guard correctness
7. resolution/closure terminal behavior
8. transport correlation/replay protections

## 12. Full Reuse Inventory from `commands-com-agent`

Reuse modes:

1. `AS_IS`: carry directly with path/namespace updates.
2. `ADAPT`: keep behavior, reshape interfaces for mediation model.
3. `REFERENCE_ONLY`: design precedent, not direct code carry.

### 12.1 Runtime + Transport

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/crypto.ts` | ADAPT | E2EE frame crypto primitives and nonce discipline | `src/security/crypto.ts` |
| `src/handshake.ts` | ADAPT | session handshake and replay protections | `src/transport/handshake.ts` |
| `src/gateway.ts` | ADAPT | gateway protocol client structure | `src/transport/gateway-client.ts` |
| `src/oauth.ts` | ADAPT | OAuth lifecycle patterns | `src/auth/oauth.ts` |
| `src/config.ts` | ADAPT | env/config normalization pattern | `src/config/index.ts` |
| `src/audit.ts` | ADAPT | structured audit entry format | `src/audit/audit-service.ts` |
| `src/runtime.ts` | REFERENCE_ONLY | runtime loop and safety guard patterns | `src/runtime/mediation-runtime.ts` |
| `src/types.ts` | REFERENCE_ONLY | result/error contract conventions | `src/contracts/common.ts` |

### 12.2 Local Prompt Bridge + Orchestration

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/local-prompt-bridge.ts` | ADAPT | request/response framing and correlation | `src/llm/local-prompt-bridge.ts` |
| `desktop/agent-runtime/local-prompt-bridge.js` | ADAPT | desktop-local bridge mechanics | `desktop/runtime/local-prompt-bridge.ts` |
| `desktop/orchestration-manager.js` | ADAPT | orchestration state machine, limits, pause/resume/stop | `src/orchestration/mediation-orchestrator.ts` |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS | normative loop and stop-condition policy | `docs/reference/spec-05-agent-to-agent-shared.md` |

### 12.3 Room Runtime + Plugins

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `desktop/room/room-runtime.js` | ADAPT | generic room lifecycle and stop precedence | `src/room/group-chat-runtime.ts` |
| `desktop/room/plugin-registry.js` | ADAPT | plugin descriptor and loading model | `src/room/plugin-registry.ts` |
| `desktop/lib/room-contracts.js` | ADAPT | contract validation and limits parsing | `src/room/contracts.ts` |
| `desktop/room/review-cycle-plugin.js` | REFERENCE_ONLY | multi-agent plugin lifecycle style | `src/room/plugins/mediation-plugin.ts` |
| `desktop/room/war-room-plugin.js` | REFERENCE_ONLY | fan-out/coordination patterns | `src/room/plugins/mediation-plugin.ts` |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS | plugin trust boundary and allowlist/integrity requirements | `docs/reference/spec-16-room-external-plugins.md` |

### 12.4 Provider/Model Layer

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `src/provider-registry.ts` | ADAPT | provider registry interface | `src/llm/provider-registry.ts` |
| `src/providers/claude-provider.ts` | ADAPT | provider implementation template | `src/llm/providers/claude-provider.ts` |
| `src/providers/ollama-provider.ts` | ADAPT | provider implementation template | `src/llm/providers/ollama-provider.ts` |
| `src/providers/index.ts` | ADAPT | provider bootstrap pattern | `src/llm/providers/index.ts` |
| `desktop/lib/provider-registry.js` | ADAPT | desktop provider registration/validation | `desktop/lib/provider-registry.ts` |
| `docs/complete/spec-12-v2-future-llm-provider-plugins.md` | REFERENCE_ONLY | long-term provider-plugin roadmap | `docs/reference/spec-12-provider-plugins.md` |

### 12.5 Desktop Security/Auth/IPC

| Source Path | Mode | What To Reuse | Mediation Target |
|---|---|---|---|
| `desktop/auth.js` | ADAPT | secure OAuth handling in trusted process | `desktop/auth.ts` |
| `desktop/gateway-client.js` | ADAPT | REST/SSE gateway client boundaries | `desktop/transport/gateway-client.ts` |
| `desktop/session-manager.js` | ADAPT | session state machine + E2EE message lifecycle | `desktop/transport/session-manager.ts` |
| `desktop/lib/credentials.js` | AS_IS | secure credential persistence approach | `desktop/lib/credentials.ts` |
| `desktop/lib/trusted-origins.js` | AS_IS | trusted-origin enforcement | `desktop/lib/trusted-origins.ts` |
| `desktop/lib/orchestration-utils.js` | ADAPT | audit and readiness helper patterns | `desktop/lib/orchestration-utils.ts` |
| `desktop/lib/validation.js` | ADAPT | common validation helpers | `desktop/lib/validation.ts` |
| `desktop/lib/errors.js` | AS_IS | stable error shape helpers | `desktop/lib/errors.ts` |
| `desktop/ipc/channel-manifest.js` | ADAPT | IPC channel naming + registration model | `desktop/ipc/channel-manifest.ts` |
| `desktop/ipc/orchestration-ipc.js` | ADAPT | orchestration IPC boundary style | `desktop/ipc/mediation-ipc.ts` |
| `desktop/ipc/room-ipc.js` | ADAPT | room IPC boundary style | `desktop/ipc/group-chat-ipc.ts` |
| `desktop/preload.cjs` | ADAPT | strict preload API exposure discipline | `desktop/preload.ts` |

### 12.6 Normative Documents To Carry

| Source Doc | Mode | What To Reuse |
|---|---|---|
| `docs/README.md` | AS_IS | global security and error-contract invariants |
| `docs/complete/spec-05-agent-to-agent-shared.md` | AS_IS | loop safety and turn-control norms |
| `docs/complete/spec-16-room-external-plugins.md` | AS_IS | plugin trust boundary requirements |
| `docs/VISION.md` | REFERENCE_ONLY | architecture and process-boundary guidance |
| `docs/complete/spec-03-multi-agent-runtime.md` | REFERENCE_ONLY | runtime control conventions |
| `docs/complete/spec-14-war-room-orchestrator.md` | REFERENCE_ONLY | orchestrator plugin lifecycle ideas |

### 12.7 Explicitly Not Reused

1. share-link UX intended for generic agent sharing rather than mediation invites
2. agent-hub branding and unrelated UI flows
3. assumptions that one operator owns all participants

## 13. Target Repository Layout

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

## 14. Current Scaffold Alignment

Current scaffold now implements:

1. invite-link case creation
2. token-based join
3. private intake threads per party
4. explicit per-party ready gating
5. automatic group-chat open on all-ready
6. mediator intro + guidance messages at group start
7. resolve/close lifecycle

Primary next implementation targets:

1. persistent store backend
2. real gateway transport adapters
3. real local-LLM and mediator-LLM adapters
4. desktop/web UI around this lifecycle
