import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { pool, db } from "../db/client";
import { chatThreads } from "../db/schema";

vi.mock("../services/web-contact-page", () => ({
  notifyWebContactCreated: vi.fn(async () => true),
}));

import { notifyWebContactCreated } from "../services/web-contact-page";
import { surfaceVisitorMessage } from "./web-contacts";

describe("surfaceVisitorMessage", () => {
  const createdThreadIds: string[] = [];
  const pages = vi.mocked(notifyWebContactCreated);

  const seedWebThread = async (reviewed: boolean) => {
    const [thread] = await db
      .insert(chatThreads)
      .values({
        title: "TEST-surface",
        externalKey: `public:${randomUUID()}`,
        reviewedAt: reviewed ? new Date() : undefined,
      })
      .returning();
    createdThreadIds.push(thread!.id);
    return thread!.id;
  };

  const reviewedAtOf = async (id: string) => {
    const [row] = await db
      .select({ reviewedAt: chatThreads.reviewedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, id));
    return row!.reviewedAt;
  };

  afterAll(async () => {
    for (const id of createdThreadIds) {
      await db.delete(chatThreads).where(eq(chatThreads.id, id));
    }
    await pool.end();
  });

  it("pages the owner on a first message and keeps the review state", async () => {
    const id = await seedWebThread(true);
    await surfaceVisitorMessage(id, 1);
    expect(pages).toHaveBeenCalledWith(id);
    expect(await reviewedAtOf(id)).not.toBeNull();
  });

  it("returns a reviewed thread to 'sin revisar' on a later visitor message, without paging", async () => {
    const before = pages.mock.calls.length;
    const id = await seedWebThread(true);
    await surfaceVisitorMessage(id, 3);
    expect(await reviewedAtOf(id)).toBeNull();
    expect(pages.mock.calls).toHaveLength(before);
  });

  it("leaves an unreviewed thread as is on a later message", async () => {
    const id = await seedWebThread(false);
    await surfaceVisitorMessage(id, 2);
    expect(await reviewedAtOf(id)).toBeNull();
  });
});
