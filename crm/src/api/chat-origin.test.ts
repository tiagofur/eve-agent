import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { pool, db } from "../db/client";
import { hashApiKey } from "../auth/keys";
import { apiKeys, chatThreads, chatMessages } from "../db/schema";
import { chatThreadOrigin } from "../domain/chat-origin";

/**
 * Web/internal boundary of the chat threads (the "Contactos web" inbox): every
 * thread reports where it comes from, the list can be narrowed to one side,
 * and the internal chat route refuses to continue a visitor's thread.
 */
describe("Chat threads: web / internal origin", () => {
  const opsKey = "cp_ops_chatorigin1234567890abcdef";
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const createdThreadIds: string[] = [];
  let webId = "";
  let desktopId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Chat Origin Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const rows = await db
      .insert(chatThreads)
      .values([
        { title: "TEST-web", externalKey: `public:${randomUUID()}` },
        { title: "TEST-desktop" },
        { title: "TEST-telegram", externalKey: `telegram:${randomUUID()}` },
      ])
      .returning();
    webId = rows[0]!.id;
    desktopId = rows[1]!.id;
    createdThreadIds.push(...rows.map((t) => t.id));
  });

  afterAll(async () => {
    for (const id of createdThreadIds) {
      await db.delete(chatThreads).where(eq(chatThreads.id, id));
    }
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("derives the origin from the external key", () => {
    expect(chatThreadOrigin(null)).toBe("internal");
    expect(chatThreadOrigin("telegram:123")).toBe("internal");
    expect(chatThreadOrigin("public:abc")).toBe("web");
    // The prefix needs its colon: a key that merely starts with it is internal.
    expect(chatThreadOrigin("public")).toBe("internal");
  });

  it("every listed thread carries its origin", async () => {
    const res = await app.request("/api/chat/threads", { headers: auth });
    expect(res.status).toBe(200);
    const { threads } = (await res.json()) as { threads: Array<{ externalKey: string | null; origin: string }> };
    expect(threads.length).toBeGreaterThan(0);
    for (const t of threads) {
      expect(t.origin).toBe(t.externalKey?.startsWith("public:") ? "web" : "internal");
    }
  });

  it("origin=web lists only web threads, origin=internal leaves them out", async () => {
    const web = await app.request("/api/chat/threads?origin=web", { headers: auth });
    expect(web.status).toBe(200);
    const webBody = (await web.json()) as { threads: Array<{ id: string; origin: string }> };
    expect(webBody.threads.length).toBeGreaterThan(0);
    expect(webBody.threads.every((t) => t.origin === "web")).toBe(true);
    expect(webBody.threads.some((t) => t.id === webId)).toBe(true);
    expect(webBody.threads.some((t) => t.id === desktopId)).toBe(false);

    const internal = await app.request("/api/chat/threads?origin=internal", { headers: auth });
    expect(internal.status).toBe(200);
    const internalBody = (await internal.json()) as { threads: Array<{ id: string; origin: string }> };
    // The list is the newest 50 of a shared DB: assert the boundary, not who is in it.
    expect(internalBody.threads.every((t) => t.origin === "internal")).toBe(true);
    expect(internalBody.threads.some((t) => t.id === webId)).toBe(false);
  });

  it("rejects an unknown origin", async () => {
    const res = await app.request("/api/chat/threads?origin=phone", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("the internal chat refuses to continue a web thread, before any EVE call", async () => {
    // With EVE unconfigured an allowed post reaches the 503 below: a 400 here
    // can only come from the guard.
    const saved = {
      url: process.env.EVE_AGENT_URL,
      user: process.env.EVE_CHANNEL_USER,
      pass: process.env.EVE_CHANNEL_PASSWORD,
    };
    delete process.env.EVE_AGENT_URL;
    delete process.env.EVE_CHANNEL_USER;
    delete process.env.EVE_CHANNEL_PASSWORD;
    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ threadId: webId, messages: [{ role: "user", content: "hola" }] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("web_thread");
      const messages = await db.select().from(chatMessages).where(eq(chatMessages.threadId, webId));
      expect(messages).toHaveLength(0);

      // A staff thread still goes through the guard untouched.
      const allowed = await app.request("/api/chat", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ threadId: desktopId, messages: [{ role: "user", content: "hola" }] }),
      });
      expect(allowed.status).toBe(503);
    } finally {
      if (saved.url !== undefined) process.env.EVE_AGENT_URL = saved.url;
      if (saved.user !== undefined) process.env.EVE_CHANNEL_USER = saved.user;
      if (saved.pass !== undefined) process.env.EVE_CHANNEL_PASSWORD = saved.pass;
    }
  });
});
