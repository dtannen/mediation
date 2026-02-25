# Mediation App (MVP Scaffold)

Standalone codebase for mediation with a hybrid model:

1. `awaiting_join` (create mediation topic and send invite link)
2. `private_intake` (each party discusses privately with their own coach LLM)
3. per-party `ready` gate (both parties must be ready)
4. `group_chat` with a neutral `mediator_llm`
5. each party can either:
   - send directly, or
   - use optional `coach draft -> approve -> send`
6. `resolved` / `closed`

## Status

This scaffold provides:
- Domain model for invites, party readiness, group drafts, and message delivery modes
- Consent policy enforcement for private-summary sharing
- Phase transition engine with join/ready guards
- In-memory store
- `MediationService` orchestration class
- Demo runner in `src/index.ts`
- Full specification in `/docs/FULL_SPEC.md`

## Quickstart

```bash
cd /Users/dtannen/Code/mediation
npm install
npm run demo
```

## Next Build Steps

- Replace in-memory store with SQLite/Postgres
- Wire real local coach adapters per party
- Wire neutral mediator adapter
- Add gateway transport adapters for shared group chat
- Build dedicated case/invite/private/group-chat UI
