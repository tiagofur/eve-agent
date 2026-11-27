import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { pool, db } from "./db/client";
import { apiKeys, chatThreads, chatMessages } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";

/**
 * "Contactos web" inbox: the review state of the web chats (list, unread
 * count, mark reviewed, conversation) kept apart from internal threads.
 */
describe("Web contacts: bandeja de revisión", () => {
  const opsKey = "cp_ops_webcontacts1234567890abcdef";
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const createdThreadIds: string[] = [];
  const T0 = Date.parse("2026-01-01T10:00:00Z");
  let unreadId = "";
  let reviewedId = "";
  let internalId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Web Contacts Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const rows = await db
      .insert(chatThreads)
      .values([
        { title: "TEST-web sin revisar", externalKey: `public:${randomUUID()}` },
        { title: "TEST-web revisado", externalKey: `public:${randomUUID()}`, reviewedAt: new Date(T0) },
        // The widget opens a thread before the visitor writes: not a contact yet.
        { title: "Chat Web", externalKey: `public:${randomUUID()}` },
        { title: "TEST-interno" },
      ])
      .returning();
    [unreadId, reviewedId, , internalId] = [rows[0]!.id, rows[1]!.id, rows[2]!.id, rows[3]!.id];
    createdThreadIds.push(...rows.map((t) => t.id));
    await db.insert(chatMessages).values([
      { threadId: unreadId, role: "user", content: "TEST-hola, quiero una app", createdAt: new Date(T0) },
      { threadId: unreadId, role: "assistant", content: "Claro, contame más", createdAt: new Date(T0 + 1000) },
      { threadId: unreadId, role: "user", content: "Es para un consultorio", createdAt: new Date(T0 + 2000) },
      { threadId: reviewedId, role: "user", content: "TEST-consulta vieja", createdAt: new Date(T0) },
      { threadId: internalId, role: "user", content: "TEST-mensaje interno", createdAt: new Date(T0) },
    ]);
  });

  afterAll(async () => {
    for (const id of createdThreadIds) {
      await db.delete(chatThreads).where(eq(chatThreads.id, id));
    }
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("requires auth", async () => {
    const res = await app.request("/api/web-contacts");
    expect(res.status).toBe(401);
  });

  it("lists the web threads that have messages, with their first message and size", async () => {
    const res = await app.request("/api/web-contacts", { headers: auth });
    expect(res.status).toBe(200);
    const { contacts } = (await res.json()) as {
      contacts: Array<{ id: string; reviewedAt: string | null; firstMessage: string | null; messageCount: number }>;
    };
    const unread = contacts.find((c) => c.id === unreadId);
    expect(unread).toMatchObject({ reviewedAt: null, firstMessage: "TEST-hola, quiero una app", messageCount: 3 });
    const reviewed = contacts.find((c) => c.id === reviewedId);
    expect(reviewed?.reviewedAt).toBe(new Date(T0).toISOString());
    // Keyless and message-less threads are not contacts.
    expect(contacts.some((c) => c.id === internalId)).toBe(false);
    expect(contacts.filter((c) => c.messageCount === 0)).toEqual([]);
  });

  it("unread-count counts only unreviewed web contacts", async () => {
    const count = async () =>
      ((await (await app.request("/api/web-contacts/unread-count", { headers: auth })).json()) as { unread: number }).unread;
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(1);

    const markRead = await app.request(`/api/web-contacts/${unreadId}/read`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ read: true }),
    });
    expect(markRead.status).toBe(200);
    const body = (await markRead.json()) as { reviewedAt: string | null };
    expect(body.reviewedAt).not.toBeNull();
    expect(await count()).toBe(before - 1);

    const markUnread = await app.request(`/api/web-contacts/${unreadId}/read`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ read: false }),
    });
    expect(markUnread.status).toBe(200);
    expect(((await markUnread.json()) as { reviewedAt: string | null }).reviewedAt).toBeNull();
    expect(await count()).toBe(before);
  });

  it("refuses to mark an internal thread or an unknown id", async () => {
    const internal = await app.request(`/api/web-contacts/${internalId}/read`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ read: true }),
    });
    expect(internal.status).toBe(404);
    const thread = await db.select({ reviewedAt: chatThreads.reviewedAt }).from(chatThreads).where(eq(chatThreads.id, internalId));
    expect(thread[0]!.reviewedAt).toBeNull();

    const missing = await app.request(`/api/web-contacts/${randomUUID()}/read`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ read: true }),
    });
    expect(missing.status).toBe(404);
  });

  it("reads the whole conversation in order, and 404s on an internal thread", async () => {
    const res = await app.request(`/api/web-contacts/${unreadId}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact: { id: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.contact.id).toBe(unreadId);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages[0]!.content).toBe("TEST-hola, quiero una app");

    const internal = await app.request(`/api/web-contacts/${internalId}`, { headers: auth });
    expect(internal.status).toBe(404);
  });
});
