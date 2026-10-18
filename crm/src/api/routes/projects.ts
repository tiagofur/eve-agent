import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { projects, tasks, organizations, milestones, contracts } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { createProject, createTask, updateTaskStatus } from "../../domain/projects";

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
      title: z.string().min(1),
      spec: z.string().min(1).describe("Detailed acceptance criteria, affected files, tests"),
      assignee: z.string().default("gentle-shell"),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const task = await createTask({
      ...data,
      actor,
    });

    return c.json({ success: true, task }, 201);
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
      status: z.enum(["ready", "dispatched", "in_progress", "in_review", "done", "blocked"]),
      prUrl: z.string().url().optional(),
    })
  ),
  async (c) => {
    const taskId = c.req.param("id");
    const { status, prUrl } = c.req.valid("json");
    const actor = c.get("actor");

    const updated = await updateTaskStatus({
      taskId,
      status,
      prUrl,
      actor,
    });

    return c.json({ success: true, task: updated });
  }
);
