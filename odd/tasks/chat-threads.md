# Chat threads + memoria persistente

Orquestador Chat del desktop: conversaciones persistidas en el backend con threads listables y botón de chat nuevo. Base para memoria de largo plazo.

## Specs

- S1: "tampoco tiene una memoria persistente" — las conversaciones del Orquestador Chat deben sobrevivir cambio de tab y recarga; el backend almacena threads y mensajes.
- S2: "tampoco puedo crear un chat nuevo" — sidebar con lista de conversaciones y botón de chat nuevo en `ChatView`.
- S3 (propuesta aprobada con "si"): "tablas chat_threads/chat_messages, endpoints CRUD y sidebar en ChatView con botón 'nuevo chat'". El POST `/api/chat` existente sigue funcionando (compatibilidad hacia atrás: `threadId` opcional).

## Tasks

- T1 (S1): schema + migración `chat_threads`/`chat_messages`, `drizzle-kit generate` + `migrate`. Route: inline. Evidencia: tablas + journal idx 3 confirmados en DB vía psql. Incidencia: `drizzle-kit migrate` muere en silencio (exit 1) y la 0002 incluía ALTERs de columnas que ya existían en DB → se agregaron IF NOT EXISTS y se migró con el migrador de drizzle-orm. Commit: pendiente de autorización del usuario.
- T2 (S1, S2): endpoints threads (listar/crear/obtener+mensajes) y persistencia en POST `/api/chat` (crea thread si no hay `threadId`, guarda usuario + respuesta, devuelve `threadId`). Route: inline. Evidencia: smoke en vivo HISTORIA_OK (crear → chatear → persistir → listar). Commit: pendiente.
- T3 (S2): sidebar en `ChatView` + botón nuevo chat + carga de thread. Route: inline. Evidencia: `tsc` EXIT 0 + `npm run build` OK (1596 módulos). Commit: pendiente.
- T4 (S1, S2): verificación (typecheck, tests nuevos, smoke en vivo). Route: inline. Evidencia: vitest 24/24 (pure) + 5/5 threads API; crm typecheck sin clases de error nuevas vs baseline (19 preexistentes). Commit: pendiente.

## Log

- L1 (usuario, verbatim): "te digo algo mas? en chat por lo que vi no disparo el sub agente de prospecto, tampoco tiene una memoria persistente, tampoco puedo crear un chat nuevo... en fin, tenemos que mejorar esto"
- L2 (usuario, verbatim): "si" — aprueba arrancar por el punto 1 (threads + persistencia + nuevo chat); el puente con el subagente prospecto queda para después.
- L3: T1–T4 verificadas. El binario instalado de desktop (Creapolis Mission Control.app) es anterior al cambio: el usuario debe reconstruir/relanzar la app para ver el sidebar.
- L4 (evidencia): rama feat/chat-prospects-subscription — a7a26db agent, 51e789c crm, 8ceb2d5 desktop, abd5ae4 docs. App reconstruida, instalada y corriendo con sidebar.
