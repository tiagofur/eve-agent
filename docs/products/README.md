# Documentación de productos y servicios Creapolis

Fuente canónica de **qué es y qué hace cada producto/servicio de Creapolis.Dev**, pensada para que los agentes de marketing creen contenido grounded (sin inventar features) y para que cualquier subagente responda sobre el catálogo.

## Reglas de uso (para agentes)

- Todo contenido de marketing sobre un producto o servicio **debe salir de estos docs**. Si algo no está aquí, no se afirma.
- Para buscar: tool `search_product_docs` (o `GET /api/products/search?q=` del CRM).
- Los docs con `tipo: pendiente` son placeholders: no generar contenido sobre ellos hasta que el owner los complete.

## Formato

Frontmatter simple (`slug`, `nombre`, `tipo`, `resumen`, `audiencia`, `palabras_clave`) + secciones fijas: **Qué es · Qué hace · Para quién · Diferencia · Casos de uso · Ángulos de marketing · Stack**.

## Índice

| Doc | Tipo | Qué cubre |
| --- | --- | --- |
| `creapolis-crm.md` | producto interno | CRM agent-first con API REST y Postgres |
| `eve-agent.md` | producto interno | El agente orchestrator + 9 subagentes |
| `desktop-console.md` | producto interno | Consola ops macOS (Tauri) del owner |
| `gentle-worker.md` | producto interno | Worker de correcciones automáticas en VPS |
| `pepinillo.md` | producto propio (público) | App de deep-work multiplataforma |
| `servicio-desarrollo-software.md` | servicio | Software a medida (web/desktop/móvil) |
| `servicio-automatizacion.md` | servicio | Automatización de procesos e integraciones |
| `servicio-agentes-ia.md` | servicio | Agentes de IA para negocio (este sistema es la demo) |
| `servicio-consultoria-ia.md` | servicio | Consultoría e implementación de IA |
| `_pendientes.md` | pendiente | heapdeck, solennix, ordo, sitio web — por completar |

## Mantenimiento

Cambios vía PR (se despliegan solos: la imagen del CRM copia esta carpeta y la sirve en `/api/products`). Al lanzar o cambiar un producto, actualizar su doc en el mismo PR.
