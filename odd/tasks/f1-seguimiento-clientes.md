# F1 — Seguimiento y clientes 360° (planificación, sin implementar)

## Specs

- S1: "hoy solo puedo hacer una interaccion con prospecto, no puedo dar seguimiento, convertirlo en cliente, etc."
- S2: "no tenemos creo un apartado de clientes para que en el CRM pueda ver el historial y que seguimiento tengo que hacer a este cliente"
- S3: "cuando sea informacion para clientes nuevos o existentes para servicios que genere un 'tiket' en otra area"
- S4: "que todo quede en algun lugar que yo pueda dar seguimiento... y responder o pedir al agente orquestrador que conteste algo al cliente"
- S5: "quiero el flujo ideal para mi perfil sea de contacto externo o solicitudes internas de mi parte a los agentes"
- S6: "planeamos todo antes de cualquier cambio efectivo en las apps"
- S7: "sirve, si F1 por ahora y seguimos con lo demas, suma" (sumar closer y biller)

## Tasks

- T1 (S1, S2): Vista Clientes 360° en Desktop — ficha por organization: contactos, leads históricos, proyectos, tickets, interacciones, contratos, próximo seguimiento. Ruta: docs + CRM API + Desktop. Commit: T1 (ver git log feat: T1 clientes 360).
- T2 (S1): Convertir lead→cliente/proyecto en un clic + alinear stages LeadsView con schema real (`new/researched/contacted/...`, no `intake/qualifying/...`). Ruta: CRM + Desktop. Commit: T2 (ver git log feat: T2 convertir lead).
- T3 (S1, S2): Follow-ups (`next_follow_up_at + nota`) en lead/cliente/ticket + alertas Dashboard/Telegram. Ruta: CRM + Desktop + bot. Commit: T3 (5aa823e).
- T4 (S3): Dos tipos de ticket: `support` (SLA 1h/4h/24h actual) e `info/sales` (SLA comercial 24h) + estados `nuevo → triage → asignado → esperando cliente → resuelto`. Ruta: CRM + Desktop. Commit: T4 (d65d55e).
- T5 (S1, S4): Interactions polimórficas (lead | cliente | ticket | proyecto) + hilos unificados por contacto con botón "pedir al orquestador que conteste". Ruta: CRM + Desktop + `/api/chat`. Commit: -
- T6 (S4): Outbox para clientes existentes (hoy exige `leadId`). Ruta: CRM + Desktop. Commit: -
- T7 (S7): Nuevos subagentes `closer` y `biller` (solo planificación: propósito, tools, HITL). Ruta: agent/. Commit: -

F0/F2/F3 quedan fuera de este documento hasta que F1 esté diseñado al detalle.

## Log

- L1 (pedido original verbatim): "revisa todo lo que son los agentes, tools, skills, etc... dentro de EVE para que tengamos certeza que todo este bien, otro tema, tenemos un flujo interno para buscar prospecto y definir que servicios ofrecer, sus contacto, borrador de contacto, etc... agente de marketing para redes que genere desde el texto, imagen, y que aprobando lo postea en las redes... y demas agentes que puedan ser utiles en una desarrolladora de software 'independiente' por asi decir o de un hombes solo... tambien el flujo de contacto para clientes desde nuevos a ya existentes... desde un chat bot que pondremos en nuestra pagina o whatsapp que integraremos a futuro... con sus tikets en caso de que sea soporte, cuando sea informacion para clientes nuevos o existentes para servicios que genere un 'tiket' en otra area... en fin, flujos para contacto y soporte... que todo quede en algun lugar que yo pueda dar seguimiento... y responder o pedir al agente orquestrador que conteste algo al cliente... quiero el flujo ideal para mi perfil sea de contacto externo o solicitudes internas de mi parte a los agentes. tenemos un CRM que es una app para MacOS que yo debo de poder hacer todo lo que sea posible desde su interfaz, ver datos de contacto, tickets, marketing, prospectos (hoy solo puedo hacer una interaccion con prospecto, no puedo dar seguimiento, convertirlo en cliente, etc.) no tenemos creo un apartado de clientes para que en el CRM pueda ver el historial y que seguimiento tengo que hacer a este cliente... mejoramos nuestro CRM y agentes para que podamos hacer todo que necesitamos... sugiera que funciones debemos de tener para tener este flujo ideal, planeamos todo antes de cualquier cambio efectivo en las apps."
- L2 (2026-10-16): Dueño confirma "sirve, si F1 por ahora y seguimos con lo demas, suma" → se suma closer + biller solo a nivel plan.
