# Flujo ideal + CRM — Creapolis.Dev (solo / independiente)

Decisión del dueño (2026-10-16): sirve la propuesta de 3 colas. Prioridad F1. Sumar `closer` y `biller`.

## Principio

Una sola bandeja de entrada, tres colas separadas, todo con rastro en CRM:

- Cola PROSPECCIÓN (outbound, la inicia el dueño)
- Cola INFO/VENTAS (inbound: pregunta por servicios, nuevo o existente) → ticket-info
- Cola SOPORTE (cliente con falla) → ticket-soporte con SLA

Nada externo sale sin aprobación del dueño (Desktop macOS o Telegram). El orquestador hace triage; el dueño puede pedirle "contestale esto al cliente" desde el Chat.

## Fases acordadas (sin cambio efectivo aún)

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
