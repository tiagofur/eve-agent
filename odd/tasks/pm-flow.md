# PM flow — strict task machine with verifiable delivery

Makes the delivery loop honest end-to-end: tasks move through an
enforced machine, milestones can't point across projects, coding agents
report verification evidence with every advance, and the pm reads tasks
back to review before any client sign-off.

## Specs

- S1 (user decisions): "Sí, estricta" (backlog→ready→dispatched→in_progress→in_review→done, blocked + regulated reopens, bad jumps rejected) + "Sí, evidencia" (resultSummary on status advances: what ran + outcome; pm reviews it, never signs off blind).
- S2 (evidence): createTask validates nothing (ghost projectId = 500, cross-project milestoneId silent); updateTaskStatus allows any jump including ready→done.
- S3 (evidence): no resultSummary field exists; pm "verifies PRs" with no instrument (no repo/PR access, no evidence channel).
- S4 (evidence): no agent tool reads tasks back (dispatch-only); projects/tasks tables hold 0 rows — the path never ran.

## Tasks

- T1, S1 — CRM: task machine validation + milestone-belongs-to-project + project-exists checks (clean 4xx, never 500). Tests. Route: inline. Commit: 3d6c741.
- T2, S1 — CRM: resultSummary column (migration) accepted on PATCH status and returned everywhere tasks show. Tests. Route: inline. Commit: 6d8c0f6.
- T3, S1 — agent: get_project_tasks read tool + lib; pm instructions (QA on resultSummary+prUrl, no sign-off without evidence, honest failures). Typecheck. Route: inline. Commit: 4be0693.
- T4, S1-S4 — verification: CRM suite + typechecks + API E2E (dispatch → advance with evidence → bad jumps rejected → read-back). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): free jumps, unvalidated links, no evidence channel, no read tool; pickup list (/tasks/ready, dev scope) is the one healthy piece.
- L2 (user decisions): "Sí, estricta" + "Sí, evidencia".
- L3 (T4 E2E, 2026-10-18, live :8787): dispatch ready → bad jump ready→done 400 → advances with resultSummary + prUrl → project readback shows evidence → in_review correctly absent from the coder pickup list → cleaned. Suite 145/145 + crm/agent typechecks green.
