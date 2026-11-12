# Creapolis.Dev — Roadmap, Pending Tasks & Implementation Plans

This document tracks completed capabilities and the remaining backlog. Historical
detail of shipped work lives in git history and PR descriptions.

---

## 1. Feature Completion Matrix

| Component | Status | Verified Capabilities |
| :--- | :---: | :--- |
| **PostgreSQL 17 CRM** | ✅ Complete | Full Drizzle schema (30+ tables incl. invoices/payments/subscriptions), audit event logging, migrations |
| **Hono REST API** | ✅ Complete | Leads, outbox, tickets, projects, billing, reports (weekly/funnel/daily), schedules, marketing, products, inbound |
| **Meta Model API (Text)** | ✅ Complete | `muse-spark-1.3-contributor` for Orchestrator & subagents; Gemini Flash when `GEMINI_API_KEY` is set |
| **Telegram Bot Channel** | ✅ Complete | Long-polling daemon, HITL interactive approval buttons, digest anti-reenvío |
| **macOS Desktop App** | ✅ Complete | Tauri v2: Dashboard, Ventas (Cobros con facturas/pagos/suscripciones), Outbox, Programadas, Reportes, Chat |
| **Outbox HITL Workflow** | ✅ Complete | Approval gates + auto-send of approved email drafts via Resend (#50) |
| **Inbound Email (Resend Receiving)** | ✅ Complete | Svix-signed webhook → interactions; replies pause follow-ups (#51); pending VPS creds `RESEND_WEBHOOK_SECRET` |
| **Meta Graph API (Facebook)** | ✅ Complete | Live publishing with Muse Image renders |
| **Meta Graph API (Instagram)** | ✅ Complete | Publish approved packs to IG from Telegram (#45); pending per-brand `PUBLISH_*` creds on VPS |
| **Gentle Worker Auto-Loop** | ✅ Complete | Correction worker on VPS with atomic claim + 4h lease (#28/#29) |
| **Production Deployment** | ✅ Complete | VPS ordo-vps with automatic GitHub Actions deploy + image rollback (since 2026-10-29) |
| **Weekly Client Reports** | ✅ Complete | `reporter` subagent + `/api/reports/weekly` + Friday schedule (#53) |
| **Collections (facturas/pagos/suscripciones)** | ✅ Complete | Mechanical paid/overdue/renew rules + biller drafts reminders (#52) |
| **Outbound WhatsApp** | ⏳ Pending | WhatsApp Cloud API delivery for approved drafts (email already live) |
| **Store Releases & Reviews** | ⏳ Pending | Release pipeline + store review monitoring for Solennix/Pepinillo |
| **Batch Prospecting** | ⏳ Pending | Lote de prospectos + secuencias multi-toque |
| **Uptime/CI Webhooks → Tickets** | ✅ Complete | CI rojo en main abre ticket solo (#56) + endpoint de uptime con auto-resolve; pending secret en GitHub + VPS |

---

## 2. Remaining Work (execution notes)

### WhatsApp outbound (approved drafts)
- Configure `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` in CRM env; `crm/src/services/` gains a WhatsApp sender beside `email.ts`.
- Cold WhatsApp requires Meta opt-in consent — the outbox approve gate already blocks consent-less drafts.

### Store releases & reviews (Solennix / Pepinillo)
- `releases` table + `release` subagent with a checklist skill (build → stores → notes → publish).
- Review monitoring: poll store APIs or a service (Appfollow-like) → analyst reports or tickets.

### Batch prospecting & sequences
- Prospect lotes ("20 clínicas en Monterrey") via `prospector` + a campaign table with cadence (3 toques) gated by the same outbox approvals.

### Uptime / CI → ticket
- Uptime webhook (Better Uptime/Healthchecks) + GitHub Actions `workflow_run` failure hook → CRM ticket endpoint; dedup by incident key.

### Pending owner input (blocks these)
- Price table for `solutions` estimates (today it estimates without one).
- Product fichas: heapdeck, ordo, creapolis.dev (`docs/products/_pendientes.md`).
- VPS creds: `RESEND_WEBHOOK_SECRET` (webhook en dashboard Resend), per-brand `PUBLISH_*` (runbook §).
