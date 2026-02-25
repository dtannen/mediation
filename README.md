# Mediation App (MVP Scaffold)

Standalone codebase for multi-party mediation with LLM-assisted phases:

1. `private_intake` (each party with their chosen local LLM)
2. `cross_agent_dialogue` (party LLM summaries communicate under consent rules)
3. `joint_mediation` (both parties + mediator LLM room)

## Status

This scaffold provides:
- Domain model for mediation cases and phases
- Consent policy enforcement for sharing private intake details
- Phase transition engine
- In-memory store
- `MediationService` orchestration class
- Demo runner in `src/index.ts`

## Quickstart

```bash
cd /Users/dtannen/Code/mediation
npm install
npm run demo
```

## Next Build Steps

- Replace in-memory store with SQLite/Postgres
- Wire local LLM providers per party
- Add gateway transport adapters
- Build a dedicated UI for party and mediator rooms
