# Flujo ideal + CRM — Creapolis.Dev (solo / independiente)

Decisión del dueño (2026-10-16): sirve la propuesta de 3 colas. Prioridad F1. Sumar `closer` y `biller`.

## Principio

Una sola bandeja de entrada, tres colas separadas, todo con rastro en CRM:

- Cola PROSPECCIÓN (outbound, la inicia el dueño)
- Cola INFO/VENTAS (inbound: pregunta por servicios, nuevo o existente) → ticket-info
- Cola SOPORTE (cliente con falla) → ticket-soporte con SLA

Nada externo sale sin aprobación del dueño (Desktop macOS o Telegram). El orquestador hace triage; el dueño puede pedirle "contestale esto al cliente" desde el Chat.

## Fases acordadas (sin cambio efectivo aún)

## Seguimientos multi-slot (Nivel 1 hecho, Nivel 2 diseñado)

Regla vigente (Nivel 1): cada entidad tiene UN slot de próxima acción — lead, ticket,
organización y contacto (`next_follow_up_at + follow_up_note`). El slot de la
organización es "lo próximo del cliente"; los de contacto/lead/ticket son temas
puntuales. El digest, el Dashboard y closer agregan todos. Suficiente para
operación de una persona.

Nivel 2 (solo cuando haya multi-usuario, NO construir antes): tabla `follow_ups`:

- Links polimórficos: `lead_id, organization_id, ticket_id, project_id, contact_id`
  (nullable, al menos uno requerido, igual que `interactions`).
- `assignee TEXT NOT NULL` (quién lo tiene que hacer), `due_at TIMESTAMPTZ NOT NULL`,
  `note TEXT`, `status` (`open | done | cancelled`, default `open`).
- `created_by`, `created_at`, `updated_at`, `done_at`.
- Digest y Dashboard filtran por `assignee`; closer toma los vencidos del dueño;
  el historial vive en la tabla (ya no hacen falta eventos para esto).
- Migración sin pérdida: cada slot actual no-nulo se convierte en una fila `open`
  con `assignee = owner`. Los endpoints `*/followup` pasan a escribir filas.

Con esto, varios seguimientos activos por entidad y por usuario, sin rediseño.

- **F0 — Alinear:** fix stages `LeadsView` vs schema real, docs (`schedule_consultation` ya es real, `whatsapp.ts` es echo placeholder).
- **F1 — Seguimiento (PRIORIDAD ACTUAL):** Clientes 360°, convertir lead→cliente, follow-ups, tickets info vs soporte, outbox para clientes, hilos unificados.
- **F2 — Contacto externo:** webchat embed → `/api/chat`, luego WhatsApp Cloud API real, envío real de outbox aprobado (Resend).
- **F3 — Marketing completo:** calendario, cross-post IG, reutilización de casos.

Detalle operativo de F1: ver `odd/tasks/f1-seguimiento-clientes.md`.

## Agentes

Se mantienen los 7 actuales (orquestador + prospector, support, marketing, pm, solutions, analyst, legal).
Se suman en planificación (no implementados todavía):

- **closer/follow-up:** recorre vencidos (`next_follow_up_at`), redacta seguimientos vía outbox, nunca envía solo.
- **biller/cobros:** contratos + hitos + recordatorios de pago.

`release/QA` queda dentro de `pm` por ahora.
