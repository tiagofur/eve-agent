---
slug: desktop-console
nombre: Consola Desktop Creapolis
tipo: producto_interno
resumen: App nativa macOS (Tauri v2 + React) donde el owner supervisa todo el sistema y ejecuta el override manual de cada flujo del agente.
audiencia: Dueños/operadores que quieren control total sobre agentes de IA desde una app nativa
palabras_clave: desktop, tauri, react, consola, override manual, kanban, aprobaciones, macos
---

# Consola Desktop Creapolis

## Qué es

La **consola de operaciones** del owner: app nativa para macOS (Tauri v2, arm64) en español, oscuro-slate con acentos cyan/esmeralda. Es el gemelo manual de todo lo que el agente hace: si Eve puede hacerlo, el owner puede hacerlo a mano desde aquí.

## Qué hace

- Vistas: **Dashboard** (métricas del día), **Chat** con el orquestador, **Marketing Studio**, **Outbox** (aprobaciones HITL), **Leads** (pipeline Lista⇄Kanban + CRUD), **Clientes** (ficha 360 con contactos, interacciones, forms de edición), **Proyectos** (tareas/correcciones), **Tickets** (SLA).
- Override manual completo: crear/editar leads, organizaciones, contactos y proyectos; borrado con confirmaciones fuertes que explicitan consecuencias.
- QA visual integrado: la app apunta a producción para lecturas y a API local para mutaciones.
- Se instala en `/Applications` como app nativa (DMG firmado del build de Tauri).

## Para quién

El owner del estudio (operador único hoy); patrón reutilizable para clientes que exigen control directo además del bot de Telegram.

## Diferencia

- No es un dashboard de solo lectura: **cada flujo del agente tiene su formulario manual equivalente** con las mismas reglas (motivos obligatorios, confirmaciones destructivas).
- Datos primero: tablas densas y ficha 360; la expresión visual está en los detalles, no en decoración.
- Nativa y liviana: Tauri (no Electron), una fracción del consumo.

## Casos de uso

1. Revisar el pipeline en kanban y mover un lead a mano con motivo, sin esperar al agente.
2. Aprobar/rechazar drafts de outreach del outbox con el detalle del contacto visible.
3. Operar el ciclo completo lead → cliente → proyecto un viernes sin agente.

## Ángulos de marketing

- "El bot propone, la app nativa dispone": HITL que no estorba.
- Tauri v2 + React: 3 MB en vez de 150 MB de Electron — detalle que a devs les encanta.
- Antes/después: la misma operación hecha por el agente y a mano desde la consola.

## Stack

Tauri v2 · React + TypeScript · Tailwind (dark slate + cyan/emerald) · API del CRM con owner key.
