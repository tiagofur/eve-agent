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
  kind?: "feature" | "correction";
  /** Corrections default to pending_approval (owner HITL gate); backlog keeps the manual pipeline. */
  initialStatus?: "pending_approval" | "backlog";
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

  const initialStatus = input.initialStatus ?? "pending_approval";

  const [task] = await db
    .insert(tasks)
    .values({
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      title: input.title,
      spec: input.spec,
      status: initialStatus,
      assignee: input.assignee ?? "gentle-shell",
      kind: input.kind ?? "feature",
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
      status: initialStatus,
      assignee: task.assignee,
      kind: task.kind,
    },
    reason: input.title,
  });

  return { success: true as const, task };
}

export interface UpdateTaskStatusInput {
  taskId: string;
  status: TaskStatus;
  prUrl?: string;
  /** Verification evidence: what ran (tests, typecheck, build) + outcome. */
  resultSummary?: string;
  actor: string;
}

export type UpdateTaskStatusResult =
  | { success: true; task: typeof tasks.$inferSelect }
  | { success: false; code: string; message: string };

/**
 * Strict machine (S1). Correction pipeline: pending_approval → approved →
 * dispatched → in_progress → in_review → done, with rejected (terminal) at
 * the approval gate. Legacy feature pipeline (backlog → ready → …) is kept
 * so old tasks and the manual CLI worker keep working. Bad jumps are rejected.
 */
const TASK_MACHINE: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready"],
  pending_approval: ["approved", "rejected", "blocked"],
  approved: ["dispatched", "pending_approval", "blocked"],
  ready: ["dispatched", "blocked"],
  dispatched: ["in_progress", "blocked"],
  in_progress: ["in_review", "blocked"],
  in_review: ["done", "in_progress", "blocked"],
  blocked: ["ready", "pending_approval", "approved", "dispatched"],
  rejected: [],
  done: [],
};

/** Only the owner-scoped approve/reject endpoints may move a task into these. */
const OWNER_ONLY_TARGETS: ReadonlySet<TaskStatus> = new Set(["approved", "rejected"]);

export async function updateTaskStatus(input: UpdateTaskStatusInput): Promise<UpdateTaskStatusResult> {
  const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!currentTask) {
    return { success: false, code: "task_not_found", message: `Task ${input.taskId} not found` };
  }

  const from = currentTask.status as TaskStatus;
  if (from === input.status) {
    return { success: true, task: currentTask };
  }
  if (OWNER_ONLY_TARGETS.has(input.status)) {
    return {
      success: false,
      code: "owner_only_transition",
      message: `Transition → ${input.status} is reserved to the owner approval endpoints.`,
    };
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
      resultSummary: input.resultSummary ?? currentTask.resultSummary,
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
    after: { status: input.status, prUrl: input.prUrl, resultSummary: input.resultSummary ?? null },
  });

  return { success: true, task: updated! };
}

export interface ApproveTaskInput {
  taskId: string;
  actor: string;
}

export type ApproveTaskResult =
  | { success: true; task: typeof tasks.$inferSelect }
  | { success: false; code: string; message: string };

/** Owner HITL gate: pending_approval → approved. The launch itself still re-verifies the folder. */
export async function approveTask(input: ApproveTaskInput): Promise<ApproveTaskResult> {
  const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!currentTask) {
    return { success: false, code: "task_not_found", message: `Task ${input.taskId} not found` };
  }
  if (currentTask.status !== "pending_approval") {
    return {
      success: false,
      code: "invalid_transition",
      message: `Only pending_approval tasks can be approved (current: ${currentTask.status}).`,
    };
  }

  const [updated] = await db
    .update(tasks)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(tasks.id, input.taskId))
    .returning();

  await logEvent({
    entity: "task",
    entityId: input.taskId,
    action: "task_approved",
    actor: input.actor,
    before: { status: "pending_approval" },
    after: { status: "approved" },
  });

  return { success: true, task: updated! };
}

export interface RejectTaskInput {
  taskId: string;
  reason?: string;
  actor: string;
}

export type RejectTaskResult =
  | { success: true; task: typeof tasks.$inferSelect }
  | { success: false; code: string; message: string };

/** Owner HITL gate: pending_approval → rejected (terminal) with an audit reason. */
export async function rejectTask(input: RejectTaskInput): Promise<RejectTaskResult> {
  const [currentTask] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!currentTask) {
    return { success: false, code: "task_not_found", message: `Task ${input.taskId} not found` };
  }
  if (currentTask.status !== "pending_approval") {
    return {
      success: false,
      code: "invalid_transition",
      message: `Only pending_approval tasks can be rejected (current: ${currentTask.status}).`,
    };
  }

  const [updated] = await db
    .update(tasks)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(tasks.id, input.taskId))
    .returning();

  await logEvent({
    entity: "task",
    entityId: input.taskId,
    action: "task_rejected",
    actor: input.actor,
    before: { status: "pending_approval" },
    after: { status: "rejected" },
    reason: input.reason ?? null,
  });

  return { success: true, task: updated! };
}

/* ------------------------------------------------------------------ */
/* Project folder configuration (coding-agent launcher)                */
/* ------------------------------------------------------------------ */

/** Mechanical verification of a project's local folder, as run by the desktop launcher. */
export interface FolderCheck {
  exists: boolean;
  isGit: boolean;
  remoteUrl: string | null;
  /** True when the folder's git remote matches the project repoUrl (null when repoUrl is unset). */
  remoteMatches: boolean | null;
  branch: string | null;
  clean: boolean | null;
  checkedAt: string;
  error?: string | null;
}

export function isFolderCheckOk(check: FolderCheck, repoUrl?: string | null): boolean {
  if (check.error || !check.exists || !check.isGit) return false;
  if (repoUrl && check.remoteMatches !== true) return false;
  return true;
}

export interface UpdateProjectFolderInput {
  projectId: string;
  localPath?: string | null;
  defaultBranch?: string;
  testCommand?: string | null;
  actor: string;
}

export type UpdateProjectFolderResult =
  | { success: true; project: typeof projects.$inferSelect }
  | { success: false; code: string; message: string };

/** Configure where the project repo lives on the launcher machine. Any previous verification is voided. */
export async function updateProjectFolder(
  input: UpdateProjectFolderInput,
): Promise<UpdateProjectFolderResult> {
  const [current] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!current) {
    return { success: false, code: "project_not_found", message: `Project ${input.projectId} not found` };
  }

  const pathChanged = input.localPath !== undefined && input.localPath !== current.localPath;
  const [updated] = await db
    .update(projects)
    .set({
      ...(input.localPath !== undefined ? { localPath: input.localPath } : {}),
      ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
      ...(input.testCommand !== undefined ? { testCommand: input.testCommand } : {}),
      // A new path invalidates the previous verification.
      ...(pathChanged ? { folderCheck: null, folderVerifiedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, input.projectId))
    .returning();

  await logEvent({
    entity: "project",
    entityId: input.projectId,
    action: "project_folder_configured",
    actor: input.actor,
    before: { localPath: current.localPath, defaultBranch: current.defaultBranch },
    after: {
      localPath: updated!.localPath,
      defaultBranch: updated!.defaultBranch,
      testCommand: updated!.testCommand,
    },
  });

  return { success: true, project: updated! };
}

export interface RecordFolderCheckInput {
  projectId: string;
  check: FolderCheck;
  actor: string;
}

export type RecordFolderCheckResult =
  | { success: true; project: typeof projects.$inferSelect; verified: boolean }
  | { success: false; code: string; message: string };

/** Persist the launcher's folder verification outcome; sets folderVerifiedAt only when the check passes. */
export async function recordFolderCheck(
  input: RecordFolderCheckInput,
): Promise<RecordFolderCheckResult> {
  const [current] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!current) {
    return { success: false, code: "project_not_found", message: `Project ${input.projectId} not found` };
  }

  const verified = isFolderCheckOk(input.check, current.repoUrl);
  const [updated] = await db
    .update(projects)
    .set({
      folderCheck: input.check,
      folderVerifiedAt: verified ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, input.projectId))
    .returning();

  await logEvent({
    entity: "project",
    entityId: input.projectId,
    action: verified ? "project_folder_verified" : "project_folder_check_failed",
    actor: input.actor,
    after: { localPath: current.localPath, check: input.check },
  });

  return { success: true, project: updated!, verified };
}
