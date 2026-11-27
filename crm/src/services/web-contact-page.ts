import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { chatMessages } from "../db/schema";
import { escapeHtml, sendTelegramMessage } from "./telegram";

// Global page throttle. The trigger — a visitor's first message — is
// public-reachable, so a flooding visitor must not be able to page the
// owner's Telegram at will. Window-bounded; overflow is dropped (the contact
// still lands in "Contactos web").
export const WEB_CONTACT_WINDOW_MS = 10 * 60 * 1000;
export const WEB_CONTACT_MAX_PER_WINDOW = 5;
const pageTimes: number[] = [];

function shouldPageWebContact(now = Date.now()): boolean {
  const recent = pageTimes.filter((t) => now - t < WEB_CONTACT_WINDOW_MS);
  if (recent.length >= WEB_CONTACT_MAX_PER_WINDOW) return false;
  recent.push(now);
  pageTimes.splice(0, pageTimes.length, ...recent);
  return true;
}

// Long visitor text stays well under Telegram's 4096 chars even once escaped.
const PAGE_EXCERPT_CHARS = 700;

/**
 * Pages the owner with the first message of a web chat. Resolves to whether
 * the page was handed to Telegram (sending is skipped outside production).
 */
export async function notifyWebContactCreated(threadId: string): Promise<boolean> {
  const [first] = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);
  if (!first) return false;

  if (!shouldPageWebContact()) {
    console.log(`[telegram] web contact ${threadId} page suppressed (window cap)`);
    return false;
  }

  const excerpt =
    first.content.length > PAGE_EXCERPT_CHARS
      ? `${first.content.slice(0, PAGE_EXCERPT_CHARS)}…`
      : first.content;
  const text = `🌐 <b>NUEVO CONTACTO WEB</b>
<i>Alguien abrió un chat en creapolis.dev</i>

<b>Mensaje del visitante:</b>
<pre>${escapeHtml(excerpt)}</pre>

Revisalo en Mission Control → <b>Contactos web</b>.`;

  const res = await sendTelegramMessage(text, undefined, "HTML");
  return res?.ok !== false;
}
