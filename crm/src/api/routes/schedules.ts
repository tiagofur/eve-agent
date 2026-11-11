import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { schedules, scheduleRuns } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { logEvent } from "../../domain/events";
import { assertValidCron, nextOccurrence } from "../../domain/schedules";
import { dispatchScheduleNow } from "../../services/schedule-dispatcher";

/**
 * Agent cronjob CRUD (ops scope; owner passes any scope check). The desktop
 * "Programadas" view and the agent's own schedule tools both land here —
 * every mutation leaves an audit event like the rest of the ops surface.
 */
export const schedulesRouter = new Hono<{ Variables: AuthContextVariables }>();

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug || `schedule_${Date.now().toString(36)}`;
}

async function latestRunFor(scheduleId: string) {
  const [run] = await db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(1);
  return run ?? null;
}

// List all schedules with their next/last execution and the server clock, so
// the desktop can render cadence and flag timezone drift against the client.
schedulesRouter.get("/", requireScope(["ops"]), async (c) => {
  const rows = await db.select().from(schedules).orderBy(schedules.name);
  const withRuns = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      lastRun: await latestRunFor(row.id),
    }))
  );
  return c.json({
    schedules: withRuns,
    serverNow: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

const createSchema = z.object({
  title: z.string().min(1).max(120),
  cron: z.string().min(1).max(60),
  prompt: z.string().min(1).max(20000),
  name: z.string().regex(/^[a-z0-9_]+$/).max(60).optional(),
  enabled: z.boolean().optional(),
});

schedulesRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator("json", createSchema),
  async (c) => {
    const { title, cron, prompt, name, enabled = true } = c.req.valid("json");
    const actor = c.get("actor");
    try {
      assertValidCron(cron);
    } catch {
      return c.json({ error: `Invalid cron expression: ${cron}` }, 400);
    }

    let created: typeof schedules.$inferSelect | undefined;
    try {
      [created] = await db
        .insert(schedules)
        .values({
          name: name ?? slugify(title),
          title,
          cron,
          prompt,
          enabled,
          source: "user",
          nextRunAt: enabled ? nextOccurrence(cron, new Date()) : null,
        })
        .returning();
    } catch (err) {
      // Drizzle wraps the pg unique-violation error; the code lives on .cause.
      const pgCode = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (pgCode === "23505") {
        return c.json({ error: `Schedule name already in use: ${name ?? slugify(title)}` }, 409);
      }
      throw err;
    }
    if (!created) return c.json({ error: "Failed to create schedule" }, 500);

    await logEvent({
      entity: "schedule",
      entityId: created.id,
      action: "created",
      actor,
      after: { name: created.name, title, cron, enabled },
    });

    return c.json({ success: true, schedule: created }, 201);
  }
);

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  cron: z.string().min(1).max(60).optional(),
  prompt: z.string().min(1).max(20000).optional(),
  enabled: z.boolean().optional(),
});

schedulesRouter.patch(
  "/:id",
  requireScope(["ops"]),
  zValidator("json", patchSchema),
  async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing schedule id" }, 400);
    const patch = c.req.valid("json");
    const actor = c.get("actor");

    const [current] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    if (!current) return c.json({ error: "Schedule not found" }, 404);

    if (patch.cron && patch.cron !== current.cron) {
      try {
        assertValidCron(patch.cron);
      } catch {
        return c.json({ error: `Invalid cron expression: ${patch.cron}` }, 400);
      }
    }

    const before: Record<string, unknown> = {};
    const changed: Record<string, unknown> = {};
    for (const key of ["title", "cron", "prompt", "enabled"] as const) {
      const next = patch[key];
      if (next === undefined || next === current[key]) continue;
      before[key] = current[key];
      changed[key] = next;
    }
    if (Object.keys(changed).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    // Cadence changes re-arm the next run from now: a new cron (or turning the
    // schedule back on) must not fire a stale window computed for the old one.
    const willBeEnabled = patch.enabled ?? current.enabled;
    const cronChanged = patch.cron !== undefined && patch.cron !== current.cron;
    const reactivated = patch.enabled === true && !current.enabled;
    if (willBeEnabled && (cronChanged || reactivated)) {
      changed.nextRunAt = nextOccurrence(patch.cron ?? current.cron, new Date());
    }

    const [updated] = await db
      .update(schedules)
      .set({ ...changed, updatedAt: new Date() } as Partial<typeof schedules.$inferInsert>)
      .where(eq(schedules.id, id))
      .returning();

    await logEvent({
      entity: "schedule",
      entityId: id,
      action: "updated",
      actor,
      before,
      after: changed,
    });

    return c.json({ success: true, schedule: updated });
  }
);

// Deleting drops the run history with it (cascade); the audit event keeps
// the tombstone. system schedules are deletable too — the owner decided so.
schedulesRouter.delete("/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing schedule id" }, 400);
  const actor = c.get("actor");

  const [current] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!current) return c.json({ error: "Schedule not found" }, 404);

  await db.delete(schedules).where(eq(schedules.id, id));

  await logEvent({
    entity: "schedule",
    entityId: id,
    action: "deleted",
    actor,
    before: { name: current.name, title: current.title, cron: current.cron },
  });

  return c.json({ success: true });
});

// Manual "Ejecutar ahora": opens the run row synchronously and drives the
// orchestrator turn in the background. Does not touch next_run_at.
schedulesRouter.post("/:id/run", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing schedule id" }, 400);
  const actor = c.get("actor");

  const [current] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!current) return c.json({ error: "Schedule not found" }, 404);

  try {
    const opened = await dispatchScheduleNow(id);
    await logEvent({
      entity: "schedule",
      entityId: id,
      action: "run_triggered",
      actor,
      after: { runId: opened.runId, trigger: "manual" },
      reason: "Ejecución manual desde Mission Control",
    });
    return c.json({ success: true, runId: opened.runId, threadId: opened.threadId }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to dispatch schedule run";
    const status = message === "Schedule not found" ? 404 : message.startsWith("Single brain unavailable") ? 503 : 500;
    return c.json({ error: message }, status as 404 | 503 | 500);
  }
});

schedulesRouter.get("/:id/runs", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing schedule id" }, 400);
  const [current] = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
  if (!current) return c.json({ error: "Schedule not found" }, 404);

  const runs = await db
    .select()
    .from(scheduleRuns)
    .where(eq(scheduleRuns.scheduleId, id))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(20);
  return c.json({ runs });
});
