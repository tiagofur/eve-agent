# Analyst flow — honest conversions, persisted reports, sample rule

Gives the analyst data it can tell the truth with: a real transition-based
conversion engine, persisted reports for genuine trends, and a
minimum-sample rule so small data never forces fabricated improvements.

## Specs

- S1 (user decisions): "Sí, motor real" (conversions from the events transition history, test noise excluded, via API + tool — honest rates or none) + "Sí, persistir" (analyst reports table + history, trends only from saved history) + "Sí, regla" (below threshold: counts + "insufficient data", no forced 3 improvements).
- S2 (evidence): /api/reports/funnel returns current-stage stocks only — conversion % from stocks is invalid (skips, re-entries, side exits). The analyst is ordered to compute what the data cannot support.
- S3 (evidence): 4 live leads, 0 with loss reason; events hold 352 stage_transitions but only for deleted test leads — live-lead join filters the noise.
- S4 (evidence): analyst outputs are ephemeral chat text; "trend" claims are impossible without history.

## Tasks

- T1, S1 — CRM: conversions domain module (edges from→to with rates from live-lead transition history, median time-in-stage, loss reasons) + GET /api/reports/conversions. /funnel untouched (dashboard uses it). Tests. Route: inline. Commit: 5d605c9.
- T2, S1 — CRM: analyst_reports table (markdown + metrics snapshot + period + author) + POST/GET routes + migration. Tests. Route: inline. Commit: pending.
- T3, S1 — agent: get_conversion_metrics tool (reads /conversions) + save_analyst_report tool (persists markdown + snapshot). Typecheck. Route: inline. Commit: 588cacb.
- T4, S1 — agent instructions: analyst uses conversions (rates only when honest), minimum-sample rule (n<10: counts + insufficient-data), persists every report, trends only from saved history. Route: inline. Commit: 58a398b.
- T5, S1-S4 — verification: CRM suite + typechecks + API E2E (seed transitions → conversions math checks out → save report → history lists it). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): funnel = stocks; analyst ordered to compute conversions + exactly 3 improvements over 4 leads / 0 losses — fabrication by design. Transition events carry before/after stage + timestamps (changeLeadStage), joinable to live leads.
- L2 (user decisions): "Sí, motor real" + "Sí, persistir" + "Sí, regla".
- L3 (T5 E2E, 2026-10-18, live :8787): seeded 2 leads through API stage moves → conversions show new→researched 5×0.833 (3 real + 2 E2E), researched→contacted/lost 1×0.2 each, lossReasons [timing×1], sufficientData false at n=6. Save report 201 + history lists it. Suite 127/127 + crm/agent typechecks green.
