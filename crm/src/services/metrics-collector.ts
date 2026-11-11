import cron from "node-cron";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { analystReports, productMetricsDaily } from "../db/schema";
import { logEvent } from "../domain/events";
import { escapeHtml, sendTelegramMessage } from "./telegram";

/**
 * Daily product/VPS metrics collector. Pulls aggregate-only snapshots from
 * every configured app (METRICS_<APP>_URL/_TOKEN, see
 * docs/integrations/internal-stats-endpoint-spec.md), measures VPS health
 * from inside the container, upserts one row per app/day into
 * product_metrics_daily, and drops a human digest into the Reports inbox
 * (analyst_reports, createdBy metrics:collector).
 */

const COLLECT_CRON = "45 6 * * *";

/** UTC date (YYYY-MM-DD) a snapshot belongs to — the server runs in UTC. */
function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const startOfUtcDay = (now: Date = new Date()): Date =>
  new Date(`${utcDate(now)}T00:00:00.000Z`);

/** Apps configured via env: METRICS_<NAME>_URL (+ optional METRICS_<NAME>_TOKEN). */
export function configuredAppSources(): Array<{ app: string; url: string; token?: string }> {
  const sources: Array<{ app: string; url: string; token?: string }> = [];
  for (const [key, url] of Object.entries(process.env)) {
    const match = /^METRICS_([A-Z0-9]+)_URL$/.exec(key);
    if (match?.[1] && url) {
      const name = match[1].toLowerCase();
      sources.push({ app: name, url, token: process.env[`METRICS_${match[1]}_TOKEN`] });
    }
  }
  return sources;
}

async function fetchAppMetrics(src: { app: string; url: string; token?: string }): Promise<Record<string, unknown>> {
  const res = await fetch(src.url, {
    headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("stats response is not a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Container-visible VPS health: DB size, key table counts, eve-agent probe. */
export async function collectVpsHealth(): Promise<Record<string, unknown>> {
  const dbStatsResult = await db.execute(
    sql`SELECT pg_database_size(current_database()) AS db_size_bytes,
               (SELECT count(*) FROM pg_stat_activity) AS connections`
  );
  const dbStats = dbStatsResult.rows[0] as { db_size_bytes: string; connections: string } | undefined;

  const countsResult = await db.execute(sql`SELECT
      (SELECT count(*) FROM leads) AS leads,
      (SELECT count(*) FROM tickets) AS tickets,
      (SELECT count(*) FROM events) AS events,
      (SELECT count(*) FROM content_packs) AS content_packs,
      (SELECT count(*) FROM schedules) AS schedules,
      (SELECT count(*) FROM analyst_reports) AS analyst_reports,
      (SELECT count(*) FROM chat_messages) AS chat_messages`);
  const counts = countsResult.rows[0] as Record<string, string> | undefined;

  let eveAgent: { ok: boolean; ms: number } = { ok: false, ms: 0 };
  const eveUrl = process.env.EVE_AGENT_URL;
  if (eveUrl) {
    const started = Date.now();
    try {
      const res = await fetch(`${eveUrl.replace(/\/+$/, "")}/eve/v1/health`, {
        signal: AbortSignal.timeout(5000),
      });
      eveAgent = { ok: res.ok, ms: Date.now() - started };
    } catch {
      eveAgent = { ok: false, ms: Date.now() - started };
    }
  }

  return {
    database: {
      sizeBytes: Number(dbStats?.db_size_bytes ?? 0),
      connections: Number(dbStats?.connections ?? 0),
      rows: Object.fromEntries(Object.entries(counts ?? {}).map(([k, v]) => [k, Number(v)])),
    },
    services: { eveAgent },
    collectedAt: new Date().toISOString(),
  };
}

/** Upserts one snapshot per app/day; returns the apps actually written. */
export async function upsertSnapshots(
  now: Date,
  entries: Array<{ app: string; metrics: Record<string, unknown> }>
): Promise<string[]> {
  const written: string[] = [];
  for (const entry of entries) {
    await db
      .insert(productMetricsDaily)
      .values({ metricDate: utcDate(now), app: entry.app, metrics: entry.metrics, collectedAt: now })
      .onConflictDoUpdate({
        target: [productMetricsDaily.metricDate, productMetricsDaily.app],
        set: { metrics: entry.metrics, collectedAt: now },
      });
    written.push(entry.app);
  }
  return written;
}

/** Shape-agnostic digest: top-level scalars as bullets, one nesting level. */
function renderAppMetrics(metrics: Record<string, unknown>): string {
  const line = (k: string, v: unknown): string => {
    const label = k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
    if (typeof v === "object" && v !== null) {
      const inner = Object.entries(v as Record<string, unknown>)
        .map(([ik, iv]) => `  - ${ik}: \`${typeof iv === "object" ? JSON.stringify(iv) : String(iv)}\``)
        .join("\n");
      return `- **${label}**\n${inner}`;
    }
    return `- **${label}:** \`${String(v)}\``;
  };
  return Object.entries(metrics).map(([k, v]) => line(k, v)).join("\n");
}

async function collectDigest(
  now: Date,
  written: Array<{ app: string; metrics: Record<string, unknown> }>
): Promise<void> {
  if (written.length === 0) return;
  const [existing] = await db
    .select({ id: analystReports.id })
    .from(analystReports)
    .where(
      and(
        eq(analystReports.createdBy, "metrics:collector"),
        gte(analystReports.createdAt, startOfUtcDay(now))
      )
    )
    .limit(1);
  if (existing) return; // one digest per day even if the tick re-runs

  const sections = written
    .map((e) => `### ${e.app}\n\n${renderAppMetrics(e.metrics)}`)
    .join("\n\n");
  const summary = `# Métricas diarias — ${utcDate(now)}\n\n${sections}\n\n_Snapshots crudos en product_metrics_daily; el agente los lee con get_product_metrics y las landings con el endpoint público curado._\n`;

  await db.insert(analystReports).values({ summary, createdBy: "metrics:collector" });
}

/** One collection tick: external apps + VPS health, then the digest. */
export async function tickMetricsCollector(now: Date = new Date()): Promise<string[]> {
  const entries: Array<{ app: string; metrics: Record<string, unknown> }> = [];

  for (const src of configuredAppSources()) {
    try {
      entries.push({ app: src.app, metrics: await fetchAppMetrics(src) });
    } catch (err) {
      console.warn(`[Metrics] ${src.app} collection failed:`, (err as Error).message);
      await logEvent({
        entity: "product_metrics",
        entityId: src.app,
        action: "collection_failed",
        actor: "system",
        after: { error: (err as Error).message },
        reason: `Fallo recolectando métricas de ${src.app}`,
      }).catch(() => undefined);
      await notifyCollectorFailure(src.app, (err as Error).message);
    }
  }

  try {
    entries.push({ app: "vps", metrics: await collectVpsHealth() });
  } catch (err) {
    console.warn("[Metrics] VPS health collection failed:", (err as Error).message);
  }

  const written = await upsertSnapshots(now, entries);
  await collectDigest(now, entries);

  if (written.length > 0) {
    console.log(`[Metrics] collected: ${written.join(", ")}`);
  }
  return written;
}

/** Failure notification is best-effort and quiet (no daily Telegram noise). */
export async function notifyCollectorFailure(app: string, error: string): Promise<void> {
  try {
    await sendTelegramMessage(
      `📊 <b>Collector de métricas</b>: fallo recolectando <b>${escapeHtml(app)}</b>\n<pre>${escapeHtml(
        error.slice(0, 400)
      )}</pre>`
    );
  } catch {
    // The audit event already carries the failure.
  }
}

let tickInFlight: Promise<unknown> | null = null;

/** Daily 06:45 UTC + boot catch-up when today has no snapshots yet. */
export function startMetricsCollector(): void {
  cron.schedule(COLLECT_CRON, () => {
    if (tickInFlight) return;
    tickInFlight = tickMetricsCollector()
      .catch((err) => console.error("[Metrics] tick failed:", err))
      .finally(() => {
        tickInFlight = null;
      });
  });

  // Boot catch-up: a deploy after 06:45 must still collect today's snapshot.
  void (async () => {
    try {
      const [row] = await db
        .select({ id: productMetricsDaily.id })
        .from(productMetricsDaily)
        .where(eq(productMetricsDaily.metricDate, utcDate()))
        .limit(1);
      if (!row) await tickMetricsCollector();
    } catch (err) {
      console.error("[Metrics] boot catch-up failed:", err);
    }
  })();
}
