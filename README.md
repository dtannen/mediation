# Mediation App (MVP Scaffold)

Standalone codebase for mediation with this lifecycle:

1. `awaiting_join` (create mediation topic and send invite link)
2. `private_intake` (each party discusses privately with their local LLM)
3. per-party `ready` gate (both parties must be ready)
4. `group_chat` (mediator LLM introduces both positions and guides discussion)
5. `resolved` / `closed`

## Status

This scaffold provides:
- Domain model for mediation lifecycle, invites, and party readiness
- Consent policy enforcement for sharing private intake summaries
- Phase transition engine with ready/join guards
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
- Wire local LLM adapters per party
- Add gateway transport adapters
- Build dedicated case/invite/private/group-chat UI
