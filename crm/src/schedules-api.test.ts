import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { apiKeys, schedules } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";

// Deterministic single-brain state for the manual-run endpoint: the proxy is
// disabled, so POST /:id/run must surface the 503 instead of phoning anyone.
vi.mock("./domain/eve-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./domain/eve-client")>();
  return {
    ...original,
    resolveEveProxyConfig: vi.fn(() => ({ enabled: false })),
  };
});

/**
 * Agent cronjob CRUD surface: scope checks, cron validation, cadence recalc
 * on PATCH, delete and the manual-run gate.
 */
describe("Schedules API", () => {
  const opsKey = "cp_ops_scheduleskey1234567890abcdef";
  const frontKey = "cp_front_scheduleskey1234567890abcd";
  const opsHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let createdId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Schedules Test Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Schedules Test Front", scope: "front", keyHash: hashApiKey(frontKey) },
    ]);
  });

  afterAll(async () => {
    await db.delete(schedules).where(like(schedules.name, "TEST-%"));
    await db.delete(apiKeys).where(like(apiKeys.name, "Schedules Test %"));
    await pool.end();
  });

  it("requires auth and rejects non-ops keys", async () => {
    const noKey = await app.request("/api/schedules");
    expect(noKey.status).toBe(401);
    const front = await app.request("/api/schedules", {
      headers: { Authorization: `Bearer ${frontKey}` },
    });
    expect(front.status).toBe(403);
  });

  it("lists schedules with the server clock", async () => {
    const res = await app.request("/api/schedules", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: unknown[]; serverNow: string; timezone: string };
    expect(Array.isArray(body.schedules)).toBe(true);
    expect(new Date(body.serverNow).toString()).not.toBe("Invalid Date");
    expect(body.timezone).toBeTruthy();
  });

  it("creates a schedule with slug name and future next_run_at", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({
        title: "TEST Programada QA",
        cron: "*/10 * * * *",
        prompt: "TEST prompt de la tarea programada",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { schedule: typeof schedules.$inferSelect };
    expect(body.schedule.name).toBe("test_programada_qa");
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.nextRunAt).not.toBeNull();
    expect(new Date(body.schedule.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 1000);
    createdId = body.schedule.id;
  });

  it("rejects invalid cron expressions", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ title: "TEST mala", cron: "cada martes", prompt: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate names with 409", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ title: "Otra", name: "test_programada_qa", cron: "0 7 * * *", prompt: "x" }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH recalcula next_run_at al cambiar el cron y permite pausar", async () => {
    const res = await app.request(`/api/schedules/${createdId}`, {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ cron: "0 5 * * *" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedule: typeof schedules.$inferSelect };
    expect(body.schedule.cron).toBe("0 5 * * *");
    expect(new Date(body.schedule.nextRunAt!).getHours()).toBe(5);

    const pause = await app.request(`/api/schedules/${createdId}`, {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);
    const paused = (await pause.json()) as { schedule: typeof schedules.$inferSelect };
    expect(paused.schedule.enabled).toBe(false);

    const noop = await app.request(`/api/schedules/${createdId}`, {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(noop.status).toBe(400);
  });

  it("manual run returns 503 while the single brain is unreachable", async () => {
    const res = await app.request(`/api/schedules/${createdId}/run`, {
      method: "POST",
      headers: opsHeaders,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Single brain unavailable");
  });

  it("lists run history and deletes the schedule", async () => {
    const runs = await app.request(`/api/schedules/${createdId}/runs`, { headers: opsHeaders });
    expect(runs.status).toBe(200);
    expect((await runs.json() as { runs: unknown[] }).runs).toHaveLength(0);

    const del = await app.request(`/api/schedules/${createdId}`, {
      method: "DELETE",
      headers: opsHeaders,
    });
    expect(del.status).toBe(200);

    const after = await app.request(`/api/schedules/${createdId}/runs`, { headers: opsHeaders });
    expect(after.status).toBe(404);
  });
});
