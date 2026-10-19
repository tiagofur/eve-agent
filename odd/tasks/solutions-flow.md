# Solutions flow — persisted estimates linked to the pipeline

Makes technical proposals durable: every estimate is saved against its
lead/organization with scope, phases, timeline and (when quoted) value —
so the closer can reference real pending proposals and nothing quoted
vanishes into chat. No price matrix: money appears only from declared
budgets or quoted numbers, never invented.

## Specs

- S1 (user decisions): "Sí, entidad" (estimates entity with lead/org, category, complexity, scope, phases, timeline, nullable value) + "Solo budget" (no price matrix; value recorded only when stated/quoted, null otherwise).
- S2 (evidence): solutions output is 100% ephemeral — no entity, no tool, no lead linkage; the closer is told to reference "pending proposal" history the CRM never stored.
- S3 (evidence): leads.estimated_value_cents holds 0 rows; budget text only lands in interaction metadata when a contact exists.
- S4 (evidence): generate_service_estimate is a static category table with no lead parameter and no persistence (honest "ballpark" framing, kept as-is).

## Tasks

- T1, S1 — CRM: estimates table (lead/org, category, complexity, scope, phases jsonb, timeline, nullable value + currency, author) + POST/GET routes (GET filterable by leadId) + migration. Tests. Route: inline. Commit: 7eec189.
- T2, S1 — agent: save_service_estimate tool + get_estimates read tool + lib fns. Typecheck. Route: inline. Commit: 0931823.
- T3, S1 — agent instructions: solutions saves every proposal (leadId/orgId from context, null value when unquoted, honest failures); closer may cite saved estimates as pending-proposal context. Route: inline. Commit: 17ce845.
- T4, S1-S4 — verification: CRM suite + typechecks + API E2E (save estimate → read by lead → value null + quoted variants). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): proposals ephemeral; estimated_value_cents dead (0 rows); static tool kept as ballpark by design.
- L2 (user decisions): "Sí, entidad" + "Solo budget".
- L3 (T4 E2E, 2026-10-18, live :8787): saved unquoted (valueCents null) + quoted (180000 MXN) estimates → read by lead lists the right one → scope-less POST rejected 400 → cleaned. Suite 137/137 + crm/agent typechecks green.
