import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "../app";
import { pool, db } from "../db/client";
import { hashApiKey } from "../auth/keys";
import { apiKeys, chatThreads, chatMessages } from "../db/schema";
import { eq } from "drizzle-orm";

describe("Chat threads API", () => {
  const opsKey = "cp_ops_threadstest1234567890abcdef";
  const createdThreadIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Test Threads Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);
  });

  afterAll(async () => {
    for (const id of createdThreadIds) {
      await db.delete(chatThreads).where(eq(chatThreads.id, id));
    }
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

  it("rejects thread creation without auth with 401", async () => {
    const res = await app.request("/api/chat/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No auth" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a thread with title and defaults title when omitted", async () => {
    const res = await app.request("/api/chat/threads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ title: "TEST-conversación" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread.id).toBeDefined();
    expect(body.thread.title).toBe("TEST-conversación");
    createdThreadIds.push(body.thread.id);

    // Separar los created_at: dos inserts en el mismo milisegundo hacen
    // no-determinístico el orden "newest first" del listado.
    await new Promise((r) => setTimeout(r, 10));

    const res2 = await app.request("/api/chat/threads", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    const body2 = await res2.json();
    expect(body2.thread.title).toBe("Nueva conversación");
    createdThreadIds.push(body2.thread.id);
  });

  it("lists threads newest first and reads one with empty messages", async () => {
    const list = await app.request("/api/chat/threads", { headers: auth });
    expect(list.status).toBe(200);
    const { threads } = await list.json();
    expect(threads.length).toBeGreaterThanOrEqual(2);
    expect(threads[0].id).toBe(createdThreadIds[createdThreadIds.length - 1]);

    const one = await app.request(`/api/chat/threads/${createdThreadIds[0]}`, { headers: auth });
    expect(one.status).toBe(200);
    const detail = await one.json();
    expect(detail.thread.id).toBe(createdThreadIds[0]);
    expect(detail.messages).toEqual([]);
  });

  it("returns 404 for unknown thread on read and on chat post (no model call)", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const get = await app.request(`/api/chat/threads/${missing}`, { headers: auth });
    expect(get.status).toBe(404);

    const post = await app.request("/api/chat", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ threadId: missing, messages: [{ role: "user", content: "hola" }] }),
    });
    expect(post.status).toBe(404);
  });

  it("deletes a thread and its messages cascade", async () => {
    const [thread] = await db
      .insert(chatThreads)
      .values({ title: "TEST-borrar" })
      .returning();
    const [msg] = await db
      .insert(chatMessages)
      .values({ threadId: thread!.id, role: "user", content: "hola" })
      .returning();

    const del = await app.request(`/api/chat/threads/${thread!.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(200);

    const remaining = await db.select().from(chatMessages).where(eq(chatMessages.id, msg!.id));
    expect(remaining).toEqual([]);
    const gone = await app.request(`/api/chat/threads/${thread!.id}`, { headers: auth });
    expect(gone.status).toBe(404);
  });

  it("returns 503 single-brain-unconfigured when EVE env is missing", async () => {
    const saved = {
      url: process.env.EVE_AGENT_URL,
      user: process.env.EVE_CHANNEL_USER,
      pass: process.env.EVE_CHANNEL_PASSWORD,
    };
    delete process.env.EVE_AGENT_URL;
    delete process.env.EVE_CHANNEL_USER;
    delete process.env.EVE_CHANNEL_PASSWORD;
    const [thread] = await db
      .insert(chatThreads)
      .values({ title: "TEST-proxy-503" })
      .returning();
    createdThreadIds.push(thread!.id);
    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          threadId: thread!.id,
          messages: [{ role: "user", content: "hola" }],
        }),
      });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/EVE_AGENT_URL|single brain/i);
    } finally {
      if (saved.url !== undefined) process.env.EVE_AGENT_URL = saved.url;
      if (saved.user !== undefined) process.env.EVE_CHANNEL_USER = saved.user;
      if (saved.pass !== undefined) process.env.EVE_CHANNEL_PASSWORD = saved.pass;
    }
  });

  it("returns 400 when the proxy is configured but no user message is sent", async () => {
    const saved = {
      url: process.env.EVE_AGENT_URL,
      user: process.env.EVE_CHANNEL_USER,
      pass: process.env.EVE_CHANNEL_PASSWORD,
    };
    process.env.EVE_AGENT_URL = "http://127.0.0.1:9";
    process.env.EVE_CHANNEL_USER = "test-user";
    process.env.EVE_CHANNEL_PASSWORD = "test-pass";
    const [thread] = await db
      .insert(chatThreads)
      .values({ title: "TEST-proxy-400" })
      .returning();
    createdThreadIds.push(thread!.id);
    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          threadId: thread!.id,
          messages: [{ role: "assistant", content: "solo contexto" }],
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      if (saved.url !== undefined) process.env.EVE_AGENT_URL = saved.url;
      else delete process.env.EVE_AGENT_URL;
      if (saved.user !== undefined) process.env.EVE_CHANNEL_USER = saved.user;
      else delete process.env.EVE_CHANNEL_USER;
      if (saved.pass !== undefined) process.env.EVE_CHANNEL_PASSWORD = saved.pass;
      else delete process.env.EVE_CHANNEL_PASSWORD;
    }
  });
});
