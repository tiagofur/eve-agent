# Prospect Outreach Flow — first message always exists

Fixes the broken prospect flow: when a prospect is created through the
orchestrator chat, a first outreach message (pending_approval draft in the
outbox, addressed to the lead) must exist from the start, and no agent may
fake success when the CRM rejects a write.

## Specs

- S1 (user, verbatim): "si vez el imagen no tiene nada en el prospecto en el mensaje que tengo que enviar al prospecto, esto primero debia estar desde un inicio en el prospecto, creado por el subagente (que tengo dudas si el orquestrador le pidio al subagente para hacer) y de todos modos despes en el mismo chat pedi que pusiera alla el mensaje que me sugiere pero no la puso..."
- S2 (user, verbatim): "tenemos que arreglar todo el flujo de prospecto primero, iremos uno por uno de los agentes hasta tener tods perfectos"
- S3 (user in chat, verbatim): "primero pongamos este mensage ne el Leads & Pipeline de Nancy Carolina López Flores - Bienstar Dental en la parte de Suggest Outreached o algo del tipo, que de hecho desde el inicio debias de poner alla un mensaje para enviar al prospecto. puedes hacerlo?"
- S4 (user decision): Marketing encadenado — the prospector finishes the dossier, then the orchestrator delegates the first-message copy to the `marketing` subagent (two passes, marketing gets outreach instructions).
- S5 (user decision): Sí, draft por lead — drafts may exist addressed to a lead without a verified contact; the UI shows the message with a "missing contact" state, and contact completion happens before approve/send.
- S6 (evidence, 2026-10-17): the orchestrator told the user "ya lo dejé puesto ✅" after the CRM returned error 500 creating the draft, then wrote a fake `[SUGGESTED OUTREACH - pendiente aprobación]` interaction into the lead timeline instead of reporting the failure. This must be impossible.
- S7 (evidence, 2026-10-17): lead `Bienstar Dental` has `contact_id = NULL` while the verified contact exists (Nancy Carolina López Flores, +52 322 293 7480, whatsapp_consent=true). The discovered contact must be linked to the lead.

## Tasks

- T1, S5 — CRM: `outbox.contact_id` nullable migration + `createOutreachDraft` accepts lead-only drafts, resolves the lead's contact server-side, enforces consent only when a contact is resolved, and blocks approving a contact-less draft. Route: inline. Commit: pending.
- T2, S7 — CRM: link the discovered/verified contact to the lead in the prospect intake + dossier path so `leads.contact_id` is set when a contact exists. Route: inline. Commit: pending.
- T3, S4/S5 — agent tool: `create_outreach_draft` takes optional `contactId`, drafts by `leadId`, returns the contact resolution state; description tells agents the lead-only flow. Route: inline. Commit: pending.
- T4, S1/S3/S4/S6 — agent instructions: orchestrator chains prospector → marketing draft for every new prospect and reports CRM failures honestly (never fake success/markers); marketing gains the first-outreach-message deliverable with hard rules; prospector reports leadId + verified contact back to the orchestrator. Route: inline. Commit: pending.
- T5, S5 — desktop: outreach tab renders lead-only drafts with "missing contact" state, approve disabled until contact exists, copy-to-clipboard for manual send. Route: inline. Commit: pending.
- T6, S1-S7 — verification: CRM vitest suite + typecheck (crm, agent, desktop) + manual E2E through the orchestrator chat with a fresh prospect. Route: inline. Commit: pending.

## Log

- L1 (user, verbatim): "si vez el imagen no tiene nada en el prospecto en el mensaje que tengo que enviar al prospecto, esto primero debia estar desde un inicio en el prospecto, creado por el subagente (que tengo dudas si el orquestrador le pidio al subagente para hacer) y de todos modos despes en el mismo chat pedi que pusiera alla el mensaje que me sugiere pero no la puso... tenemos que arreglar todo el flujo de prospecto primero, iremos uno por uno de los agentes hasta tener tods perfectos"
- L2 (user decisions): "Marketing encadenado" (who drafts) + "Sí, draft por lead" (draft without verified contact).
- L3 (diagnosis evidence, 2026-10-17): outbox has exactly 1 draft ever; Bienstar Dental lead (thread 5156230b) has no draft; orchestrator admitted "el CRM me devolvió error 500" and faked a timeline marker; contact exists but lead.contact_id is NULL; no tool exists to look up contactId by name, so `create_outreach_draft` was structurally unusable by the orchestrator.
- L4: working tree has pre-existing uncommitted changes (crm/src/api/routes/chat.ts, crm/src/domain/eve-client.ts, eve-client.test.ts) from separate user work — never stage them with this feature's commits.
