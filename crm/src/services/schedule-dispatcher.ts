import cron from "node-cron";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { chatMessages, schedules } from "../db/schema";
import { logEvent } from "../domain/events";
import { runProxiedTurn } from "../domain/agent-turn";
import { resolveEveProxyConfig, type EnabledEveProxyConfig } from "../domain/eve-client";
import {
  alignFreshSchedules,
  claimDueSchedules,
  closeScheduleRun,
  openScheduleRun,
  summarizeReply,
} from "../domain/schedules";
import { escapeHtml, sendTelegramMessage } from "./telegram";

/**
 * Agent-cronjob dispatcher: a node-cron minute tick (same daemon pattern as
 * followup-digest) that claims due `schedules` rows and executes each prompt
 * as an orchestrator turn through the staff EVE proxy. Execution outcomes
 * land in `schedule_runs` with a dedicated thread per run.
 */

/** A claimed window older than this is skipped instead of run after downtime. */
export const SCHEDULE_GRACE_MS = 10 * 60_000;

/** Hard cap per execution: a stuck EVE stream must not pin a run as running forever. */
const RUN_TIMEOUT_MS = 30 * 60_000;

export interface ScheduleRef {
  id: string;
  title: string;
  prompt: string;
}

/**
 * Opens the run row synchronously (callers get the runId immediately), then
 * drives the orchestrator turn in the background and closes the run with the
 * outcome. Failures notify Telegram and leave an audit event.
 */
export async function startScheduleExecution(
  schedule: ScheduleRef,
  trigger: "cron" | "manual",
  eve: EnabledEveProxyConfig
): Promise<{ runId: string; threadId: string }> {
  const opened = await openScheduleRun(schedule.id, schedule.title, trigger);
  // driveScheduleRun closes its own failures; this catch only guards against
  // a bug in that close path itself.
  void driveScheduleRun(opened, schedule, eve).catch(async (err) => {
    console.error("[Schedules] run driver crashed:", err);
    await closeScheduleRun(opened.runId, {
      status: "failed",
      error: err instanceof Error ? err.message : "run driver crashed",
    }).catch(() => undefined);
  });
  return opened;
}

async function driveScheduleRun(
  opened: { runId: string; threadId: string },
  schedule: ScheduleRef,
  eve: EnabledEveProxyConfig
): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  try {
    // The schedule prompt is the turn's user message: persists verbatim in
    // the run thread so Mission Control shows what the agent was asked to do.
    await db.insert(chatMessages).values({
      threadId: opened.threadId,
      role: "user",
      content: schedule.prompt,
    });
    const out = await runProxiedTurn({
      threadId: opened.threadId,
      userContent: schedule.prompt,
      eve,
      signal: abort.signal,
    });
    await closeScheduleRun(opened.runId, { status: "succeeded", resultSummary: summarizeReply(out.reply) });
    console.log(`[Schedules] run ${opened.runId} of "${schedule.title}" succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown schedule run failure";
    await closeScheduleRun(opened.runId, { status: "failed", error: message });
    await logEvent({
      entity: "schedule",
      entityId: schedule.id,
      action: "run_failed",
      actor: "system",
      after: { runId: opened.runId, error: message },
      reason: "Ejecución de tarea programada fallida",
    }).catch(() => undefined);
    try {
      await sendTelegramMessage(
        `⚠️ <b>Tarea programada fallida</b>: ${escapeHtml(schedule.title)}\n<pre>${escapeHtml(
          message.slice(0, 500)
        )}</pre>`
      );
    } catch {
      // Notification is best-effort; the run row already carries the error.
    }
    console.error(`[Schedules] run ${opened.runId} of "${schedule.title}" failed:`, message);
  } finally {
    clearTimeout(timer);
  }
}

/** One dispatcher tick: align fresh rows, claim due windows, execute them. */
export async function tickScheduleDispatcher(now: Date = new Date()): Promise<void> {
  const eve = resolveEveProxyConfig(process.env);
  if (!eve.enabled) {
    // The brain is down: leave windows unclaimed so a later tick (once EVE
    // is back) still executes everything within the grace window.
    console.warn("[Schedules] tick skipped: EVE proxy not configured/unreachable config");
    return;
  }

  await alignFreshSchedules(now);

  const due = await claimDueSchedules(now);
  for (const job of due) {
    if (now.getTime() - job.dueAt.getTime() > SCHEDULE_GRACE_MS) {
      // Missed by more than the grace window (long downtime): skip ahead —
      // the claim already advanced next_run_at to the following occurrence.
      console.log(
        `[Schedules] "${job.title}" window ${job.dueAt.toISOString()} skipped (stale, next ${job.nextRunAt.toISOString()})`
      );
      continue;
    }
    await startScheduleExecution(job, "cron", eve);
  }
}

/** Manual "Ejecutar ahora": fire one run now, without touching next_run_at. */
export async function dispatchScheduleNow(
  scheduleId: string
): Promise<{ runId: string; threadId: string }> {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1);
  if (!row) throw new Error("Schedule not found");
  const eve = resolveEveProxyConfig(process.env);
  if (!eve.enabled) {
    throw new Error(
      "Single brain unavailable: configure EVE_AGENT_URL, EVE_CHANNEL_USER and EVE_CHANNEL_PASSWORD."
    );
  }
  return startScheduleExecution({ id: row.id, title: row.title, prompt: row.prompt }, "manual", eve);
}

let tickInFlight: Promise<void> | null = null;

/** Minute tick + overlapping-tick guard (followup-digest pattern). */
export function startScheduleDispatcher(): void {
  cron.schedule("* * * * *", () => {
    if (tickInFlight) return;
    tickInFlight = tickScheduleDispatcher()
      .catch((err) => console.error("[Schedules] tick failed:", err))
      .finally(() => {
        tickInFlight = null;
      });
  });
}
