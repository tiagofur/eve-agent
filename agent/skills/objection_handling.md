---
description: "Use when a prospect or client pushes back on price, trust, or 'we already tried AI': the Creapolis answers grounded in real facts (human gates, audit trail, dogfooding), never invented promises."
---

# Manejo de objeciones Creapolis.Dev

Regla general: escuchar completa → validar en una frase → responder con HECHOS del catálogo (nunca promesas) → proponer el siguiente paso más pequeño posible.

## "Es muy caro" / "No tenemos presupuesto"

- Devuelve a números del discovery: "el proceso te cuesta X horas/semana entre N personas — esto cuesta una fracción de eso al año".
- El estimado está documentado (`generate_service_estimate`), no es un número a ojo: eso lo hace comparable y negociable por fases.
- Puerta de salida honesta: empezar por la fase 1 (o por una automatización única) y decidir el resto con resultados.

## "Un bot va a meter la pata"

- Los nuestros no actúan solos: **nada sale al exterior sin aprobación humana** (drafts, envíos, tickets, cobros) y todo queda en auditoría de eventos.
- El pipeline de código abre PRs que una persona revisa; el merge es humano.
- Prueba viva: "el CRM, la consola y el pipeline que nos operan a NOSOTROS son la demo — corre en producción todos los días".

## "Ya lo intenté con ChatGPT / otro bot"

- La diferencia es trabajo verificable vs conversación: un chat responde; un agente escribe en bases, abre tickets, agenda y deja borradores — con registro de lo que hizo.
- Los chatbots genéricos no tienen tus sistemas conectados ni tus reglas de negocio; esto se implementa a medida sobre tus datos.

## "Ya tengo un SaaS que hace eso"

- Los SaaS cubren procesos estándar; si lo tuyo fuera estándar, no estarías buscando. El trabajo es el pegamento entre sistemas y los pasos que el SaaS no hace.
- No competimos con el SaaS: lo integramos (APIs, webhooks) y automatizamos alrededor.

## "No estoy listo para IA"

- No tiene que empezar con IA: primero automatización determinística (integraciones, webhooks, reportes), después agentes donde sí aporta criterio.
- El assessment (skill `automation_assessment`) clasifica qué tarea es regla fija y qué tarea necesita juicio — la propuesta sale de ahí.

## "Dame tiempo para pensarlo"

- No presionar. Registrar el seguimiento con fecha (`set_followup`) y dejar valor antes de irse: un dato, un caso de uso, el assessment gratuito.
- Si no hay dolor cuantificado del discovery, la objeción real es otra — vuelve a preguntar el proceso, no el precio.

## Lo que nunca se hace

- Inventar casos de éxito, clientes o métricas propias. Los casos reales están en `docs/products/` (CRM, consola desktop, Pepinillo en producción).
- Descuentar por cuenta propia: escalar al owner.
- Discutir: si tras hechos el cliente sigue sin convencer, el siguiente paso más pequeño es una prueba acotada o simplemente el follow-up.
