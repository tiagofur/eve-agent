import { eq, desc, inArray, and } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, taskRuns } from "../db/schema";
import { updateTaskStatus } from "./projects";
import { logEvent } from "./events";

export interface OpenTaskRunInput {
  taskId: string;
  /** Absolute paths on the launcher machine (audit + replay of the exact issue handed to the agent). */
  logPath?: string;
  issuePath?: string;
  branch?: string;
  actor: string;
}

export type OpenTaskRunResult =
  | { success: true; run: typeof taskRuns.$inferSelect; task: typeof tasks.$inferSelect }
  | { success: false; code: string; message: string };

/**
 * Open a launcher run for an approved correction. Moves the task to
 * `dispatched` (from approved/ready); a rework run on an already
 * `in_progress` task opens without a transition. `pending_approval` tasks
 * can never be launched — the owner gate is enforced here, not only in the route.
 *
 * The approved/ready → dispatched flip is an atomic conditional UPDATE: when
 * the desktop launcher and the VPS worker race for the same task, exactly one
 * of them wins the claim and the other gets `already_dispatched`.
 */
export async function openTaskRun(input: OpenTaskRunInput): Promise<OpenTaskRunResult> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  if (!task) {
    return { success: false, code: "task_not_found", message: `Task ${input.taskId} not found` };
  }

  if (task.status === "pending_approval") {
    return {
      success: false,
      code: "task_not_approved",
      message: "Task is pending owner approval; approve it before launching.",
    };
  }
  if (task.status === "dispatched") {
    return {
      success: false,
      code: "already_dispatched",
      message: "Task already has a live run; refuse the double launch.",
    };
  }
  if (!["approved", "ready", "in_progress"].includes(task.status)) {
    return {
      success: false,
      code: "invalid_transition",
      message: `Task in status ${task.status} cannot be launched.`,
    };
  }

  if (task.status === "approved" || task.status === "ready") {
    const claimed = await db
      .update(tasks)
      .set({ status: "dispatched", updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, input.taskId),
          inArray(tasks.status, ["approved", "ready"])
        )
      )
      .returning();
    if (claimed.length === 0) {
      return {
        success: false,
        code: "already_dispatched",
        message: "Task already has a live run; refuse the double launch.",
      };
    }
    await logEvent({
      entity: "task",
      entityId: input.taskId,
      action: "task_status_changed",
      actor: input.actor,
      before: { status: task.status },
      after: { status: "dispatched" },
      reason: "run claim",
    });
  }

  const [run] = await db
    .insert(taskRuns)
    .values({
      taskId: input.taskId,
      status: "running",
      ...(input.logPath ? { logPath: input.logPath } : {}),
      ...(input.issuePath ? { issuePath: input.issuePath } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
    })
    .returning();

  await logEvent({
    entity: "task_run",
    entityId: run!.id,
    action: "task_run_opened",
    actor: input.actor,
    after: { taskId: input.taskId, logPath: input.logPath ?? null, branch: input.branch ?? null },
  });

  const [fresh] = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  return { success: true, run: run!, task: fresh! };
}

export interface CloseTaskRunInput {
  runId: string;
  exitCode: number;
  resultSummary?: string;
  prUrl?: string;
  actor: string;
}

export type CloseTaskRunResult =
  | {
      success: true;
      run: typeof taskRuns.$inferSelect;
      task: typeof tasks.$inferSelect | null;
      /** Set when the run closed but the task status could not advance (already moved on). */
      transitionSkipped?: string;
    }
  | { success: false; code: string; message: string };

/**
 * Close a launcher run. Exit 0 → run succeeded and the task moves to
 * in_review with the agent's report; non-zero → run failed and the task is
 * blocked with the failure tail for the owner to inspect.
 */
export async function closeTaskRun(input: CloseTaskRunInput): Promise<CloseTaskRunResult> {
  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, input.runId)).limit(1);
  if (!run) {
    return { success: false, code: "run_not_found", message: `Run ${input.runId} not found` };
  }
  if (run.status !== "running") {
    return { success: false, code: "run_already_closed", message: `Run ${input.runId} is already ${run.status}.` };
  }

  const succeeded = input.exitCode === 0;
  const [closed] = await db
    .update(taskRuns)
    .set({
      status: succeeded ? "succeeded" : "failed",
      finishedAt: new Date(),
      exitCode: input.exitCode,
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
      ...(input.prUrl ? { prUrl: input.prUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(taskRuns.id, input.runId))
    .returning();

  await logEvent({
    entity: "task_run",
    entityId: input.runId,
    action: succeeded ? "task_run_succeeded" : "task_run_failed",
    actor: input.actor,
    after: { taskId: run.taskId, exitCode: input.exitCode, prUrl: input.prUrl ?? null },
    reason: input.resultSummary ?? null,
  });

  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
  if (!task) {
    return { success: true, run: closed!, task: null, transitionSkipped: "task_missing" };
  }

  let transitionSkipped: string | undefined;
  if (["dispatched", "in_progress"].includes(task.status)) {
    const moved = await updateTaskStatus({
      taskId: task.id,
      status: succeeded ? "in_review" : "blocked",
      ...(input.resultSummary ? { resultSummary: input.resultSummary.slice(0, 2000) } : {}),
      ...(input.prUrl ? { prUrl: input.prUrl } : {}),
      actor: input.actor,
    });
    if (!moved.success) {
      transitionSkipped = moved.message;
    }
  } else {
    transitionSkipped = `task already in ${task.status}`;
  }

  const [fresh] = await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
  return {
    success: true,
    run: closed!,
    task: fresh ?? null,
    ...(transitionSkipped ? { transitionSkipped } : {}),
  };
}

/** Latest run per task for a set of tasks (pipeline view). */
export async function latestRunsForTasks(taskIds: string[]) {
  if (taskIds.length === 0) return new Map<string, typeof taskRuns.$inferSelect>();
  const rows = await db
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(desc(taskRuns.createdAt));
  const byTask = new Map<string, typeof taskRuns.$inferSelect>();
  for (const row of rows) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, row);
  }
  return byTask;
}
