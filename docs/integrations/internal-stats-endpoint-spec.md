# Spec: Internal Stats Endpoint (`GET /internal/stats`)

Contrato único para que el **collector de métricas del CRM** (Creapolis, PR del 2026-11-11)
recolecte diariamente los agregados de uso de cada app propia (Solennix hoy, Pepinillo cuando
su backend de sync exista). El collector corre a las 06:45 UTC y llama este endpoint con un
**Bearer token**; guarda el JSON como snapshot diario en `product_metrics_daily` y genera un
digest para el owner en la pestaña **Reportes** de Mission Control.

Copia esta spec tal cual al agente responsable de la app como requisito de implementación.

## Contrato

```
GET /internal/stats
Authorization: Bearer <METRICS_<APP>_TOKEN>
→ 200 application/json
```

- **Solo agregados**: contados, sumas y promedios. **Jamás PII** (nada de emails, nombres,
  ids de usuario, contenido de eventos/tareas). Si un agregado no se puede computar sin exponer
  datos, se omite.
- Responde en <2s: es una lectura barata (counts indexados o un contador diario cacheado).
- Campos desconocidos se ignoran; el collector guarda el objeto completo tal cual.
- 401 con token incorrecto. El collector reintentará el día siguiente; un fallo no es alerta
  crítica (queda auditado).

## Shape esperado (app = objeto raíz con las claves de abajo)

### Solennix (organizadores = usuarios del sistema)

```json
{
  "users":     { "total": 0, "new30d": 0, "active7d": 0, "active30d": 0 },
  "events":    { "total": 0, "created30d": 0 },
  "clients":   { "total": 0 },
  "products":  { "total": 0 },
  "quotes":    { "total": 0, "created30d": 0 }
}
```

- `users.active7d/30d`: usuarios con login (o sesión/API call) en los últimos 7/30 días.
- Fechas de corte: el snapshot es "a ahora"; el collector sella la fecha.

### Pepinillo (requiere telemetría opt-in en la app — fase 2)

```json
{
  "users":         { "total": 0, "new30d": 0, "active7d": 0, "active30d": 0 },
  "sessions":      { "total30d": 0, "byMode30d": { "pomodoro": 0, "flowtime": 0, "timeblock": 0, "stopwatch": 0 } },
  "focusMinutes":  { "total30d": 0, "byMode30d": { "pomodoro": 0, "flowtime": 0, "timeblock": 0, "stopwatch": 0 } },
  "breakMinutes":  { "total30d": 0 },
  "tasks":         { "created30d": 0, "completed30d": 0 }
}
```

- La app debe pedir **consentimiento explícito** para compartir métricas de uso agregadas
  (opt-in en onboarding/settings, describiendo exactamente qué se comparte: solo contados y
  minutos agregados, nunca contenido de tareas ni horarios individuales).

## Configuración (lado CRM, se setea cuando el endpoint exista)

```bash
METRICS_SOLENNIX_URL=https://solennix.com/internal/stats
METRICS_SOLENNIX_TOKEN=<token-opaco-generado>
```

El token se genera una vez y se comparte solo por canal seguro. Para exponer números en
landings, el owner curá qué paths son públicos vía `METRICS_PUBLIC_KEYS`
(p. ej. `solennix.users.total`) — **nada es público por defecto**.
