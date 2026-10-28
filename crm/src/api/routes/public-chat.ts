import { Hono } from "hono";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "../.env.local" });
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, asc, gte, like, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client";
import { chatThreads, chatMessages } from "../../db/schema";
import {
  EveClientError,
  createEveSession,
  findMissingEveMessages,
  parseEveStream,
  readEveStreamToTerminal,
  resolvePublicEveProxyConfig,
  sendEveMessage,
  type EnabledEveProxyConfig,
} from "../../domain/eve-client";

// Simple in-memory rate limiter for public chat turns per IP (e.g. 20 requests per 10 minutes)
const ipRateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_TURNS = 20;

// Cost guardrails. Public threads are tagged with a "public:" externalKey so
// the daily budget counts only visitor traffic (staff threads carry keys like
// "telegram:<id>"), and per-thread caps bound any single conversation.
const PUBLIC_KEY_PREFIX = "public:";
const MAX_TURNS_PER_THREAD = Number(process.env.PUBLIC_CHAT_MAX_TURNS_PER_THREAD ?? 60);
const DAILY_TURN_BUDGET = Number(process.env.PUBLIC_CHAT_DAILY_TURN_BUDGET ?? 400);

const THREAD_CAP_REPLY =
  "Alcanzaste el límite de mensajes de esta conversación. Si quieres seguir con tu proyecto, deja tu nombre y un correo o WhatsApp y el equipo de Creapolis.Dev te contacta.";
const DAILY_BUDGET_REPLY =
  "El chat llegó a su límite de uso por hoy. Deja tu nombre y un correo o WhatsApp y el equipo de Creapolis.Dev te escribe a la brevedad.";

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_TURNS) {
    return false;
  }
  entry.count++;
  return true;
}

function utcDayStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function countUserTurnsToday(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatMessages.threadId, chatThreads.id))
    .where(
      and(
        eq(chatMessages.role, "user"),
        gte(chatMessages.createdAt, utcDayStart()),
        like(chatThreads.externalKey, `${PUBLIC_KEY_PREFIX}%`)
      )
    );
  return rows[0]?.n ?? 0;
}

async function countUserTurnsInThread(threadId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, "user")));
  return rows[0]?.n ?? 0;
}

export const publicChatRouter = new Hono();

async function runPublicTurn(args: {
  threadId: string;
  userContent: string;
  eve: EnabledEveProxyConfig;
  signal?: AbortSignal | null;
}) {
  const { threadId, userContent, eve } = args;

  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  let sessionId = thread?.eveSessionId ?? null;
  let deliveryId: string | undefined;

  // Prepend instruction context indicating a public visitor session
  const payloadToEve = `[Contexto del canal: Cliente visitante en chat web público de Creapolis.Dev]\n\n${userContent}`;

  if (!sessionId) {
    const created = await createEveSession({
      baseUrl: eve.baseUrl,
      auth: eve,
      message: payloadToEve,
      operationId: `public-thread-${threadId}`,
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
      message: payloadToEve,
    });
    deliveryId = sent.deliveryId;
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

  // Persist assistant message
  await db.insert(chatMessages).values({
    threadId,
    role: "assistant",
    content: parsed.text,
    toolCalls: [],
  });

  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId));

  return { reply: parsed.text, threadId };
}

// Create new public thread or retrieve existing public thread
publicChatRouter.post(
  "/threads",
  zValidator("json", z.object({ title: z.string().max(100).optional() })),
  async (c) => {
    const rawIp = c.req.header("x-forwarded-for");
    const ip = rawIp ? rawIp.split(",")[0]?.trim() || "127.0.0.1" : "127.0.0.1";
    if (!checkRateLimit(ip)) {
      return c.json({ error: "Límite de mensajes alcanzado. Intenta de nuevo más tarde." }, 429);
    }

    const { title } = c.req.valid("json");
    const [created] = await db
      .insert(chatThreads)
      .values({
        title: title?.trim() || "Chat Web",
        externalKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`,
      })
      .returning();

    if (!created) return c.json({ error: "No se pudo iniciar el chat" }, 500);
    return c.json({ threadId: created.id });
  }
);

// Post message to public thread
publicChatRouter.post(
  "/",
  zValidator(
    "json",
    z.object({
      threadId: z.string().uuid().optional(),
      message: z.string().min(1).max(2000),
    })
  ),
  async (c) => {
    const rawIp = c.req.header("x-forwarded-for");
    const ip = rawIp ? rawIp.split(",")[0]?.trim() || "127.0.0.1" : "127.0.0.1";
    if (!checkRateLimit(ip)) {
      return c.json({ error: "Demasiadas peticiones. Por favor espera unos minutos." }, 429);
    }

    const { message, threadId: requestedThreadId } = c.req.valid("json");

    let threadId = requestedThreadId;
    if (threadId) {
      const [existing] = await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!existing) return c.json({ error: "Conversación no encontrada" }, 404);
      // This route only serves its own public threads: a staff thread id
      // (telegram/desktop) must never be continued by an anonymous visitor.
      if (!existing.externalKey?.startsWith(PUBLIC_KEY_PREFIX)) {
        return c.json({ error: "Conversación no encontrada" }, 404);
      }
    } else {
      const [created] = await db
        .insert(chatThreads)
        .values({
          title: message.slice(0, 50),
          externalKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`,
        })
        .returning();
      if (!created) return c.json({ error: "Error al crear conversación" }, 500);
      threadId = created.id;
    }

    // Public visitor traffic authenticates with the dedicated public proxy
    // credential so eve can mechanically distinguish it from staff callers.
    const eve = resolvePublicEveProxyConfig(process.env);
    if (!eve.enabled) {
      return c.json({ error: "Servicio de asistente temporalmente no disponible" }, 503);
    }

    const turnsToday = await countUserTurnsToday();
    if (turnsToday >= DAILY_TURN_BUDGET) {
      return c.json({ error: DAILY_BUDGET_REPLY }, 429);
    }

    try {
      await db.insert(chatMessages).values({
        threadId,
        role: "user",
        content: message,
      });

      if ((await countUserTurnsInThread(threadId)) >= MAX_TURNS_PER_THREAD) {
        await db.insert(chatMessages).values({
          threadId,
          role: "assistant",
          content: THREAD_CAP_REPLY,
          toolCalls: [],
        });
        return c.json({ reply: THREAD_CAP_REPLY, threadId });
      }

      const out = await runPublicTurn({
        threadId,
        userContent: message,
        eve,
        signal: c.req.raw.signal,
      });

      return c.json(out);
    } catch (err: any) {
      console.error("Public chat orchestration error:", err);
      return c.json({ error: "Error al procesar el mensaje" }, 500);
    }
  }
);
