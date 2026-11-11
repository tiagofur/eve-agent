import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { chatMessages, chatThreads } from "../db/schema";
import {
  EveClientError,
  createEveSession,
  findMissingEveMessages,
  parseEveStream,
  readEveStreamToTerminal,
  sendEveMessage,
  type EnabledEveProxyConfig,
} from "./eve-client";

/**
 * Single-brain proxy turn shared by the desktop chat route and the schedule
 * dispatcher: ensures (or recreates) the EVE session mapped to a CRM thread,
 * forwards one user message and persists the assistant reply, deduped on
 * eve_event_id. Extracted verbatim from api/routes/chat.ts.
 */
export interface ProxiedTurnResult {
  reply: string;
  toolCalls: Array<{ toolName: string; args: unknown }>;
  threadId: string;
}

export async function runProxiedTurn(args: {
  threadId: string;
  userContent: string;
  eve: EnabledEveProxyConfig;
  signal?: AbortSignal | null;
}): Promise<ProxiedTurnResult> {
  const { threadId, userContent, eve } = args;
  const isDeadSession = (err: unknown): boolean =>
    err instanceof EveClientError &&
    (err.status === 409 ||
      err.code === "session_not_active" ||
      err.code === "session_stranded");

  // Ensure EVE session, recreating once when the mapped one is dead.
  // The create-once operationId keeps retried creates from duplicating sessions.
  let sessionId: string | null = null;
  let deliveryId: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sessionId) {
      const [thread] = await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      sessionId = thread?.eveSessionId ?? null;
    }
    try {
      if (!sessionId) {
        const created = await createEveSession({
          baseUrl: eve.baseUrl,
          auth: eve,
          message: userContent,
          operationId: `crm-thread-${threadId}`,
        });
        sessionId = created.sessionId;
        await db
          .update(chatThreads)
          .set({ eveSessionId: sessionId })
          .where(eq(chatThreads.id, threadId));
      } else {
        const sent = await sendEveMessage({
          baseUrl: eve.baseUrl,
          auth: eve,
          sessionId,
          message: userContent,
        });
        // The session stream replays every recorded event; the follow-up's
        // deliveryId scopes the read below to the turn this message owns.
        deliveryId = sent.deliveryId;
      }
      break;
    } catch (err) {
      if (attempt === 0 && isDeadSession(err)) {
        sessionId = null;
        await db
          .update(chatThreads)
          .set({ eveSessionId: null })
          .where(eq(chatThreads.id, threadId));
        continue;
      }
      throw err;
    }
  }
  if (!sessionId) {
    throw new EveClientError("Could not establish an EVE session", { status: 502 });
  }

  const raw = await readEveStreamToTerminal({
    baseUrl: eve.baseUrl,
    auth: eve,
    sessionId,
    signal: args.signal ?? undefined,
    deliveryId,
  });
  const parsed = parseEveStream(raw, { deliveryId });
  if (!parsed.turnCompleted && !parsed.sessionWaiting) {
    throw new EveClientError("EVE turn ended without a terminal event", { status: 502 });
  }
  // One row per completed message keeps the sync dedupe exact; the common
  // single-message turn persists exactly one row like the legacy path.
  // Replay or a retried request can hand back events already persisted, so
  // dedupe on eve_event_id before inserting (mirrors syncThreadFromEve).
  const existingRows = await db
    .select({ eveEventId: chatMessages.eveEventId })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId));
  const known = new Set(
    existingRows.map((r) => r.eveEventId).filter((id): id is string => !!id)
  );
  for (const m of findMissingEveMessages(known, parsed.messages)) {
    await db.insert(chatMessages).values({
      threadId,
      role: "assistant",
      content: m.text,
      toolCalls: [],
      eveEventId: m.id,
    });
  }
  // Terminal turn with deltas only (no completed message): persist once.
  if (parsed.messages.length === 0 && parsed.text) {
    await db.insert(chatMessages).values({
      threadId,
      role: "assistant",
      content: parsed.text,
      toolCalls: [],
    });
  }
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId));
  return { reply: parsed.text, toolCalls: [], threadId };
}
