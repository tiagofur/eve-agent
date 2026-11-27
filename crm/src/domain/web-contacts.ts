import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { chatThreads } from "../db/schema";
import { notifyWebContactCreated } from "../services/web-contact-page";

/**
 * Review bookkeeping for a visitor message that just landed on a web thread.
 * The first message is a new contact: it pages the owner. A later message on
 * a thread the owner already reviewed carries visitor words they have not
 * seen, so the thread returns to "Sin revisar" (no page: the contact is no
 * longer new).
 */
export async function surfaceVisitorMessage(threadId: string, userTurns: number): Promise<void> {
  if (userTurns <= 1) {
    notifyWebContactCreated(threadId).catch((err) =>
      console.error("Failed to dispatch telegram web contact alert:", err)
    );
    return;
  }
  await db
    .update(chatThreads)
    .set({ reviewedAt: null })
    .where(and(eq(chatThreads.id, threadId), isNotNull(chatThreads.reviewedAt)));
}
