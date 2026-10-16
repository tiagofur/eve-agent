# Feature: Single Brain — EVE orchestrates all channels durably

Owner decided (2026-10-15): one brain (EVE) for every channel; tasks must
survive closing the chat because they run behind, not in the frontend.

## Specs

- S1: "un solo cerebro para todos canales" — the macOS app chat (and any
  future channel) is a thin visual layer: `POST /api/chat` authenticates,
  persists threads, and proxies to a running EVE deployment (`/eve/v1`
  sessions); the EVE orchestrator (+ subagents, incl. prospector) does the
  work and its reply returns to the chat. No more two parallel agent layers.
- S2: "si cierro el chat no pierdo la tarea" — execution is durable and
  server-side: closing the frontend never aborts the run (unlike today's
  `generateText`-inside-the-request, which is what orphaned the Timothy
  lead). The client reconnects to the session stream to observe progress.
- S3: The CRM stays the system of record (REST API, DB, domain guarantees,
  scopes, threads, Telegram daemon). Only prompt/tool orchestration
  consolidates into EVE. `researchAndSaveProspect` + `web-search` domains
  stay as API-level write guarantees regardless of which brain calls.

## Tasks

- T1 (S1/S2): spike — run the eve agent as a local service (`eve build` +
  `eve start`), prove over HTTP that a session survives client disconnect
  (create → disconnect → reconnect stream → result), document the exact
  contract the proxy needs. Commit: docs(spike) or chore.
- T2 (S1): operate the eve service alongside the CRM (port, process mgmt,
  `.eve/.workflow-data` persistence, `/eve/` + `/.well-known/workflow/`
  reachability, model access via existing Muse subscription path).
  Commit: chore(ops).
- T3 (S1/S2): CRM `/api/chat` becomes thin proxy (auth, threads, forward to
  eve session, stream/return reply, reconnect support). Commit: feat(crm).
- T4 (S1): port `search_web` (+ any CRM-only research capability) into an
  eve tool for the prospector; eve agent calls CRM API for writes.
  Commit: feat(agent).
- T5 (S1): retire the inline tools in `chat.ts` (or keep behind a fallback
  flag during transition). Commit: refactor(crm).
- T6 (S1/S2): E2E proof — request a prospect from the macOS chat, close the
  chat mid-research, reopen: dossier complete in CRM. Commit: test.
- T7: docs (ARCHITECTURE + runbook single-brain topology) + work-unit
  commits review. Commit: docs.

## Log

- L1 (2026-10-15, user): "no, tenemos que hacer que tengamos un solo cerebro
  para todos canales, tambien por si cierro el chat no pierdo la tarea
  porque esta corriendo por detras no en el frontend..."
- L2 (session): evidence — crm/ imports from agent/ only
  `createSubscriptionFetch` (model auth helper); CRM chat runs
  `generateText` inside the HTTP request (abort kills the run — the Timothy
  mechanism). EVE provides: `/eve/v1` HTTP API (sessions, streams with
  reconnection, cancel, durable session IDs, create-once `operationId`);
  self-host via `eve build` + `eve start` with workflow state in
  `.eve/.workflow-data`; every agent call is a resumable `serve` task
  (receipt now, `task.result` later; new messages don't disturb tasks).
  Recommendation: self-host the eve service next to the CRM (local-first,
  no surprise billing, consistent with agent/lib/models.ts philosophy).
- L3 (2026-10-15, spike T1 VERIFIED): `eve build` failed 10x identical on
  compaction metadata for the custom model — root cause: the build compiles
  the root agent PLUS all 7 subagents, each needing the escape hatch.
  Fix: `modelContextWindowTokens: 1048576` (Meta docs verified) in
  agent/agent.ts + all 7 agent/subagents/*/agent.ts → BUILD GREEN (Nitro
  11 MB in .output). Channel auth: `localDev()` only works under `eve dev`,
  so `eve start` needs `httpBasic` from EVE_CHANNEL_USER/PASSWORD env
  (added, conditional). Service UP at 127.0.0.1:3000, health OK.
  DURABILITY PROVEN: session created (accepted + sessionId), stream killed
  mid-turn (simulated chat close), reconnect observed `turn.completed` +
  `session.waiting` with the full answer. Proxy contract: POST /eve/v1/session
  {message} + Basic → {sessionId}; GET /eve/v1/session/:sid/stream (NDJSON,
  reconnectable); disconnects never abort server-side turns. Spike server
  stopped and spike secrets deleted after verification.
- L4 (2026-10-15, T2 operate VERIFIED): eve service runs alongside the CRM
  (:3000 + :8787, both healthy; .eve/.output gitignored, tree clean).
  Root .env.local already carries CRM_API_URL/FRONT/OPS keys; service
  launched with env exported + ephemeral EVE_CHANNEL_* (never on disk in
  repo). Functional proof: orchestrator answered "2" via get_crm_metrics
  (exact DB count), delegated to analyst subagent, zero key/network errors.
  Model subscription works file-based (no extra auth). Operated service
  stays up (job-18) with spike-grade creds in /tmp (600) until T3 defines
  the real secret story.
- L5 (2026-10-15, T3 thin proxy VERIFIED): POST /api/chat proxies to EVE
  when EVE_AGENT_URL/USER/PASSWORD are configured (thread↔session via
  chat_threads.eve_session_id, create-once operationId `crm-thread-<id>`),
  awaits the turn to a terminal event, persists one row per completed
  message with chat_messages.eve_event_id; otherwise the legacy inline loop
  runs untouched. Sync-on-POST/GET backfills missed replies idempotently.
  Live proof: new thread → PROXY-OK + sid set + 2 rows; second message →
  same sid reused, 4 rows, ordered GET, history present eve-side; test
  thread deleted. Contract preserved ({reply, toolCalls: [], threadId},
  404-before-model). Migration 0003 applied (both columns nullable).
  Suite 71/71, crm + agent typechecks clean.
- L6 (2026-10-15, T4 port search_web VERIFIED): agent/tools/web_search.ts
  (self-contained Brave/Tavily, env-based, honest degradation) + prospector
  instructions point to it first for unnamed candidates. Agent typecheck
  clean (after fixing a mapBrave/mapTavily naming slip); eve rebuilt/restarted
  with the tool. Live wiring proof: orchestrator invoked web_search,
  relayed search_not_configured + setup instructions honestly, offered
  prospector delegation; turn completed cleanly. Real search results pending
  the owner's Brave key.
- L7 (2026-10-15, T5 retire inline tools VERIFIED, opción A): deleted the
  legacy generateText loop + all 8 inline tools from crm/src/api/routes/chat.ts
  (~290 lines) + getModel + unused imports; added explicit gates (503 brain
  unconfigured, 400 no user message). Live smoke: T5-OK via proxy on the
  trimmed code; test thread deleted. Suite 73/73 (incl. new 503/400 route
  tests), both typechecks clean. No fallback retained: unconfigured chat
  fails loud, never answers from a second brain.
- L8 (2026-10-15, T6 E2E durability VERIFIED): requested Cinépolis prospect
  research via the macOS chat path, aborted the request at 60s/0-bytes
  (simulated chat close) → the eve turn continued server-side (prospector
  delegation observed live: 2x prospector calls, task.started → task.settled)
  and completed: org + complete dossier (techStack/pains/solutions/
  outreachAngle verified, 6 real sources, honest keyContacts with zero
  invented contacts) + dossier_created event. The 10-min poller missed it
  on an accent bug in its own pattern (%cinepolis% vs Cinépolis); UUID +
  event-entity_id lookup settled it (model was honest throughout).
  Reopen via GET showed all 6 messages synced with eve_event_id. Test rows
  deleted; DB back to real-data-only (2 orgs, 2 leads, 1 dossier).
  HALLAZGO: dossier saved with lead_id NULL (no lead row) — eve
  register_lead requires contact, so contact-less prospects never enter the
  pipeline. Fix proposal: relax the contact requirement (eve tool schema +
  POST /api/leads) to use the honest no-contact ingest path.
- L8 (2026-10-15, T6 E2E durability VERIFIED): requested Cinépolis prospect
  research via the macOS chat path, aborted the request at 60s/0-bytes
  (simulated chat close) → the eve turn continued server-side (prospector
  delegation observed live: 2x prospector calls, task.started → task.settled)
  and completed: org + complete dossier (techStack/pains/solutions/
  outreachAngle verified, 6 real sources, honest keyContacts with zero
  invented contacts) + dossier_created event. The 10-min poller missed it
  on an accent bug in its own pattern (%cinepolis% vs Cinépolis); UUID +
  event-entity_id lookup settled it (model was honest throughout).
  Reopen via GET showed all 6 messages synced with eve_event_id. Test rows
  deleted; DB back to real-data-only (2 orgs, 2 leads, 1 dossier).
  HALLAZGO: dossier saved with lead_id NULL (no lead row) — eve
  register_lead requires contact, so contact-less prospects never enter the
  pipeline. Fix proposal: relax the contact requirement (eve tool schema +
  POST /api/leads) to use the honest no-contact ingest path.
- L9 (2026-10-16, Fix unleaded-dossier VERIFIED): createDossier auto-crea
  lead honesto sin contacto cuando no viene leadId (ingest con dedup,
  rollback condicional, transición a researched, source prospector_agent).
  Schemas relajados: POST /api/leads + eve register_lead aceptan contact
  ausente; prospector registra siempre. E2E Run #3: abort-60s/0bytes →
  lead researched + dossier ligado + contactos nulos + reapertura con 7 msgs;
  DB limpia (2/2/1). Suite 76/76, ambos typechecks limpios. Run #2 había
  muerto por DNS transitorio (ENOTFOUND), no por código.
