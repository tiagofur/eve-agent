# Support flow — loggable strangers, no double pages, no fake IDs

Makes the support path honest and complete: info questions log without a
contact, repeat reports of the same open incident return the existing
ticket instead of paging twice, and CRM failures fail loudly instead of
fabricating local ticket IDs.

## Specs

- S1 (user decisions): "Sí, opcional" (contact optional for info tickets; still required for support incidents) + "Sí, deduplicar" (same contact + system with an open ticket returns it, no duplicate, no re-page).
- S2 (evidence): create_support_ticket returns a fabricated TICK-XXX id with status logged_locally when the CRM errors — a ticket that exists nowhere (same S6-class sin as the prospect flow).
- S3 (evidence): severity is required even for info kind, where it is meaningless (SLA always 24h commercial).
- S4 (evidence): tickets table holds 0 rows — the path never executed with real data.

## Tasks

- T1, S1 — CRM: contact optional for info tickets (domain + route validation); severity optional for info (defaults minor). Tests. Route: inline. Commit: 518109d.
- T2, S1 — CRM: open-ticket dedup per resolved contact + system (case-insensitive); returns existing ticket, skips the owner page. Tests. Route: inline. Commit: b294c6e.
- T3, S2/S3 — agent: tool fails loudly on CRM error (no fake IDs), contact/severity optional per kind. Typecheck. Route: inline. Commit: c46497b.
- T4, S1 — agent instructions: support touch-up (contact-less info OK, dedup behavior, honest failures). Route: inline. Commit: 8c96fd5.
- T5, S1-S4 — verification: CRM suite + typechecks + API E2E (info without contact → dedup on repeat → support still requires contact). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): contact required for all kinds; no dedup (repeat outage = repeat page); fake-ID fallback; severity required for info; 0 tickets on record. SLA clock is naive wall-clock (1h/4h/24h incl. 3am) and breach re-paging doesn't exist — noted, out of scope.
- L2 (user decisions): "Sí, opcional" + "Sí, deduplicar".
- L3 (T5 E2E, 2026-10-18, live :8787): info without contact → 201 (minor/24h) → support major → 201 (4h) → repeat same system → 200 duplicate=true same id → support without contact → 400 contact_required → cleaned. Suite 134/134 + crm/agent typechecks green.
