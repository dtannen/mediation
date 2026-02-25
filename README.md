# Mediation App

Standalone codebase for mediation with a hybrid model:

1. `awaiting_join` (create mediation topic and send invite link)
2. `private_intake` (each party discusses privately with their own coach LLM)
3. per-party `ready` gate (both parties must be ready)
4. `group_chat` with a neutral `mediator_llm`
5. each party can either:
   - send directly, or
   - use optional `private coach conversation -> final draft -> approve -> send`
6. `resolved` / `closed`

## Status

Implemented:
- Domain model for invites, party readiness, group drafts, and message delivery modes
- Consent policy enforcement for private-summary sharing
- Phase transition engine with join/ready guards
- In-memory store
- `MediationService` orchestration class
- Transport/security stack (`crypto`, handshake, trusted gateway client)
- Local prompt bridge, provider interfaces/registry, built-in provider adapters
- Room/plugin runtime scaffold with manifest validation + external plugin allowlist/integrity checks
- Desktop-layer infrastructure scaffold (`desktop/auth`, transport/session manager, IPC channels, preload API, credentials/trusted-origin/utils)
- Reference specs copied into `docs/reference/`
- Automated test suite for domain, consent, and transport invariants

## Quickstart

```bash
cd /Users/dtannen/Code/mediation
npm install
npm run demo
```

## Verification (current repo)

Available scripts:

- `npm run build` — compile TypeScript to `dist/`
- `npm run build:desktop` — compile Electron/desktop TypeScript to `dist-desktop/`
- `npm run typecheck` — type-check without emitting build artifacts
- `npm run typecheck:desktop` — strict type-check for desktop code
- `npm run demo` — build and run console demo workflow
- `npm test` — build + run automated tests (`src/tests/*`)

To run the Electron app:

```bash
cd /Users/dtannen/Code/mediation
npm run start:desktop
```

## Next Build Steps

- Replace in-memory store with SQLite/Postgres
- Harden desktop/Electron wiring and renderer UX around current IPC/runtime contracts
- Add integration/e2e tests against real gateway/session paths
- Add durable encrypted case persistence and retention controls
