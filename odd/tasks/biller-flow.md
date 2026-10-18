# Biller flow — read-only cashflow reporting with real amounts

Turns the biller into what the data supports: a read-only cashflow
analyst that reports overdue milestones, unsigned contracts and missing
data with facts — the owner decides who to write to. Amounts become
first-class milestone data; org-draft dedup closes the stacking hole.

## Specs

- S1 (user decisions): "No, reportar" (biller drafts nothing; reports findings, owner decides the recipient) + "Por destinatario" (second pending draft per org+contact recipient is rejected) + "Sí, montos" (amount + currency on milestones).
- S2 (evidence): /api/projects/billing carries zero contact data while the biller must draft "addressed to the client contact" — structurally impossible (contact_required).
- S3 (evidence): milestones have no amount column (title/dueDate/doneAt only) — every reminder would fall into "ask the owner".
- S4 (evidence): T1 dedup covers lead drafts only; org+contact drafts stack on re-runs. projects/milestones/contracts tables hold 0 rows — the path never executed.

## Tasks

- T1, S1 — CRM: amount_cents + currency on milestones (migration + create_project milestonesList support). Tests. Route: inline. Commit: c0c091f.
- T2, S1 — CRM: billing endpoint returns server-side overdueMilestones, unsignedContracts and dueSoonMilestones (7d); no contacts per decision. Tests. Route: inline. Commit: 3ad8cdb.
- T3, S1 — CRM: dedup guard extended to pending drafts per (organizationId, contactId). Tests. Route: inline. Commit: cb72505.
- T4, S1 — agent: biller instructions rewrite (read-only briefing: facts per finding, missing data as questions, never draft/never invent) + get_billing_status passes server flags through. Route: inline. Commit: 9fc0fd8.
- T5, S1-S4 — verification: CRM suite + typechecks + API E2E (seed org+project+milestones+contract → flags → dedup → cleanup). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): billing payload = org ids without contacts; milestones = dates without amounts; org drafts undeduped; tables empty (0/0/0). "Due within 7 days" promised by instructions but never computed anywhere.
- L2 (user decisions): "No, reportar" + "Por destinatario" + "Sí, montos".
- L3 (T5 E2E, 2026-10-18, live :8787): seeded client + project with amounts via API + sent contract → billing flags overdue [(Anticipo, 150000, MXN)] + unsigned [Contrato sitio web], no contacts in payload → org draft 201 pending_approval → duplicate 400 draft_already_pending → cleaned. Suite 131/131 + crm/agent typechecks green.
