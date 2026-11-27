import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { chatThreads } from "../db/schema";

/**
 * Review bookkeeping for a visitor message that just landed on a web thread.
 * A later message on a thread the owner already reviewed carries visitor
 * words they have not seen, so the thread returns to "Sin revisar" (no page:
 * the contact is no longer new). A first message needs nothing: the thread
 * is unreviewed from the start.
 */
export async function surfaceVisitorMessage(threadId: string, userTurns: number): Promise<void> {
  if (userTurns <= 1) return;
  await db
    .update(chatThreads)
    .set({ reviewedAt: null })
    .where(and(eq(chatThreads.id, threadId), isNotNull(chatThreads.reviewedAt)));
}
