import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { chatThreads } from "../db/schema";

export interface ExternalThread {
  id: string;
  eveSessionId: string | null;
}

/**
 * Find or create the persistent CRM thread for an external conversation
 * (S1/S2): each Telegram admin chat maps to exactly one thread by a stable
 * key. The title is taken from the first message that created the thread
 * and is never renamed afterwards.
 */
export async function ensureExternalThread(params: {
  key: string;
  title: string;
}): Promise<ExternalThread> {
  const existing = await findByKey(params.key);
  if (existing) return existing;

  try {
    const [created] = await db
      .insert(chatThreads)
      .values({ externalKey: params.key, title: params.title.slice(0, 120) })
      .returning();
    if (created) {
      return { id: created.id, eveSessionId: created.eveSessionId };
    }
  } catch (err) {
    // Concurrent first-message race: the unique key already landed.
    const raced = await findByKey(params.key);
    if (raced) return raced;
    throw err;
  }

  throw new Error(`Failed to ensure external thread for key ${params.key}`);
}

async function findByKey(key: string): Promise<ExternalThread | null> {
  const [row] = await db
    .select({ id: chatThreads.id, eveSessionId: chatThreads.eveSessionId })
    .from(chatThreads)
    .where(eq(chatThreads.externalKey, key))
    .limit(1);
  return row ? { id: row.id, eveSessionId: row.eveSessionId } : null;
}
