import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, milestones, organizations, projects, tasks } from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Strict task machine (S1): validated project/milestone links (clean 4xx,
 * never 500 on ghosts) and enforced transitions — ready→done jumps and
 * cross-project milestones are rejected.
 */
describe("task machine and links", () => {
  const opsKey = "cp_ops_taskmachkey1234567890abcdef12";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let orgId = "";
  let projectA = "";
  let milestoneA = "";
  let milestoneB = "";
  const createdTaskIds: string[] = [];

  const dispatch = async (body: Record<string, unknown>) =>
    app.request("/api/projects/tasks", { method: "POST", headers, body: JSON.stringify(body) });

  const move = async (id: string, status: string) =>
    app.request(`/api/projects/tasks/${id}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status }),
    });

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Task Machine", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Task Machine" }).returning();
    orgId = org!.id;
    const [pa] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST PM-A", status: "active" })
      .returning();
    projectA = pa!.id;
    const [pb] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST PM-B", status: "active" })
      .returning();
    const [ma] = await db.insert(milestones).values({ projectId: projectA, title: "M-A" }).returning();
    milestoneA = ma!.id;
    const [mb] = await db.insert(milestones).values({ projectId: pb!.id, title: "M-B" }).returning();
    milestoneB = mb!.id;
  });

  afterAll(async () => {
    for (const id of createdTaskIds) {
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    await db.delete(milestones).where(eq(milestones.projectId, projectA));
    await db.delete(projects).where(eq(projects.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("rejects ghost project and cross-project milestone links", async () => {
    const ghost = await dispatch({
      projectId: "00000000-0000-0000-0000-000000000000",
      title: "Tarea fantasma",
      spec: "Spec.",
    });
    expect(ghost.status).toBe(404);

    const crossed = await dispatch({
      projectId: projectA,
      milestoneId: milestoneB,
      title: "Tarea cruzada",
      spec: "Spec.",
    });
    expect(crossed.status).toBe(400);
  });

  it("walks the full machine and rejects bad jumps", async () => {
    const created = await dispatch({
      projectId: projectA,
      milestoneId: milestoneA,
      title: "Tarea ciclo completo",
      spec: "Contexto, criterios, archivos, comandos.",
    });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe("ready");
    createdTaskIds.push(task.id);

    // ready → done directly must fail.
    expect((await move(task.id, "done")).status).toBe(400);

    for (const next of ["dispatched", "in_progress", "in_review", "done"]) {
      const res = await move(task.id, next);
      expect(res.status).toBe(200);
    }

    // done is terminal.
    expect((await move(task.id, "in_progress")).status).toBe(400);
  });

  it("supports blocked, retry and rework transitions", async () => {
    const created = await dispatch({ projectId: projectA, title: "Tarea bloqueada", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);

    expect((await move(task.id, "blocked")).status).toBe(200);
    expect((await move(task.id, "ready")).status).toBe(200);
    expect((await move(task.id, "dispatched")).status).toBe(200);
    expect((await move(task.id, "in_progress")).status).toBe(200);
    expect((await move(task.id, "in_review")).status).toBe(200);
    expect((await move(task.id, "in_progress")).status).toBe(200);
  });
});
