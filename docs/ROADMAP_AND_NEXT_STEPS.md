# Creapolis.Dev — Roadmap, Pending Tasks & Implementation Plans

This document tracks all completed features, in-progress items, and provides detailed execution plans for upcoming capabilities.

---

## 1. Feature Completion Matrix

| Component | Status | Verified Capabilities |
| :--- | :---: | :--- |
| **PostgreSQL 17 CRM** | ✅ Complete | Full Drizzle schema, 16 tables, audit event logging, migrations applied |
| **Hono REST API** | ✅ Complete | Health, leads, outbox, tickets, dossiers, projects, chat, marketing routes |
| **Meta Model API (Text)** | ✅ Complete | `muse-spark-1.3-contributor` integrated for Orchestrator & subagents |
| **Meta Model API (Image)**| ✅ Complete | `muse-image-1.0` integrated for 1024x1024 native WebP graphic generation |
| **Telegram Bot Channel** | ✅ Complete | Long-polling daemon, `/pipeline` metrics, HITL interactive approval buttons |
| **Telegram Photo Dispatch**| ✅ Complete | `sendPhoto` with WebP buffers and inline keyboard approval buttons |
| **macOS Desktop App** | ✅ Complete | Native arm64 DMG/App, Dashboard, Chat, Marketing Studio, SLA, Drawers |
| **Outbox HITL Workflow** | ✅ Complete | Live test rejection & approval verified end-to-end via Telegram callbacks |
| **Meta Graph API (Facebook)**| ✅ Complete | Live verified publishing to Creapolis Dev Page with Muse Image 1.0 WebP renders |
| **Meta Graph API (Instagram)**| ⏳ Pending | Linked account `@creapolisdev` identified; awaits Cross-posting or public URL hosting |
| **Outbound Email & WhatsApp**| ⏳ Pending | SMTP/Resend delivery for approved cold outreach drafts |
| **Gentle Worker Auto-Loop**| ⏳ Pending | Autonomous terminal coding worker continuous polling and PR creation |
| **Cloud Deployment** | ⏳ Pending | Vercel deployment for Eve agents + managed DB/Docker for CRM |

---

## 2. Detailed Implementation Plans for Next Tasks

### Task 1: Complete Instagram Publishing (Direct API / Public URL Proxy)

#### Current Status:
- Facebook Page publishing is **100% verified and live** (`https://www.facebook.com/122103972981506897/posts/122103973377506897`).
- Instagram account `@creapolisdev` (ID `17841458937890967`) is officially linked to Page `1307077739164874`.
- Facebook accepts direct binary WebP multipart uploads from localhost (`formData.append("source", blob)`).
- Instagram Media Container API (`POST /{ig-user-id}/media`) strictly requires an internet-accessible public HTTPS URL (`image_url`).

#### Execution Options:
1. **Option A (Zero-Code):** Enable native Cross-posting in Facebook Page settings (`facebook.com/settings/?tab=linked_accounts` -> Instagram -> Share automatically). Every post published on Facebook Page automatically posts to Instagram.
2. **Option B (Direct API):** Add a lightweight public image upload endpoint or ephemeral proxy in `crm/src/services/image-host.ts` (e.g. upload base64 WebP to free CDN or Vercel Blob), pass the returned public HTTPS URL to `publishToInstagram()`, and ensure `instagram_content_publish` is added to the token.

---

### Task 2: Live Delivery for Approved Outbox Drafts (Email & WhatsApp)

#### Objective:
When the owner approves a cold outreach draft in `outbox`, automatically send the message through the designated channel.

#### Implementation:
1. **Email Channel (Resend / SMTP):**
   - Add `RESEND_API_KEY` to `crm/.env` (delivery runs server-side inside the CRM daemon).
   - In `crm/src/services/email.ts`:
     ```ts
     import { Resend } from "resend";
     const resend = new Resend(process.env.RESEND_API_KEY);
     await resend.emails.send({
       from: "Tiago Furtado <tiago@creapolis.dev>",
       to: contactEmail,
       subject: draft.subject,
       text: draft.body,
     });
     ```
2. **WhatsApp Channel (WhatsApp Cloud API):**
   - Configure `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in `crm/.env` (the CRM backend sends approved drafts). The eve WhatsApp channel (`agent/channels/whatsapp.ts`) keeps its own credentials in the root `.env.local`.
   - Send approved template messages via `https://graph.facebook.com/v21.0/{phone-number-id}/messages`.
3. **State Transition:**
   - On delivery success: update `outbox.status` to `"sent"` and record `sentAt = new Date()`.
   - On delivery error: update `outbox.status` to `"failed"` with error message.

---

### Task 3: Continuous Coding Worker Loop (`gentle-worker.ts`)

#### Objective:
Enable the terminal coding worker to run continuously as a background service, pulling tasks from `/api/projects/tasks/ready` and submitting Git branches.

#### Implementation:
1. In `crm/src/scripts/gentle-worker.ts`:
   - Add an interval polling loop or cron schedule.
   - When a task with `assignee = 'gentle-shell'` is found in status `'ready'`:
     1. Move status to `'in_progress'`.
     2. Create local git branch: `git checkout -b task/{task-id}`.
     3. Apply task specification using the LLM agent.
     4. Run local test suite (`npm test`).
     5. Move status to `'in_review'` and log the git diff in `crm.tasks`.

---

### Task 4: Production Deployment

#### Steps:
1. **Database:** Migrate PostgreSQL to a managed cloud instance (e.g. Supabase, Neon, or Railway PostgreSQL). Update `DATABASE_URL`.
2. **CRM Backend:** Deploy the Hono server to Railway, Render, or a VPS (Docker container) with persistent port 8787.
3. **Eve Agents:** Deploy root agent to Vercel via `eve deploy --non-interactive --yes`.
4. **Telegram Webhook:** Switch from long-polling to official webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://api.creapolis.dev/eve/v1/telegram","allowed_updates":["message","callback_query"]}'
   ```
5. **Desktop App:** Build release bundle with code signing:
   ```bash
   npm run tauri build
   ```
