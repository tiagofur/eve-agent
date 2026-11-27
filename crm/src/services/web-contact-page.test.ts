import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { pool, db } from "../db/client";
import { chatThreads, chatMessages } from "../db/schema";

vi.mock("./telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("./telegram")>();
  return {
    ...original,
    sendTelegramMessage: vi.fn(async () => ({ ok: true })),
  };
});

import { sendTelegramMessage } from "./telegram";
import { WEB_CONTACT_MAX_PER_WINDOW, notifyWebContactCreated } from "./web-contact-page";

/**
 * Owner page for a new web contact: the visitor's first message goes out as
 * Telegram HTML (escaped), long text is cut, and a flood cannot exceed the
 * window cap. The cap is module state shared by every test in this file, so
 * the assertions hold in whatever order they run.
 */
describe("Web contact page (Telegram)", () => {
  const createdThreadIds: string[] = [];
  const sends = vi.mocked(sendTelegramMessage);

  const seedContact = async (firstMessage?: string) => {
    const [thread] = await db
      .insert(chatThreads)
      .values({ title: "TEST-page", externalKey: `public:${randomUUID()}` })
      .returning();
    createdThreadIds.push(thread!.id);
    if (firstMessage !== undefined) {
      await db.insert(chatMessages).values({ threadId: thread!.id, role: "user", content: firstMessage });
    }
    return thread!.id;
  };

  afterAll(async () => {
    for (const id of createdThreadIds) {
      await db.delete(chatThreads).where(eq(chatThreads.id, id));
    }
    await pool.end();
  });

  it("pages with the visitor's first message, escaped for Telegram HTML", async () => {
    const id = await seedContact('Hola <b>soy Ana</b> & quiero una app');
    const paged = await notifyWebContactCreated(id);
    expect(paged).toBe(true);
    const [text, keyboard, parseMode] = sends.mock.calls[sends.mock.calls.length - 1]!;
    expect(parseMode).toBe("HTML");
    expect(keyboard).toBeUndefined();
    expect(text).toContain("<pre>Hola &lt;b&gt;soy Ana&lt;/b&gt; &amp; quiero una app</pre>");
    expect(text).toContain("Contactos web");
  });

  it("cuts a long message so the page stays under Telegram's limit", async () => {
    const id = await seedContact("x".repeat(1500));
    await notifyWebContactCreated(id);
    const [text] = sends.mock.calls[sends.mock.calls.length - 1]!;
    const pre = /<pre>([\s\S]*)<\/pre>/.exec(text)![1]!;
    expect(pre).toBe(`${"x".repeat(700)}…`);
    expect(text.length).toBeLessThan(4096);
  });

  it("does not page a thread without messages", async () => {
    const before = sends.mock.calls.length;
    expect(await notifyWebContactCreated(await seedContact())).toBe(false);
    expect(sends.mock.calls).toHaveLength(before);
  });

  it("drops pages once the window cap is reached", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < WEB_CONTACT_MAX_PER_WINDOW + 3; i++) {
      results.push(await notifyWebContactCreated(await seedContact("hola")));
    }
    // From the first drop on, every later page in the window is dropped too.
    const firstDrop = results.indexOf(false);
    expect(firstDrop).toBeGreaterThanOrEqual(0);
    expect(results.slice(firstDrop).every((r) => r === false)).toBe(true);
    // And nothing in this file ever pushed more pages than the cap allows.
    expect(sends.mock.calls.length).toBeLessThanOrEqual(WEB_CONTACT_MAX_PER_WINDOW);
  });
});
