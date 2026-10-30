---
slug: creapolis-crm
nombre: Creapolis CRM
tipo: producto_interno
resumen: CRM agent-first con API REST (Hono), PostgreSQL 17 y auditoría total: el agente captura y trabaja los leads, el owner supervisa y aprueba.
audiencia: Estudios y pymes que quieren un CRM operado por un agente de IA sin perder control humano
palabras_clave: crm, leads, pipeline, kanban, api, postgres, hono, auditoria, outbox, tickets
---

# Creapolis CRM

## Qué es

El corazón del sistema Creapolis: un CRM donde **el agente hace el trabajo y el humano aprueba**. Cada lead, ticket, proyecto y outreach queda registrado con auditoría (tabla `events` con before/after, actor y motivo). En producción en `https://crm.creapolis.dev` (VPS propio, deploy automático por GitHub Actions).

## Qué hace

- **Pipeline completo**: 12 etapas de lead (new → won/lost/onboarding/active/support), cambio de etapa exige motivo, conversión lead→proyecto solo desde `won`.
- **Captación multicanal**: chat público web (con presupuesto diario propio), Telegram, el agente registra leads con dedup de organizaciones.
- **Outreach HITL**: el agente redacta drafts de primer contacto → quedan `pending_approval` → el owner aprueba desde desktop o Telegram. Nada se envía solo.
- **Soporte con SLA**: tickets support/info con severidades, autodespacho GATE1/GATE2 y worker de correcciones.
- **Ficha 360**: organización, contactos, interacciones, proyectos, tickets y estimados en una sola vista.
- **Override manual completo**: todo lo que hace el agente lo puede hacer el owner a mano desde desktop (CRUD de leads/orgs/contactos/proyectos, pipeline Lista⇄Kanban).
- **API REST por scopes**: `front` (captación), `ops` (agentes), `owner` (desktop), keys hasheadas en DB.

## Para quién

El propio estudio (dogfooding real: es el CRM con el que opera Creapolis) y como demo viva del servicio de agentes de IA: "nuestro CRM lo opera un agente, el nuestro puede operar el tuyo".

## Diferencia

- No es un CRM SaaS genérico: es **la parte humana de un agente autónomo** — cada flujo automático tiene su gemelo manual.
- Trazabilidad radical: toda mutación pide motivo y queda auditada.
- Autosuficiente: corre en un VPS de ~$20/mes, sin licencias SaaS por usuario.

## Casos de uso

1. Estudio solo/indie que necesita pipeline + outreach sin pagar por asientos.
2. Captar desde chat web público con control de costo (presupuesto diario).
3. Auditoría de cada acción comercial para rendir cuentas a clientes/socios.

## Ángulos de marketing

- "Nuestro CRM nos entrevista a nosotros: el agente investiga, redacta y nosotros solo aprobamos."
- El pipeline kanban con toggle Lista⇄Kanban hecho en una tarde por un agente de código.
- 16+ tablas Postgres, auditoría de cada cambio: control sin fricción.
- Anti-buzzword: no vendemos "IA mágica", enseñamos los gates donde el humano dice sí o no.

## Stack

Hono (REST) · Drizzle ORM · PostgreSQL 17 · Docker · GitHub Actions (deploy automático + rollback) · Telegram daemon integrado.
