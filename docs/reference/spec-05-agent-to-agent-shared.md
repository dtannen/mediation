# Spec 05 - Agent-to-Agent Communication via Shared Agents

Status: Complete
Priority: P1

Implementation Readiness: Complete (all blocking gates are green).

## Goal

Allow a user to run a local agent as an orchestrator inside an existing chat session with a shared remote agent.

This is a proxy mode on top of the current shared-chat transport:

- Desktop keeps using existing gateway + E2EE session flow.
- Local and remote agent turns are orchestrated by desktop main process.
- User can watch, pause, intervene, and redirect at any time.

## Canonical User Flow

1. User opens chat with a shared agent (existing flow).
2. User enables `Use my agent` and selects one local agent.
3. User enters objective prompt (example: `review this API for security issues`).
4. Desktop asks local agent for an outbound message draft.
5. Desktop sends local agent output through existing E2EE relay to remote shared agent.
6. Remote agent response is received through existing E2EE relay.
7. Desktop forwards remote response back to local agent as context.
8. Loop continues until stop condition or user action.

## Architecture

### Orchestrator Placement

Orchestration loop runs in desktop **main process**.

- Renderer provides user controls and displays state.
- Main process owns session state, gateway I/O, and orchestration state.
- Renderer never receives tokens, keys, or ciphertext.

### Transport

No new relay crypto protocol is required.

- Reuse `session-manager` for shared agent E2EE sessions.
- Reuse current gateway relay send/receive APIs.
- Add orchestration state machine on top.

### Local Agent Interface

Desktop invokes local agent through existing local process bridge/IPC, with explicit context envelope per turn.

## Local Agent Invocation Mechanism (Normative)

Define a concrete request/response channel between desktop main process and each running local agent process.

Transport:

- Per-profile local IPC prompt channel over stdio NDJSON on the running agent process.
- Main process writes request frames to agent stdin.
- Agent emits response frames on stdout tagged for desktop bridge.
- Renderer never talks to this channel directly.

Frame contract:

Request (`desktop.local_prompt.request`):

```json
{
  "type": "desktop.local_prompt.request",
  "request_id": "req_01...",
  "profile_id": "profile_...",
  "session_id": "sess_...",
  "turn_index": 3,
  "mode": "manual|semi_auto|full_auto",
  "objective": "review this API for security issues",
  "remote_message": "latest remote agent response",
  "history": [
    { "role": "local_agent", "text": "..." },
    { "role": "remote_agent", "text": "..." }
  ],
  "constraints": {
    "max_output_chars": 12000,
    "allow_tool_use": true,
    "max_history_turns": 6,
    "max_history_chars": 24000,
    "max_tool_rounds": 3,
    "local_turn_timeout_ms": 120000
  }
}
```

Response (`desktop.local_prompt.response`):

```json
{
  "type": "desktop.local_prompt.response",
  "request_id": "req_01...",
  "status": "ok|error",
  "draft_message": "next outbound message to remote agent",
  "reason": "",
  "metrics": { "latency_ms": 842 }
}
```

Channel rules:

- Exactly one in-flight local prompt request per profile.
- Request timeout default 60s when tool use is disabled; up to 120s when `allow_tool_use=true`.
- Local agent may perform multiple internal tool calls, but must emit exactly one terminal response frame per request.
- Responses with unknown `request_id` are ignored and logged as protocol violations.
- If channel is unavailable (agent restarting/crashed), orchestration transitions to `error` and requires user action.

Main-process API boundary:

- Add internal bridge module (`local-agent-bridge`) used by orchestration manager.
- Renderer gets high-level orchestration events only, never raw bridge control frames.

History bounding and summarization:

- Orchestrator must enforce both `max_history_turns` and `max_history_chars` before sending each local prompt request.
- If history exceeds bounds, oldest turns are summarized into a compact `history_summary` field and raw old turns are dropped.
- Keep the most recent remote message verbatim as `remote_message`.

## Orchestration Modes

Per session mode selected in UI:

- `manual`: local draft generated, user approves before send.
- `semi_auto`: auto-send unless confidence/risk rule triggers review.
- `full_auto`: auto-send all turns until stop condition.

Default: `manual`.

## Stop Conditions and Safety Limits

Mandatory hard limits:

- `maxTurns` (default 8)
- `maxDurationMs` (default 10 minutes)
- `maxFailures` (default 3 consecutive failures)
- `maxTokensBudget` (optional per run)

User controls:

- `Pause`
- `Resume`
- `Stop`
- `Take over` (switch to manual human typing)

## State Machine (Session Overlay)

`idle -> planning -> waiting_local -> ready_to_send -> waiting_remote -> processing_remote -> completed | paused | error | stopped`

Rules:

- Single in-flight turn at a time per orchestrated session.
- Transition to `error` on transport or local-agent hard failure.
- `Pause` is immediate and prevents new sends.

## Policy Controls

Per local profile settings:

- `allowSharedAgentCalls: boolean`
- `allowedSharedDeviceIds: string[]`
- `maxConcurrentSharedCalls` (default 3)
- `maxHopCount` (default 2)

Default is deny until enabled.

## Loop and Abuse Prevention

Each forwarded message includes orchestration metadata (in control envelope, not user-visible prose):

- `origin_agent_device_id`
- `trace_id`
- `hop_count`
- `orchestrator_profile_id`

Enforcement:

- Reject if `hop_count > maxHopCount`.
- Reject self-loop (`origin == target`).
- Rate-limit per `(profileId, targetDeviceId)`.

## UX Requirements

In shared chat view:

- `Use my agent` toggle.
- Local-agent selector dropdown.
- Objective prompt input.
- Mode selector (`manual`, `semi_auto`, `full_auto`).
- Turn timeline with avatars (`Local Agent`, `Remote Agent`, optional `You`).
- Sticky run controls (`Pause`, `Resume`, `Stop`, `Take over`).

Presentation:

- User objective pinned at top.
- Clear labels for auto-sent vs user-approved turns.
- Explicit banner when limits are hit.

## Observability and Audit

Audit entries include:

- `profileId`
- target `sharedDeviceId`
- requester identity context
- turn index
- mode
- timing/status/failure reason

Redaction remains unchanged: no plaintext secrets, no tokens, no keys.

## Dependencies and Priority

Hard dependencies:

- Spec 02 requester identity enrichment
- Spec 03 multi-agent runtime

Soft dependency:

- Spec 04 share links (helpful for discovery, not required for core orchestration)

Priority guidance:

- This feature can ship **before share links** if "Shared With Me" inventory already exists.

## Verification

1. Start orchestrated session from shared chat with selected local agent.
2. Confirm loop: local draft -> remote send -> remote response -> local follow-up.
3. Confirm manual mode requires approval before each send.
4. Confirm full-auto runs until max-turn stop condition.
5. Confirm pause/resume/stop work without breaking E2EE session integrity.
6. Confirm policy blocks disallowed target.
7. Confirm loop-prevention blocks recursive chains.
8. Confirm audit/log entries are profile-scoped and redacted.
9. Kill local agent mid-run -> channel timeout/error path is surfaced and loop halts safely.
10. Oversized history is truncated/summarized deterministically and stays within configured bounds.
11. Tool-enabled runs respect `max_tool_rounds` and timeout constraints.

## Implementation Readiness Gates (Blocking)

These are hard gates for build start, not optional backlog items.

### Gate A - Local Prompt Bridge Exists End-to-End (P1)

Required:

- Local agent runtime accepts `desktop.local_prompt.request` and emits `desktop.local_prompt.response`.
- Desktop main process can send request frames and correlate response frames by `request_id`.
- One in-flight local prompt per profile is enforced.
- Unknown/late `request_id` responses are dropped and logged.
- Bridge is main-process only; renderer never receives raw control frames.

Fail conditions:

- Agent process is launched without stdin/stdout framing support.
- Runtime has no request handler for desktop local-prompt frames.

### Gate B - Main-Process Orchestration State Machine Implemented (P1)

Required:

- Dedicated orchestration manager in desktop main process with explicit states:
  `idle -> planning -> waiting_local -> ready_to_send -> waiting_remote -> processing_remote -> completed | paused | error | stopped`.
- Single in-flight turn per orchestrated session.
- Deterministic transitions for pause/resume/stop and hard failures.
- Idempotent start/stop handling.

Fail conditions:

- Orchestration logic split across renderer callbacks or ad-hoc chat handlers.
- Duplicate transitions produce conflicting UI state.

### Gate C - Policy Schema Persisted and Enforced (P1)

Required profile fields:

- `allowSharedAgentCalls: boolean`
- `allowedSharedDeviceIds: string[]`
- `maxConcurrentSharedCalls: number`
- `maxHopCount: number`

Required behavior:

- Profile create/update validation in desktop main process.
- Deny-by-default when policy is missing or disabled.
- Enforcement on every orchestration start and forwarded hop.

Fail conditions:

- Policy flags only exist in UI and are not enforced in main process.
- Missing profile policy defaults to allow.

### Gate D - Shared Transport Metadata + Loop Controls (P1)

Required forwarded metadata path:

- `origin_agent_device_id`
- `trace_id`
- `hop_count`
- `orchestrator_profile_id`

Required enforcement:

- Reject self-loop (`origin == target`).
- Reject `hop_count > maxHopCount`.
- Apply per `(profileId, targetDeviceId)` rate limits.

Fail conditions:

- Outbound payload cannot carry metadata.
- Desktop orchestration/session transport cannot parse/enforce loop controls.

### Gate E - Deterministic Turn Timeout and Run Limits (P2)

Required:

- Local turn timeout is deterministic and mode-aware.
- Late local responses after timeout are ignored.
- `maxTurns`, `maxDurationMs`, `maxFailures`, and optional token budget are enforced in manager.
- Tool-enabled local turns enforce `max_tool_rounds`.

Fail conditions:

- Desktop times out but runtime continues and can mutate active turn state.
- Mode limits exist only in UI, not in manager logic.

### Gate F - UI Ownership and Control Surface (P2)

Required:

- Shared chat exposes orchestration controls:
  `Use my agent`, local-agent selector, objective input, mode selector, run controls.
- Manual chat send path is ownership-safe while orchestration is active.
- Timeline clearly distinguishes user-approved vs auto-sent turns.

Fail conditions:

- Manual send and orchestration send can run concurrently without arbitration.
- Renderer synthesizes state not backed by main-process events.

### Gate G - Audit and Error Contract Compliance (P2)

Required:

- Orchestration audit entries in main process include:
  profile, target device, turn index, mode, status, timings, failure reason.
- Redaction guarantees remain intact (no tokens, keys, ciphertext, or secrets in logs).
- User-facing errors follow cross-spec contract:
  `{ code: string, message: string, recoverable: boolean }`.
- Initial stable `code` values for renderer behavior are required:
  `policy_denied`, `local_prompt_timeout`, `loop_detected`, `hop_limit_exceeded`, `orchestration_busy`.

Fail conditions:

- Errors are unstructured/free-form strings.
- Audit stream is only runtime-level and cannot reconstruct orchestration runs.

### Gate H - Readiness Harness and Race Coverage (P2)

Required verification coverage before rollout:

- Duplicate start/stop idempotency.
- Start->stop and stop->start queue ordering.
- Agent restart mid-run.
- Late/stale `request_id` response handling.
- Transport failure during `waiting_remote`.
- Oversized history truncation/summarization determinism.

Fail conditions:

- No scripted smoke path for orchestrated flow.
- Race handling validated only manually.

## Build Sequence (Normative)

Implement in this order to avoid rework:

1. Runtime local prompt bridge.
2. Desktop local-agent bridge (correlation + timeouts).
3. Orchestration manager core state machine.
4. Orchestration IPC + renderer event surface.
5. Profile policy schema + validation + persistence.
6. Shared transport metadata + loop controls.
7. Bounded history/summarization enforcement.
8. Modes + run-limit enforcement.
9. UI controls + timeline ownership rules.
10. Audit path + error-contract normalization.
11. Race/idempotency hardening.
12. Readiness harness and scripted verification.

No partial rollout is considered ready until Gates A-D are complete.
