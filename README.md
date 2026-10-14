# Creapolis.Dev — Autonomous Multi-Agent Operations System

An AI-first agency operations platform built on the [eve](https://eve.dev) framework: an orchestrator agent with 7 specialist subagents prospects clients, drafts outreach, manages SLA-bound support, generates marketing campaigns with AI graphics, and dispatches coding tasks — all under strict Human-in-the-Loop (HITL) approval via the desktop app or Telegram.

## Repository layout

| Path | Component | Stack |
|------|-----------|-------|
| `agent/` | Eve orchestrator: 7 subagents, 9 tools, WhatsApp channel (stub), daily report schedule | Eve + Meta Model API (Muse) |
| `crm/` | CRM REST API + Telegram HITL bot daemon (`:8787`) | Hono, Drizzle ORM, PostgreSQL 17 (Docker, `:5433`) |
| `desktop/` | Mission Control app: dashboard, approvals, marketing studio, SLA view | Tauri v2, React 18, Vite, Tailwind |

## Quick start

```bash
# 1. Database: PostgreSQL 17 in Docker (port 5433)
cd crm
npm run db:up
npm run db:migrate

# 2. CRM API + Telegram daemon (port 8787)
npm run dev

# 3. Desktop app — separate terminal
cd desktop
npm run tauri dev

# 4. Agent REPL — separate terminal, repo root
npm run dev
```

Environment variables: copy `.env.example` → `.env.local`, `crm/.env.example` → `crm/.env`, and set `VITE_CRM_OWNER_KEY` in `desktop/.env`. See the [Operations Runbook](docs/OPERATIONS_RUNBOOK.md) for the full reference.

## Documentation

- [Documentation index](docs/README.md)
- [System architecture](docs/ARCHITECTURE.md)
- [Operations runbook](docs/OPERATIONS_RUNBOOK.md)
- [Roadmap & next steps](docs/ROADMAP_AND_NEXT_STEPS.md)

## Eve resources

- [eve documentation](https://eve.dev/docs) — features and authoring APIs.
- [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent) — build and deploy an agent step by step.
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy the **agent** (not the CRM backend or desktop app) from the project root:

```bash
eve deploy
```

`eve deploy` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.
