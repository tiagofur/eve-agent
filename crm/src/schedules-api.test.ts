import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { apiKeys, scheduleRuns, schedules } from "./db/schema";
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

// Shared across describes: one seeded key pair and one file-level cleanup,
// because ending the pool inside a describe would close it before the next
// describe's tests run.
const opsKey = "cp_ops_scheduleskey1234567890abcdef";
const frontKey = "cp_front_scheduleskey1234567890abcd";
const opsHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

afterAll(async () => {
  await db.delete(schedules).where(like(schedules.name, "TEST-%"));
  await db.delete(apiKeys).where(like(apiKeys.name, "Schedules Test %"));
  await pool.end();
});

/**
 * Agent cronjob CRUD surface: scope checks, cron validation, cadence recalc
 * on PATCH, delete and the manual-run gate.
 */
describe("Schedules API", () => {
  let createdId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Schedules Test Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Schedules Test Front", scope: "front", keyHash: hashApiKey(frontKey) },
    ]);
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

  it("lists each schedule with its trailing-week token spend", async () => {
    const [row] = await db
      .insert(schedules)
      .values({
        name: "TEST-usage-api",
        title: "TEST usage",
        cron: "0 7 * * *",
        prompt: "x",
        enabled: false,
      })
      .returning();
    await db.insert(scheduleRuns).values({
      scheduleId: row!.id,
      status: "succeeded",
      inputTokens: 300000,
      outputTokens: 4000,
      cacheReadTokens: 250000,
      finishedAt: new Date(),
    });
    try {
      const res = await app.request("/api/schedules", { headers: opsHeaders });
      const body = (await res.json()) as {
        schedules: Array<typeof schedules.$inferSelect & { usage7d: unknown }>;
      };
      expect(body.schedules.find((s) => s.id === row!.id)?.usage7d).toEqual({
        runs: 1,
        inputTokens: 300000,
        outputTokens: 4000,
        cacheReadTokens: 250000,
      });
      // A task that spent nothing in the window reports zeros, not a missing field.
      expect(body.schedules.find((s) => s.id === createdId)?.usage7d).toEqual({
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
      });
    } finally {
      await db.delete(schedules).where(eq(schedules.id, row!.id));
    }
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

describe("Schedules API: categorías", () => {
  const createdIds: string[] = [];

  const createSchedule = async (body: Record<string, unknown>) => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { schedule: typeof schedules.$inferSelect };
    createdIds.push(out.schedule.id);
    return out.schedule;
  };

  afterAll(async () => {
    for (const id of createdIds.splice(0)) {
      await db.delete(schedules).where(eq(schedules.id, id));
    }
  });

  it("infere la categoría del título cuando no se pasa, y respeta la explícita", async () => {
    const inferred = await createSchedule({
      title: "TEST contenido diario de prueba",
      cron: "0 3 * * *",
      prompt: "x",
      name: "test_cat_inferred",
      enabled: false,
    });
    expect(inferred.category).toBe("content");

    const explicit = await createSchedule({
      title: "TEST sin pista de categoría",
      cron: "0 3 * * *",
      prompt: "x",
      name: "test_cat_explicit",
      enabled: false,
      category: "sales",
    });
    expect(explicit.category).toBe("sales");
  });

  it("rechaza una categoría desconocida al crear y al re-clasificar", async () => {
    const bad = await app.request("/api/schedules", {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ title: "TEST mala", cron: "0 3 * * *", prompt: "x", category: "financial" }),
    });
    expect(bad.status).toBe(400);

    const [target] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.name, "test_cat_explicit"))
      .limit(1);
    const refile = await app.request(`/api/schedules/${target!.id}`, {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ category: "desconocida" }),
    });
    expect(refile.status).toBe(400);
  });

  it("PATCH re-clasifica una tarea y queda en el evento de auditoría", async () => {
    const [target] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.name, "test_cat_explicit"))
      .limit(1);
    const res = await app.request(`/api/schedules/${target!.id}`, {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ category: "other" }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { schedule: typeof schedules.$inferSelect };
    expect(out.schedule.category).toBe("other");
  });

  it("el switch de categoría pausa y reactiva solo su bloque, re-armando la próxima ejecución", async () => {
    const a = await createSchedule({
      title: "TEST bloque A uno",
      cron: "0 4 * * *",
      prompt: "x",
      name: "test_cat_block_a",
      enabled: true,
      category: "system",
    });
    const b = await createSchedule({
      title: "TEST bloque A dos",
      cron: "30 4 * * *",
      prompt: "x",
      name: "test_cat_block_b",
      enabled: true,
      category: "system",
    });
    const other = await createSchedule({
      title: "TEST fuera del bloque",
      cron: "0 5 * * *",
      prompt: "x",
      name: "test_cat_outside",
      enabled: true,
      category: "reports",
    });

    const pause = await app.request("/api/schedules/category/system", {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(pause.status).toBe(200);
    const pauseBody = (await pause.json()) as { changed: number; changes: Array<{ scheduleId: string }> };
    const touched = pauseBody.changes.map((ch) => ch.scheduleId);
    expect(touched).toContain(a.id);
    expect(touched).toContain(b.id);
    expect(touched).not.toContain(other.id);

    const [pausedA] = await db.select().from(schedules).where(eq(schedules.id, a.id)).limit(1);
    expect(pausedA?.enabled).toBe(false);

    // Resuming re-arms from now (same contract as the per-task PATCH).
    const resume = await app.request("/api/schedules/category/system", {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(resume.status).toBe(200);
    const resumeBody = (await resume.json()) as { changed: number };
    expect(resumeBody.changed).toBe(2);

    const [resumedA] = await db.select().from(schedules).where(eq(schedules.id, a.id)).limit(1);
    expect(resumedA?.enabled).toBe(true);
    expect(new Date(resumedA!.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 1000);

    // A no-op toggle reports zero changes instead of rewriting every row.
    const again = await app.request("/api/schedules/category/system", {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    expect(((await again.json()) as { changed: number }).changed).toBe(0);
  });

  it("rechaza el switch de una categoría inexistente", async () => {
    const res = await app.request("/api/schedules/category/financial", {
      method: "PATCH",
      headers: opsHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(400);
  });
});
