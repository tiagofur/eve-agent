# Creapolis.Dev — Operations & Development Runbook

This guide contains everything required to start, operate, debug, and build the Creapolis.Dev operations platform from a fresh terminal or session.

---

## 1. Prerequisites

- **macOS:** Apple Silicon (arm64) or Intel
- **Node.js:** v24.x (matches the root `engines` field)
- **Package Managers:** `npm` or `pnpm`
- **Docker & Docker Compose:** Running locally for PostgreSQL 17
- **Rust & Cargo:** Required only if recompiling the Tauri desktop native binary (`cargo --version`)

---

## 2. Environment Configuration

The project uses two environment files:

### Root `.env.local` (Framework, Agent & Shared Keys)
Copy `.env.example` to `.env.local` at the repository root (git-ignored) and fill in real values:
```bash
# Meta Model API (Muse Spark & Muse Image)
META_API_BASE_URL="https://api.meta.ai/v1"
META_API_KEY="<your-meta-api-key>"
META_MODEL_ID="muse-spark-1.3-contributor"
DEFAULT_MODEL="muse-spark-1.3-contributor"

# Telegram Bot (Executive Alerts & HITL Approvals)
TELEGRAM_BOT_TOKEN="<botfather-token>"
TELEGRAM_ADMIN_CHAT_ID="<your-numeric-chat-id>"
TELEGRAM_BOT_USERNAME="creapolis_cm_bot"

# CRM Connection for Eve Agent Tools
CRM_API_URL="http://localhost:8787"
CRM_FRONT_KEY="<cp_front_key>"
CRM_OPS_KEY="<cp_ops_key>"
CRM_OWNER_KEY="<cp_owner_key>"

# Eve Brain Service (single brain for all channels; CRM `/api/chat` proxies here)
EVE_AGENT_URL="http://127.0.0.1:3000"
EVE_CHANNEL_USER="<eve-service-user>"
# Generate once per environment, never commit: openssl rand -hex 32
EVE_CHANNEL_PASSWORD="<eve-service-password>"
# PUBLIC web-chat proxy credential — MUST be a different username from
# EVE_CHANNEL_USER. Sessions authenticated with it are marked as public
# visitors and staff-only agent tools reject them (agent/lib/guard.ts).
# Without it the public chat answers 503 (fails closed).
EVE_PUBLIC_USER="creapolis-public"
EVE_PUBLIC_PASSWORD="<another-openssl-rand-hex-32>"

# Public chat cost guardrails (CRM-side caps; unset = hardcoded defaults)
PUBLIC_CHAT_MAX_TURNS_PER_THREAD=60
PUBLIC_CHAT_DAILY_TURN_BUDGET=400

# WhatsApp inbound throttle per sender (messages per window, window minutes)
WHATSAPP_THROTTLE_MAX=20
WHATSAPP_THROTTLE_WINDOW_MINUTES=10

# Google Calendar (real `schedule_consultation`: freebusy + Meet events)
GOOGLE_CLIENT_ID="<google-oauth-client-id>"
GOOGLE_CLIENT_SECRET="<google-oauth-client-secret>"
GOOGLE_REFRESH_TOKEN="<google-refresh-token>"
# Optional calendar (default primary)
GOOGLE_CALENDAR_ID=""

# WhatsApp Cloud API (Optional / Pending production credentials)
WHATSAPP_ACCESS_TOKEN=""
WHATSAPP_APP_SECRET=""
WHATSAPP_PHONE_NUMBER_ID=""
WHATSAPP_VERIFY_TOKEN=""

# Meta Graph API (Facebook Page & Instagram Business Publishing)
META_GRAPH_API_VERSION="v20.0"
META_FACEBOOK_PAGE_ID="1307077739164874"
META_PAGE_ACCESS_TOKEN="<page-access-token-with-pages_manage_posts>"
META_INSTAGRAM_ACCOUNT_ID="17841458937890967"
```

### CRM Local `.env` (Database & Server Ports)
Copy `crm/.env.example` to `crm/.env` (git-ignored) and fill in real values. Generate or rotate keys with `npx tsx src/seed-keys.ts`:
```bash
DATABASE_URL=postgres://creapolis:creapolis@localhost:5433/creapolis
PORT=8787
FRONT_API_KEY=<cp_front_key>
OPS_API_KEY=<cp_ops_key>
OWNER_API_KEY=<cp_owner_key>
DEV_API_KEY=<cp_dev_key>
# Web search for the chat orchestrator (`search_web` tool): required to FIND
# prospects by criteria instead of guessing from model memory.
# Free keys: Brave (https://brave.com/search/api) or Tavily (https://tavily.com)
SEARCH_PROVIDER=brave
SEARCH_API_KEY=<your-search-api-key>
```

### Desktop App `desktop/.env` (Mission Control API Access)
The desktop app talks to exactly one URL: the public CRM API. The eve agent (`eve-agent:3200`) and
PostgreSQL (`creapolis-db:5432`) are resolved server-side inside the Docker network by
`docker-compose.prod.yml` — the desktop never connects to them directly.

At dev/build time the connection comes from Vite environment variables (git-ignored; see `desktop/.env.example`):
```bash
# Local development
VITE_CRM_API_URL=http://localhost:8787
VITE_CRM_OWNER_KEY=<cp_owner_key>

# Production: public URL fronted by nginx (proxies / -> 127.0.0.1:8787)
VITE_CRM_API_URL=https://<tu-dominio>
VITE_CRM_OWNER_KEY=<cp_owner_key-produccion>
```
Runtime overrides (no rebuild needed): the gear icon in the sidebar footer opens the Connection
panel, which tests and stores the API URL + owner key in localStorage as `CREAPOLIS_API_URL` /
`CREAPOLIS_OWNER_KEY`; these win over the build-time values, and "Valores compilados" restores them.
Prefer an `https://` target: the macOS webview may block plain-HTTP API calls from the installed app.

### Google Calendar one-time consent (`schedule_consultation`)
1. Google Cloud → project → enable **Google Calendar API**.
2. OAuth consent screen → External → test mode → add yourself as test user.
3. Credentials → Create Credentials → OAuth client ID → **Desktop app** → copy ID + secret into `.env.local` above.
4. Run the loopback consent flow (opens browser approval, stores the refresh token at `~/.config/eve-agent/google-calendar.json`, never committed):
```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." node scripts/google-auth.mjs
node scripts/google-auth.mjs --check
```
5. Copy the stored refresh token into `.env.local` as `GOOGLE_REFRESH_TOKEN`, rebuild + restart the eve service so the tool picks it up.
Without these three vars the tool answers `not_configured` honestly instead of inventing meetings; unknown dates, past times and busy calendars also return explicit messages (with up to 3 free alternatives on conflict).

---

## 3. Starting the Services

### Step 1: Start PostgreSQL 17 (Docker)
```bash
cd crm
npm run db:up
```
*Note: Runs container `creapolis-crm-db` on host port `5433`.*

### Step 2: Apply Database Migrations
```bash
cd crm
npm run db:migrate
```

### Step 3: Start CRM Backend & Telegram Bot Daemon
```bash
cd crm
npm run dev
```
*Output confirmation:*
```
Creapolis CRM API running at http://localhost:8787
[Telegram] Service active for Admin Chat ID: <your-id>
```

### Step 4: Start Eve Brain Service (single brain for all channels)
```bash
npm run build
set -a; . .env.local; set +a
PORT=3000 npm run start -- --host 127.0.0.1
```
*Output: serves `/eve/v1` on `http://127.0.0.1:3000` (health: `GET /eve/v1/health`).*
*Notes: rebuild after changing anything under `agent/` (tools, instructions, channel auth); workflow state persists in `.eve/.workflow-data` (git-ignored); model access uses the local Muse subscription (no extra auth). If `eve build` fails on compaction metadata for a custom model, declare `modelContextWindowTokens` in `agent/agent.ts` (verified value documented there). CRM `/api/chat` requires `EVE_AGENT_URL`, `EVE_CHANNEL_USER` and `EVE_CHANNEL_PASSWORD` from above, otherwise it answers 503.*

### Step 5: Run the macOS Desktop App

#### Development Mode (Live Hot Reloading):
```bash
cd desktop
npm run tauri dev
```

#### Running the Installed Native App:
```bash
open "/Applications/Creapolis Mission Control.app"
```

#### Rebuilding the Native Installer (`.dmg` & `.app`):
```bash
cd desktop
npm run build
npm run tauri build -- --debug
hdiutil create -volname "Creapolis Mission Control" \
  -srcfolder "src-tauri/target/debug/bundle/macos/Creapolis Mission Control.app" \
  -ov -format UDZO "src-tauri/target/debug/bundle/dmg/Creapolis Mission Control_0.1.0_aarch64.dmg"
```

*Shortcut scripts:* `npm run desktop:dev` and `npm run desktop:build` (in `desktop/`) wrap the dev and release flows.

---

## 4. Operational Workflows & Testing

### A. Testing the Orchestrator via CLI
Replace `$OWNER_API_KEY` with the `OWNER_API_KEY` value from `crm/.env`:
```bash
curl -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OWNER_API_KEY" \
  -d '{"messages":[{"role":"user","content":"¿Qué prospectos tenemos en el CRM actualmente?"}]}'
```

### B. Triggering an AI Marketing Campaign with Muse Image
```bash
curl -X POST http://localhost:8787/api/marketing/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OWNER_API_KEY" \
  -d '{
    "platform": "instagram",
    "topic": "Caso de éxito: Agente de WhatsApp para clínicas médicas que reduce ausencias en un 40%",
    "tone": "Moderno, técnico y orientado a ROI"
  }'
```
*Result:*
1. Generates Spanish technical copy.
2. Generates 1024x1024 graphic via `muse-image-1.0`.
3. Inserts into database in `pending_approval` status.
4. Sends photo with `[✅ Aprobar]` / `[❌ Rechazar]` buttons to Telegram.

### C. Resetting or Cleaning Test Data
To clean automated test records while preserving real prospects and API keys:
```bash
cd crm
npx tsx src/scripts/clean-test-data.ts
```

### D. Support → Correction Pipeline & Gentle Shell Launcher

The full support lifecycle (ITIL-inspired: resolution ≠ closure — the client confirms before closing):

```
Cliente reporta (chat/WhatsApp/manual)
  → 1. Ticket creado (create_support_ticket) con projectId + problema REAL   [agente]
  → 2. GATE 1: owner aprueba el ticket (Tickets view / Telegram) → in_progress
  → 3. pm despacha corrección con ticketId (CRM rechaza si el ticket está `open`)
  → 4. GATE 2: owner aprueba la tarea (pending_approval) → gentle-shell corre
  → 5. Owner revisa el reporte (in_review) → done
       AUTO: ticket → resolved + borrador de notificación al cliente (outbox)
  → 6. GATE 3: owner aprueba el borrador → copia y envía → "Marcar enviado"
       AUTO: interacción registrada + ticket → waiting_client
  → 7. Cliente confirma → owner cierra (closed). "Reabrir" disponible.
```

Mechanical gates (CRM-enforced, not prompt-enforced): a `POST /api/projects/tasks` with a `ticketId` whose ticket is still `open` fails with `ticket_not_approved` — the agent must ask the owner, never retry. Task `done` auto-resolves the linked ticket (`system:task-done` actor) and queues the notification draft; skips (no contact/org, dedup) are audited as `client_notification_skipped` events.

Desktop surfaces:

1. **Configure once per project** (Desktop → Proyectos y carpetas): set `localPath`, `defaultBranch`, optional `testCommand`, then **Verificar carpeta**. Launches are blocked until verified. Each project card also carries the collapsible **Historial de tareas** (Todas · Finalizadas · Rechazadas) with PR links and agent reports.
2. **Tickets de soporte**: every support ticket pages the owner on Telegram (Aprobar / Resolver / Rechazar). The drawer shows SLA, timeline, linked corrections (status/PR/report), edits the description (vague-intake fix), resolves with internal note + client message, handles `waiting_client` (close on confirmation / reopen attention) and reopens resolved/closed tickets.
3. **Approve the correction**: pending corrections show project + folder + full issue; **Aprobar y lanzar** (owner key) marks it `approved` and launches gentle-shell in the verified folder. Runs audited in `task_runs`.
4. **Review**: finished runs land in `in_review` with the agent's report; **Marcar resuelta** completes the task (`done`) — which auto-resolves the ticket and queues the client draft.
5. **Outbox**: pending drafts → Aprobar → the **Aprobados · por enviar** queue → Copiar → send manually through the channel → **Marcar enviado** (logs the interaction; ticket-linked drafts move the ticket to `waiting_client`).

Agent side: `create_support_ticket` (auto-links `projectName`), `get_support_tickets` (dedup check), `update_support_ticket` (correct content / advance status), `dispatch_coding_task(ticketId)`. A correction without a ticket, a dispatch from an unapproved ticket, or an unnotified client are pipeline violations the agent must report, not paper over.

Prerequisites on the launcher machine: `gentle-shell` installed (default lookup: `~/.local/bin/gentle-shell`, override with `GENTLE_SHELL_BIN`), and project repos cloned locally.

Manual CLI fallback (prints the task packet, no auto-launch):

```bash
cd crm
npm run gentle
```

### E. Automated Tests, Type Checks & Agent Scripts
```bash
# CRM unit & API tests (vitest): lead-stage state machine + API suite
cd crm && npm run test

# TypeScript checks per component
npm run typecheck             # root (eve agent)
cd crm && npm run typecheck   # CRM backend

# Agent tooling smoke test (register lead + save dossier against the local CRM)
npx tsx agent/scripts/test-prospect-muse.ts
```
