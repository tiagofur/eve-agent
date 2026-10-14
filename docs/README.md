# Creapolis.Dev — Documentation Index

Welcome to the **Creapolis.Dev** Autonomous Multi-Agent Operations System documentation repository.

## Documentation Structure

1. **[System Architecture](ARCHITECTURE.md)**
   - Complete technical overview of the platform.
   - Multi-agent topology (Eve framework + 7 specialist subagents).
   - PostgreSQL 17 CRM schema (16 tables, audit logging, scoped keys).
   - Meta Model API integration (`muse-spark-1.3-contributor` and `muse-image-1.0`).
   - macOS Desktop App (Tauri v2 + React 18) and Telegram Bot (@creapolis_cm_bot).

2. **[Operations & Runbook](OPERATIONS_RUNBOOK.md)**
   - Step-by-step instructions to start every service from scratch.
   - Environment variables reference (`.env.local` and `crm/.env`).
   - Testing scripts, CLI commands, and database maintenance.
   - Compiling and bundling the native macOS Desktop application (`.app` / `.dmg`).

3. **[Roadmap & Next Steps](ROADMAP_AND_NEXT_STEPS.md)**
   - Matrix of completed vs. pending capabilities.
   - Detailed technical plans to connect Meta Graph API (Facebook/Instagram live publishing).
   - Email (Resend) and WhatsApp Cloud API delivery for approved outreach.
   - Automated coding worker loop (`gentle-worker.ts`).
   - Production deployment strategy.

---

## Quick Reference Commands

```bash
# 1. Start PostgreSQL Database
cd crm && npm run db:up

# 2. Run Database Migrations
cd crm && npm run db:migrate

# 3. Start CRM API Server & Telegram Daemon (:8787)
cd crm && npm run dev

# 4. Launch macOS Desktop App
open "/Applications/Creapolis Mission Control.app"
# Or run live dev mode:
cd desktop && npm run tauri dev
```
