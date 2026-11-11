import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { productMetricsDaily } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";

/** Latest + historical product/VPS metrics snapshots (ops + agent tool). */
export const metricsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Latest snapshot per app (or one app with ?app=solennix).
metricsRouter.get("/latest", requireScope(["ops"]), async (c) => {
  const app = c.req.query("app");

  if (app) {
    const [row] = await db
      .select()
      .from(productMetricsDaily)
      .where(eq(productMetricsDaily.app, app))
      .orderBy(desc(productMetricsDaily.metricDate), desc(productMetricsDaily.collectedAt))
      .limit(1);
    return c.json({ metrics: row ? [row] : [] });
  }

  // One row per app: latest metric_date per app, then the newest collectedAt.
  const rows = await db
    .select()
    .from(productMetricsDaily)
    .orderBy(desc(productMetricsDaily.metricDate), desc(productMetricsDaily.collectedAt))
    .limit(200);
  const seen = new Set<string>();
  const latest = rows.filter((r) => {
    if (seen.has(r.app)) return false;
    seen.add(r.app);
    return true;
  });
  return c.json({ metrics: latest });
});

// Daily series for trends/charts (?app= required, days capped at 90).
metricsRouter.get("/history", requireScope(["ops"]), async (c) => {
  const app = c.req.query("app");
  const days = Math.min(Number(c.req.query("days") ?? 30) || 30, 90);
  if (!app) return c.json({ error: "Missing app query param" }, 400);

  const rows = await db
    .select()
    .from(productMetricsDaily)
    .where(eq(productMetricsDaily.app, app))
    .orderBy(desc(productMetricsDaily.metricDate))
    .limit(days);
  return c.json({ app, days, metrics: rows });
});
