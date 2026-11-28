# Creapolis.Dev — System Architecture & Multi-Agent Operations Platform

## 1. Executive Summary

**Creapolis.Dev** is an AI-first agency operations system designed to autonomously prospect clients, diagnose business pains, draft cold outreach, manage support tickets with contractual SLAs, create multi-channel marketing campaigns (with AI-generated visual graphics), and dispatch coding tasks to autonomous terminal workers.

The entire system adheres strictly to the **Human-in-the-Loop (HITL)** architecture:
- Autonomous agents perform research, diagnosis, drafting, and creative generation.
- **No external communication** (cold emails, WhatsApp messages, social media posts) is sent without explicit human sign-off from either the **macOS Desktop App** or the **Telegram Mobile Bot**.

---

## 2. Global Architecture Diagram

```
                             +-----------------------------+
                             |     Human Director / CEO    |
                             +--------------+--------------+
                                            |
                    +-----------------------+-----------------------+
                    |                                               |
         [macOS Desktop App]                               [Telegram Bot]
     (Tauri v2 + React + Tailwind)                    (@creapolis_cm_bot - HITL)
                    |                                               |
                    | (REST / Bearer OWNER_KEY)                     | (Long Polling / Webhook)
                    v                                               v
+-------------------------------------------------------------------------------+
|                       Creapolis CRM REST API (Hono.js)                        |
|                               Port: :8787                                     |
|-------------------------------------------------------------------------------|
|  Endpoints:                                                                   |
|   • /health               • /api/leads              • /api/outbox             |
|   • /api/tickets          • /api/dossiers           • /api/projects           |
|   • /api/reports          • /api/chat (Orchestrator)• /api/marketing          |
|                                                                               |
|  Services:                                                                    |
|   • Telegram Polling & Callback Dispatcher (sendPhoto, inline_keyboards)      |
|   • Audit Event Logger (every state change is cryptographically tracked)      |
+---------------------------------------+---------------------------------------+
                                        | (Drizzle ORM)
                                        v
+-------------------------------------------------------------------------------+
|                       PostgreSQL 17 Database (Docker)                         |
|                               Port: :5433                                     |
|-------------------------------------------------------------------------------|
|  Tables:                                                                      |
|• organizations         • contacts                • leads                      |
|• dossiers              • interactions            • outbox                     |
|• tickets               • social_posts            • projects                   |
|• tasks                 • milestones              • contracts                  |
|• events (audit)        • api_keys                • daily_reports              |
|• idempotency_keys                                                             |
+-------------------------------------------------------------------------------+
                                        ^
                                        | (REST / Bearer OPS_KEY)
+---------------------------------------+---------------------------------------+
|                    Vercel Eve AI Framework (agent/)                           |
|-------------------------------------------------------------------------------|
|  Core Models (Meta Model API - https://api.meta.ai/v1):                       |
|   • muse-spark-1.3-contributor (Reasoning, Copywriting, Dossier Synthesis)    |
|   • muse-image-1.0             (1024x1024 Generative Graphic Renders)         |
|                                                                               |
|  Subagents:                                                                   |
|   • pm (Project Management)       • analyst (Metrics & Reports)               |
|   • prospector (Lead Diagnosis)   • solutions (Architecture Estimates)        |
|   • support (SLA Enforcement)     • marketing (Social Copy & Muse Graphics)   |
|   • legal (Contracts & Terms)                                                 |
|                                                                               |
|  Tools:                                                                       |
|• register_lead                 • save_prospect_dossier                        |
|• create_support_ticket         • create_project                               |
|• dispatch_coding_task          • generate_marketing_post                      |
|• get_crm_metrics               • generate_service_estimate                    |
|• schedule_consultation                                                        |
+-------------------------------------------------------------------------------+
                                        |
                                        v
+-------------------------------------------------------------------------------+
|              Correction Pipeline: Issue → Owner Approval → gentle-shell       |
|-------------------------------------------------------------------------------|
|  • Eve pm drafts the spec (dispatch_coding_task) -> task 'pending_approval'   |
|  • Owner approves in the Desktop app (owner scope) -> 'approved'              |
|  • Desktop launcher (Tauri Rust commands in desktop/src-tauri) verifies the   |
|    project's local folder (git repo + remote match), composes the ISSUE.md,   |
|    spawns `gentle-shell -p` inside the folder and streams the live log.       |
|  • task_runs rows audit every launch (log, issue, branch, exit, report).      |
|  • States: pending_approval -> approved -> dispatched -> in_progress ->       |
|    in_review -> done (rejected/blocked/rework along the way).                 |
|  • crm/src/scripts/gentle-worker.ts remains as the manual CLI fallback.       |
+-------------------------------------------------------------------------------+
```

---

## 3. Core Subsystems

### A. AI Engine: Meta Model API (Muse Suite)
- **Base URL:** `https://api.meta.ai/v1`
- **Text & Reasoning Model:** `muse-spark-1.3-contributor`
  - Used by Eve Orchestrator and all declared subagents (13 as of 2026-11: analyst, biller, closer, designer, intel, legal, marketing, pm, prospector, reporter, solutions, strategist, support) — the single brain behind every channel (CRM `/api/chat` proxies to it; no inline LLM loop remains there).
  - Configured via `@ai-sdk/openai` compatibility layer in `agent/lib/models.ts`.
- **Image Generation Model:** `muse-image-1.0`
  - Generates native 1024x1024 WebP renders via `POST https://api.meta.ai/v1/images/generations`.
  - Dispatched directly as high-resolution Telegram photos and displayed in the macOS Desktop App.
- **Fallback:** when `META_API_KEY` is absent, `agent/lib/models.ts` falls back to `DEFAULT_MODEL` (default `openai/gpt-6-luna-fast`) through the default gateway.

### B. CRM Backend (`crm/`)
- **Runtime:** Node.js 26 + TypeScript + `tsx watch`
- **HTTP Engine:** Hono.js (`@hono/node-server`) on `http://localhost:8787`
- **Database:** PostgreSQL 17 in Docker (`creapolis-crm-db` on port 5433).
- **ORM:** Drizzle ORM (`drizzle-kit` for migrations).
- **Security & Scopes:**
  - `front`: Read/create leads from public inbounds.
  - `ops`: Read/write pipeline data, dossiers, and tasks.
  - `owner`: Approve/reject outbox drafts, review social posts, modify SLA statuses.
  - `dev`: Terminal coding agent access.
  - CORS configured with `origin: "*"` to support WebKit/Tauri desktop origins.
- **Scheduled tasks (`schedules` / `schedule_runs`):** agent cronjobs live in the database and are dispatched by a minute tick (`crm/src/services/schedule-dispatcher.ts`). Rows are `kind=agent` (EVE orchestrator turns) or `kind=local` (registered CRM handlers like `followup_digest`/`metrics_collector` — no LLM, run even without EVE, 12h grace). Each agent run records the tokens its turn spent — delegated subagents included — read from the stream's `usage.recorded` facts; `GET /api/schedules` adds each task's trailing-week total as `usage7d`. Tasks carry a `category` block (content/reports/sales/system/other) the desktop groups by; `PATCH /api/schedules/category/:category` pauses or resumes a whole block, re-arming next runs on resume.
- **Web contacts inbox (`chat_threads.reviewed_at`):** threads keyed `public:<uuid>` are the visitors of the creapolis.dev chat widget; everything else (desktop chats, the Telegram orchestrator thread, schedule runs) is internal. `GET /api/chat/threads` reports each thread's `origin` and filters by it, and `POST /api/chat` refuses a web thread. `/api/web-contacts` is the owner's review inbox over the web chats: list (first message + size), unread count, mark reviewed, and the conversation. A visitor writing again on a reviewed thread returns it to "sin revisar"; the first message of a chat pages the owner's Telegram (`crm/src/services/web-contact-page.ts`, capped at 5 pages per 10 minutes).

### C. macOS Desktop App (`desktop/`)
- **Runtime:** Tauri v2 + Rust
- **Frontend:** React 18 + Vite + Tailwind CSS + Lucide Icons
- **Key Modules:**
  1. **Dashboard:** High-level pipeline metrics, conversion rates, open SLAs, and approval alerts.
  2. **Orquestador Chat:** Thin visual layer over the single EVE brain. `POST /api/chat` forwards each turn to an EVE `/eve/v1` session (durable server-side: closing the chat never aborts the run), maps threads 1:1 to sessions (`chat_threads.eve_session_id`), and persists replies; without EVE env it answers 503 instead of a second brain. It lists internal threads only — the web chats live in Contactos web.
  3. **Marketing Studio:** AI Campaign generator. View generated copy, hashtags, and Muse Image visual renders with 1-click Approve / Reject / Publish buttons.
  4. **Outbox Approvals:** Human-in-the-Loop review queue for cold email and WhatsApp drafts.
  5. **Leads & Pipeline:** Kanban/Table view with full Dossier slide-over drawers (pains, verified source links, outreach history).
  6. **Support SLA:** Incident management with live countdowns against contractual SLAs (1h critical, 4h major, 24h minor).
  7. **Coding Dispatcher:** Backlog and ready tasks queue for autonomous terminal workers.
  8. **Contactos web:** Review inbox for the chats visitors open on creapolis.dev — sin revisar / revisados, unread badge in the sidebar, the whole conversation in a drawer, and «Pedir respuesta», which hands the transcript to the Orquestador Chat as untrusted data so the agent leaves a reply draft in Outbox (`desktop/src/lib/webContactReply.ts` builds that prompt).

### D. Mobile Channel: Telegram Bot (`crm/src/services/telegram.ts`)
- **Bot Username:** `@creapolis_cm_bot`
- **Engine:** Long-polling service running inside the CRM daemon (no public ngrok tunnel required for local development).
- **Capabilities:**
  - `/pipeline` and `/status`: Real-time database metrics query.
  - Outbox Approvals: Dispatches card with copy and inline buttons `[✅ Aprobar Envío]` and `[❌ Rechazar]`.
  - Marketing Approvals: Dispatches rendered WebP photo via `sendPhoto` with `[✅ Aprobar para INSTAGRAM]` and `[❌ Rechazar]`.
  - Critical Support Incidents: Dispatches SLA alert with `[⚡ En Progreso]` and `[✅ Resolver]`.
  - Callback Queries: Processed instantly, updates the PostgreSQL database, and edits the Telegram message in-place to confirm the decision.

### E. Eve Agent Tools & Channels (`agent/`)
Tools are thin wrappers over the CRM REST API (see `agent/lib/crm.ts`); two run locally without CRM access:

| Tool | Scope | Effect |
|------|-------|--------|
| `register_lead` | front | Creates lead + contact via `POST /api/leads` |
| `save_prospect_dossier` | ops | Persists research dossier via `POST /api/dossiers`; tags the lead `researched` |
| `create_support_ticket` | front | Logs incident with SLA due date via `POST /api/tickets` |
| `create_project` | ops | Creates project (+ milestones) via `POST /api/projects` |
| `dispatch_coding_task` | ops | Queues a `pending_approval` issue (owner HITL gate) via `POST /api/projects/tasks` |
| `generate_marketing_post` | ops | Copy + Muse Image campaign via `POST /api/marketing/generate` |
| `get_crm_metrics` | ops | Funnel counts & conversions via `GET /api/reports/funnel` |
| `generate_service_estimate` | local | Timeline/deliverable estimate matrix (no CRM call) |
| `schedule_consultation` | local | Real Google Calendar event with Meet link, invites the contact email; public sessions are capped by `lib/booking-limits.ts` (2 per conversation, 8 per day) |

Channels (`agent/channels/`):
- `eve.ts` — default eve channel (Vercel OIDC for deployments + local dev auth).
- `whatsapp.ts` — scaffolding stub via `@chat-adapter/whatsapp` that echoes every message back. **Placeholder only: do not deploy until real intent handling replaces the echo.**
