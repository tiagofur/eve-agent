---
slug: gentle-worker
nombre: Gentle-shell Worker (correcciones automáticas)
tipo: producto_interno
resumen: Worker en el VPS que toma tickets de corrección, ejecuta un agente de código en sandbox, abre PR, y cierra el ciclo ticket→fix→PR→merge con gates humanos.
audiencia: Equipos dev que quieren convertir bugs reportados en PRs listas sin intervenir el flujo
palabras_clave: worker, correcciones, tickets, pull requests, sandbox, vps, ci, automatizacion dev
---

# Gentle-shell Worker — pipeline de correcciones

## Qué es

El pipeline que convierte **un ticket de soporte en un PR merged**: los tickets de corrección (kind `correction`) pasan GATE 1 (triage), se autodespachan a un worker que corre en el VPS con claim atómico y lease de 4h, el agente de código trabaja en sandbox (gentle-shell), abre el PR, CI valida, el owner revisa y mergea (GATE 2), el bot notifica al cliente y cierra el ticket. Queda draft de manual de lo corregido (GATE 3).

## Qué hace

- Cola segura: claim atómico por ticket (dos workers no pisan el mismo trabajo), lease renovable, reintentos.
- Ejecución aislada: el agente de código corre en el VPS con las credenciales mínimas; nada llega a producción sin PR + CI + revisión humana.
- Cierre de ciclo: notificación automática al cliente, ticket resuelto, tarea done, draft de manual generado.
- Traza completa en el CRM: `task_runs` con estado running/succeeded/failed + eventos de auditoría.

## Para quién

El estudio (mantiene sus propios productos); patrón vendible a cualquier equipo con backlog de bugs y CI.

## Diferencia

- No es "IA que escribe a producción": es un **pipeline con 3 gates humanos** y reversión disponible (imágenes `:previous`).
- Ciclo demostrable de punta a punta: ticket → PR → merge → cliente notificado, con tiempos medibles.

## Casos de uso

1. Bug reportado por un cliente a las 8am → PR con fix y tests a las 10am esperando revisión.
2. Backlog de deuda técnica menor que se drena en tandas supervisadas.

## Ángulos de marketing

- "Nuestros bugs se despachan solos; nosotros solo revisamos el PR" — con la traza real de un ciclo.
- Lease de 4h y claim atómico: la ingeniería aburrida que evita desastres con agentes autónomos.
- El ticket #0659d873: historia completa de un fix automático, de reporte a manual.

## Stack

Node/tsx en Docker (VPS) · claim atómico en Postgres · agente de código en sandbox · GitHub Actions CI · notificación Telegram.
