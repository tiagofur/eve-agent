import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
// Default import: v4 is CJS without an ESM exports map, so a named import
// works under vitest/vite interop but fails in plain Node ESM (tsx runtime).
import cronParser from "cron-parser";

const parseExpression = cronParser.parseExpression;
import { db } from "../db/client";
import {
  chatThreads,
  scheduleCategoryEnum,
  schedules,
  scheduleRuns,
  type ScheduleCategory,
  type ScheduleRunTrigger,
} from "../db/schema";
import type { EveUsage } from "./eve-client";

/**
 * Domain layer for agent cronjobs (see the `schedules` / `schedule_runs`
 * tables). The dispatcher service owns execution; this module owns cadence
 * math and the atomic claim that keeps overlapping minute ticks from
 * dispatching the same window twice.
 */

export const SCHEDULE_CATEGORIES = scheduleCategoryEnum.enumValues;

/**
 * Category of a new schedule when its creator gave none: a keyword match on
 * the slug and title. Anything unrecognized lands in `other`, where it is
 * still listed and can be re-filed.
 */
export function inferScheduleCategory(name: string, title: string): ScheduleCategory {
  const haystack = `${name} ${title}`.toLowerCase();
  if (/(contenid|content|intel|editorial|marketing|post|diseñ|design|pack|redes|social)/.test(haystack)) {
    return "content";
  }
  if (/(report|informe|brief|metric|m[eé]tric|resumen|digest)/.test(haystack)) return "reports";
  if (/(venta|sale|pipeline|follow|seguimiento|cobro|billing|prospect|lead|outreach)/.test(haystack)) {
    return "sales";
  }
  if (/(backup|sistem|system|salud|health|limpieza|cleanup|migraci)/.test(haystack)) return "system";
  return "other";
}

/** Validates a 5-field cron expression; throws (cron-parser) when invalid. */
export function assertValidCron(expr: string): void {
  parseExpression(expr);
}

/**
 * Next occurrence strictly after `after`, in the server's local time — the
 * same clock node-cron's minute tick uses, so computed nextRunAt values match
 * what actually fires.
 */
export function nextOccurrence(expr: string, after: Date): Date {
  // +1s keeps "next" strictly after even when `after` sits exactly on a match.
  const interval = parseExpression(expr, { currentDate: new Date(after.getTime() + 1000) });
  return interval.next().toDate();
}

/**
 * Fresh rows (next_run_at NULL, e.g. the migration seed) get aligned to their
 * next occurrence without firing: deploying at 14:00 must not trigger the
 * 07:00 intel brief out of cadence.
 */
export async function alignFreshSchedules(now: Date): Promise<number> {
  const fresh = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), isNull(schedules.nextRunAt)));
  for (const row of fresh) {
    await db
      .update(schedules)
      .set({ nextRunAt: nextOccurrence(row.cron, now) })
      .where(and(eq(schedules.id, row.id), isNull(schedules.nextRunAt)));
  }
  return fresh.length;
}

export interface ClaimedSchedule {
  id: string;
  name: string;
  title: string;
  prompt: string;
  cron: string;
  /** The window that came due — old next_run_at, before the claim advanced it. */
  dueAt: Date;
  /** next_run_at already advanced to the following occurrence. */
  nextRunAt: Date;
}

/**
 * Atomically claims due rows by compare-and-set on next_run_at: the update
 * only wins while the row still shows the due window we saw, so concurrent
 * ticks (or a manual tick racing the cron) never double-dispatch a window.
 */
export async function claimDueSchedules(now: Date, limit = 20): Promise<ClaimedSchedule[]> {
  const candidates = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
    .orderBy(asc(schedules.nextRunAt))
    .limit(limit);

  const claimed: ClaimedSchedule[] = [];
  for (const row of candidates) {
    const dueAt = row.nextRunAt;
    if (!dueAt) continue;
    const nextRunAt = nextOccurrence(row.cron, now);
    const won = await db
      .update(schedules)
      .set({ nextRunAt })
      .where(
        and(
          eq(schedules.id, row.id),
          eq(schedules.nextRunAt, dueAt),
          eq(schedules.enabled, true)
        )
      )
      .returning({ id: schedules.id });
    if (won.length === 1) {
      claimed.push({
        id: row.id,
        name: row.name,
        title: row.title,
        prompt: row.prompt,
        cron: row.cron,
        dueAt,
        nextRunAt,
      });
    }
  }
  return claimed;
}

/** A task whose enabled flag a category-wide toggle actually changed. */
export interface CategoryToggleChange {
  scheduleId: string;
  name: string;
  title: string;
  before: boolean;
  after: boolean;
}

/**
 * Pauses or resumes every task of a category. Resuming re-arms each task's
 * next run from now, exactly like the single-task patch, so a task that was
 * off for days never fires the window it missed. Returns only the tasks that
 * actually changed: the audit trail mirrors them one event each.
 */
export async function setScheduleCategoryEnabled(
  category: ScheduleCategory,
  enabled: boolean,
  now: Date = new Date()
): Promise<CategoryToggleChange[]> {
  const rows = await db.select().from(schedules).where(eq(schedules.category, category));
  const changes: CategoryToggleChange[] = [];
  for (const row of rows) {
    if (row.enabled === enabled) continue;
    const [updated] = await db
      .update(schedules)
      .set({
        enabled,
        // A paused row keeps its stale next_run_at; only a resumed one needs a fresh window.
        ...(enabled ? { nextRunAt: nextOccurrence(row.cron, now) } : {}),
        updatedAt: now,
      })
      .where(eq(schedules.id, row.id))
      .returning({ enabled: schedules.enabled });
    if (updated) {
      changes.push({
        scheduleId: row.id,
        name: row.name,
        title: row.title,
        before: row.enabled,
        after: updated.enabled,
      });
    }
  }
  return changes;
}

/** Opens a run: dedicated orchestrator thread + running row, linked together. */
export async function openScheduleRun(
  scheduleId: string,
  title: string,
  trigger: ScheduleRunTrigger,
  now: Date = new Date()
): Promise<{ runId: string; threadId: string }> {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  const [thread] = await db
    .insert(chatThreads)
    .values({ title: `⏰ ${title} — ${stamp}` })
    .returning();
  if (!thread) throw new Error("Failed to create schedule run thread");
  const [run] = await db
    .insert(scheduleRuns)
    .values({ scheduleId, trigger, threadId: thread.id, startedAt: now })
    .returning();
  if (!run) throw new Error("Failed to create schedule run");
  return { runId: run.id, threadId: thread.id };
}

export async function closeScheduleRun(
  runId: string,
  outcome:
    | { status: "succeeded"; resultSummary: string; usage?: EveUsage | null }
    | { status: "failed"; error: string },
  finishedAt: Date = new Date()
): Promise<void> {
  const usage = outcome.status === "succeeded" ? outcome.usage : null;
  await db
    .update(scheduleRuns)
    .set({
      ...(outcome.status === "succeeded"
        ? { status: "succeeded" as const, resultSummary: outcome.resultSummary }
        : { status: "failed" as const, error: outcome.error }),
      ...(usage
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
          }
        : {}),
      finishedAt,
    })
    .where(eq(scheduleRuns.id, runId));
}

/** Token spend of a schedule's settled runs over the trailing window. */
export interface ScheduleUsageSummary {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Trailing-window spend per schedule, in one grouped query. The window covers
 * `now - days` by start time, so a job paused days ago shows what it spent
 * while it was still on.
 */
export async function usageBySchedule(
  days: number,
  now: Date = new Date()
): Promise<Map<string, ScheduleUsageSummary>> {
  const rows = await db
    .select({
      scheduleId: scheduleRuns.scheduleId,
      runs: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${scheduleRuns.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${scheduleRuns.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce(sum(${scheduleRuns.cacheReadTokens}), 0)::bigint`,
    })
    .from(scheduleRuns)
    .where(gte(scheduleRuns.startedAt, new Date(now.getTime() - days * 86_400_000)))
    .groupBy(scheduleRuns.scheduleId);
  // pg returns BIGINT sums as strings; the CRM's JSON surface wants numbers.
  return new Map(
    rows.map((row) => [
      row.scheduleId,
      {
        runs: row.runs,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cacheReadTokens: Number(row.cacheReadTokens),
      },
    ])
  );
}

/** One-line excerpt of the orchestrator reply for run lists. */
export function summarizeReply(reply: string, maxChars = 300): string {
  const flat = reply.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}
