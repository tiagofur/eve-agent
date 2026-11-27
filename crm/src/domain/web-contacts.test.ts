import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { pool, db } from "../db/client";
import { chatThreads } from "../db/schema";
import { surfaceVisitorMessage } from "./web-contacts";

describe("surfaceVisitorMessage", () => {
  const createdThreadIds: string[] = [];

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

  it("does not touch the review state on a first message", async () => {
    const id = await seedWebThread(true);
    await surfaceVisitorMessage(id, 1);
    expect(await reviewedAtOf(id)).not.toBeNull();
  });

  it("returns a reviewed thread to 'sin revisar' on a later visitor message", async () => {
    const id = await seedWebThread(true);
    await surfaceVisitorMessage(id, 3);
    expect(await reviewedAtOf(id)).toBeNull();
  });

  it("leaves an unreviewed thread as is on a later message", async () => {
    const id = await seedWebThread(false);
    await surfaceVisitorMessage(id, 2);
    expect(await reviewedAtOf(id)).toBeNull();
  });
});
