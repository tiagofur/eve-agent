import { eq, desc } from "drizzle-orm";
import { db } from "../db/client";
import {
  projects,
  milestones,
  tasks,
  leads,
  type ProjectStatus,
  type TaskStatus,
} from "../db/schema";
import { changeLeadStage } from "./leads";
import { logEvent } from "./events";

export interface CreateProjectInput {
  organizationId: string;
  leadId?: string;
  name: string;
  repoUrl?: string;
  milestonesList?: Array<{ title: string; dueDate?: string; amountCents?: number; currency?: string }>;
  actor: string;
}

export async function createProject(input: CreateProjectInput) {
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: input.organizationId,
      leadId: input.leadId,
      name: input.name,
      status: "onboarding",
      repoUrl: input.repoUrl,
    })
    .returning();

  if (!project) {
    throw new Error("Failed to create project");
  }

  // Insert milestones if provided
  if (input.milestonesList && input.milestonesList.length > 0) {
    for (const m of input.milestonesList) {
      await db.insert(milestones).values({
        projectId: project.id,
        title: m.title,
        dueDate: m.dueDate,
        amountCents: m.amountCents ?? null,
        ...(m.currency ? { currency: m.currency } : {}),
      });
    }
  }

  // Advance lead stage to 'onboarding' if linked
  if (input.leadId) {
    const [lead] = await db.select().from(leads).where(eq(leads.id, input.leadId)).limit(1);
    if (lead && lead.stage === "won") {
      await changeLeadStage({
        leadId: input.leadId,
        targetStage: "onboarding",
        reason: `Project "${project.name}" initialized`,
        actor: input.actor,
      });
    }
  }

  await logEvent({
    entity: "project",
    entityId: project.id,
    action: "project_created",
    actor: input.actor,
    after: { name: project.name, status: "onboarding" },
    reason: `New client project initialized: ${project.name}`,
  });

  return project;
}

export interface CreateTaskInput {
  projectId: string;
  milestoneId?: string;
  title: string;
  spec: string; // The complete engineering spec: files, acceptance criteria, test commands
  assignee?: string; // e.g. "gentle-shell", "pi-agent", "human-dev"
  actor: string;
}

export type CreateTaskResult =
  | { success: true; task: typeof tasks.$inferSelect }
  | { success: false; code: string; message: string };

export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  // Link validation (S1): ghost projects 404, cross-project milestones 400
  // — never a bare FK 500, never a silently wrong link.
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) {
    return { success: false, code: "project_not_found", message: `Project ${input.projectId} not found` };
  }

  if (input.milestoneId) {
    const [milestone] = await db
      .select()
      .from(milestones)
      .where(eq(milestones.id, input.milestoneId))
      .limit(1);
    if (!milestone) {
      return { success: false, code: "milestone_not_found", message: `Milestone ${input.milestoneId} not found` };
    }
    if (milestone.projectId !== input.projectId) {
      return {
        success: false,
        code: "milestone_mismatch",
        message: "Milestone belongs to a different project.",
      };
    }
  }

  const [task] = await db
    .insert(tasks)
    .values({
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      title: input.title,
      spec: input.spec,
      status: "ready", // Ready to be dispatched to a coding agent
      assignee: input.assignee ?? "gentle-shell",
    })
    .returning();

  if (!task) {
    throw new Error("Failed to create task");
  }

  await logEvent({
    entity: "task",
    entityId: task.id,
    action: "task_created",
    actor: input.actor,
    after: {
      projectId: input.projectId,
      title: input.title,
      status: "ready",
      assignee: task.assignee,
    },
    reason: input.title,
  });

  return { success: true as const, task };
}

export interface UpdateTaskStatusInput {
  taskId: string;
  status: TaskStatus;
  prUrl?: string;
  actor: string;
}

export type UpdateTaskStatusResult =
  | { success: true; task: typeof tasks.$inferSelect }
  | { success: false; code: string; message: string };

/**
 * Strict machine (S1): backlog → ready → dispatched → in_progress →
 * in_review → done, with blocked along the way, retry from blocked, and
 * rework from in_review. Done is terminal. Bad jumps are rejected.
 */
const TASK_MACHINE: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready"],
  ready: ["dispatched", "blocked"],
  dispatched: ["in_progress", "blocked"],
  in_progress: ["in_review", "blocked"],
  in_review: ["done", "in_progress", "blocked"],
  blocked: ["ready"],
  done: [],
};

export async function updateTaskStatus(input: UpdateTaskStatusInput): Promise<UpdateTaskStatusResult> {
  const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!currentTask) {
    return { success: false, code: "task_not_found", message: `Task ${input.taskId} not found` };
  }

  const from = currentTask.status as TaskStatus;
  if (from === input.status) {
    return { success: true, task: currentTask };
  }
  if (!TASK_MACHINE[from].includes(input.status)) {
    return {
      success: false,
      code: "invalid_transition",
      message: `Invalid task transition: ${from} → ${input.status}`,
    };
  }

  const [updated] = await db
    .update(tasks)
    .set({
      status: input.status,
      prUrl: input.prUrl ?? currentTask.prUrl,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, input.taskId))
    .returning();

  await logEvent({
    entity: "task",
    entityId: input.taskId,
    action: "task_status_changed",
    actor: input.actor,
    before: { status: currentTask.status },
    after: { status: input.status, prUrl: input.prUrl },
  });

  return { success: true as const, task: updated! };
}
