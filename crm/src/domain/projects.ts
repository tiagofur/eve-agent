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
  milestonesList?: Array<{ title: string; dueDate?: string }>;
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

export async function createTask(input: CreateTaskInput) {
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

  return task;
}

export interface UpdateTaskStatusInput {
  taskId: string;
  status: TaskStatus;
  prUrl?: string;
  actor: string;
}

export async function updateTaskStatus(input: UpdateTaskStatusInput) {
  const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!currentTask) {
    throw new Error(`Task ${input.taskId} not found`);
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

  return updated;
}
