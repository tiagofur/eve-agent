import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { analystReports, apiKeys, productMetricsDaily } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";
import {
  collectVpsHealth,
  configuredAppSources,
  tickMetricsCollector,
  upsertSnapshots,
} from "./services/metrics-collector";

vi.mock("./services/telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("./services/telegram")>();
  return {
    ...original,
    sendTelegramMessage: vi.fn(async () => ({ ok: true })),
    sendTelegramPhoto: vi.fn(async () => ({ ok: true })),
  };
});

describe("Metrics collector", () => {
  const opsKey = "cp_ops_metrics1234567890abcdef00";
  const opsHeaders = { Authorization: `Bearer ${opsKey}` };

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Metrics Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
  });

  afterAll(async () => {
    await db.delete(productMetricsDaily).where(like(productMetricsDaily.app, "TEST-%"));
    await db.delete(productMetricsDaily).where(eq(productMetricsDaily.app, "teststub"));
    await db.delete(productMetricsDaily).where(eq(productMetricsDaily.app, "vps"));
    await db.delete(analystReports).where(eq(analystReports.createdBy, "metrics:collector"));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("configuredAppSources descubre METRICS_<APP>_URL de las envs", () => {
    process.env.METRICS_TESTAPP_URL = "http://127.0.0.1:1/stats";
    process.env.METRICS_TESTAPP_TOKEN = "tok";
    try {
      const sources = configuredAppSources();
      const mine = sources.find((s) => s.app === "testapp");
      expect(mine).toEqual({ app: "testapp", url: "http://127.0.0.1:1/stats", token: "tok" });
    } finally {
      delete process.env.METRICS_TESTAPP_URL;
      delete process.env.METRICS_TESTAPP_TOKEN;
    }
  });

  it("upsertSnapshots es idempotente por (día, app)", async () => {
    const day1 = new Date("2026-11-10T06:45:00Z");
    await upsertSnapshots(day1, [{ app: "TEST-x", metrics: { v: 1 } }]);
    const later = new Date("2026-11-10T18:00:00Z");
    await upsertSnapshots(later, [{ app: "TEST-x", metrics: { v: 2 } }]);

    const rows = await db.select().from(productMetricsDaily).where(eq(productMetricsDaily.app, "TEST-x"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metrics).toEqual({ v: 2 });
    expect(rows[0]!.collectedAt.toISOString()).toBe(later.toISOString());
  });

  it("collectVpsHealth devuelve tamaño de BD, filas y probe del eve agent", async () => {
    const health = (await collectVpsHealth()) as {
      database: { sizeBytes: number; rows: Record<string, number> };
      services: { eveAgent: { ok: boolean; ms: number } };
    };
    expect(health.database.sizeBytes).toBeGreaterThan(0);
    expect(health.database.rows.leads).toBeGreaterThanOrEqual(0);
    expect(typeof health.services.eveAgent.ok).toBe("boolean");
  });

  it("tick: app externa configurada se recolecta y el digest aterriza en Reportes", async () => {
    // Stub HTTP "app" en un puerto efímero.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ users: { total: 42, active7d: 7 }, events: { total: 100 } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    process.env.METRICS_TESTSTUB_URL = `http://127.0.0.1:${port}/internal/stats`;
    try {
      const written = await tickMetricsCollector(new Date());
      expect(written).toContain("teststub");
      expect(written).toContain("vps");

      // Digest único del día en la pestaña Reportes.
      const digests = await db
        .select()
        .from(analystReports)
        .where(eq(analystReports.createdBy, "metrics:collector"));
      expect(digests).toHaveLength(1);
      expect(digests[0]!.summary).toContain("# Métricas diarias —");
      expect(digests[0]!.summary).toContain("teststub");

      // Segunda llamada el mismo día: snapshot actualizado, digest NO duplicado.
      const second = await tickMetricsCollector(new Date());
      expect(second).toContain("teststub");
      const digests2 = await db
        .select()
        .from(analystReports)
        .where(eq(analystReports.createdBy, "metrics:collector"));
      expect(digests2).toHaveLength(1);
    } finally {
      delete process.env.METRICS_TESTSTUB_URL;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("API: latest requiere auth y history exige app", async () => {
    const noAuth = await app.request("/api/metrics/latest");
    expect(noAuth.status).toBe(401);

    const historyNoApp = await app.request("/api/metrics/history", { headers: opsHeaders });
    expect(historyNoApp.status).toBe(400);

    const latest = await app.request("/api/metrics/latest?app=TEST-x", { headers: opsHeaders });
    expect(latest.status).toBe(200);
    const body = (await latest.json()) as { metrics: Array<{ app: string }> };
    expect(body.metrics[0]!.app).toBe("TEST-x");
  });

  it("API pública: vacío por defecto y expone solo paths curados", async () => {
    // (el collector ya dejó snapshots TEST-x y vps de los tests anteriores)
    const empty = await app.request("/api/public/metrics");
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { metrics: Record<string, unknown> };
    expect(Object.keys(emptyBody.metrics)).toHaveLength(0);

    process.env.METRICS_PUBLIC_KEYS = "TEST-x.users.total,TEST-x.secret.deep,vps.nonexistent.path";
    try {
      const res = await app.request("/api/public/metrics");
      const body = (await res.json()) as { metrics: Record<string, { value: unknown }> };
      // TEST-x.users.total no existe en el snapshot {v:2} → nada; scalars only.
      expect(Object.keys(body.metrics)).toHaveLength(0);

      // Ahora con un snapshot que sí tiene el path curado.
      await upsertSnapshots(new Date(), [
        { app: "TEST-x", metrics: { users: { total: 42 }, secret: { deep: { x: 1 } } } },
      ]);
      const res2 = await app.request("/api/public/metrics");
      const body2 = (await res2.json()) as { metrics: Record<string, { value: unknown }> };
      expect(body2.metrics["TEST-x.users.total"]?.value).toBe(42);
      expect(body2.metrics["TEST-x.secret.deep"]).toBeUndefined();
      expect(body2.metrics["vps.nonexistent.path"]).toBeUndefined();
    } finally {
      delete process.env.METRICS_PUBLIC_KEYS;
    }
  });
});
