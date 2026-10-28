import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, milestones, organizations, projects, tasks } from "./db/schema";
import { eq } from "drizzle-orm";

// Single shared pool: closed once after every describe in this file.
afterAll(async () => {
  await pool.end();
});

/**
 * Strict task machine (S1): validated project/milestone links (clean 4xx,
 * never 500 on ghosts) and enforced transitions — including the correction
 * pipeline pending_approval → approved (owner gate) → dispatched → …, ready→done
 * jumps and cross-project milestones are rejected.
 */
describe("task machine and links", () => {
  const opsKey = "cp_ops_taskmachkey1234567890abcdef12";
  const ownerKey = "cp_owner_taskmachkey1234567890abcd";
  const devKey = "cp_dev_taskmachkey1234567890abcdef1";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const ownerHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` };
  const devHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${devKey}` };
  let orgId = "";
  let projectA = "";
  let milestoneA = "";
  let milestoneB = "";
  const createdTaskIds: string[] = [];

  const dispatch = async (body: Record<string, unknown>) =>
    app.request("/api/projects/tasks", { method: "POST", headers, body: JSON.stringify(body) });

  const move = async (id: string, status: string, useHeaders = headers) =>
    app.request(`/api/projects/tasks/${id}/status`, {
      method: "PATCH",
      headers: useHeaders,
      body: JSON.stringify({ status }),
    });

  const approve = async (id: string) =>
    app.request(`/api/projects/tasks/${id}/approve`, { method: "POST", headers: ownerHeaders });

  const reject = async (id: string, reason?: string) =>
    app.request(`/api/projects/tasks/${id}/reject`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ reason }),
    });

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Task Machine", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Task Machine Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
      { name: "Task Machine Dev", scope: "dev", keyHash: hashApiKey(devKey) },
    ]);
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
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(ownerKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(devKey)));
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

  it("creates corrections as pending_approval and only the owner can approve", async () => {
    const created = await dispatch({
      projectId: projectA,
      milestoneId: milestoneA,
      title: "Corrección con aprobación",
      spec: "Contexto, criterios, archivos, comandos.",
      kind: "correction",
    });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string; status: string; kind: string } };
    expect(task.status).toBe("pending_approval");
    expect(task.kind).toBe("correction");
    createdTaskIds.push(task.id);

    // dev/ops cannot approve — not even via the generic status PATCH.
    const devApprove = await app.request(`/api/projects/tasks/${task.id}/approve`, {
      method: "POST",
      headers: devHeaders,
    });
    expect(devApprove.status).toBe(403);
    expect((await move(task.id, "approved", ownerHeaders)).status).toBe(400);

    const approved = await approve(task.id);
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { task: { status: string } };
    expect(body.task.status).toBe("approved");

    // approved → done directly must fail.
    expect((await move(task.id, "done")).status).toBe(400);

    for (const next of ["dispatched", "in_progress", "in_review", "done"]) {
      const res = await move(task.id, next);
      expect(res.status).toBe(200);
    }

    // done is terminal.
    expect((await move(task.id, "in_progress")).status).toBe(400);
  });

  it("rejects a pending correction (terminal) with an audit reason", async () => {
    const created = await dispatch({ projectId: projectA, title: "Corrección rechazada", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);

    const res = await reject(task.id, "Fuera de alcance del contrato");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { status: string } };
    expect(body.task.status).toBe("rejected");

    // rejected is terminal: no further transitions.
    expect((await move(task.id, "approved", ownerHeaders)).status).toBe(400);
    expect((await move(task.id, "dispatched")).status).toBe(400);
    // And only pending_approval tasks can be rejected.
    expect((await reject(task.id, "otra vez")).status).toBe(400);
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

  it("records verification evidence on advances and returns it on readback", async () => {
    const created = await dispatch({ projectId: projectA, title: "Tarea con evidencia", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);
    await approve(task.id);

    const evidence = "npm test: 12 passed. tsc clean. Build ok.";
    const res = await app.request(`/api/projects/tasks/${task.id}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "dispatched", resultSummary: evidence }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; task: { resultSummary: string | null } };
    expect(body.task.resultSummary).toBe(evidence);

    const ready = await app.request("/api/projects/tasks/ready", { headers });
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as {
      tasks: Array<{ id: string; resultSummary: string | null }>;
    };
    const found = readyBody.tasks.find((t) => t.id === task.id);
    expect(found?.resultSummary).toBe(evidence);
  });

  it("lists a project's tasks with evidence for pm review", async () => {
    const created = await dispatch({ projectId: projectA, title: "Tarea para QA", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);
    await approve(task.id);
    await move(task.id, "dispatched");
    await app.request(`/api/projects/tasks/${task.id}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress", resultSummary: "Trabajo en curso." }),
    });

    const res = await app.request(`/api/projects/${projectA}/tasks`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Array<{ id: string; status: string; resultSummary: string | null; prUrl: string | null }>;
    };
    const listed = body.tasks.find((t) => t.id === task.id);
    expect(listed?.status).toBe("in_progress");
    expect(listed?.resultSummary).toBe("Trabajo en curso.");
  });
});

describe("correction launcher runs (task_runs)", () => {
  // Owner key: approve is owner-only and owner passes every scope.
  const ownerKey = "cp_owner_taskruns1234567890abcdefg";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` };
  let orgId = "";
  let projectId = "";
  const createdTaskIds: string[] = [];

  const dispatch = async (body: Record<string, unknown>) =>
    app.request("/api/projects/tasks", { method: "POST", headers, body: JSON.stringify(body) });

  const approve = async (id: string) =>
    app.request(`/api/projects/tasks/${id}/approve`, { method: "POST", headers });

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Task Runs", scope: "owner", keyHash: hashApiKey(ownerKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Task Runs" }).returning();
    orgId = org!.id;
    const [p] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST Runs App", status: "active" })
      .returning();
    projectId = p!.id;
  });

  afterAll(async () => {
    for (const id of createdTaskIds) {
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    await db.delete(projects).where(eq(projects.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(ownerKey)));
  });

  const openRun = (id: string, body: Record<string, unknown> = {}) =>
    app.request(`/api/projects/tasks/${id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  it("refuses to launch a pending_approval task", async () => {
    const created = await dispatch({ projectId, title: "Sin aprobar", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);

    const res = await openRun(task.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("task_not_approved");
  });

  it("successful run moves the task to in_review with the agent report", async () => {
    const created = await dispatch({ projectId, title: "Corrección lanzada", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);
    await approve(task.id);

    const opened = await openRun(task.id, { logPath: "/tmp/run.log", branch: "fix/abc" });
    expect(opened.status).toBe(201);
    const openBody = (await opened.json()) as {
      run: { id: string; status: string; branch: string | null };
      task: { status: string };
    };
    expect(openBody.run.status).toBe("running");
    expect(openBody.run.branch).toBe("fix/abc");
    expect(openBody.task.status).toBe("dispatched");

    // Mark the process alive, then close with exit 0 + report.
    await app.request(`/api/projects/tasks/${task.id}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const closed = await app.request(`/api/projects/tasks/${task.id}/runs/${openBody.run.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        exitCode: 0,
        resultSummary: "BRANCH fix/abc — 2 files changed — npm test ok",
      }),
    });
    expect(closed.status).toBe(200);
    const closeBody = (await closed.json()) as {
      run: { status: string; exitCode: number | null };
      task: { status: string; resultSummary: string | null };
    };
    expect(closeBody.run.status).toBe("succeeded");
    expect(closeBody.task.status).toBe("in_review");
    expect(closeBody.task.resultSummary).toContain("npm test ok");

    // A closed run cannot be closed twice.
    const again = await app.request(`/api/projects/tasks/${task.id}/runs/${openBody.run.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ exitCode: 0 }),
    });
    expect(again.status).toBe(400);
  });

  it("failed run blocks the task with the failure tail", async () => {
    const created = await dispatch({ projectId, title: "Corrección que falla", spec: "Spec." });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);
    await approve(task.id);

    const opened = await openRun(task.id);
    const openBody = (await opened.json()) as { run: { id: string } };
    await app.request(`/api/projects/tasks/${task.id}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const closed = await app.request(`/api/projects/tasks/${task.id}/runs/${openBody.run.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ exitCode: 1, resultSummary: "gentle-shell: model error after retry" }),
    });
    expect(closed.status).toBe(200);
    const closeBody = (await closed.json()) as {
      run: { status: string };
      task: { status: string };
    };
    expect(closeBody.run.status).toBe("failed");
    expect(closeBody.task.status).toBe("blocked");
  });
});

describe("project folder configuration and pipeline", () => {
  const opsKey = "cp_ops_foldercfg1234567890abcdefgh";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let orgId = "";
  let projectId = "";
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Folder Cfg", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Folder Cfg" }).returning();
    orgId = org!.id;
    const [p] = await db
      .insert(projects)
      .values({
        organizationId: orgId,
        name: "TEST Folder App",
        status: "active",
        repoUrl: "https://github.com/tiagofur/folder-app",
      })
      .returning();
    projectId = p!.id;
  });

  afterAll(async () => {
    for (const id of createdTaskIds) {
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    await db.delete(projects).where(eq(projects.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
  });

  const okCheck = (over: Record<string, unknown> = {}) => ({
    exists: true,
    isGit: true,
    remoteUrl: "https://github.com/tiagofur/folder-app",
    remoteMatches: true,
    branch: "main",
    clean: true,
    checkedAt: new Date().toISOString(),
    ...over,
  });

  it("configures the folder and only passes verification when the check is ok", async () => {
    const set = await app.request(`/api/projects/${projectId}/folder`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ localPath: "/Users/tiagofur/workspace/folder-app", defaultBranch: "main" }),
    });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { project: { localPath: string | null; defaultBranch: string } };
    expect(setBody.project.localPath).toBe("/Users/tiagofur/workspace/folder-app");
    expect(setBody.project.defaultBranch).toBe("main");

    // A failing check (remote mismatch) is recorded but does not verify.
    const bad = await app.request(`/api/projects/${projectId}/folder/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ check: okCheck({ remoteMatches: false, remoteUrl: "https://github.com/other/repo" }) }),
    });
    expect(bad.status).toBe(200);
    const badBody = (await bad.json()) as { verified: boolean; project: { folderVerifiedAt: string | null } };
    expect(badBody.verified).toBe(false);
    expect(badBody.project.folderVerifiedAt).toBeNull();

    const good = await app.request(`/api/projects/${projectId}/folder/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ check: okCheck() }),
    });
    expect(good.status).toBe(200);
    const goodBody = (await good.json()) as { verified: boolean; project: { folderVerifiedAt: string | null } };
    expect(goodBody.verified).toBe(true);
    expect(goodBody.project.folderVerifiedAt).not.toBeNull();

    // Changing the path voids the previous verification.
    const reset = await app.request(`/api/projects/${projectId}/folder`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ localPath: "/Users/tiagofur/workspace/folder-app-v2" }),
    });
    const resetBody = (await reset.json()) as { project: { folderCheck: unknown; folderVerifiedAt: string | null } };
    expect(resetBody.project.folderCheck).toBeNull();
    expect(resetBody.project.folderVerifiedAt).toBeNull();
  });

  it("pipeline joins task + project folder config + latest run for the launcher", async () => {
    const created = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, title: "Corrección pipeline", spec: "Spec.", kind: "correction" }),
    });
    const { task } = (await created.json()) as { task: { id: string } };
    createdTaskIds.push(task.id);

    const res = await app.request("/api/projects/tasks/pipeline", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Array<{
        id: string;
        status: string;
        project: { name: string | null; localPath: string | null; repoUrl: string | null };
        latestRun: unknown;
      }>;
    };
    const found = body.tasks.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending_approval");
    expect(found?.project.name).toBe("TEST Folder App");
    expect(found?.project.repoUrl).toBe("https://github.com/tiagofur/folder-app");
    expect(found?.latestRun).toBeNull();
  });
});
