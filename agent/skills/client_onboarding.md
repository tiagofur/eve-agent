---
description: "Use when a lead signs and becomes a client: the onboarding checklist that turns the win into a running project in the CRM, with expectations set on approvals and weekly reports."
---

# Onboarding de cliente Creapolis.Dev

Objetivo: en la primera semana, el cliente sabe qué esperar, quién aprueba qué, y el proyecto corre en el CRM con hitos y canal definidos.

## Día 0 — cierre a CRM (mecánico)

- Lead → stage `won` → crear **organización** (si no existe) + **contacto** principal verificado + **proyecto** (`create_project`) con estado `onboarding`.
- Guardar el contrato firmado (`save_contract_draft` con estado `signed`) y crear los **hitos** acordados con montos.
- Crear la **factura** del anticipo si aplica (Ventas › Cobros) — el biller la sigue y redacta recordatorios.

## Semana 1 — kickoff

1. **Kickoff call** (agenda `schedule_consultation`): presentar el plan por fases y los hitos; acordar canal primario (email o WhatsApp) y la persona/contacto de decisión.
2. **Expectativas de aprobación** (explicarlo explícito):
   - Todo lo que sale hacia terceros (mensajes, reportes) lo redacta el agente y lo aprueba el owner — el cliente recibe calidad revisada, no respuestas automáticas crudas.
   - Los tickets de soporte abren con severidad y SLA; las correcciones entran al pipeline con revisión de PR.
3. **Reporte semanal**: avisar que cada viernes-ish llega "Avance semanal" por email con logrado / en curso / próximo / pendientes del cliente.
4. **Accesos**: repos, sistemas, credenciales — por canal seguro, nunca por chat plano; registrar en el dossier qué se recibió.

## En el CRM, sin excepciones

- `nextFollowUpAt` del proyecto/organización seteado al siguiente punto de contacto.
- Interacción de kickoff registrada (`log_client_interaction`).
- Suscripciones recurrentes acordadas (hosting/mantenimiento) creadas en Cobros con su cadencia y próxima renovación.

## Reglas duras

- No prometas fechas que no estén en los hitos acordados.
- No pidas credenciales por chat ni las repitas en textos: el owner las maneja.
- Un onboarding incompleto (sin hitos con montos o sin contacto verificado) NO se da por cerrado: se reporta al owner qué falta.
