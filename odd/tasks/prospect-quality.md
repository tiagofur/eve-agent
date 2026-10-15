# Prospect quality: sin duplicados, datos completos

El research del Orquestador Chat debe: reutilizar el lead existente si el negocio ya está prospectado, persistir datos completos (summary + dossier) y avanzar a `researched`. Metodología del subagente prospector consolidada en el flujo CRM.

## Specs

- S1: "puso repetido porque no vio si ya estaba o no en los prospectos o clientes el que sugerio" — investigar un negocio ya prospectado devuelve el lead existente, nunca crea un duplicado.
- S2: "tampoco relleno los datos necesarios solo el nombre" — el research persiste datos completos (summary, pains, solución, fuentes, dossier) y el lead avanza a `researched`; nada de "No notes".
- S3: "tengo la disconfianza de que el orquestrador no paso la tarea de prospecto al sub agente de prospecto" — el flujo CRM aplica la metodología del prospector (verificar existente → descubrir contacto → dossier verificado). Puente al runtime eve: diferido (post pruebas finales).

## Tasks

- T1 (S1): guard anti-duplicados en `ingestLead` (lead abierto existente para misma org/contacto → devuelve `{duplicate: true}` sin crear). Route: inline. Commit: pendiente de autorización.
- T2 (S2, S3): gate de calidad en `research_and_save_prospect` (mínimos reales, transición a `researched`, mensaje con completitud). Route: inline. Commit: pendiente.
- T3 (S1, S2): tests de integración (doble ingest → 1 lead; research validation). Route: inline. Commit: pendiente.
- T4 (S1, S2): verificación (typecheck vs baseline, tests, smoke en vivo). Route: inline. Evidencia: vitest 37/37 (5 archivos); crm typecheck sin clases de error nuevas vs baseline; smoke Globant → duplicado sin fila nueva; smoke Espiga Dorada → stage researched + summary + dossier, 1 fila, sin contacto inventado. Commit: pendiente.

## Log

- L1 (usuario, verbatim): "tengo la disconfianza de que el orquestrador no paso la tarea de prospecto al sub agente de prospecto, tampoco relleno los datos necesarios solo el nombre, puso repetido porque no vio si ya estaba o no en los prospectos o clientes el que sugerio... tenemos que arreglar esto para que la app este lista para ya pruebas finales"
- L2: captura 15/10 8:48am — Timothy Real Estate Group duplicado (2 filas idénticas, ORCHESTRATOR_CHAT, 14/10), Globant solo-nombre en `new` sin notes, Mendoza (PROSPECTOR_AGENT) como referencia correcta en `researched`.
- L3: hallazgos del smoke — el modelo inventa nombres de parámetros (email/phone/website/dossier, business_name snake_case) y no puede citar fuentes (sin browsing). Fix a prueba de modelo: `domain/research-input.ts` (normalización de alias + validación propia ANTES de escribir en DB + error con nombres exactos), schema zod laxo, rollback del lead si falla el dossier, `sources` opcional. Además: `maxSteps` no existe en ai v7 (era un solo paso); el loop discovery→save exigió `stopWhen`. Filas de prueba propias pendientes de limpieza: San Mateo y VSF (summary NULL, pre-gate).
- L4 (evidencia): rama feat/chat-prospects-subscription (commits en L4 de chat-threads.md). Limpieza ejecutada 15/10: quedan 2 leads (Mendoza researched + 1 Timothy new); eliminados 1 Timothy duplicado, San Mateo, VSF, Globant y Espiga con sus dossiers e interacciones.
