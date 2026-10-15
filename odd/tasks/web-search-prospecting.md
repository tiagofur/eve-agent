# Feature: Web Search Prospecting + CRM Defect Fixes

Owner asked (2026-10-15): make web search work for prospecting, clarify
orchestrator→prospector delegation, and fix the 2 pre-existing CRM defects
(test isolation + typecheck errors).

## Specs

- S1: "tenemos que hacer funcionar las busquedas web" — the CRM chat
  orchestrator must perform real web searches when asked to find/research a
  prospect, instead of relying on model memory. Key-ready: works once a free
  search API key (BRAVE or TAVILY) is placed in env; degrades with a clear
  message when no key is configured.
- S2: "el orquestrador esta pasando la tarea al prospectador?" — answer with
  evidence: CRM `/api/chat` has no prospector agent (inline tools); the eve
  agent delegates to its `prospector` subagent via the root-only `agent` tool.
  No architecture change in this feature; report only.
- S3: "tenemos que arreglar los 2 defectos preexistentes" —
  (a) `api.test.ts` leaves its "Valeria" lead in the DB, so a second suite run
  fails at `PATCH /api/leads/:id/stage` with 400; the suite must be idempotent
  against the same DB. (b) `crm npm run typecheck` fails with 21 pre-existing
  errors (drizzle where-overloads on chat tables, all `tool()` overloads in
  chat.ts, `result.task` misuse, missing guards in marketing.ts and
  telegram.ts); typecheck must pass clean without behavior changes.

## Tasks

- T1 (S1): domain `web-search.ts` (provider abstraction: brave/tavily via
  env, injectable IO, honest no-key error) + tests. Commit: feat(crm).
- T2 (S1): `search_web` tool in chat.ts + research-loop prompt update:
  search first for unnamed prospects, then discovery, then
  research_and_save_prospect. Commit: feat(crm).
- T3 (S3a): api.test.ts cleanup of its own records; prove suite idempotency
  (two consecutive runs green). Commit: test(crm).
- T4 (S3b): fix 21 typecheck errors to a clean `npm run typecheck`. Commit:
  fix(crm).
- T5 (S1): document the search key in crm/.env.example + OPERATIONS_RUNBOOK.
  Commit: docs.

## Log

- L1 (2026-10-15, user): "vamos, tenemos que hacer funcionar las busquedas
  web, pero el orquestrador esta pasando la tarea al prospectador? tambien
  tenemos que arreglar los 2 defectos preexistentes"
- L2 (session): eve registry checked: native `tool/web_search` requires
  model-vendor search or AI Gateway fallback (exa/parallel) — not available
  with the Muse/Meta model; DDG HTML scraping returns an anomaly challenge
  from server IPs. Decision: author a CRM-owned search tool with Brave/Tavily
  adapters selected by env.
