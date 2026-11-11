import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { chatThreads, schedules, scheduleRuns } from "./db/schema";

vi.mock("./services/telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("./services/telegram")>();
  return {
    ...original,
    sendTelegramMessage: vi.fn(async () => ({ ok: true })),
  };
});

// EVE is "configured" (so ticks proceed) but unreachable: every proxied turn
// fails fast, which is exactly the failure path the dispatcher must record.
vi.mock("./domain/eve-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./domain/eve-client")>();
  return {
    ...original,
    resolveEveProxyConfig: vi.fn(() => ({
      enabled: true,
      baseUrl: "http://127.0.0.1:9",
    })),
    createEveSession: vi.fn(async () => {
      throw new Error("EVE unreachable (test)");
    }),
  };
});

import {
  alignFreshSchedules,
  assertValidCron,
  claimDueSchedules,
  nextOccurrence,
} from "./domain/schedules";
import { tickScheduleDispatcher } from "./services/schedule-dispatcher";

let seq = 0;
const nextName = () => `TEST-Sch${++seq}${Date.now().toString(36)}`;

async function insertSchedule(overrides: Partial<typeof schedules.$inferInsert>) {
  const [row] = await db
    .insert(schedules)
    .values({
      name: nextName(),
      title: `TEST ${overrides.cron ?? ""}`,
      cron: "* * * * *",
      prompt: "TEST prompt",
      enabled: true,
      source: "user",
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("test insert failed");
  return row;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met in time");
}

// One file-level cleanup: ending the pool in a describe-scoped afterAll
// would close it before the next describe's tests run.
afterAll(async () => {
  await db.delete(schedules).where(like(schedules.name, "TEST-Sch%"));
  await db.delete(chatThreads).where(like(chatThreads.title, "⏰ TEST %"));
  await pool.end();
});

describe("Schedules: cadencia y claim", () => {
  it("valida expresiones cron y calcula la próxima ocurrencia en hora local", () => {
    expect(() => assertValidCron("0 7 * * *")).not.toThrow();
    expect(() => assertValidCron("not-a-cron")).toThrow();
    // Local-time semantics: matches what node-cron's tick actually fires.
    const next = nextOccurrence("0 7 * * *", new Date(2026, 10, 11, 10, 0, 0));
    expect(next.getTime()).toBe(new Date(2026, 10, 12, 7, 0, 0).getTime());
  });

  it("alignFreshSchedules alinea filas nuevas sin dispararlas", async () => {
    const row = await insertSchedule({ cron: "0 7 * * *", nextRunAt: null });
    const aligned = await alignFreshSchedules(new Date(2026, 10, 11, 10, 0, 0));
    expect(aligned).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(schedules).where(eq(schedules.id, row.id)).limit(1);
    expect(after?.nextRunAt?.getTime()).toBe(new Date(2026, 10, 12, 7, 0, 0).getTime());
    const runs = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, row.id));
    expect(runs).toHaveLength(0);
  });

  it("claimDueSchedules reclama vencidas exactamente una vez y avanza next_run_at", async () => {
    const past = new Date(Date.now() - 60_000);
    const row = await insertSchedule({ cron: "* * * * *", nextRunAt: past });

    const claimed = await claimDueSchedules(new Date());
    const mine = claimed.filter((c) => c.id === row.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.dueAt.getTime()).toBe(past.getTime());
    expect(mine[0]!.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    const [after] = await db.select().from(schedules).where(eq(schedules.id, row.id)).limit(1);
    expect(after?.nextRunAt?.getTime()).toBe(mine[0]!.nextRunAt.getTime());

    const second = await claimDueSchedules(new Date());
    expect(second.filter((c) => c.id === row.id)).toHaveLength(0);
  });

  it("no reclama desactivadas ni futuras", async () => {
    await insertSchedule({ enabled: false, nextRunAt: new Date(Date.now() - 60_000) });
    await insertSchedule({ cron: "0 7 * * *", nextRunAt: new Date(Date.now() + 24 * 3_600_000) });
    const claimed = await claimDueSchedules(new Date());
    expect(claimed).toHaveLength(0);
  });
});

describe("Schedules: tick del dispatcher", () => {
  it("salta ventanas vencidas hace más de la gracia (downtime largo)", async () => {
    const row = await insertSchedule({
      title: "TEST stale",
      cron: "0 7 * * *",
      nextRunAt: new Date(Date.now() - 2 * 3_600_000),
    });

    await tickScheduleDispatcher(new Date());

    const runs = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, row.id));
    expect(runs).toHaveLength(0);
    const [after] = await db.select().from(schedules).where(eq(schedules.id, row.id)).limit(1);
    // Advanced to the next 07:00 window, skipping the missed one entirely.
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("ejecuta ventanas dentro de la gracia y registra el fallo del turno", async () => {
    const row = await insertSchedule({
      title: "TEST gracia",
      cron: "* * * * *",
      nextRunAt: new Date(Date.now() - 30_000),
    });

    await tickScheduleDispatcher(new Date());

    const [run] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, row.id));
    expect(run).toBeDefined();
    expect(run?.threadId).toBeDefined();

    // The turn runs in the background; with EVE unreachable it must settle as
    // failed with the error recorded, the prompt persisted, and cadence advanced.
    await waitFor(async () => {
      const [r] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, run!.id));
      return r?.status === "failed";
    });
    const [settled] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, run!.id));
    expect(settled?.error).toContain("EVE unreachable");
    expect(settled?.finishedAt).toBeDefined();

    const [sched] = await db.select().from(schedules).where(eq(schedules.id, row.id));
    expect(sched?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });
});
