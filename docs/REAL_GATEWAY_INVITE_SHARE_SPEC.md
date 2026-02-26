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

## 6.6 Group chat and resolution

1. Group messages and draft actions use remote commands for collaborator.
2. Owner appends mediator/party messages in canonical case.
3. Owner broadcasts updates.
4. Either authorized party can request resolve/close (per policy).
5. Owner applies transition + resolution text.
6. Both machines render final resolved/closed states.

## 6.7 Access termination

- Owner revoke:
  - `POST /shares/grants/:grant_id/revoke`
  - collaborator commands are denied from that point onward.
- Collaborator leave:
  - `POST /shares/grants/:grant_id/leave`
  - collaborator loses access to owner shared device/cases.

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

Request:

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

Success response:

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

Error response:

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

Push event:

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

- `case.list`
- `case.get`
- `case.join`
- `case.append_private`
- `case.set_consent`
- `case.set_private_summary`
- `case.set_ready`
- `case.send_group`
- `case.create_draft`
- `case.append_draft`
- `case.run_draft_suggestion`
- `case.approve_draft`
- `case.reject_draft`
- `case.resolve`
- `case.close`

## 9.3 Idempotency

Mutating commands may include optional idempotency token:

```json
{
  "payload": {
    "idempotency_key": "idem_..."
  }
}
```

Owner caches completed command results for short TTL and returns same result on replay.

## 10. Authorization And Policy

## 10.1 Gateway role checks

Gateway enforces device-level access:

- owner and collaborator can session handshake/send/events.
- only owner can manage grants.

## 10.2 Mediation action checks on owner

Owner router enforces per-command rules:

- collaborator can only act on joined party assigned to that collaborator.
- collaborator cannot mutate owner's party state.
- phase constraints mirror `MediationService` domain rules.

## 10.3 Party binding

When collaborator joins a party slot, owner records binding:

```ts
casePartyBindings[caseId][partyId] = {
  actorUid,
  actorDeviceId,
  grantId,
  boundAt,
}
```

Subsequent commands for that party must match binding.

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

- queue command in memory as `pending`.
- auto retry after session ready.
- drop with explicit error after max retries.

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
- [ ] Remote mediation command router implemented.
- [ ] Party binding + authorization enforcement implemented.
- [ ] Remote case sync metadata persisted.
- [ ] Reconnect/version conflict handling implemented.
- [ ] Revoke/leave access cut-off enforced.
- [ ] Full two-machine acceptance script passes.
