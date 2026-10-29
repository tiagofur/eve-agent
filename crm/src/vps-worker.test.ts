import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, events, organizations, projects, taskRuns, tasks } from "./db/schema";
import { eq } from "drizzle-orm";

describe("Worker VPS: claim atómico de runs y recovery de lease", () => {
  const opsKey = "cp_ops_vpsworkertestkey1234567890abc";
  let orgId = "";
  let projectId = "";
  let approvedTaskId = "";
  let staleTaskId = "";
  let staleRunId = "";

  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "VPS Worker Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST VPS Worker" }).returning();
    orgId = org!.id;
    const [project] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST worker repo", defaultBranch: "main" })
      .returning();
    projectId = project!.id;

    const [approved] = await db
      .insert(tasks)
      .values({ projectId, title: "TEST aprobada", spec: "spec", status: "approved", kind: "correction" })
      .returning();
    approvedTaskId = approved!.id;

    // Tarea en ejecución con run "running" de hace 5h (lease vencido)
    const [stale] = await db
      .insert(tasks)
      .values({ projectId, title: "TEST atorada", spec: "spec", status: "in_progress", kind: "correction" })
      .returning();
    staleTaskId = stale!.id;
    const [run] = await db
      .insert(taskRuns)
      .values({ taskId: staleTaskId, status: "running", startedAt: new Date(Date.now() - 5 * 3600000) })
      .returning();
    staleRunId = run!.id;
  });

  afterAll(async () => {
    await db.delete(events).where(eq(events.entityId, approvedTaskId));
    await db.delete(events).where(eq(events.entityId, staleTaskId));
    await db.delete(taskRuns).where(eq(taskRuns.taskId, staleTaskId));
    await db.delete(tasks).where(eq(tasks.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("el segundo openTaskRun sobre la misma tarea pierde el claim (atómico)", async () => {
    const first = await app.request(`/api/projects/tasks/${approvedTaskId}/runs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ branch: "fix/test" }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/api/projects/tasks/${approvedTaskId}/runs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ branch: "fix/test" }),
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("already_dispatched");

    const [task] = await db.select().from(tasks).where(eq(tasks.id, approvedTaskId)).limit(1);
    expect(task!.status).toBe("dispatched");
  });

  it("el worker recupera un run con lease vencido y lo devuelve a ready", async () => {
    // mismo flujo que recoverStaleRuns(): cerrar el run vencido y devolver a ready
    const close = await app.request(`/api/projects/tasks/${staleTaskId}/runs/${staleRunId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        exitCode: 1,
        resultSummary: "Lease de 4h vencido sin cierre: run recuperado automáticamente por el worker VPS.",
      }),
    });
    expect(close.status).toBe(200);

    const toBlocked = await app.request(`/api/projects/tasks/${staleTaskId}/status`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "blocked" }),
    });
    expect(toBlocked.status).toBe(200);

    const toReady = await app.request(`/api/projects/tasks/${staleTaskId}/status`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ status: "ready" }),
    });
    expect(toReady.status).toBe(200);

    // y la tarea recuperada es reclamable de nuevo
    const reclaim = await app.request(`/api/projects/tasks/${staleTaskId}/runs`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ branch: "fix/recovered" }),
    });
    expect(reclaim.status).toBe(201);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, staleTaskId)).limit(1);
    expect(task!.status).toBe("dispatched");
  });

  it("el endpoint de log exige WORKER_LOG_ROOT y rechaza paths fuera de la raíz", async () => {
    const oldRoot = process.env.WORKER_LOG_ROOT;
    delete process.env.WORKER_LOG_ROOT;
    const noRoot = await app.request(`/api/projects/tasks/${staleTaskId}/runs/${staleRunId}/log`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(noRoot.status).toBe(404);

    process.env.WORKER_LOG_ROOT = "/data/worker/runs";
    const forbidden = await app.request(`/api/projects/tasks/${staleTaskId}/runs/${staleRunId}/log`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    // el run de prueba no tiene logPath (o está fuera de la raíz) → 404/403, nunca 200
    expect([403, 404]).toContain(forbidden.status);
    if (oldRoot === undefined) delete process.env.WORKER_LOG_ROOT;
    else process.env.WORKER_LOG_ROOT = oldRoot;
  });
});
