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
  getLocalScheduleHandler,
  openScheduleRun,
  recordLocalRun,
  registerLocalScheduleHandler,
  summarizeReply,
  type ClaimedSchedule,
} from "../domain/schedules";
import { runDailyDigestOnce } from "./followup-digest";
import { tickMetricsCollector } from "./metrics-collector";
import { escapeHtml, sendTelegramMessage } from "./telegram";

/**
 * Agent-cronjob dispatcher: a node-cron minute tick (same daemon pattern as
 * followup-digest) that claims due `schedules` rows and executes each one —
 * agent rows as orchestrator turns through the staff EVE proxy, local rows
 * through their registered CRM handler. Execution outcomes land in
 * `schedule_runs` with a dedicated thread per agent run.
 */

/** A claimed window older than this is skipped instead of run after downtime. */
export const SCHEDULE_GRACE_MS = 10 * 60_000;

/**
 * Local jobs are idempotent per day (digest dedupes on its event, the
 * collector upserts per day), so a missed window during downtime can still
 * run late — the boot catch-up they used to do themselves.
 */
export const LOCAL_SCHEDULE_GRACE_MS = 12 * 60 * 60_000;

/** Hard cap per execution: a stuck EVE stream must not pin a run as running forever. */
const RUN_TIMEOUT_MS = 30 * 60_000;

// The two seeded local jobs (kind=local): CRM-side work, no LLM involved.
registerLocalScheduleHandler("followup_digest", () => runDailyDigestOnce());
registerLocalScheduleHandler("metrics_collector", async () => {
  await tickMetricsCollector();
});

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
    await closeScheduleRun(opened.runId, {
      status: "succeeded",
      resultSummary: summarizeReply(out.reply),
      usage: out.usage,
    });
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
  await alignFreshSchedules(now);

  // Local jobs run even without the brain configured.
  const locals = await claimDueSchedules(now, 20, "local");
  for (const job of locals) {
    await runLocalSchedule(job, now);
  }

  // Agent jobs need the brain; while it is down their windows stay unclaimed
  // so a later tick (once EVE is back) still executes them within the grace.
  const eve = resolveEveProxyConfig(process.env);
  if (!eve.enabled) {
    console.warn("[Schedules] agent ticks skipped: EVE proxy not configured/unreachable config");
    return;
  }
  const due = await claimDueSchedules(now, 20, "agent");
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

/** Executes a claimed local job through its registered handler, no EVE. */
async function runLocalSchedule(job: ClaimedSchedule, now: Date): Promise<void> {
  if (now.getTime() - job.dueAt.getTime() > LOCAL_SCHEDULE_GRACE_MS) {
    console.log(
      `[Schedules] "${job.title}" window ${job.dueAt.toISOString()} skipped (stale, next ${job.nextRunAt.toISOString()})`
    );
    return;
  }
  const handler = job.handler ? getLocalScheduleHandler(job.handler) : undefined;
  if (!handler) {
    await recordLocalRun(job.id, {
      status: "failed",
      error: `No local handler registered for "${job.handler ?? "(none)"}"`,
    });
    return;
  }
  try {
    await handler();
    await recordLocalRun(job.id, { status: "succeeded", resultSummary: "Job local ejecutado" });
    console.log(`[Schedules] local "${job.title}" succeeded`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown local job failure";
    await recordLocalRun(job.id, { status: "failed", error: message });
    await logEvent({
      entity: "schedule",
      entityId: job.id,
      action: "run_failed",
      actor: "system",
      after: { error: message },
      reason: "Job local de tarea programada fallido",
    }).catch(() => undefined);
    console.error(`[Schedules] local "${job.title}" failed:`, message);
  }
}

/** Manual "Ejecutar ahora": fire one run now, without touching next_run_at. */
export async function dispatchScheduleNow(
  scheduleId: string
): Promise<{ runId: string; threadId: string | null }> {
  const [row] = await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1);
  if (!row) throw new Error("Schedule not found");

  if (row.kind === "local") {
    const handler = row.handler ? getLocalScheduleHandler(row.handler) : undefined;
    if (!handler) {
      throw new Error(`No local handler registered for "${row.handler ?? "(none)"}"`);
    }
    try {
      await handler();
      const runId = await recordLocalRun(
        row.id,
        { status: "succeeded", resultSummary: "Job local ejecutado" },
        "manual"
      );
      return { runId, threadId: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown local job failure";
      const runId = await recordLocalRun(row.id, { status: "failed", error: message }, "manual");
      await logEvent({
        entity: "schedule",
        entityId: row.id,
        action: "run_failed",
        actor: "system",
        after: { runId, error: message },
        reason: "Ejecución manual de job local fallida",
      }).catch(() => undefined);
      throw err;
    }
  }

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
