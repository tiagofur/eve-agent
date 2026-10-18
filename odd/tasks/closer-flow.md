# Closer flow — nudges without duplicates, loop always closes

Fixes the follow-up agent path: the queue must give the closer usable
target IDs, one lead carries at most one pending draft, and drafting a
nudge advances the reminder so the same item never resurfaces forever.

## Specs

- S1 (user decisions): "Sí, draft por lead" (closer drafts nudges for contact-less leads, contact-gated like first-touch) + "Sí, bloquear" (a second pending draft for the same lead is rejected with a clear code) + "Sí, tool acotada" (closer gets a narrow tool to move the follow-up after drafting).
- S2 (evidence): /api/reports/followups lead items carry no contactId and don't label the lead id — the closer cannot map items to draft targets without guessing (same UUID trap as the prospect flow).
- S3 (evidence): no agent tool sets/clears next_follow_up_at (only the desktop PATCH route does) — after a nudge draft, the item stays overdue forever, compounding duplicates every run.
- S4 (evidence, 2026-10-18): outbox holds exactly 2 drafts ever, none of them closer nudges; queue currently empty (0 overdue). No successful closer run is on record.

## Tasks

- T1, S1 — CRM: createOutreachDraft rejects a second pending_approval draft for the same lead (code draft_already_pending). Tests. Route: inline. Commit: 8143396.
- T2, S2 — CRM: followups queue exposes explicit leadId + contactId on lead items (and contact/organization ids where the joins know them) so the closer never guesses IDs. Tests. Route: inline. Commit: b75f837.
- T3, S1 — agent: narrow set_followup tool (lead|ticket|organization|contact by id; next date or clear + note) wired to the existing PATCH routes. Route: inline. Commit: aa9ca4f.
- T4, S1 — agent instructions: closer drafts by leadId (contact-less OK), honors draft_already_pending (report + still advance the follow-up), advances every worked item with set_followup, honest errors. Route: inline. Commit: b794e0c.
- T5, S1-S4 — verification: CRM suite + typechecks + API-level E2E (seed overdue lead → queue shows IDs → draft → duplicate blocked → follow-up advanced → queue drains). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): closer instructions say "skip when contact missing" (now stale vs lead-drafts) and "use the IDs the queue gives you" (the queue gives no contactId); no dedup anywhere; no agent-side follow-up setter; two 9am triggers (CRM cron digest + eve daily_report schedule) with unclear single ownership — left as a user-observable check, not modified.
- L2 (user decisions): "Sí, draft por lead" + "Sí, bloquear" + "Sí, tool acotada".
- L3 (T5 E2E, 2026-10-18, live :8787): seeded overdue contact-less lead → queue exposes leadId + contactId null → draft by leadId 201 pending_approval (resolution missing) → duplicate 400 draft_already_pending → PATCH followup reschedule success → lead gone from overdue (queue drains). Suite 123/123 + crm/agent typechecks green. One transient empty response mid-run (tsx reload hiccup); focused re-run clean.
