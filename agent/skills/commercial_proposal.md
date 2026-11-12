---
description: "Use when drafting a commercial proposal for a prospect or client: structure, the evidence rules (amounts only from the estimate tools), and the closing next step."
---

# Propuesta comercial Creapolis.Dev

Estructura fija, en español, sin relleno. Cada sección responde una pregunta que el cliente tiene en la cabeza.

## 1. Contexto (3-4 líneas)

- Lo que el cliente contó (discovery, tickets, dossier): su proceso, su dolor, su objetivo.
- Solo hechos registrados. Si no hay discovery, pide uno antes de proponer: proponer a ciegas es cómo se pierde credibilidad.

## 2. El problema en concreto

- Reformula el dolor en términos medibles: horas semanales, errores, retrasos, dinero.
- Si el cliente no dio números, nombra la categoría del costo sin inventar cifras.

## 3. La solución propuesta

- El servicio correcto del catálogo (ver `docs/products/servicio-*.md`): desarrollo a medida, automatización, agentes de IA o consultoría. Nombra UNO como centro; los demás solo si hay evidencia de que aplican.
- Qué entrega y qué NO entrega (alcance negativo evita disputas).
- Guardrails que nos distinguen: aprobación humana en lo que sale al exterior, auditoría de eventos, pipeline con revisión en cada PR.

## 4. Fases y entregables

- 2-4 fases, cada una con entregable verificable y timeframe realista ("2-3 semanas").
- Cada fase ↔ un hito del CRM (el que paga se puede volver factura).

## 5. Inversión

- Montos: SOLO de `generate_service_estimate` + `save_service_estimate`. Si no hay estimado guardado, primero genera y guarda; una propuesta sin monto se marca como borrador para el owner.
- Nunca inventes precios, ni "aproximados". Si el cliente pide descuento, escala al owner.

## 6. Garantías de operación

- CI, deploy automático con rollback, runbook, opción de mantenimiento con el pipeline de correcciones.
- Propiedad total del código para el cliente.

## 7. Próximo paso

- UN paso concreto: aprobar la propuesta, agendar kickoff (`schedule_consultation`), o una prueba acotada.

## Reglas duras

- Montos, plazos y alcance: solo de tools y docs. Una afirmación sin fuente se corta antes de enviar.
- Todo draft va a `pending_approval`: el owner aprueba antes de que salga.
- Formato: corto (el cliente lee en el móvil), headers claros, cero jerga interna (no mencionar "eve", "subagentes" ni nombres de tools).
