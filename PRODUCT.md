# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tiago (owner del estudio Creapolis, desarrollo de software): operador principal y único usuario de la consola desktop. Llega con poco tiempo, entre tareas o desde Telegram, y necesita ver el estado del negocio y ejecutar acciones directamente, sin depender del agente.

## Product Purpose

CRM agent-first: Eve (agente eve, 7 subagentes) captura leads, investiga prospectos, hace outreach y gestiona soporte vía chat/Telegram; la app desktop (Tauri v2 + React) es la consola ops del owner para supervisar, auditar y ejecutar el override manual de todo lo que el agente hace. Éxito: el owner puede operar el ciclo completo lead → cliente → proyecto a mano, y toda acción queda trazada.

## Positioning

No es un CRM genérico: es la parte humana de un agente autónomo. Cada flujo automatizado tiene su gemelo manual en desktop (formularios ops + auditoría), y el API exige motivos para las acciones sensibles (cambio de etapa con `reason`, outreach con aprobación previa).

## Operating Context

- CRM API: Hono + Drizzle + PostgreSQL 17 (API 8787, DB 5433). Producción: https://crm.creapolis.dev con deploy automática por GitHub Actions.
- Desktop: Tauri v2 + React, autenticado con owner key; vistas Dashboard, Chat, Leads, Clientes (ficha 360), Proyectos, Tickets, Marketing, Outbox.
- El agente eve corre en este mismo repo (`agent/`) y consume el mismo API que el desktop.
- Regla del estudio: despliegues al VPS solo con plan aprobado previamente.

## Capabilities and Constraints

- Etapas de lead (12, enum cerrado): new, researched, contacted, qualified, discovery, proposal, contract, won, lost, onboarding, active, support. El cambio de etapa exige `reason`; a `lost` se le suma `lostReason`.
- Solo leads en `won` se convierten a proyecto (`POST /api/leads/:id/convert`).
- Eliminar organización borra en cascada sus leads y contactos; la UI debe explicitarlo en la confirmación.
- Auth por scopes: owner/ops para todo lo manual; el chat público usa credenciales separadas (EVE_PUBLIC_USER) con presupuesto diario.
- Decisiones confirmadas por el owner el 2026-10-29 para el override manual: pipeline con toggle Lista ⇄ Kanban; CRUD completo incluyendo endpoints nuevos (crear organización, editar campos de lead, borrar contacto, editar proyecto); borrado mixto (lead → `lost` con motivo; organización y contacto → DELETE con confirmación fuerte; proyecto no se borra, se cierra/cancela).

## Brand Commitments

Nombre: Creapolis. UI del desktop en español, tono directo y operativo. Sin identidad visual formal documentada: el look vigente es dark slate con acentos cyan/por estado (Tailwind), construido incrementalmente — refinarlo, no reemplazarlo.

## Evidence on Hand

- Datos reales en producción (leads, clientes, proyectos, tickets). Regla de QA visual: lecturas contra prod vía `desktop/.env`; mutaciones solo contra API local con key desechable.
- Reportes existentes: embudo de leads (`/api/reports/funnel`), métricas diarias, follow-ups vencidos/próximos.
- Sin testimonios ni material de marketing: no fabricar.

## Product Principles

1. Agent-first con override manual: si Eve puede hacerlo, el owner puede hacerlo a mano desde desktop.
2. Trazabilidad ante todo: toda mutación pide motivo o queda auditada; el destructivo confirma consecuencias explícitas.
3. Datos primero: tablas densas y ficha 360 antes que decoración; la expresión visual vive en los detalles precisos.
4. Una sola fuente de verdad: desktop y agente consumen el mismo API; nunca duplicar estado.

## Accessibility & Inclusion

Español, un único operador experto. Mantener foco visible, Escape cierra overlays (patrón ya establecido en SlideOver/Modal) y contraste legible del tema dark.
