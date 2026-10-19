/**
 * Orchestrator turns for the Telegram daemon (S2/S3): run a user message
 * through the eve proxy with the same protocol the desktop chat uses —
 * session create/reuse, dead-session recovery, durable message persistence
 * — and return the final assistant text. Built exclusively on eve-client's
 * existing exports so the desktop route's WIP stays untouched; the eve
 * client is injectable for network-free tests.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { chatMessages, chatThreads } from "../db/schema";
import {
  parseEveStream,
  createEveSession,
  sendEveMessage,
  readEveStreamToTerminal,
  type EveAuth,
  type EnabledEveProxyConfig,
} from "./eve-client";

export interface TurnDeps {
  createSession: (input: { message: string; operationId?: string }) => Promise<{
    sessionId: string;
  }>;
  sendMessage: (input: { sessionId: string; message: string }) => Promise<{
    deliveryId?: string;
  }>;
  readStream: (input: { sessionId: string; deliveryId?: string }) => Promise<string>;
}

export function defaultTurnDeps(eve: EnabledEveProxyConfig): TurnDeps {
  const auth: EveAuth = { username: eve.username, password: eve.password };
  return {
    createSession: (input) =>
      createEveSession({ baseUrl: eve.baseUrl, auth, message: input.message, operationId: input.operationId }),
    sendMessage: (input) =>
      sendEveMessage({ baseUrl: eve.baseUrl, auth, sessionId: input.sessionId, message: input.message }),
    readStream: (input) =>
      readEveStreamToTerminal({
        baseUrl: eve.baseUrl,
        auth,
        sessionId: input.sessionId,
        deliveryId: input.deliveryId,
      }),
  };
}

interface EveFailure {
  status?: number;
  code?: string;
}

function isDeadSession(err: unknown): boolean {
  const failure = err as EveFailure;
  return (
    failure?.status === 409 ||
    failure?.code === "session_not_active" ||
    failure?.code === "session_stranded"
  );
}

function describeError(err: unknown): string {
  const failure = err as EveFailure;
  const where = failure?.status ? ` (HTTP ${failure.status}${failure.code ? `: ${failure.code}` : ""})` : "";
  const message = err instanceof Error ? err.message : String(err);
  return `EVE turn failed${where}: ${message}`;
}

export type OrchestratorTurnResult =
  | { reply: string; error?: undefined }
  | { reply: null; error: string };

export async function runOrchestratorTurn(params: {
  threadId: string;
  userContent: string;
  deps: TurnDeps;
}): Promise<OrchestratorTurnResult> {
  const { threadId, userContent, deps } = params;

  const [thread] = await db
    .select({ eveSessionId: chatThreads.eveSessionId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread) {
    return { reply: null, error: `Thread ${threadId} not found` };
  }

  // The user message is real the moment it arrived, regardless of outcome.
  await db.insert(chatMessages).values({ threadId, role: "user", content: userContent });

  let sessionId = thread.eveSessionId;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let deliveryId: string | undefined;
      if (!sessionId) {
        const created = await deps.createSession({
          message: userContent,
          operationId: `crm-thread-${threadId}`,
        });
        sessionId = created.sessionId;
        await db
          .update(chatThreads)
          .set({ eveSessionId: sessionId, updatedAt: new Date() })
          .where(eq(chatThreads.id, threadId));
      } else {
        const sent = await deps.sendMessage({ sessionId, message: userContent });
        deliveryId = sent.deliveryId;
      }

      const raw = await deps.readStream({ sessionId, deliveryId });
      const parsed = parseEveStream(raw, { deliveryId });

      if (!parsed.text.trim()) {
        return { reply: null, error: "EVE turn finished without a reply" };
      }

      const lastId = parsed.messages[parsed.messages.length - 1]?.id;
      await db.insert(chatMessages).values({
        threadId,
        role: "assistant",
        content: parsed.text,
        ...(lastId ? { eveEventId: lastId } : {}),
      });
      await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, threadId));

      return { reply: parsed.text };
    } catch (err) {
      if (attempt === 0 && isDeadSession(err)) {
        sessionId = null;
        await db
          .update(chatThreads)
          .set({ eveSessionId: null, updatedAt: new Date() })
          .where(eq(chatThreads.id, threadId));
        continue;
      }
      return { reply: null, error: describeError(err) };
    }
  }

  return { reply: null, error: "EVE turn failed after session recovery" };
}
