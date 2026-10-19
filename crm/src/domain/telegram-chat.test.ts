import { describe, expect, it, afterAll } from "vitest";
import { pool, db } from "../db/client";
import { eq, asc } from "drizzle-orm";
import { chatThreads, chatMessages } from "../db/schema";
import { ensureExternalThread } from "./threads";
import { runOrchestratorTurn, type TurnDeps } from "./telegram-chat";

/**
 * runOrchestratorTurn (S2/S3): a Telegram message must reach the eve
 * orchestrator through the same protocol the desktop chat uses — session
 * create/reuse with dead-session recovery, persisted user+assistant
 * messages, and the final assistant text as the reply. The eve client is
 * fully mocked: no network.
 */
const KEY = "telegram:test-turn:111222333";
const EVE = { enabled: true as const, baseUrl: "http://eve.test", username: "u", password: "p" };

function makeDeps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    createSession: async () => ({ sessionId: "sess-1" }),
    sendMessage: async () => ({ deliveryId: "del-1" }),
    readStream: async () =>
      [
        { type: "message.completed", data: { message: "Listo: prospecto registrado." } },
        { type: "session.waiting" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    ...overrides,
  };
}

afterAll(async () => {
  await db.delete(chatThreads).where(eq(chatThreads.externalKey, KEY));
  await pool.end();
});

describe("runOrchestratorTurn", () => {
  it("creates the session on first turn, persists both messages, returns the reply", async () => {
    const thread = await ensureExternalThread({ key: KEY, title: "Telegram — turno 1" });

    const created: string[] = [];
    const result = await runOrchestratorTurn({
      threadId: thread.id,
      userContent: "necesito 1 prospecto en Vallarta",
      deps: makeDeps({
        createSession: async (input) => {
          created.push(input.message);
          return { sessionId: "sess-1" };
        },
      }),
    });

    expect(result.error).toBeUndefined();
    expect(result.reply).toBe("Listo: prospecto registrado.");
    expect(created).toEqual(["necesito 1 prospecto en Vallarta"]);

    const [saved] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, thread.id))
      .limit(1);
    expect(saved?.eveSessionId).toBe("sess-1");

    const rows = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt));
    expect(rows).toEqual([
      { role: "user", content: "necesito 1 prospecto en Vallarta" },
      { role: "assistant", content: "Listo: prospecto registrado." },
    ]);
  });

  it("reuses the live session and scopes the read to the turn's deliveryId", async () => {
    const thread = await ensureExternalThread({ key: KEY, title: "Telegram — turno 1" });
    await db
      .update(chatThreads)
      .set({ eveSessionId: "sess-live" })
      .where(eq(chatThreads.id, thread.id));

    const sends: Array<{ sessionId: string; message: string }> = [];
    const reads: Array<{ sessionId: string; deliveryId?: string }> = [];
    const result = await runOrchestratorTurn({
      threadId: thread.id,
      userContent: "otro mensaje",
      deps: makeDeps({
        createSession: async () => {
          throw new Error("must not create: session is live");
        },
        sendMessage: async (input) => {
          sends.push({ sessionId: input.sessionId, message: input.message });
          return { deliveryId: "del-42" };
        },
        readStream: async (input) => {
          reads.push({ sessionId: input.sessionId, deliveryId: input.deliveryId });
          return [
            {
              type: "message.completed",
              data: { message: "Respuesta del segundo turno." },
              meta: { deliveryIds: ["del-42"] },
            },
            { type: "turn.completed", meta: { deliveryIds: ["del-42"] } },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n");
        },
      }),
    });

    expect(result.reply).toBe("Respuesta del segundo turno.");
    expect(sends).toEqual([{ sessionId: "sess-live", message: "otro mensaje" }]);
    expect(reads).toEqual([{ sessionId: "sess-live", deliveryId: "del-42" }]);
  });

  it("recovers once from a dead session by recreating it", async () => {
    const thread = await ensureExternalThread({ key: KEY, title: "Telegram — turno 1" });
    await db
      .update(chatThreads)
      .set({ eveSessionId: "sess-dead" })
      .where(eq(chatThreads.id, thread.id));

    let calls = 0;
    const result = await runOrchestratorTurn({
      threadId: thread.id,
      userContent: "mensaje tras session muerta",
      deps: makeDeps({
        sendMessage: async () => {
          calls += 1;
          if (calls === 1) {
            const err = new Error("dead") as Error & { status: number; code?: string };
            err.status = 409;
            err.code = "session_not_active";
            throw err;
          }
          return { deliveryId: "del-2" };
        },
        createSession: async () => ({ sessionId: "sess-revived" }),
        readStream: async () =>
          [
            { type: "message.completed", data: { message: "Sesión recuperada." } },
            { type: "session.waiting" },
          ]
            .map((e) => JSON.stringify(e))
            .join("\n"),
      }),
    });

    expect(result.reply).toBe("Sesión recuperada.");
    const [saved] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, thread.id))
      .limit(1);
    expect(saved?.eveSessionId).toBe("sess-revived");
  });

  it("returns an honest error instead of a fabricated reply when eve fails", async () => {
    const thread = await ensureExternalThread({ key: KEY, title: "Telegram — turno 1" });
    await db
      .update(chatThreads)
      .set({ eveSessionId: null })
      .where(eq(chatThreads.id, thread.id));

    const result = await runOrchestratorTurn({
      threadId: thread.id,
      userContent: "mensaje que falla",
      deps: makeDeps({
        createSession: async () => {
          const err = new Error("brain down") as Error & { status: number };
          err.status = 502;
          throw err;
        },
      }),
    });

    expect(result.reply).toBeNull();
    expect(result.error).toContain("502");
  });
});
