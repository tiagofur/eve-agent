---
description: "Use before or during a discovery call: the question flow to quantify a prospect's pain, map their systems, and end with a concrete next step registered in the CRM."
---

# Guion de discovery Creapolis.Dev

Objetivo: salir de la llamada con (1) el dolor cuantificado, (2) los sistemas involucrados, (3) un siguiente paso acordado — todo registrado en el CRM.

## Apertura (2 min)

- "La idea es entender tu operación hoy, no venderte nada todavía."
- Confirma rol de la persona y quién decide la compra (si no decide: el discovery incluye "¿quién más debería estar?").

## El proceso actual (el corazón, 15 min)

1. **Camina el proceso**: "Cuéntame qué pasa desde que llega X hasta que sale Y, paso por paso."
2. **Volumen y frecuencia** (cuantifica SIEMPRE): ¿cuántas veces al día/semana? ¿cuántas personas lo tocan? ¿cuánto tarda cada vuelta?
3. **Herramientas**: ¿en qué está registrado hoy? (hojas de cálculo, WhatsApp, SaaS, papel) ¿qué se copia y pega entre sistemas?
4. **Errores y cuellos**: ¿dónde se pierde, se duplica o se olvida? ¿cuál fue la última vez que dolió?

## Contexto comercial (5 min)

- ¿Qué pasó para que ahora lo busquen? (urgencia real vs curioseo)
- ¿Ya intentaron resolverlo? (con qué, por qué no funcionó — oro para objeciones después)
- Presupuesto y timeline: "proyectos como este van de X a Y; ¿dónde te sientes cómodo?" — si no hay rango del owner, pregunta sin prometer.

## Cierre (3 min)

- Devuelve en 3 líneas lo que entendiste y EL cuello de botella.
- Siguiente paso concreto y con fecha: propuesta con estimado, demo del CRM/pipeline, o segunda llamada con el decisor.
- Registrar TODO en el CRM en la misma sesión: interacción (`log_client_interaction`) + notas al dossier (`save_prospect_dossier`) + seguimiento (`set_followup`). Lo que no se registra no existió.

## Qué NO hacer

- No prometas soluciones ni plazos en la llamada: "te lo confirmo en la propuesta".
- No llenes silencios: el cliente pensando está dando información.
- No vendas agentes de IA a quien necesita primero una automatización simple: diagnostica con honestidad (ver skill `automation_assessment`).
