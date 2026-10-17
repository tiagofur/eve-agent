import { describe, expect, it, afterAll } from "vitest";
import { pool, db } from "../db/client";
import { eq } from "drizzle-orm";
import { chatThreads } from "../db/schema";
import { ensureExternalThread } from "./threads";

/**
 * External threads (S1/S2): each Telegram admin chat maps to exactly one
 * persistent CRM thread, findable by its external key.
 */
const KEY = "telegram:test:999888777";

afterAll(async () => {
  await db.delete(chatThreads).where(eq(chatThreads.externalKey, KEY));
  await db.delete(chatThreads).where(eq(chatThreads.externalKey, `${KEY}:b`));
  await pool.end();
});

describe("ensureExternalThread", () => {
  it("creates the thread on first use and returns the same one afterwards", async () => {
    const first = await ensureExternalThread({
      key: KEY,
      title: "Telegram — necesito un prospecto",
    });
    expect(first.id).toBeTruthy();
    expect(first.eveSessionId).toBeNull();

    const second = await ensureExternalThread({
      key: KEY,
      title: "Telegram — otro mensaje distinto",
    });
    expect(second.id).toBe(first.id);

    // Title comes from the FIRST message only; later calls never rename.
    const [row] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, first.id))
      .limit(1);
    expect(row?.title).toBe("Telegram — necesito un prospecto");
    expect(row?.externalKey).toBe(KEY);
  });

  it("keeps different external keys on separate threads", async () => {
    const a = await ensureExternalThread({ key: `${KEY}:b`, title: "Telegram B" });
    const b = await ensureExternalThread({ key: KEY, title: "Telegram A" });
    expect(a.id).not.toBe(b.id);
  });
});
