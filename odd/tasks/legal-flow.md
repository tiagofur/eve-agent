# Legal flow — contracts API with enforced signing machine

Gives contracts what the schema comment always demanded: a real API
with a strict status machine, owner-only signing, and persisted drafts
with reviewer flags — so legal output lives in the CRM instead of chat.

## Specs

- S1 (user decisions): "Sí, solo owner" (`signed` requires owner scope) + "Sí, estricta" (draft → in_review → sent → signed; void from any non-terminal state with a stored reason).
- S2 (evidence): legal has zero tools (pure chat responder); no contracts API exists anywhere (only embedded reads in /billing); the demo rows (Enviado/Firmado/Anulado) prove nothing runs through it.
- S3 (evidence): status flow unenforced — draft→signed flippable by anyone with DB access; reviewer flags have nowhere to land.
- S4 (evidence): contracts carry leadId/projectId links but nothing writes them from agent-land.

## Tasks

- T1, S1 — CRM: contracts API (POST draft + PATCH status with strict machine, owner-only signed/void-signed, void_reason column + migration, reviewerNote) + GET list/by-project. Tests. Route: inline. Commit: 655fb23.
- T2, S1 — agent: save_contract_draft + update_contract_status tools + lib fns. Typecheck. Route: inline. Commit: 6a1477e.
- T3, S1 — agent instructions: legal saves every draft (reviewerNote flags), moves in_review→sent, never signs; honest failures. Route: inline. Commit: 4cd37a2.
- T4, S1-S4 — verification: CRM suite + typechecks + API E2E (draft → review → send → owner-sign + void-reason + rejected bad jumps). Route: inline. Commit: pending.

## Log

- L1 (diagnosis, 2026-10-18): zero legal tools; zero contract routes; unenforced statuses; reviewer notes homeless. 3 demo rows, 0 real contracts.
- L2 (user decisions): "Sí, solo owner" + "Sí, estricta".
- L3 (T4 E2E, 2026-10-18, live :8787): draft → in_review → sent → ops-sign 403 owner_only → owner-sign signed → bad jump draft→sent 400 → void with stored reason → cleaned. Suite 140/140 + crm/agent typechecks green.
