---
slug: servicio-agentes-ia
nombre: Agentes de IA para negocio
tipo: servicio
resumen: Diseño e implementación de agentes de IA que hacen trabajo real (no chats): operación de CRM, soporte, prospección y código, con gates humanos y presupuestos bajo control.
audiencia: Empresas que ya probaron chatbots y quieren agentes que ejecuten trabajo verificable
palabras_clave: agentes ia, ai agents, llm, orquestador, subagentes, hitl, chatbot, soporte, prospeccion
---

# Servicio: agentes de IA para negocio

## Qué es

La especialidad de la casa: **agentes que trabajan**. Un orquestador que entiende el negocio + subagentes especializados + tools conectadas a los sistemas reales del cliente (CRM, email, tickets, GitHub), con aprobación humana en todo lo que sale al exterior. El sistema interno de Creapolis (Eve + CRM + worker) es la demo en vivo: el mismo patrón, implementado a la medida del cliente.

## Qué incluye

- Diseño del equipo de agentes (roles, tools, límites) sobre framework eve (open source).
- Integración con los sistemas del cliente vía APIs/tools seguras.
- Guardrails: gates de aprobación, presupuestos diarios por canal, separación público/interno.
- Canales: Telegram, WhatsApp, web chat, o embebido en sus sistemas.
- Métricas de lo que el agente hizo: drafts aprobados, tickets resueltos, horas ahorradas.

## Para quién

Equipos de soporte saturados; comerciales que no alcanzan a hacer follow-up; estudios dev que quieren agentes de código con revisión; cualquier operación con tareas de texto/datos repetitivas y criterio.

## Diferencia

- **Trabajo verificable, no conversación**: el agente escribe en bases, abre PRs, agenda, factura borradores — siempre auditado.
- Seguridad primero: nada externo sale sin humano; chat público aislado con presupuesto propio.
- Dogfooding extremo: vendemos lo que nos opera a nosotros todos los días, con números propios.

## Casos de uso

1. Agente de soporte nivel 1 que resuelve el 60% de tickets y escala el resto con contexto.
2. Agente comercial que investiga prospectos y deja drafts de outreach listos.
3. Agente de operaciones que produce el reporte diario y persigue seguimientos vencidos.

## Ángulos de marketing

- Contenido educativo: qué es un "gate", por qué un agente sin gate es un riesgo.
- Demos con números propios: drafts aprobados/semana, tiempo del reporte diario.
- Serie "así opera Creapolis con agentes" mostrando pantallas reales del sistema.

## Stack

Framework eve · AI SDK · tools TypeScript · channels Telegram/web · gates HITL propios.
