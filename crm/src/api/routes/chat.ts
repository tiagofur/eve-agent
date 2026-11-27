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
import { runProxiedTurn } from "../../domain/agent-turn";
import { chatThreadOrigin, internalThreadFilter, webThreadFilter } from "../../domain/chat-origin";
import {
  findMissingEveMessages,
  parseEveStream,
  readEveStreamToTerminal,
  resolveEveProxyConfig,
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
  const parsed = parseEveStream(raw, { sessionId });
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

export const chatRouter = new Hono<{ Variables: AuthContextVariables }>();


// List threads (newest first). `origin` narrows the list to one side of the
// web/internal boundary; every row carries its origin either way.
chatRouter.get(
  "/threads",
  requireScope(["ops"]),
  zValidator("query", z.object({ origin: z.enum(["web", "internal"]).optional() })),
  async (c) => {
    const { origin } = c.req.valid("query");
    const threads = await db
      .select()
      .from(chatThreads)
      .where(origin === "web" ? webThreadFilter : origin === "internal" ? internalThreadFilter : undefined)
      .orderBy(desc(chatThreads.updatedAt))
      .limit(50);
    return c.json({ threads: threads.map((t) => ({ ...t, origin: chatThreadOrigin(t.externalKey) })) });
  }
);

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
  // Web threads belong to the "Contactos web" inbox. Reading one here would
  // also run the EVE history sync below, which re-inserts every reply of the
  // visitor's session as a new row: the public route persists replies without
  // an eve_event_id, so the sync's dedupe has nothing to match against.
  if (chatThreadOrigin(thread.externalKey) === "web") {
    return c.json(
      { error: "Web chat threads are reviewed in Contactos web", code: "web_thread" },
      400
    );
  }
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
  const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  // Same boundary as the read above: the inbox owns the web threads' lifecycle.
  if (chatThreadOrigin(thread.externalKey) === "web") {
    return c.json(
      { error: "Web chat threads are reviewed in Contactos web", code: "web_thread" },
      400
    );
  }
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
      // Web threads belong to the "Contactos web" inbox: continuing one here
      // would talk to the agent inside a visitor's session (and bill the
      // public budget) while the visitor never sees the reply.
      if (chatThreadOrigin(existing.externalKey) === "web") {
        return c.json(
          { error: "Web chat threads are reviewed in Contactos web; they cannot be continued here", code: "web_thread" },
          400
        );
      }
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
