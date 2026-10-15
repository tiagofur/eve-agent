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
The desktop app reads its CRM connection at dev/build time from Vite environment variables (git-ignored):
```bash
VITE_CRM_API_URL=http://localhost:8787
VITE_CRM_OWNER_KEY=<cp_owner_key>
```
A runtime override is also honored: `localStorage.setItem("CREAPOLIS_OWNER_KEY", ...)`.

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

### Step 4: Run the macOS Desktop App

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

### D. Running Autonomous Terminal Coding Worker (Gentle Shell)
```bash
cd crm
npm run gentle
```
*Listens for tasks in `ready` status, creates feature branches, executes test suites, and marks tasks `in_review`.*

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
