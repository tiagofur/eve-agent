import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { chatMessages, chatThreads } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { webThreadFilter } from "../../domain/chat-origin";

/**
 * "Contactos web" inbox: the chats visitors open on creapolis.dev, kept apart
 * from the owner's own conversations and flagged for review. A contact is
 * "sin revisar" while reviewed_at is NULL. A thread the widget opened but the
 * visitor never wrote to is not a contact and stays out of the inbox.
 */
export const webContactsRouter = new Hono<{ Variables: AuthContextVariables }>();

const threadsWithMessages = db.select({ id: chatMessages.threadId }).from(chatMessages);
const contactFilter = and(webThreadFilter, inArray(chatThreads.id, threadsWithMessages))!;

// Inbox list, most recent activity first, with the first visitor message and
// the size of each conversation.
webContactsRouter.get(
  "/",
  requireScope(["ops"]),
  zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(200).optional() })),
  async (c) => {
    const limit = c.req.valid("query").limit ?? 100;
    const threads = await db
      .select({
        id: chatThreads.id,
        title: chatThreads.title,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
        reviewedAt: chatThreads.reviewedAt,
      })
      .from(chatThreads)
      .where(contactFilter)
      .orderBy(desc(chatThreads.updatedAt))
      .limit(limit);

    const summaries = threads.length
      ? await db
          .select({
            threadId: chatMessages.threadId,
            firstMessage: sql<string>`(array_agg(${chatMessages.content} order by ${chatMessages.createdAt}, ${chatMessages.id}))[1]`,
            messageCount: count(chatMessages.id),
          })
          .from(chatMessages)
          .where(inArray(chatMessages.threadId, threads.map((t) => t.id)))
          .groupBy(chatMessages.threadId)
      : [];
    const summaryByThread = new Map(summaries.map((s) => [s.threadId, s]));

    const contacts = threads.map((t) => {
      const summary = summaryByThread.get(t.id);
      return { ...t, firstMessage: summary?.firstMessage ?? null, messageCount: summary?.messageCount ?? 0 };
    });
    return c.json({ contacts });
  }
);

// Sidebar badge: web contacts the owner has not reviewed yet.
webContactsRouter.get("/unread-count", requireScope(["ops"]), async (c) => {
  const [row] = await db
    .select({ unread: count() })
    .from(chatThreads)
    .where(and(contactFilter, isNull(chatThreads.reviewedAt))!);
  return c.json({ unread: row?.unread ?? 0 });
});

// Mark one contact reviewed / back to "sin revisar" (the desktop auto-marks on open).
webContactsRouter.post(
  "/:id/read",
  requireScope(["ops"]),
  zValidator("json", z.object({ read: z.boolean() })),
  async (c) => {
    const id = c.req.param("id");
    const { read } = c.req.valid("json");

    const [updated] = await db
      .update(chatThreads)
      .set({ reviewedAt: read ? new Date() : null })
      .where(and(eq(chatThreads.id, id), webThreadFilter))
      .returning({ reviewedAt: chatThreads.reviewedAt });
    if (!updated) return c.json({ error: "Web contact not found" }, 404);

    return c.json({ success: true, reviewedAt: updated.reviewedAt?.toISOString() ?? null });
  }
);

// The whole conversation in order. Unlike the internal chat route this never
// syncs with EVE: the public route persists every reply as it happens.
webContactsRouter.get("/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing contact id" }, 400);
  const [contact] = await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
      reviewedAt: chatThreads.reviewedAt,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, id), webThreadFilter))
    .limit(1);
  if (!contact) return c.json({ error: "Web contact not found" }, 404);

  const messages = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, id))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  return c.json({ contact, messages });
});
