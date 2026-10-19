import { Hono } from "hono";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "../.env.local" });
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, asc, desc } from "drizzle-orm";
import { db } from "../../db/client";
import { chatThreads, chatMessages } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  EveClientError,
  createEveSession,
  findMissingEveMessages,
  parseEveStream,
  readEveStreamToTerminal,
  resolveEveProxyConfig,
  sendEveMessage,
  type EnabledEveProxyConfig,
} from "../../domain/eve-client";

/**
 * Single-brain proxy (S1): forward chat turns to the EVE deployment instead
 * of the legacy inline generateText loop. Active only when EVE_AGENT_URL +
 * EVE_CHANNEL_USER/PASSWORD are configured; otherwise the legacy path runs.
 * Proxy failures are loud (the brain is down) — never silently answered by
 * a second brain.
 */
async function syncThreadFromEve(
  threadId: string,
  eve: EnabledEveProxyConfig
): Promise<number> {
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  const sessionId = thread?.eveSessionId;
  if (!sessionId) return 0;
  const raw = await readEveStreamToTerminal({
    baseUrl: eve.baseUrl,
    auth: eve,
    sessionId,
    follow: false,
  });
  const parsed = parseEveStream(raw);
  if (parsed.messages.length === 0) return 0;
  const existing = await db
    .select({ eveEventId: chatMessages.eveEventId })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId));
  const known = new Set(
    existing.map((r) => r.eveEventId).filter((id): id is string => !!id)
  );
  const missing = findMissingEveMessages(known, parsed.messages);
  for (const m of missing) {
    await db.insert(chatMessages).values({
      threadId,
      role: "assistant",
      content: m.text,
      toolCalls: [],
      eveEventId: m.id,
    });
  }
  return missing.length;
}

interface ProxiedTurnResult {
  reply: string;
  toolCalls: Array<{ toolName: string; args: unknown }>;
  threadId: string;
}

async function runProxiedTurn(args: {
  threadId: string;
  userContent: string;
  eve: EnabledEveProxyConfig;
  signal?: AbortSignal | null;
}): Promise<ProxiedTurnResult> {
  const { threadId, userContent, eve } = args;
  const isDeadSession = (err: unknown): boolean =>
    err instanceof EveClientError &&
    (err.status === 409 ||
      err.code === "session_not_active" ||
      err.code === "session_stranded");

  // Ensure EVE session, recreating once when the mapped one is dead.
  // The create-once operationId keeps retried creates from duplicating sessions.
  let sessionId: string | null = null;
  let deliveryId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sessionId) {
      const [thread] = await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      sessionId = thread?.eveSessionId ?? null;
    }
    try {
      if (!sessionId) {
        const created = await createEveSession({
          baseUrl: eve.baseUrl,
          auth: eve,
          message: userContent,
          operationId: `crm-thread-${threadId}`,
        });
        sessionId = created.sessionId;
        await db
          .update(chatThreads)
          .set({ eveSessionId: sessionId })
          .where(eq(chatThreads.id, threadId));
      } else {
        const sent = await sendEveMessage({
          baseUrl: eve.baseUrl,
          auth: eve,
          sessionId,
          message: userContent,
        });
        // The session stream replays every recorded event; the follow-up's
        // deliveryId scopes the read below to the turn this message owns.
        deliveryId = sent.deliveryId;
      }
      break;
    } catch (err) {
      if (attempt === 0 && isDeadSession(err)) {
        sessionId = null;
        await db
          .update(chatThreads)
          .set({ eveSessionId: null })
          .where(eq(chatThreads.id, threadId));
        continue;
      }
      throw err;
    }
  }
  if (!sessionId) {
    throw new EveClientError("Could not establish an EVE session", { status: 502 });
  }

  const raw = await readEveStreamToTerminal({
    baseUrl: eve.baseUrl,
    auth: eve,
    sessionId,
    signal: args.signal ?? undefined,
    deliveryId,
  });
  const parsed = parseEveStream(raw, { deliveryId });
  if (!parsed.turnCompleted && !parsed.sessionWaiting) {
    throw new EveClientError("EVE turn ended without a terminal event", { status: 502 });
  }
  // One row per completed message keeps the sync dedupe exact; the common
  // single-message turn persists exactly one row like the legacy path.
  // Replay or a retried request can hand back events already persisted, so
  // dedupe on eve_event_id before inserting (mirrors syncThreadFromEve).
  const existingRows = await db
    .select({ eveEventId: chatMessages.eveEventId })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId));
  const known = new Set(
    existingRows.map((r) => r.eveEventId).filter((id): id is string => !!id)
  );
  for (const m of findMissingEveMessages(known, parsed.messages)) {
    await db.insert(chatMessages).values({
      threadId,
      role: "assistant",
      content: m.text,
      toolCalls: [],
      eveEventId: m.id,
    });
  }
  // Terminal turn with deltas only (no completed message): persist once.
  if (parsed.messages.length === 0 && parsed.text) {
    await db.insert(chatMessages).values({
      threadId,
      role: "assistant",
      content: parsed.text,
      toolCalls: [],
    });
  }
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId));
  return { reply: parsed.text, toolCalls: [], threadId };
}

export const chatRouter = new Hono<{ Variables: AuthContextVariables }>();


// List threads (newest first)
chatRouter.get("/threads", requireScope(["ops"]), async (c) => {
  const threads = await db
    .select()
    .from(chatThreads)
    .orderBy(desc(chatThreads.updatedAt))
    .limit(50);
  return c.json({ threads });
});

// Create thread
chatRouter.post(
  "/threads",
  requireScope(["ops"]),
  zValidator("json", z.object({ title: z.string().max(120).optional() })),
  async (c) => {
    const { title } = c.req.valid("json");
    const [created] = await db
      .insert(chatThreads)
      .values({ title: title?.trim() || "Nueva conversación" })
      .returning();
    if (!created) return c.json({ error: "Failed to create thread" }, 500);
    return c.json({ thread: created });
  }
);

// Get thread with messages
chatRouter.get("/threads/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing thread id" }, 400);
  const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  // Reconnect support: pull replies completed while no client was attached.
  // Idempotent (dedupe by eve_event_id); skipped for threads without an EVE session.
  const eve = resolveEveProxyConfig(process.env);
  if (eve.enabled && thread.eveSessionId) {
    try {
      await syncThreadFromEve(thread.id, eve);
    } catch (syncErr) {
      console.error("EVE history sync failed:", syncErr);
    }
  }
  const msgs = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, id))
    .orderBy(asc(chatMessages.createdAt));
  return c.json({ thread, messages: msgs });
});

// Delete thread (messages cascade)
chatRouter.delete("/threads/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing thread id" }, 400);
  await db.delete(chatThreads).where(eq(chatThreads.id, id));
  return c.json({ success: true });
});

chatRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      threadId: z.string().uuid().optional(),
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string(),
        })
      ),
    })
  ),
  async (c) => {
    const { messages, threadId: requestedThreadId } = c.req.valid("json");

    // Resolve or create the conversation thread (persistent memory).
    let threadId = requestedThreadId;
    if (threadId) {
      const [existing] = await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!existing) return c.json({ error: "Thread not found" }, 404);
    } else {
      const firstUser = messages.find((m) => m.role === "user");
      const title = (firstUser?.content ?? "Nueva conversación").slice(0, 60);
      const [created] = await db.insert(chatThreads).values({ title }).returning();
      if (!created) return c.json({ error: "Failed to create thread" }, 500);
      threadId = created.id;
    }

    try {
      const eve = resolveEveProxyConfig(process.env);
      if (!eve.enabled) {
        return c.json(
          {
            error:
              "Single brain unavailable: configure EVE_AGENT_URL, EVE_CHANNEL_USER and EVE_CHANNEL_PASSWORD so /api/chat can reach the EVE deployment.",
          },
          503
        );
      }
      const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMessage) {
        return c.json({ error: "No user message to forward to the EVE brain." }, 400);
      }
      {
        // Single-brain path: EVE owns the turn; this route only proxies and
        // persists. The model reads EVE's own instructions, not the legacy
        // system prompt below.
        // Best-effort sync of replies completed while the client was away; a
        // sync failure never blocks the new message (the forward below fails
        // loudly anyway when EVE is unreachable).
        try {
          await syncThreadFromEve(threadId, eve);
        } catch (syncErr) {
          console.error("EVE history sync failed:", syncErr);
        }
        // Same semantics as the legacy path: the user message is always recorded.
        await db.insert(chatMessages).values({ threadId, role: "user", content: lastUserMessage.content });
        const out = await runProxiedTurn({
          threadId,
          userContent: lastUserMessage.content,
          eve,
          signal: c.req.raw.signal,
        });
        return c.json(out);
      }

    } catch (err: any) {
      console.error("Chat orchestration error:", err);
      return c.json({ error: err.message || "Failed to process message" }, 500);
    }
  }
);
