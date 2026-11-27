import { describe, expect, it, afterAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { chatThreads, schedules, scheduleRuns } from "./db/schema";
import type { EveUsage } from "./domain/eve-client";

/**
 * Token spend per schedule run: the dispatcher records what the proxied turn
 * reported, and the trailing-week summary a task lists adds it up.
 */

// The dispatcher only needs a turn that settles with a known spend: the
// proxied turn is replaced wholesale, so no EVE and no network are involved.
const turn = vi.hoisted(() => ({
  reply: "Dos packs listos",
  usage: null as EveUsage | null,
}));

vi.mock("./domain/agent-turn", () => ({
  runProxiedTurn: vi.fn(async (args: { threadId: string }) => ({
    reply: turn.reply,
    toolCalls: [],
    threadId: args.threadId,
    usage: turn.usage,
  })),
}));

vi.mock("./domain/eve-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./domain/eve-client")>();
  return {
    ...original,
    resolveEveProxyConfig: vi.fn(() => ({
      enabled: true,
      baseUrl: "http://127.0.0.1:9",
    })),
  };
});

import { usageBySchedule } from "./domain/schedules";
import { dispatchScheduleNow } from "./services/schedule-dispatcher";

let seq = 0;
const nextName = () => `TEST-Usage${++seq}${Date.now().toString(36)}`;

async function insertSchedule() {
  const [row] = await db
    .insert(schedules)
    .values({
      name: nextName(),
      title: "TEST usage",
      cron: "0 7 * * *",
      prompt: "TEST prompt",
      enabled: false,
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

/** Runs the schedule manually and returns its settled run row. */
async function runAndSettle(scheduleId: string) {
  const { runId } = await dispatchScheduleNow(scheduleId);
  await waitFor(async () => {
    const [run] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId));
    return run?.status !== "running";
  });
  const [run] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId));
  return run;
}

afterAll(async () => {
  await db.delete(schedules).where(like(schedules.name, "TEST-Usage%"));
  await db.delete(chatThreads).where(like(chatThreads.title, "⏰ TEST usage%"));
  await pool.end();
});

describe("Schedules: gasto de tokens por ejecución", () => {
  it("guarda en la corrida lo que el turno gastó y lo suma en la ventana", async () => {
    turn.usage = { inputTokens: 420000, outputTokens: 5100, cacheReadTokens: 310000, cacheWriteTokens: 0 };
    const row = await insertSchedule();

    const run = await runAndSettle(row.id);
    expect(run?.status).toBe("succeeded");
    expect(run?.resultSummary).toBe("Dos packs listos");
    expect(run?.inputTokens).toBe(420000);
    expect(run?.outputTokens).toBe(5100);
    expect(run?.cacheReadTokens).toBe(310000);

    const week = await usageBySchedule(7);
    expect(week.get(row.id)).toEqual({
      runs: 1,
      inputTokens: 420000,
      outputTokens: 5100,
      cacheReadTokens: 310000,
    });
    // Outside the window the task shows no spend at all.
    expect((await usageBySchedule(0)).has(row.id)).toBe(false);
  });

  it("deja el gasto en NULL cuando el turno no reportó uso", async () => {
    turn.usage = null;
    const row = await insertSchedule();

    const run = await runAndSettle(row.id);
    expect(run?.status).toBe("succeeded");
    expect(run?.inputTokens).toBeNull();
    expect(run?.outputTokens).toBeNull();
    expect(run?.cacheReadTokens).toBeNull();
  });
});
