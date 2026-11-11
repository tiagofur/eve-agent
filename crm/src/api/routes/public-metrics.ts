import { Hono } from "hono";
import { desc } from "drizzle-orm";
import { db } from "../../db/client";
import { productMetricsDaily } from "../../db/schema";

/**
 * Public, curated metrics for landing pages (badges like "X organizadores
 * activos"). NOTHING is exposed by default: only dotted paths listed in
 * METRICS_PUBLIC_KEYS (e.g. "solennix.users.total,solennix.events.total")
 * reach this endpoint — the owner decides what is public.
 */
export const publicMetricsRouter = new Hono();

function publicKeys(): string[] {
  return (process.env.METRICS_PUBLIC_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function pickPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

publicMetricsRouter.get("/", async (c) => {
  const keys = publicKeys();
  if (keys.length === 0) {
    return c.json(
      { metrics: {}, note: "No public metrics configured (METRICS_PUBLIC_KEYS is empty)." },
      { headers: { "Cache-Control": "public, max-age=1800" } }
    );
  }

  const rows = await db
    .select()
    .from(productMetricsDaily)
    .orderBy(desc(productMetricsDaily.metricDate), desc(productMetricsDaily.collectedAt))
    .limit(200);
  const latestByApp = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByApp.has(row.app)) latestByApp.set(row.app, row);
  }

  const out: Record<string, { value: unknown; date: string }> = {};
  for (const key of keys) {
    const app = key.split(".")[0] ?? "";
    const snapshot = latestByApp.get(app);
    if (!snapshot) continue;
    const value = pickPath(snapshot.metrics as Record<string, unknown>, key.slice(app.length + 1));
    if (value === undefined || typeof value === "object") continue;
    out[key] = { value, date: snapshot.metricDate };
  }

  return c.json(
    { metrics: out },
    { headers: { "Cache-Control": "public, max-age=1800" } }
  );
});
