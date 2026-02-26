# Real Gateway Invite/Share + Full Two-Machine Mediation Flow Spec

Status: Proposed
Date: 2026-02-26
Target App: `mediation` desktop (Electron)

## 1. Objective

Deliver a complete mediation cycle between two different machines using real gateway invite/share and encrypted gateway messaging.

This replaces local-only invite/join as the primary cross-machine path and defines the missing system behavior needed for full end-to-end mediation.

## 2. Definition Of Done

A complete flow is considered done when the following works between Machine A (owner) and Machine B (invitee/collaborator):

1. Machine A signs in, has a stable mediation device, creates a case, and sends a real gateway invite link.
2. Machine B opens the link, signs in if needed, accepts gateway share, and sees A's mediation device as shared.
3. Machine B joins the specific case from UI.
4. Both parties can complete private intake and mark ready.
5. Group mediation starts automatically once both are ready.
6. Parties can send group messages, run draft coaching, approve/reject, and continue turns.
7. A resolution can be created and case can be closed.
8. Case appears in "Your Cases" across app restarts on both machines.
9. Revoke/leave immediately stops further case actions for removed collaborator.

## 3. Verified Existing Infrastructure

The following already exists and should be reused, not rebuilt:

- OAuth login + refresh token lifecycle in mediation desktop auth service.
- Auto mediation device registration via `PUT /gateway/v1/devices/:device_id/identity-key`.
- Device reuse behavior on same UID + gateway.
- Agent runtime bootstrapping on sign-in.
- Gateway E2EE session handshake/message/event transport.
- Local mediation domain service (`MediationService`) and file-backed store.
- Gateway share APIs in gateway backend:
  - `POST /gateway/v1/shares/invites`
  - `POST /gateway/v1/shares/invites/accept`
  - `GET /gateway/v1/shares/devices/:device_id/grants`
  - `POST /gateway/v1/shares/grants/:grant_id/revoke`
  - `POST /gateway/v1/shares/grants/:grant_id/leave`
- Gateway authz supports collaborator for session handshake/send/events.

## 4. Main Gaps To Close

The current main gaps for full two-machine mediation are:

1. Mediation desktop lacks full share IPC client surface (`create/consume/list/revoke/leave`).
2. UI still relies on local invite token flow (`caseId + token`) as primary join.
3. No formal owner-device mediation command protocol for remote case actions.
4. No robust case state sync model for collaborator machines.
5. No explicit permission matrix for party-level remote actions.

Invite/share is necessary, but full cycle requires all five gaps to be closed.

## 5. Target Architecture

## 5.1 Authority

- Owner device is authoritative for shared case state.
- Collaborator device keeps a synced local shadow copy for fast UI rendering.
- Collaborator writes are remote commands to owner device.
- Owner validates every command with role + party + phase checks before mutating case state.

## 5.2 Data ownership model

- Case created locally on owner machine.
- Shared case projected to collaborator after invite acceptance and case join.
- Both machines persist local copies, but owner is canonical source.
- Collaborator copy is updated only by owner responses/events.

## 5.3 Transport

- Reuse existing gateway encrypted session pipeline.
- Mediation traffic uses structured JSON command/event envelopes inside session messages.
- Correlation IDs are required for request/response matching.

## 6. Full Product Flow

## 6.1 Start and device bootstrap

1. User clicks `Start`.
2. OAuth flow completes.
3. App ensures mediation device registration.
4. If same UID + gateway and prior device exists, reuse same device ID.
5. Runtime auto-starts.
6. Dashboard loads with runtime-ready status.

## 6.2 Owner creates case and invite

1. Owner creates case from dashboard.
2. Owner auto-joins their party.
3. UI shows case in `Your Cases` immediately.
4. Owner chooses `Invite by Email`.
5. App calls `gateway.share.create` IPC -> `POST /gateway/v1/shares/invites`.
6. UI receives `inviteUrl` and displays copy/share modal.

## 6.3 Invitee accepts share link

1. Invitee opens `https://<frontend>/share/<token>`.
2. App parses token.
3. If signed out:
   - store token as pending share token.
   - prompt Start/OAuth.
4. After sign-in, app auto-consumes token.
5. `POST /gateway/v1/shares/invites/accept` returns active grant + owner device ID.
6. UI updates shared devices inventory.

## 6.4 Invitee joins case

1. Invitee opens shared owner device in mediation UI.
2. App ensures ready session to owner device.
3. App sends `case.list` to fetch joinable cases.
4. Invitee selects case + party slot.
5. App sends `case.join` command.
6. Owner applies `join` mutation and returns updated case snapshot.
7. Invitee stores synced case and enters intake view.

## 6.5 Private intake and ready

1. Each party uses intake UI.
2. On collaborator device, intake mutations are sent to owner via remote commands:
   - append private message
   - set consent
   - set private summary
   - set ready
3. Owner validates and persists.
4. Owner emits case-updated events to both parties.
5. Once both parties are `ready`, owner transitions case to `group_chat`.

## 6.6 Group chat, coaching, and resolution

1. Group messages and draft actions use remote commands for collaborator (see command schemas in Section 9.2).
2. Owner appends mediator/party messages in canonical case.
3. Owner broadcasts projected case updates to all bound parties (Section 9.4).
4. Collaborator draft coaching follows one of two paths (Section 9.5):
   - **Owner-side coaching:** Collaborator sends `case.run_draft_suggestion`, owner runs LLM and returns suggestion.
   - **Collaborator-side coaching:** Collaborator runs local LLM and sends result via `case.submit_suggestion`.
5. Owner (acting as mediator) can resolve the case via `case.resolve` and close via `case.close` (Section 10.6 for authorization policy). In v1, only the owner can invoke these transitions.
6. Both machines render final resolved/closed states.

## 6.7 Access termination

Access termination must provide immediate, deterministic cutoff. The following defines the full end-to-end sequence for both revoke and leave paths.

### 6.7.1 Owner revoke sequence

When owner revokes a collaborator's grant:

**Step 1: Gateway invalidation**
1. Owner calls `POST /shares/grants/:grant_id/revoke`.
2. Gateway marks grant as `revoked`. All future session handshakes and messages from this grant are rejected at the gateway layer.

**Step 2: Active session teardown**
3. Gateway sends a `grant.revoked` transport event to the collaborator's device if a session is active.
4. Gateway terminates the active session for this grant. No further messages are delivered in either direction.

**Step 3: Owner-side cleanup**
5. Owner router marks all party bindings for this `grantId` as `revoked`.
6. Owner removes the grant from `grantCaseAccess` (Section 10.5).
7. Any pending/in-flight commands from this grant that arrive after revocation are rejected with `grant_revoked`.
8. Owner does NOT delete case data — the case continues with the party slot marked as `disconnected` for record-keeping.

**Step 4: Owner event fanout**
9. Owner emits `mediation.event` with `event: "party.disconnected"` to remaining bound parties:
```json
{
  "type": "mediation.event",
  "schema_version": 1,
  "event": "party.disconnected",
  "case_id": "case_abc",
  "party_id": "party_b",
  "reason": "grant_revoked",
  "remote_version": 55
}
```

**Step 5: Collaborator-side handling**
10. Collaborator receives `grant.revoked` transport event (or detects session termination).
11. Collaborator emits `access.revoked` event to renderer.
12. Renderer shows "Access revoked" notification and disables all case actions.
13. Collaborator marks all synced cases from this grant as `access_revoked` in local store.
14. Collaborator does NOT auto-delete local case data (user may need to review). Local copies are marked read-only with a `revoked` badge.

### 6.7.2 Collaborator leave sequence

When collaborator voluntarily leaves:

**Step 1: Gateway leave**
1. Collaborator calls `POST /shares/grants/:grant_id/leave`.
2. Gateway marks grant as `left`. Session is terminated.

**Step 2: Collaborator-side cleanup**
3. Collaborator marks all synced cases from this grant as `left` in local store.
4. Collaborator emits `access.left` event to renderer.
5. Renderer shows "You left this shared device" confirmation and transitions to dashboard.
6. Synced case entries are tombstoned (retained with `left` status for UX, hidden from active case list).

**Step 3: Owner-side handling**
7. Owner receives `grant.left` transport event from gateway (or detects session termination).
8. Owner router marks party bindings for this `grantId` as `left`.
9. Owner removes the grant from `grantCaseAccess`.
10. Owner emits `party.disconnected` event to remaining bound parties with `reason: "collaborator_left"`.

### 6.7.3 Pending command cancellation

When a session terminates (revoke or leave):
1. Collaborator's command queue (Section 12.3) is flushed. All pending commands receive local `grant_revoked` or `session_terminated` errors.
2. No retries are attempted for commands in the queue.
3. UI callbacks for pending commands are resolved with the termination error.

### 6.7.4 Required renderer events

| Event | Trigger | UI behavior |
|---|---|---|
| `access.revoked` | Grant revoked by owner | Show "Access revoked" banner, disable all actions, mark cases read-only |
| `access.left` | Collaborator left voluntarily | Show confirmation, return to dashboard, tombstone cases |
| `party.disconnected` | Other party's grant revoked/left | Show "Other party disconnected" indicator on case view |
| `case.removed` | Case removed from grant visibility | Remove case from active list, show notification |

### 6.7.5 Local store cleanup

| Scenario | Local store behavior |
|---|---|
| Grant revoked | Mark cases `status: 'access_revoked'`, retain for 30 days, then auto-purge |
| Collaborator left | Mark cases `status: 'left'`, retain for 30 days, then auto-purge |
| Owner removes case visibility | Mark specific case `status: 'removed'`, purge immediately |

## 7. UX Requirements

UI behavior must satisfy the existing `docs/UI_UX_SPEC.md` structure, with these gateway-specific updates.

## 7.1 Dashboard

Required actions:

- `+ New Mediation`
- `Join from Invite Link` (supports both mediation links and gateway share links)
- `Invite by Email` on owned case
- `Your Cases` shows:
  - owned local cases
  - shared remote cases

Case cards show source badge:

- `Owned` for owner-local
- `Shared` for remote collaborator copies

## 7.2 Invite UI

Owner invite modal fields:

- Invitee email (required)
- Optional TTL/expiry controls (advanced)

Actions:

- `Create Invite Link`
- `Copy Link`
- `View Grants`

## 7.3 Accept/share deep-link UX

When app launches with share link:

1. Resolve token.
2. If signed out, store pending token and show Start.
3. After auth, auto-consume and show success/failure.
4. Navigate to case discovery/join flow for that shared device.

## 7.4 Case-level status UX

Case view always shows:

- current phase
- participant states
- own role (`owner` / `collaborator`)
- sync freshness indicator (`live` / `stale` / `reconnecting`)

## 8. Data Model Changes

## 8.1 Case metadata

Add sync metadata for persisted cases:

```ts
interface CaseSyncMetadata {
  source: 'owner_local' | 'shared_remote';
  ownerDeviceId?: string;
  grantId?: string;
  accessRole?: 'owner' | 'collaborator';
  localPartyId?: string;
  remoteVersion?: number;
  syncUpdatedAt?: string;
}
```

`MediationCase` can be wrapped or extended with metadata in storage layer.

## 8.2 Versioning

Owner includes monotonically increasing `remoteVersion` in every remote case response/event.
Collaborator ignores stale updates where `incoming.remoteVersion <= current.remoteVersion`.

## 8.3 Local store durability

Persist both:

- canonical owner cases
- remote synced cases with metadata

Survive restart without requiring immediate refetch to render list.

## 9. Remote Mediation Protocol

All remote mediation calls run over existing encrypted session messages.

## 9.1 Envelope

### 9.1.1 Request envelope schema

Every request uses this envelope. `case_id` and `party_id` are **top-level envelope fields** (never duplicated inside `payload`). Their presence is required or omitted per the command matrix below.

```json
{
  "type": "mediation.command",
  "schema_version": 1,
  "request_id": "req_123",
  "command": "case.join",
  "case_id": "case_abc",
  "party_id": "party_b",
  "payload": {}
}
```

| Envelope field | Type | Description |
|---|---|---|
| `type` | `"mediation.command"` | Always required. Discriminator. |
| `schema_version` | `1` | Always required. Protocol version. |
| `request_id` | string | Always required. Unique per request for correlation. |
| `command` | string | Always required. Command name from Section 9.2. |
| `case_id` | string | Required per command matrix (see below). Identifies the target case. |
| `party_id` | string | Required per command matrix (see below). Identifies the acting party. |
| `payload` | object | Always required. Command-specific fields (may be `{}`). |

### 9.1.2 Envelope field requirements per command

`party_id` is the **canonical location** for identifying the acting party. It MUST NOT appear inside `payload`. Owner router resolves the acting party from the envelope `party_id` and validates it against the auth context binding (Section 10.2).

| Command | `case_id` | `party_id` | Notes |
|---|---|---|---|
| `case.list` | omit | omit | Lists all visible cases; no target case or party. |
| `case.get` | **required** | omit | Read-only fetch; party resolved from auth context binding. |
| `case.join` | **required** | **required** | `party_id` is the slot to join. |
| `case.append_private` | **required** | **required** | |
| `case.set_consent` | **required** | **required** | |
| `case.set_private_summary` | **required** | **required** | |
| `case.set_ready` | **required** | **required** | |
| `case.send_group` | **required** | **required** | |
| `case.create_draft` | **required** | **required** | |
| `case.append_draft` | **required** | **required** | |
| `case.run_draft_suggestion` | **required** | **required** | |
| `case.submit_suggestion` | **required** | **required** | |
| `case.approve_draft` | **required** | **required** | |
| `case.reject_draft` | **required** | **required** | |
| `case.resolve` | **required** | **required** | |
| `case.close` | **required** | **required** | |

**Validation rules:**
- If a command requires `case_id` and it is missing, owner returns `missing_case_id` error.
- If a command requires `party_id` and it is missing, owner returns `missing_party_id` error.
- If `case_id` or `party_id` appears on a command where it should be omitted, owner MUST ignore the extraneous field (do not reject).
- `party_id` MUST NOT appear inside `payload`. If it does, owner MUST return `invalid_payload` error.

### 9.1.3 Success response envelope

```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_123",
  "ok": true,
  "case": {},
  "remote_version": 42
}
```

### 9.1.4 Error response envelope

```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_123",
  "ok": false,
  "error": {
    "code": "invalid_phase",
    "message": "group operations are only allowed during group_chat phase",
    "recoverable": true
  }
}
```

### 9.1.5 Push event envelope

```json
{
  "type": "mediation.event",
  "schema_version": 1,
  "event": "case.updated",
  "case_id": "case_abc",
  "case": {},
  "remote_version": 43
}
```

## 9.2 Command catalog (required v1)

Each command below defines its request payload, success response, error codes, side effects, and validation rules. All commands use the envelope from Section 9.1. The `payload` field carries command-specific fields only (never `case_id` or `party_id`, which live at envelope level). All responses include `case` (projected per Section 9.4) and `remote_version` unless otherwise noted.

### 9.2.0 Canonical phase constants

All phase references in this spec use the following authoritative enum. Implementations MUST use these exact string values for phase checks, transitions, and serialization:

| Phase | Description |
|---|---|
| `awaiting_join` | Case created, waiting for all parties to join |
| `private_intake` | All parties joined; each party in private intake with coach |
| `group_chat` | All parties ready; group mediation in progress |
| `resolved` | Resolution text set; case resolved |
| `closed` | Case finalized; no further mutations allowed |

Allowed transitions (see `phase-engine.ts`):

```
awaiting_join → private_intake, closed
private_intake → group_chat, closed
group_chat → resolved, closed
resolved → closed
closed → (none)
```

### 9.2.1 `case.list`

List cases the collaborator is eligible to join or has already joined on this owner device.

**Request payload:**
```json
{
  "payload": {}
}
```
No payload fields. `case_id` and `party_id` are both omitted from the envelope (see Section 9.1.2). Owner filters cases based on the requester's grant and case-level visibility (see Section 10.5).

**Success response:**
```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_001",
  "ok": true,
  "cases": [
    {
      "case_id": "case_abc",
      "title": "Noise Dispute",
      "phase": "private_intake",
      "created_at": "2026-02-25T10:00:00Z",
      "parties": [
        { "party_id": "party_a", "label": "Party A", "joined": true, "is_self": false },
        { "party_id": "party_b", "label": "Party B", "joined": false, "is_self": false }
      ],
      "role": "available"
    }
  ]
}
```
Note: `case.list` does not return `remote_version` or full case body. The `role` field is `"available"` (not yet joined), `"joined"` (already a party), or `"observer"` (if supported later).

**Error codes:** `unauthorized`, `grant_revoked`, `session_error`

**Side effects:** None (read-only).

**Validation:** Requester must have an active grant to this owner device.

---

### 9.2.2 `case.get`

Fetch the full projected case snapshot for a case the collaborator has joined.

**Request payload:**
```json
{
  "payload": {}
}
```
`case_id` is at envelope level. `party_id` is omitted (owner resolves the requester's party from auth context binding per Section 10.2).

**Success response:**
```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_002",
  "ok": true,
  "case": { "...projected case per Section 9.4..." },
  "remote_version": 42
}
```

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `grant_revoked`

**Side effects:** None (read-only).

**Validation:** Requester must be bound to a party in this case (resolved from auth context, see Sections 10.2 and 10.4). Case must be visible per Section 10.5.

---

### 9.2.3 `case.join`

Join an open party slot in a case. The target party is identified by `party_id` at envelope level (Section 9.1.2). This is a mutating command and requires `idempotency_key` per Section 9.3.

**Request payload:**
```json
{
  "payload": {
    "idempotency_key": "idem_join_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `idempotency_key` | string | yes | Dedup key (see Section 9.3) |

`case_id` and `party_id` (the slot to join) are at envelope level per Section 9.1.2.

**Success response:**
```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_003",
  "ok": true,
  "case": { "...projected case..." },
  "remote_version": 43
}
```

**Error codes:** `unauthorized`, `case_not_found`, `party_already_bound`, `party_not_found`, `case_not_visible`, `grant_revoked`

**Side effects:**
- Creates party binding (Section 10.4).
- Adds case to grant's allowed case list (Section 10.5).
- Owner emits `case.updated` event to all bound parties.

**Idempotency behavior:** If a `case.join` is replayed with the same `idempotency_key` and the original join succeeded, owner returns the cached success result with `replayed: true` (not `party_already_bound`). This ensures deterministic retry behavior during disconnect/reconnect.

**Validation:**
- Party slot must not already be bound to another actor (unless this is an idempotent replay of the same join by the same actor).
- Case must be in `awaiting_join` or `private_intake` phase.
- Case must be visible to the requester's grant (Section 10.5).

---

### 9.2.4 `case.append_private`

Append a message to the collaborator's private intake thread.

**Request payload:**
```json
{
  "payload": {
    "message": {
      "role": "user",
      "content": "I want to describe my side of the situation..."
    },
    "idempotency_key": "idem_ap_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `message.role` | `"user"` | yes | Must be `"user"` for party messages |
| `message.content` | string | yes | Message text (max 10000 chars) |
| `idempotency_key` | string | yes | Dedup key (see Section 9.3) |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `message_too_long`, `grant_revoked`

**Side effects:**
- Appends message to the party's private intake thread.
- Owner emits `case.updated` event to the acting party only (private data).

**Validation:**
- Case must be in `private_intake` phase.
- Actor must be bound to `party_id` in envelope.
- `message.content` must be non-empty and within size limit.

---

### 9.2.5 `case.set_consent`

Set or update the collaborator's consent grant for their party. The consent model uses granular fields matching the mediation domain's `ConsentGrant` structure (see `src/domain/types.ts`).

**Request payload:**
```json
{
  "payload": {
    "consent": {
      "allowSummaryShare": true,
      "allowDirectQuote": false,
      "allowedTags": ["feelings", "needs"]
    },
    "idempotency_key": "idem_sc_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `consent` | object | yes | Full consent grant object |
| `consent.allowSummaryShare` | boolean | yes | Whether party's private intake summary may be shared with other parties during group chat |
| `consent.allowDirectQuote` | boolean | yes | Whether shared summaries may use direct quotes (`true`) or must be paraphrased (`false`) |
| `consent.allowedTags` | string[] | yes | Content tags the party allows to be shared. Empty array `[]` means all tags allowed. |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `invalid_consent_fields`, `grant_revoked`

**Side effects:**
- Updates the party's full consent grant (`ConsentGrant`) in the case's `consent.byPartyId` map.
- Owner emits `case.updated` event to the acting party.

**Validation:**
- Case must be in `private_intake` phase.
- Actor must be bound to `party_id`.
- All three consent fields must be present and correctly typed.
- `allowedTags` entries must be non-empty strings if provided.

---

### 9.2.6 `case.set_private_summary`

Set or update the AI-generated private intake summary for the collaborator's party.

**Request payload:**
```json
{
  "payload": {
    "summary": "Party B describes a recurring noise issue from upstairs neighbor...",
    "idempotency_key": "idem_sps_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `summary` | string | yes | Private intake summary text (max 5000 chars) |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `summary_too_long`, `grant_revoked`

**Side effects:**
- Updates the party's private intake summary field.
- Owner emits `case.updated` event to the acting party only.

**Validation:**
- Case must be in `private_intake` phase.
- Actor must be bound to `party_id`.
- Summary must be non-empty and within size limit.

---

### 9.2.7 `case.set_ready`

Mark the collaborator's party as ready for group mediation.

**Request payload:**
```json
{
  "payload": {
    "ready": true,
    "idempotency_key": "idem_sr_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ready` | boolean | yes | Ready state (`true` to mark ready) |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `consent_required`, `grant_revoked`

**Side effects:**
- Sets party ready state.
- If all parties are now ready, owner auto-transitions case to `group_chat` phase.
- Owner emits `case.updated` event to all bound parties (phase transition is visible to all).

**Validation:**
- Case must be in `private_intake` phase.
- Party must have a valid consent grant set (all `ConsentGrant` fields present) before marking ready.
- Actor must be bound to `party_id`.

---

### 9.2.8 `case.send_group`

Send a group chat message during mediation.

**Request payload:**
```json
{
  "payload": {
    "message": {
      "role": "user",
      "content": "I'd like to propose we set quiet hours after 10pm."
    },
    "idempotency_key": "idem_sg_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `message.role` | `"user"` | yes | Must be `"user"` for party messages |
| `message.content` | string | yes | Message text (max 10000 chars) |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `message_too_long`, `grant_revoked`

**Side effects:**
- Appends message to group thread with party attribution.
- Owner emits `case.updated` event to all bound parties.

**Validation:**
- Case must be in `group_chat` phase.
- Actor must be bound to `party_id`.

---

### 9.2.9 `case.create_draft`

Create a new draft message for coaching/review before sending to group.

**Request payload:**
```json
{
  "payload": {
    "content": "I feel frustrated when noise continues late at night.",
    "idempotency_key": "idem_cd_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | Initial draft text (max 10000 chars) |
| `idempotency_key` | string | yes | Dedup key |

**Success response:**
```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_009",
  "ok": true,
  "case": { "...projected case..." },
  "draft_id": "draft_xyz",
  "remote_version": 50
}
```

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `draft_already_active`, `grant_revoked`

**Side effects:**
- Creates a new draft object associated with the party.
- Owner emits `case.updated` event to the acting party.

**Validation:**
- Case must be in `group_chat` phase.
- Party must not have another active (non-finalized) draft.
- Actor must be bound to `party_id`.

---

### 9.2.10 `case.append_draft`

Append or replace content in an existing draft.

**Request payload:**
```json
{
  "payload": {
    "draft_id": "draft_xyz",
    "content": "I feel frustrated when noise continues late at night. Could we discuss quiet hours?",
    "idempotency_key": "idem_ad_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `draft_id` | string | yes | Target draft ID |
| `content` | string | yes | Updated draft text |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `draft_not_found`, `draft_finalized`, `grant_revoked`

**Side effects:**
- Updates draft content.
- Owner emits `case.updated` event to the acting party.

**Validation:**
- Draft must exist, belong to this party, and not be finalized (approved/rejected).
- Case must be in `group_chat` phase.

---

### 9.2.11 `case.run_draft_suggestion`

Request the owner's AI mediator to generate a coaching suggestion for the collaborator's current draft.

**Request payload:**
```json
{
  "payload": {
    "draft_id": "draft_xyz",
    "idempotency_key": "idem_rds_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `draft_id` | string | yes | Draft to generate suggestion for |
| `idempotency_key` | string | yes | Dedup key |

**Success response:**
```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_011",
  "ok": true,
  "case": { "...projected case..." },
  "suggestion": {
    "suggestion_id": "sug_001",
    "original_content": "I feel frustrated when noise continues late at night.",
    "suggested_content": "I feel frustrated when noise continues late at night. I'd appreciate if we could discuss setting quiet hours that work for both of us.",
    "rationale": "Added a collaborative framing to invite joint problem-solving."
  },
  "remote_version": 51
}
```

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `draft_not_found`, `draft_finalized`, `suggestion_in_progress`, `llm_error`, `grant_revoked`

**Side effects:**
- Owner runs LLM inference locally to generate suggestion (see Section 9.5 for coaching execution model).
- Suggestion is attached to the draft.
- Owner emits `case.updated` event to the acting party.

**Validation:**
- Draft must exist, belong to this party, and not be finalized.
- No other suggestion generation may be in-flight for this draft.
- Case must be in `group_chat` phase.

---

### 9.2.12 `case.approve_draft`

Approve a draft (with or without suggestion), promoting it to a group message.

**Request payload:**
```json
{
  "payload": {
    "draft_id": "draft_xyz",
    "use_suggestion": true,
    "idempotency_key": "idem_apd_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `draft_id` | string | yes | Draft to approve |
| `use_suggestion` | boolean | no | If `true`, use the suggested content instead of original (default: `false`) |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `draft_not_found`, `draft_finalized`, `no_suggestion_available`, `grant_revoked`

**Side effects:**
- Finalizes draft as approved.
- Appends final content (original or suggested) as a group message with party attribution.
- Owner emits `case.updated` event to all bound parties (new group message).

**Validation:**
- Draft must exist, belong to this party, and not be finalized.
- If `use_suggestion: true`, a suggestion must exist on the draft.
- Case must be in `group_chat` phase.

---

### 9.2.13 `case.reject_draft`

Reject/discard a draft without sending it to group.

**Request payload:**
```json
{
  "payload": {
    "draft_id": "draft_xyz",
    "idempotency_key": "idem_rjd_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `draft_id` | string | yes | Draft to reject |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `draft_not_found`, `draft_finalized`, `grant_revoked`

**Side effects:**
- Finalizes draft as rejected. No group message is created.
- Owner emits `case.updated` event to the acting party.

**Validation:**
- Draft must exist, belong to this party, and not be finalized.
- Case must be in `group_chat` phase.

---

### 9.2.14 `case.submit_suggestion`

Submit a collaborator-generated coaching suggestion to the owner for application to a draft. This allows the collaborator to run local AI inference and send the result to the owner for storage.

**Request payload:**
```json
{
  "payload": {
    "draft_id": "draft_xyz",
    "suggested_content": "I feel frustrated when noise continues late at night. I'd appreciate if we could discuss setting quiet hours that work for both of us.",
    "rationale": "Added a collaborative framing to invite joint problem-solving.",
    "idempotency_key": "idem_ss_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `draft_id` | string | yes | Draft to attach suggestion to |
| `suggested_content` | string | yes | The suggested replacement text |
| `rationale` | string | no | Explanation of the suggestion |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `draft_not_found`, `draft_finalized`, `grant_revoked`

**Side effects:**
- Attaches collaborator-generated suggestion to the draft on owner.
- Owner emits `case.updated` event to the acting party.

**Validation:**
- Draft must exist, belong to this party, and not be finalized.
- Case must be in `group_chat` phase.

---

### 9.2.15 `case.resolve`

Propose or confirm a resolution for the case.

**Request payload:**
```json
{
  "payload": {
    "resolution_text": "Both parties agree to quiet hours from 10pm-8am and a 2-week check-in.",
    "idempotency_key": "idem_res_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `resolution_text` | string | yes | Resolution summary (max 10000 chars) |
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `not_authorized_to_resolve`, `grant_revoked`

**Side effects:**
- Sets resolution text and transitions case to `resolved` phase.
- Owner emits `case.updated` event to all bound parties.

**Validation:**
- Case must be in `group_chat` phase.
- See Section 10.6 for resolve/close authorization policy.

---

### 9.2.16 `case.close`

Close a resolved case. No further mutations are allowed after close.

**Request payload:**
```json
{
  "payload": {
    "idempotency_key": "idem_cls_001"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `idempotency_key` | string | yes | Dedup key |

**Success response:** Standard result with projected case + `remote_version`.

**Error codes:** `unauthorized`, `case_not_found`, `not_joined`, `invalid_phase`, `not_authorized_to_close`, `grant_revoked`

**Side effects:**
- Transitions case to `closed` phase. All further mutating commands are rejected.
- Owner emits `case.updated` event to all bound parties.

**Validation:**
- Case must be in `resolved` phase.
- See Section 10.6 for resolve/close authorization policy.

---

### 9.2.17 Global error codes

The following error codes apply across all commands:

| Code | Description | Recoverable |
|---|---|---|
| `unauthorized` | Requester has no valid grant or session | no |
| `grant_revoked` | The share grant has been revoked | no |
| `case_not_found` | Case ID does not exist on owner | no |
| `case_not_visible` | Case exists but is not visible to this grant | no |
| `not_joined` | Requester has not joined this case | no |
| `invalid_phase` | Command not allowed in current case phase | yes (wait for phase change) |
| `party_not_found` | Party ID does not exist in this case | no |
| `party_already_bound` | Party slot is already taken | no |
| `consent_required` | Party must consent before this action | yes |
| `message_too_long` | Message exceeds max length | yes (shorten content) |
| `summary_too_long` | Summary exceeds max length | yes (shorten content) |
| `draft_not_found` | Draft ID does not exist | no |
| `draft_finalized` | Draft is already approved or rejected | no |
| `draft_already_active` | Party already has an active draft | yes (finalize existing) |
| `suggestion_in_progress` | An LLM suggestion is already running for this draft | yes (wait) |
| `no_suggestion_available` | No suggestion exists for `use_suggestion: true` | yes |
| `llm_error` | AI inference failed | yes (retry) |
| `not_authorized_to_resolve` | Actor lacks permission to resolve | no |
| `not_authorized_to_close` | Actor lacks permission to close | no |
| `session_error` | Transport/session-level failure | yes (reconnect) |
| `idempotency_conflict` | Same key used with different payload | no |
| `missing_case_id` | Required `case_id` missing from envelope | no |
| `missing_party_id` | Required `party_id` missing from envelope | no |
| `invalid_payload` | Payload contains disallowed fields (e.g., `party_id` inside payload) | no |
| `invalid_consent_fields` | Consent grant object is malformed or missing required fields | yes (fix fields) |

## 9.3 Idempotency

All mutating commands MUST include a required `idempotency_key` field in their payload. This includes `case.join` and all subsequent mutation commands (`case.append_private`, `case.set_consent`, `case.set_ready`, `case.send_group`, `case.create_draft`, etc.). Read-only commands (`case.list`, `case.get`) do not require idempotency keys.

**Note on `case.join` idempotency:** Join is particularly important to handle idempotently because disconnect during the join handshake can leave the collaborator unsure whether the join succeeded. On replay, if the original join succeeded, owner MUST return the cached success result (not `party_already_bound`). This ensures the collaborator can safely retry join without special-case error handling.

```json
{
  "payload": {
    "idempotency_key": "idem_..."
  }
}
```

**Owner-side deduplication requirements:**

1. Owner maintains an idempotency store keyed by `(grantId, idempotency_key)`.
2. Minimum TTL for cached results: **15 minutes** from first completion.
3. For each cached entry, owner stores a **request fingerprint** derived from the full envelope + payload — not payload alone. The fingerprint covers: `command`, `case_id` (if present), `party_id` (if present), and a canonical hash of `payload` (excluding `idempotency_key` itself). This is necessary because `case_id`, `party_id`, and `command` are envelope-level fields (Section 9.1) and commands with minimal payloads (e.g., `case.join`, `case.close`) would otherwise be indistinguishable.
4. If a command arrives with a previously-seen `idempotency_key` from the same grant:
   - If the request fingerprint matches the original, return the cached result (same `ok`, `case`, `remote_version`).
   - If the request fingerprint differs (different `command`, `case_id`, `party_id`, or `payload`), return error code `idempotency_conflict`.
5. Expired keys are treated as new requests.
6. The idempotency store MUST survive owner process restart (persist to disk or reconstruct from command log).

**Request fingerprint construction:**

```ts
function requestFingerprint(envelope: MediationCommand): string {
  return canonicalHash({
    command: envelope.command,
    case_id: envelope.case_id ?? null,
    party_id: envelope.party_id ?? null,
    payload: omit(envelope.payload, 'idempotency_key'),
  });
}
```

The `idempotency_key` is excluded from the fingerprint because it is the lookup key, not part of the semantic request identity.

**Collaborator-side requirements:**

1. Generate a unique `idempotency_key` (e.g., `idem_<uuid>`) for every new logical mutation.
2. Reuse the same key when retrying a failed/timed-out command (Section 12.3).
3. Never reuse a key for a semantically different operation.

**Replay response behavior:**

When owner returns a cached idempotent response, it MUST set a `replayed: true` field in the result envelope so the collaborator can distinguish replayed results from fresh mutations:

```json
{
  "type": "mediation.result",
  "schema_version": 1,
  "request_id": "req_retry",
  "ok": true,
  "replayed": true,
  "case": { "..." },
  "remote_version": 42
}
```

## 9.4 Case Projection and Redaction Rules

All case data returned in `mediation.result` and `mediation.event` payloads MUST be projected through a `projectCaseForActor(case, actorPartyId, actorRole)` function before transmission. This prevents leaking private intake data between parties.

### 9.4.1 Projection contract

The projected case object includes the following fields, with visibility rules per recipient:

| Field | Owner sees | Collaborator sees | Notes |
|---|---|---|---|
| `case_id` | full | full | |
| `title` | full | full | |
| `phase` | full | full | |
| `created_at` | full | full | |
| `parties[].party_id` | full | full | |
| `parties[].label` | full | full | |
| `parties[].joined` | full | full | |
| `parties[].consent` | full | own party only | Full `ConsentGrant` object; other party's consent is `null` |
| `parties[].consent.allowSummaryShare` | full | own party only | Part of consent grant |
| `parties[].consent.allowDirectQuote` | full | own party only | Part of consent grant |
| `parties[].consent.allowedTags` | full | own party only | Part of consent grant |
| `parties[].ready` | full | full | Needed to show waiting state |
| `parties[].has_consent` | full | full | Boolean: whether the party has set any consent (non-private indicator) |
| `parties[].private_thread` | full | own party only | **REDACTED** for other party |
| `parties[].private_summary` | full | own party only | **REDACTED** for other party |
| `parties[].drafts` | full | own party only | **REDACTED** for other party |
| `group_thread` | full | full | All group messages visible to both |
| `resolution` | full | full | |
| `mediator_notes` | full | omitted | Internal mediator data |

### 9.4.2 Redaction behavior

- **REDACTED** fields are replaced with `null` in the projected output (not omitted from the schema, to allow clients to distinguish "empty" from "hidden").
- Owner (local machine) always sees the full unredacted case since the owner is the mediator/authority.
- Collaborator only sees:
  - Their own party's full consent grant (`ConsentGrant` object with `allowSummaryShare`, `allowDirectQuote`, `allowedTags`).
  - The other party's `has_consent` boolean (whether they've set consent), but NOT the specific consent field values.
  - Their own party's private thread, summary, and drafts.
  - The other party's `party_id`, `label`, `joined`, and `ready` status (needed for UI indicators).
  - The full group thread (shared by design).
  - Resolution text (shared once resolved).

### 9.4.3 Projection in events

Push events (`mediation.event` with `event: "case.updated"`) MUST also project the case for the specific recipient. If an event is triggered by a private action (e.g., `case.append_private`), the event is only sent to the acting party. If the action affects shared state (e.g., `case.send_group`, `case.set_ready` triggering phase change), the event is sent to all bound parties, each receiving their own projected view.

### 9.4.4 Example: projected case for collaborator (Party B)

```json
{
  "case_id": "case_abc",
  "title": "Noise Dispute",
  "phase": "private_intake",
  "created_at": "2026-02-25T10:00:00Z",
  "parties": [
    {
      "party_id": "party_a",
      "label": "Party A",
      "joined": true,
      "consent": null,
      "has_consent": true,
      "ready": false,
      "private_thread": null,
      "private_summary": null,
      "drafts": null
    },
    {
      "party_id": "party_b",
      "label": "Party B",
      "joined": true,
      "consent": {
        "allowSummaryShare": true,
        "allowDirectQuote": false,
        "allowedTags": ["feelings", "needs"]
      },
      "has_consent": true,
      "ready": false,
      "private_thread": [
        { "role": "user", "content": "My upstairs neighbor plays loud music..." },
        { "role": "assistant", "content": "Thank you for sharing. Can you tell me more about..." }
      ],
      "private_summary": null,
      "drafts": []
    }
  ],
  "group_thread": [],
  "resolution": null
}
```

Note: Party A's `consent` is `null` (redacted — collaborator B cannot see A's specific consent settings), but `has_consent: true` tells the UI that A has set their consent preferences.

## 9.5 Collaborator Coaching Execution Model

Draft coaching (AI-assisted message improvement) can execute in two modes. The spec supports both to allow flexibility based on collaborator device capabilities.

### 9.5.1 Owner-side coaching (primary path)

1. Collaborator sends `case.run_draft_suggestion` command to owner.
2. Owner runs LLM inference locally using its agent runtime, with access to the full case context.
3. Owner stores the generated suggestion on the draft and returns it in the response.
4. Collaborator receives the suggestion and renders it in the draft review UI.

This is the default path because the owner has full case context and a running agent runtime.

### 9.5.2 Collaborator-side coaching (alternative path)

1. Collaborator runs LLM inference locally on their own machine using their own agent runtime.
2. Collaborator has access only to their own projected case view (redacted per Section 9.4).
3. Collaborator sends the resulting suggestion to owner via `case.submit_suggestion` command.
4. Owner stores the suggestion on the draft and confirms.
5. Collaborator can then approve/reject the draft with or without the suggestion.

This path is used when:
- Collaborator has local AI capabilities and prefers local inference.
- Owner's LLM inference is slow or unavailable.
- Privacy preference: collaborator does not want draft text sent to owner before they approve.

### 9.5.3 Coaching command flow summary

```
Collaborator                          Owner
    |                                   |
    |-- case.create_draft ------------->|  (create draft)
    |<------------ result + draft_id ---|
    |                                   |
    | Option A: Owner-side coaching     |
    |-- case.run_draft_suggestion ----->|  (owner runs LLM)
    |<------------ result + suggestion -|
    |                                   |
    | Option B: Collaborator-side       |
    |   [local LLM inference]           |
    |-- case.submit_suggestion -------->|  (send result to owner)
    |<------------ result --------------|
    |                                   |
    |-- case.approve_draft ------------>|  (approve with/without suggestion)
    |<------------ result --------------|
```

## 10. Authorization And Policy

## 10.1 Gateway role checks

Gateway enforces device-level access:

- owner and collaborator can session handshake/send/events.
- only owner can manage grants.

## 10.2 Trusted Actor Identity From Transport Context

The owner router MUST derive actor identity from the gateway/session transport layer, NOT from fields inside the `mediation.command` payload. This prevents a collaborator from spoofing another actor's identity.

### 10.2.1 Auth context contract

When the gateway delivers a session message to the owner, it MUST attach an authenticated context object derived from the session handshake and grant validation:

```ts
interface GatewayAuthContext {
  /** UID of the authenticated requester (from OAuth/session) */
  requesterUid: string;
  /** Device ID of the requester's device */
  requesterDeviceId: string;
  /** Grant ID that authorized this session (from gateway share) */
  grantId: string;
  /** Role derived from grant: 'owner' | 'collaborator' */
  role: 'owner' | 'collaborator';
  /** Grant status at time of message delivery */
  grantStatus: 'active' | 'revoked';
}
```

### 10.2.2 Router identity resolution

1. Owner router receives `(authContext, mediationCommand)` tuple.
2. Router uses `authContext.requesterUid`, `authContext.requesterDeviceId`, and `authContext.grantId` as the trusted actor identity.
3. Router MUST ignore any `actor_uid`, `actor_device_id`, or `grant_id` fields inside the `mediation.command` payload. These fields are not part of the command schema and MUST be rejected if present.
4. For party resolution, router looks up `casePartyBindings[caseId]` to find the party bound to `(authContext.requesterUid, authContext.grantId)` and verifies it matches the `party_id` in the command envelope.

### 10.2.3 Identity validation sequence

```
Gateway Session Layer                Owner Router
    |                                    |
    |-- session message + authContext -->|
    |                                    |-- extract authContext
    |                                    |-- parse mediation.command
    |                                    |-- verify grantStatus == 'active'
    |                                    |-- lookup party binding by (uid, grantId)
    |                                    |-- verify party_id matches binding
    |                                    |-- dispatch to MediationService
    |                                    |
```

## 10.3 Mediation action checks on owner

Owner router enforces per-command rules:

- collaborator can only act on joined party assigned to that collaborator (verified via auth context, not payload claims).
- collaborator cannot mutate owner's party state.
- phase constraints mirror `MediationService` domain rules.
- all identity assertions come from `GatewayAuthContext` (Section 10.2).

## 10.4 Party binding

When collaborator joins a party slot, owner records binding:

```ts
casePartyBindings[caseId][partyId] = {
  actorUid,       // from authContext.requesterUid
  actorDeviceId,  // from authContext.requesterDeviceId
  grantId,        // from authContext.grantId
  boundAt,        // ISO timestamp
}
```

Subsequent commands for that party must match binding identity from auth context.

## 10.5 Case-Level Visibility and Grant-to-Case Binding

Gateway shares are device-scoped (a grant gives access to communicate with an owner device), but mediation requires case-level access control. Without it, a collaborator with a valid device grant could see or interact with unrelated cases on the same owner device.

### 10.5.1 Grant-to-case binding model

Owner maintains a case visibility map per grant:

```ts
interface GrantCaseAccess {
  /** Cases this grant is allowed to see/interact with */
  allowedCaseIds: Set<string>;
  /** Default policy for new cases */
  defaultPolicy: 'deny';
}

// Storage
grantCaseAccess: Map<grantId, GrantCaseAccess>
```

### 10.5.2 Access rules

| Action | Visibility requirement |
|---|---|
| `case.list` | Returns only cases in `allowedCaseIds` for this grant |
| `case.get` | Case must be in `allowedCaseIds` |
| `case.join` | Case must be in `allowedCaseIds` (added by owner invite flow) |
| All other commands | Case must be in `allowedCaseIds` AND actor must be bound to a party |

### 10.5.3 How cases become visible to a grant

Cases are added to a grant's `allowedCaseIds` through these paths:

1. **Owner invite flow:** When owner creates a gateway share invite for a specific case, the owner records `(grantId, caseId)` in the visibility map upon invite creation or acceptance.
2. **Explicit case.join:** When `case.join` succeeds, the case is confirmed in `allowedCaseIds`.
3. **Owner manual grant:** Owner UI can explicitly add/remove case visibility for a grant.

### 10.5.4 Default deny

- New grants start with an empty `allowedCaseIds` set.
- `defaultPolicy` is always `'deny'` — a collaborator cannot discover or access any case unless explicitly granted.
- `case.list` for a grant with no allowed cases returns an empty list.

### 10.5.5 Revocation cascade

When a case is removed from `allowedCaseIds`:
- Future commands for that case return `case_not_visible`.
- Owner emits a `case.removed` event to the collaborator (see Section 6.7).
- Collaborator should tombstone or remove the local synced copy.

## 10.6 Resolve/Close Authorization Policy

The spec defines explicit authorization rules for case resolution and closure. These are the v1 defaults; future versions may support configurable policies.

### 10.6.1 Policy matrix

| Command | Who can invoke | Required phase | Required preconditions |
|---|---|---|---|
| `case.resolve` | Owner only | `group_chat` | At least 1 group message exists |
| `case.close` | Owner only | `resolved` | Resolution text is set |

### 10.6.2 Rationale

- **Owner-only resolve/close** is the v1 default because the owner acts as mediator and authority. The owner has full case context and is responsible for ensuring resolution is fair.
- Collaborators can *request* resolution by sending a group message proposing terms, but only the owner can formally transition the case state.

### 10.6.3 Future extension: collaborative resolve

A future version may support collaborative resolve where:
- Either party proposes resolution via `case.propose_resolve`.
- Other party confirms via `case.confirm_resolve`.
- Owner auto-transitions once both parties confirm.

This is a non-goal for v1 but the command schema is designed to allow it.

### 10.6.4 Error behavior

- If a collaborator sends `case.resolve`, owner returns `not_authorized_to_resolve` with `recoverable: false`.
- If a collaborator sends `case.close`, owner returns `not_authorized_to_close` with `recoverable: false`.
- If owner attempts `case.resolve` in wrong phase, returns `invalid_phase`.
- If owner attempts `case.close` without resolution, returns `invalid_phase`.

## 11. Error Handling

Normalize all gateway and remote errors to:

```ts
interface NormalizedError {
  code: string;
  message: string;
  recoverable: boolean;
  status?: number;
  details?: Record<string, unknown>;
}
```

Required handling categories:

- Auth: unauthorized, expired token, requires sign-in.
- Share: invalid token, expired invite, email mismatch, already accepted.
- Session: no ready session, handshake timeout, stream disconnect.
- Domain: invalid phase/transition, party not joined, draft errors.
- Sync: stale version, conflict, missing case.

UI should surface actionable recovery text and keep draft input where possible.

## 12. Offline, Restart, And Reconnect

## 12.1 Collaborator reconnect

On startup:

1. Load local synced cases.
2. Fetch shared devices.
3. Re-establish device event stream.
4. For selected active case, call `case.get` to reconcile remoteVersion.

## 12.2 Owner restart

On owner restart:

- Runtime starts automatically.
- Existing case state from file store is loaded.
- Collaborator commands resume once session is re-established.

## 12.3 Temporary disconnect

If send fails with retryable session error:

1. Queue command in memory as `pending`, preserving its original `idempotency_key`.
2. Auto-retry after session is re-established, using the **same** `idempotency_key` as the original attempt.
3. Owner-side deduplication (Section 9.3) ensures that if the original command was actually received and processed, the retry returns the cached result with `replayed: true`.
4. Max retry attempts: **3** (configurable). After max retries, drop with explicit `session_error` to the UI.
5. If the grant has been revoked/left during disconnect, flush all pending commands with `grant_revoked` / `session_terminated` error (Section 6.7.3).

**Queue ordering:** Commands are retried in FIFO order. If a command fails with a non-retryable error, it is removed from the queue and subsequent commands continue.

## 13. Required Code Changes By Layer

## 13.1 Desktop transport

File: `desktop/transport/gateway-client.ts`

Add methods:

- `createShareInvite(gatewayUrl, payload)`
- `consumeShareInvite(gatewayUrl, token)`
- `listShareGrants(gatewayUrl, deviceId)`
- `revokeShareGrant(gatewayUrl, grantId)`
- `leaveShareGrant(gatewayUrl, grantId)`

## 13.2 IPC channels

File: `desktop/ipc/channel-manifest.ts`

Add channels:

- `desktop:gateway:share-consume`
- `desktop:gateway:share-create`
- `desktop:gateway:share-list-grants`
- `desktop:gateway:share-revoke`
- `desktop:gateway:share-leave`
- `desktop:gateway-share-event` (outbound)

## 13.3 Gateway IPC handlers

File: `desktop/ipc/gateway-ipc.ts`

Add handlers and validation logic matching commands-com-agent patterns:

- parse share links + raw tokens
- requires-auth pending token behavior
- emit share events on success/error

## 13.4 Preload API

File: `desktop/preload.ts`

Expose share methods under `window.mediationDesktop.gateway`.

## 13.5 Main process remote mediation router

File: `desktop/main.ts` (or dedicated module)

Add:

- inbound command parser
- party/phase/role authorization checks
- command dispatch to `MediationService`
- case update event fanout
- correlation ID response handling

## 13.6 Renderer

File: `desktop/renderer/app.js`

Update flows:

- owner invite by email using gateway share create
- share-link accept path
- case discovery/join from shared device
- synced remote case rendering
- stale/live sync indicators

## 13.7 Store

File: `src/store/file-backed-store.ts` and related types

Add sync metadata persistence and version checks.

## 14. Rollout Plan

Phase 1: Share primitives in mediation desktop

- transport + IPC + preload for share endpoints
- deep-link token consume with auth resume

Phase 2: UI invite/share migration

- owner invite by email
- invitee consume flow
- shared device discovery

Phase 3: Remote case command protocol

- owner router + command catalog
- collaborator case join and mutations
- event sync + remoteVersion

Phase 4: Full cycle hardening

- reconnect/offline queue behavior
- revoke/leave enforcement in live sessions
- race/idempotency handling

Phase 5: local invite deprecation

- remove local cross-machine token as default
- keep optional local-only mode behind feature flag if needed

## 15. Test Plan

## 15.1 Unit

- share link parser
- IPC payload validation
- remote command envelope validation
- party binding authorization checks
- version conflict resolution

## 15.2 Integration

- create invite -> accept -> shared device listed
- collaborator join -> intake -> ready -> group chat
- draft create/suggest/approve/reject across machines
- resolve/close case replication
- revoke/leave mid-session behavior

## 15.3 End-to-end acceptance script

Machine A:

1. Start and sign in.
2. Create case.
3. Create gateway invite for B's email.

Machine B:

1. Open share link.
2. Start/sign in.
3. Accept invite and join case.

Both:

1. Complete intake and mark ready.
2. Exchange group messages.
3. Approve at least one drafted message.
4. Resolve and close.
5. Restart both apps and verify case status persists and matches.

## 16. Observability And Debugging

Emit structured events in main process logs:

- `share.create.success|error`
- `share.consume.success|error|requires_auth`
- `mediation.command.received`
- `mediation.command.applied`
- `mediation.command.denied`
- `mediation.case.synced`
- `mediation.sync.conflict`

Include fields:

- `request_id`
- `case_id`
- `device_id`
- `grant_id`
- `party_id`
- `remote_version`
- `error.code`

## 17. Security And Privacy Notes

- This spec is owner-authoritative for shared case state.
- Private intake visibility is scoped to mediation app roles, not cryptographically hidden from owner device storage.
- If stronger privacy is required later, add per-party encrypted intake blobs where owner stores ciphertext only.

## 18. Non-Goals For This Milestone

- Multi-owner concurrent canonical writes.
- Federation across multiple gateway origins.
- Automated outbound email delivery from mediation app itself.
- Cryptographic private-intake secrecy from owner device.

## 19. Implementation Checklist

- [ ] Share methods added to mediation gateway client.
- [ ] Share IPC channels + handlers + events added.
- [ ] Preload exposes share APIs.
- [ ] Share deep-link consume flow implemented.
- [ ] Owner invite-by-email UI implemented.
- [ ] Remote mediation command router implemented with all v1 command schemas (Section 9.2).
- [ ] `GatewayAuthContext` injected from transport layer; router ignores payload identity claims (Section 10.2).
- [ ] Party binding + authorization enforcement implemented.
- [ ] Grant-to-case visibility model (`grantCaseAccess`) implemented with default-deny (Section 10.5).
- [ ] `projectCaseForActor` redaction function implemented per Section 9.4.
- [ ] Resolve/close authorization policy enforced (owner-only in v1, Section 10.6).
- [ ] Collaborator coaching paths implemented: owner-side `run_draft_suggestion` and collaborator-side `submit_suggestion` (Section 9.5).
- [ ] Required `idempotency_key` for all mutating commands; owner-side dedupe store with 15-min TTL (Section 9.3).
- [ ] Remote case sync metadata persisted.
- [ ] Reconnect/version conflict handling with idempotent retry (Section 12.3).
- [ ] Full revoke/leave sequence: gateway invalidation, session teardown, event fanout, store cleanup (Section 6.7).
- [ ] Renderer events for `access.revoked`, `access.left`, `party.disconnected`, `case.removed` (Section 6.7.4).
- [ ] Full two-machine acceptance script passes.
