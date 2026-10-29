import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { projects, tasks, organizations, milestones, contracts, taskRuns } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  createProject,
  createTask,
  updateTaskStatus,
  approveTask,
  rejectTask,
  updateProjectFolder,
  recordFolderCheck,
} from "../../domain/projects";
import { openTaskRun, closeTaskRun, latestRunsForTasks } from "../../domain/task-runs";

const folderCheckSchema = z.object({
  exists: z.boolean(),
  isGit: z.boolean(),
  remoteUrl: z.string().nullable(),
  remoteMatches: z.boolean().nullable(),
  branch: z.string().nullable(),
  clean: z.boolean().nullable(),
  checkedAt: z.string().min(1),
  // Rust serializes Option::None as null when the check succeeded.
  error: z.string().nullish(),
});

export const projectsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Billing status for the biller subagent: open projects + milestones + contracts.
projectsRouter.get("/billing", requireScope(["ops"]), async (c) => {
  const openProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      organizationId: projects.organizationId,
      organizationName: organizations.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(sql`${projects.status} IN ('onboarding', 'active', 'paused')`)
    .orderBy(desc(projects.createdAt));

  const projectIds = openProjects.map((p) => p.id);
  const allMilestones =
    projectIds.length > 0
      ? await db
          .select()
          .from(milestones)
          .where(
            sql`${milestones.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`
          )
      : [];
  const allContracts =
    projectIds.length > 0
      ? await db
          .select()
          .from(contracts)
          .where(
            sql`${contracts.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`
          )
      : [];

  return c.json({
    projects: openProjects.map((p) => {
      const milestones = allMilestones.filter((m) => m.projectId === p.id);
      const contracts = allContracts.filter((ct) => ct.projectId === p.id);
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const in7days = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
      const dueDateOf = (m: { dueDate: string | null }) => (m.dueDate ? new Date(m.dueDate) : null);
      return {
        ...p,
        milestones,
        contracts,
        // Server-side flags (single clock): overdue = past due and not done;
        // due soon = due within the next 7 days; unsigned = sent but not signed.
        overdueMilestones: milestones.filter((m) => {
          const due = dueDateOf(m);
          return !m.doneAt && due !== null && due < startOfToday;
        }),
        dueSoonMilestones: milestones.filter((m) => {
          const due = dueDateOf(m);
          return !m.doneAt && due !== null && due >= startOfToday && due <= in7days;
        }),
        unsignedContracts: contracts.filter((c) => c.status !== "signed" && c.status !== "void"),
      };
    }),
  });
});

// Create project
projectsRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      organizationId: z.string().uuid(),
      leadId: z.string().uuid().optional(),
      name: z.string().min(1),
      repoUrl: z.string().url().optional(),
      milestonesList: z
        .array(
          z.object({
            title: z.string().min(1),
            dueDate: z.string().optional(),
            amountCents: z.number().int().nonnegative().optional(),
            currency: z.string().max(8).optional(),
          })
        )
        .optional(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const project = await createProject({
      ...data,
      actor,
    });

    return c.json({ success: true, project }, 201);
  }
);

// List projects
projectsRouter.get("/", requireScope(["ops"]), async (c) => {
  const result = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      repoUrl: projects.repoUrl,
      localPath: projects.localPath,
      defaultBranch: projects.defaultBranch,
      testCommand: projects.testCommand,
      folderCheck: projects.folderCheck,
      folderVerifiedAt: projects.folderVerifiedAt,
      organizationName: organizations.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .orderBy(desc(projects.createdAt));

  return c.json({ projects: result });
});

// Create task with engineering spec
projectsRouter.post(
  "/tasks",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      projectId: z.string().uuid(),
      milestoneId: z.string().uuid().optional(),
      ticketId: z.string().uuid().optional(),
      title: z.string().min(1),
      spec: z.string().min(1).describe("Detailed acceptance criteria, affected files, tests"),
      assignee: z.string().default("gentle-shell"),
      kind: z.enum(["feature", "correction"]).optional(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const task = await createTask({
      ...data,
      actor,
    });

    if (!task.success) {
      const status =
        task.code === "project_not_found" ||
        task.code === "ticket_not_found" ||
        task.code === "milestone_not_found"
          ? 404
          : 400;
      return c.json({ error: task.message, code: task.code }, status as 400);
    }

    return c.json({ success: true, task: task.task }, 201);
  }
);

// Get all tasks of a project (ops): the pm review surface — every status
// with specs, PR urls and verification evidence for QA before sign-off.
projectsRouter.get(
  "/:projectId/tasks",
  requireScope(["ops"]),
  async (c) => {
    const projectId = c.req.param("projectId");

    const [project] = await db.select().from(projects).where(sql`${projects.id} = ${projectId}`).limit(1);
    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const result = await db
      .select({
        id: tasks.id,
        milestoneId: tasks.milestoneId,
        ticketId: tasks.ticketId,
        title: tasks.title,
        spec: tasks.spec,
        status: tasks.status,
        assignee: tasks.assignee,
        prUrl: tasks.prUrl,
        resultSummary: tasks.resultSummary,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .where(sql`${tasks.projectId} = ${projectId}`)
      .orderBy(desc(tasks.createdAt));

    return c.json({ tasks: result });
  }
);

// Get tasks ready for coding agents (accessible via 'dev' scope as well as ops/owner)
projectsRouter.get("/tasks/ready", requireScope(["dev", "ops"]), async (c) => {
  const result = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      projectName: projects.name,
      repoUrl: projects.repoUrl,
      title: tasks.title,
      spec: tasks.spec,
      status: tasks.status,
      assignee: tasks.assignee,
      resultSummary: tasks.resultSummary,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.status, ["ready", "dispatched", "in_progress"]))
    .orderBy(desc(tasks.createdAt));

  return c.json({ tasks: result });
});

// Update task status and PR url (accessible by coding agent using 'dev' scope)
projectsRouter.patch(
  "/tasks/:id/status",
  requireScope(["dev", "ops"]),
  zValidator(
    "json",
    z.object({
      status: z.enum(["pending_approval", "ready", "dispatched", "in_progress", "in_review", "done", "blocked"]),
      prUrl: z.string().url().optional(),
      resultSummary: z.string().max(2000).optional(),
    })
  ),
  async (c) => {
    const taskId = c.req.param("id");
    const { status, prUrl, resultSummary } = c.req.valid("json");
    const actor = c.get("actor");

    const updated = await updateTaskStatus({
      taskId,
      status,
      prUrl,
      resultSummary,
      actor,
    });

    if (!updated.success) {
      const statusCode = updated.code === "task_not_found" ? 404 : 400;
      return c.json({ error: updated.message, code: updated.code }, statusCode as 400);
    }

    return c.json({ success: true, task: updated.task });
  }
);

// ---------------------------------------------------------------------
// Correction pipeline (CRM → issue → owner approval → gentle-shell)
// ---------------------------------------------------------------------

// Full correction pipeline for the desktop launcher: every active task with
// its project folder config + latest run. This is the approval & launch surface.
projectsRouter.get("/tasks/pipeline", requireScope(["ops"]), async (c) => {
  const rows = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      milestoneId: tasks.milestoneId,
      title: tasks.title,
      spec: tasks.spec,
      status: tasks.status,
      assignee: tasks.assignee,
      kind: tasks.kind,
      prUrl: tasks.prUrl,
      resultSummary: tasks.resultSummary,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      projectName: projects.name,
      repoUrl: projects.repoUrl,
      localPath: projects.localPath,
      defaultBranch: projects.defaultBranch,
      testCommand: projects.testCommand,
      folderCheck: projects.folderCheck,
      folderVerifiedAt: projects.folderVerifiedAt,
      organizationName: organizations.name,
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(
      inArray(tasks.status, ["pending_approval", "approved", "dispatched", "in_progress", "in_review"]),
    )
    .orderBy(desc(tasks.createdAt));

  const latestRuns = await latestRunsForTasks(rows.map((r) => r.id));

  return c.json({
    tasks: rows.map(
      (
        {
          projectName,
          repoUrl,
          localPath,
          defaultBranch,
          testCommand,
          folderCheck,
          folderVerifiedAt,
          organizationName,
          ...task
        },
      ) => ({
        ...task,
        project: {
          name: projectName,
          organizationName,
          repoUrl,
          localPath,
          defaultBranch,
          testCommand,
          folderCheck,
          folderVerifiedAt,
        },
        latestRun: latestRuns.get(task.id) ?? null,
      }),
    ),
  });
});

// Owner HITL gate: approve a pending correction (issue) for launch.
projectsRouter.post("/tasks/:id/approve", requireScope(["owner"]), async (c) => {
  const actor = c.get("actor");
  const taskId = c.req.param("id")!;
  const result = await approveTask({ taskId, actor });
  if (!result.success) {
    const status = result.code === "task_not_found" ? 404 : 400;
    return c.json({ error: result.message, code: result.code }, status as 400);
  }
  return c.json({ success: true, task: result.task });
});

// Owner HITL gate: reject a pending correction with an audit reason.
projectsRouter.post(
  "/tasks/:id/reject",
  requireScope(["owner"]),
  zValidator("json", z.object({ reason: z.string().max(2000).optional() })),
  async (c) => {
    const actor = c.get("actor");
    const { reason } = c.req.valid("json");
    const result = await rejectTask({ taskId: c.req.param("id"), reason, actor });
    if (!result.success) {
      const status = result.code === "task_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }
    return c.json({ success: true, task: result.task });
  }
);

// Open a launcher run (desktop gentle-shell): task → dispatched, run → running.
projectsRouter.post(
  "/tasks/:id/runs",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      logPath: z.string().optional(),
      issuePath: z.string().optional(),
      branch: z.string().optional(),
    }),
  ),
  async (c) => {
    const actor = c.get("actor");
    const data = c.req.valid("json");
    const result = await openTaskRun({ taskId: c.req.param("id"), ...data, actor });
    if (!result.success) {
      const status = result.code === "task_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }
    return c.json({ success: true, run: result.run, task: result.task }, 201);
  }
);

// Close a launcher run: exit 0 → in_review with the agent report; failure → blocked.
projectsRouter.patch(
  "/tasks/:id/runs/:runId",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      exitCode: z.number().int(),
      resultSummary: z.string().max(4000).optional(),
      prUrl: z.string().url().optional(),
    }),
  ),
  async (c) => {
    const actor = c.get("actor");
    const { exitCode, resultSummary, prUrl } = c.req.valid("json");
    const result = await closeTaskRun({
      runId: c.req.param("runId"),
      exitCode,
      resultSummary,
      prUrl,
      actor,
    });
    if (!result.success) {
      const status = result.code === "run_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }
    return c.json({ success: true, run: result.run, task: result.task, ...(result.transitionSkipped ? { transitionSkipped: result.transitionSkipped } : {}) });
  }
);

// Tail of a run log for runs executed by the VPS worker: the file lives on a
// shared volume reachable by this API, guarded to WORKER_LOG_ROOT so a run
// row can never make the API read arbitrary container paths. Desktop-launched
// runs keep reading their local file directly.
projectsRouter.get("/tasks/:id/runs/:runId/log", requireScope(["ops"]), async (c) => {
  const root = process.env.WORKER_LOG_ROOT;
  if (!root) {
    return c.json({ error: "WORKER_LOG_ROOT is not configured on this API instance" }, 404);
  }
  const [run] = await db
    .select()
    .from(taskRuns)
    .where(sql`${taskRuns.id} = ${c.req.param("runId")}`)
    .limit(1);
  if (!run?.logPath) {
    return c.json({ error: "Run or log path not found" }, 404);
  }
  const resolved = path.resolve(run.logPath);
  const normalizedRoot = path.resolve(root);
  if (!resolved.startsWith(normalizedRoot + path.sep)) {
    return c.json({ error: "Log path is outside WORKER_LOG_ROOT" }, 403);
  }
  try {
    const stat = await fsp.stat(resolved);
    const size = Math.min(stat.size, 65536);
    const fh = await fsp.open(resolved, "r");
    const buf = Buffer.alloc(size);
    if (size > 0) await fh.read(buf, 0, size, stat.size - size);
    await fh.close();
    return c.json({ log: buf.toString("utf-8"), size: stat.size, truncated: stat.size > size });
  } catch {
    return c.json(
      { error: "Log file not readable (the run may have executed on another machine)" },
      404
    );
  }
});

// Configure where a project repo lives on the launcher machine.
projectsRouter.patch(
  "/:id/folder",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      localPath: z.string().max(1024).nullable().optional(),
      defaultBranch: z.string().max(200).optional(),
      testCommand: z.string().max(500).nullable().optional(),
    }),
  ),
  async (c) => {
    const actor = c.get("actor");
    const data = c.req.valid("json");
    const result = await updateProjectFolder({ projectId: c.req.param("id"), ...data, actor });
    if (!result.success) {
      const status = result.code === "project_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }
    return c.json({ success: true, project: result.project });
  }
);

// Persist the desktop launcher's mechanical folder verification.
projectsRouter.post(
  "/:id/folder/verify",
  requireScope(["ops"]),
  zValidator("json", z.object({ check: folderCheckSchema })),
  async (c) => {
    const actor = c.get("actor");
    const { check } = c.req.valid("json");
    const result = await recordFolderCheck({ projectId: c.req.param("id"), check, actor });
    if (!result.success) {
      const status = result.code === "project_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }
    return c.json({ success: true, project: result.project, verified: result.verified });
  }
);
