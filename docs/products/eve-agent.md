---
slug: eve-agent
nombre: Agente Eve (orquestador + equipo de subagentes)
tipo: producto_interno
resumen: Agente de operaciones construido con el framework eve: 1 orquestador + 9 subagentes especializados, 27+ tools, canales Telegram y chat web, con gates humanos en todo lo externo.
audiencia: Negocios que quieren delegar operación real (no chats) a agentes de IA con supervisión
palabras_clave: agente, ia, subagentes, orquestador, eve, telegram, automatizacion, tools, hitl
---

# Agente Eve — el equipo de IA de Creapolis

## Qué es

El agente que **opera el negocio**: construido con el framework open-source `eve`, corre en Docker en el VPS y habla por Telegram (canal interno del owner) y chat web público (visitantes, con presupuesto diario). Un orquestador hace triage y delega a subagentes especializados.

## Qué hace

- **Equipo de subagentes**: `analyst` (inteligencia/reportes), `prospector` (investigación de prospectos y dossiers), `marketing` (contenido y outreach), `closer` (seguimientos), `solutions` (diagnóstico técnico), `support` (tickets SLA), `biller` (estimados/contratos), `legal`, `pm`.
- **27+ tools**: registrar leads, crear dossiers, drafts de outreach (siempre `pending_approval`), tickets, proyectos, estimados, métricas del CRM, búsqueda web.
- **Rutinas agendadas**: reporte diario de ops 9:00 con cuellos de botella y 3 mejoras, digest de seguimientos, passes del `closer`.
- **Seguridad pública/interna**: credenciales duales (usuario público ≠ staff), tools de staff bloqueadas al chat público, presupuesto diario de tokens.
- **Canal Telegram**: aprobación de drafts con botones inline desde el móvil.

## Para quién

- El propio estudio: operación diaria (prospección, soporte, reportes) sin contratar un equipo.
- Clientes: el patrón "orquestador + subagentes + gates" es lo que Creapolis implementa a medida.

## Diferencia

- Agentes que **hacen trabajo verifiable** (drafts en DB, tickets con SLA, PRs de código) en vez de solo conversar.
- HITL real: no existe tool que envíe algo externo sin aprobación — está ausente por diseño.
- Multicanal con presupuestos y guardrails por principal: seguro para exponer al público.

## Casos de uso

1. Reporte diario del pipeline con 3 acciones concretas propuestas.
2. Investigar un prospecto y dejar el dossier + draft de outreach listo para aprobar.
3. Responder el chat público de la web capturando leads al CRM sin fugar costo.

## Ángulos de marketing

- "Contratamos a un equipo de 9 y resultó ser 1 agente + 1 humano que aprueba."
- La seguridad aburida que sí importa: presupuesto diario del chat público, tools de staff fuera del alcance público.
- Mostrar el reporte diario real (con datos) como pieza de contenido recurrente.

## Stack

Framework eve (TypeScript) · modelado vía AI SDK · Docker · canales Telegram + web chat · schedules cron.
