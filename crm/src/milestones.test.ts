import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, milestones, organizations, projects, tasks } from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Milestones CRUD (Ventas view): the manual billing surface. Amounts stay
 * explicit (null = not agreed), done toggles stamp/clear doneAt, deletes
 * detach tasks instead of destroying them, and everything is audited.
 */
describe("milestones CRUD", () => {
  const opsKey = "cp_ops_milestonekey1234567890abcdef1";
  const ops = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let orgId = "";
  let projectId = "";
  const milestoneIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Milestone Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Milestones" }).returning();
    orgId = org!.id;
    const [project] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST Proyecto Hitos", status: "active" })
      .returning();
    projectId = project!.id;
  });

  afterAll(async () => {
    for (const id of milestoneIds) {
      await db.delete(milestones).where(eq(milestones.id, id));
    }
    await db.delete(tasks).where(eq(tasks.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("adds a milestone without amount and reads it back", async () => {
    const res = await app.request(`/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "Entrega final", dueDate: "2026-12-15" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      milestone: { id: string; amountCents: number | null; currency: string; doneAt: null };
    };
    expect(body.success).toBe(true);
    expect(body.milestone.amountCents).toBeNull();
    expect(body.milestone.currency).toBe("USD");
    expect(body.milestone.doneAt).toBeNull();
    milestoneIds.push(body.milestone.id);
  });

  it("adds a milestone with an agreed amount and currency", async () => {
    const res = await app.request(`/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "Anticipo 50%", dueDate: "2026-11-10", amountCents: 250000, currency: "MXN" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { milestone: { id: string; amountCents: number; currency: string } };
    expect(body.milestone.amountCents).toBe(250000);
    expect(body.milestone.currency).toBe("MXN");
    milestoneIds.push(body.milestone.id);
  });

  it("rejects a ghost project and a negative amount", async () => {
    const ghost = await app.request(`/api/projects/00000000-0000-0000-0000-000000000000/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "X" }),
    });
    expect(ghost.status).toBe(404);

    const negative = await app.request(`/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "X", amountCents: -100 }),
    });
    expect(negative.status).toBe(400);
  });

  it("edits title, amount and date, and toggles done both ways", async () => {
    const res = await app.request(`/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "A revisar" }),
    });
    const { milestone } = (await res.json()) as { milestone: { id: string } };
    milestoneIds.push(milestone.id);

    const edit = await app.request(`/api/projects/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({
        title: "MVP aprobado",
        dueDate: "2026-11-20",
        amountCents: 180000,
        currency: "USD",
      }),
    });
    expect(edit.status).toBe(200);
    const edited = (await edit.json()) as { changed: boolean; milestone: { title: string; amountCents: number | null } };
    expect(edited.changed).toBe(true);
    expect(edited.milestone.title).toBe("MVP aprobado");
    expect(edited.milestone.amountCents).toBe(180000);

    const done = await app.request(`/api/projects/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({ done: true }),
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as { milestone: { doneAt: string | null } };
    expect(doneBody.milestone.doneAt).not.toBeNull();

    // Toggling done again with no other field is a no-op, not a new stamp.
    const redo = await app.request(`/api/projects/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({ done: true }),
    });
    expect(redo.status).toBe(200);
    const redoBody = (await redo.json()) as { changed: boolean };
    expect(redoBody.changed).toBe(false);

    const undone = await app.request(`/api/projects/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({ done: false, amountCents: null }),
    });
    expect(undone.status).toBe(200);
    const undoneBody = (await undone.json()) as { milestone: { doneAt: string | null; amountCents: number | null } };
    expect(undoneBody.milestone.doneAt).toBeNull();
    expect(undoneBody.milestone.amountCents).toBeNull();
  });

  it("rejects invalid patches", async () => {
    const res = await app.request(`/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "Temp" }),
    });
    const { milestone } = (await res.json()) as { milestone: { id: string } };
    milestoneIds.push(milestone.id);

    const badAmount = await app.request(`/api/projects/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({ amountCents: -5 }),
    });
    expect(badAmount.status).toBe(400);

    const badDate = await app.request(`/api/projects/milestones/${milestone.id}`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({ dueDate: "20/11/2026" }),
    });
    expect(badDate.status).toBe(400);

    const ghost = await app.request(`/api/projects/milestones/00000000-0000-0000-0000-000000000000`, {
      method: "PATCH",
      headers: ops,
      body: JSON.stringify({ title: "X" }),
    });
    expect(ghost.status).toBe(404);
  });

  it("deletes a milestone, detaching its tasks instead of destroying them", async () => {
    const res = await app.request(`/api/projects/${projectId}/milestones`, {
      method: "POST",
      headers: ops,
      body: JSON.stringify({ title: "Hito con tarea", amountCents: 90000 }),
    });
    const { milestone } = (await res.json()) as { milestone: { id: string } };

    const [task] = await db
      .insert(tasks)
      .values({ projectId, milestoneId: milestone.id, title: "TEST tarea ligada", spec: "n/a", status: "backlog" })
      .returning();

    const del = await app.request(`/api/projects/milestones/${milestone.id}`, { method: "DELETE", headers: ops });
    expect(del.status).toBe(200);

    const [gone] = await db.select().from(milestones).where(eq(milestones.id, milestone.id)).limit(1);
    expect(gone).toBeUndefined();

    const [keptTask] = await db.select().from(tasks).where(eq(tasks.id, task!.id)).limit(1);
    expect(keptTask).toBeDefined();
    expect(keptTask!.milestoneId).toBeNull();
  });
});
