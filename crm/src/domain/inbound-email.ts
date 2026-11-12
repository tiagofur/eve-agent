import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { contacts, interactions, leads, organizations, outbox } from "../db/schema";
import { logEvent } from "./events";
import { escapeHtml, sendTelegramMessage } from "../services/telegram";

/**
 * Inbound email replies. Provider-agnostic on purpose: the Resend webhook is
 * one feeder; an IMAP poller or a manual import can call the same function.
 *
 * A reply is DATA from an external person: it is stored and shown, never
 * interpreted. Agents reading it later apply their untrusted-input rules.
 */

const ACTOR = "system:inbound-email";
const MAX_CONTENT_CHARS = 8000;

export interface InboundEmailInput {
  /** Bare address or "Name <address>". */
  from: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  /** RFC Message-ID: the dedup key across webhook retries. */
  messageId?: string | null;
  providerId?: string | null;
  /** False when the provider reports DMARC failure: the sender may be spoofed. */
  senderVerified?: boolean;
}

export type InboundEmailResult =
  | { status: "logged"; interactionId: string; contactId: string; leadId: string | null; followUpMoved: boolean }
  | { status: "duplicate"; interactionId: string }
  | { status: "unmatched"; from: string }
  | { status: "ignored"; reason: "invalid_sender" | "empty_body" };

export function extractAddress(from: string): string | null {
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  const candidate = (angled?.[1] ?? from).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

/** Crude but dependency-free: enough to read a reply whose client sent HTML only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const QUOTE_MARKERS = [
  /^On .+ wrote:\s*$/i,
  /^El .+ escribió:\s*$/i,
  /^Em .+ escreveu:\s*$/i,
  /^-{2,}\s*(Original Message|Mensaje original|Forwarded message)\s*-{2,}\s*$/i,
  /^(From|De):\s.+@.+$/i,
  /^_{10,}\s*$/,
];

/**
 * Keeps only what the person wrote now, dropping the quoted thread below.
 * Returns the full text when stripping would leave nothing (top-posting is
 * the norm, but an inline-reply-only message must not vanish).
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (QUOTE_MARKERS.some((re) => re.test(trimmed))) break;
    // Gmail wraps "On <date> <name>\n<email> wrote:" across two lines.
    if (/^(On|El|Em) .+/i.test(trimmed) && /(wrote|escribió|escreveu):\s*$/i.test((lines[i + 1] ?? "").trim())) break;
    if (trimmed.startsWith(">")) {
      // A quoted block followed only by more quotes/blank lines ends the reply.
      if (lines.slice(i).every((l) => l.trim() === "" || l.trim().startsWith(">"))) break;
      continue;
    }
    kept.push(line);
  }
  const result = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || text.trim();
}

export async function ingestInboundEmail(input: InboundEmailInput): Promise<InboundEmailResult> {
  const address = extractAddress(input.from);
  if (!address) return { status: "ignored", reason: "invalid_sender" };

  const messageId = input.messageId?.trim() || null;
  if (messageId) {
    const [existing] = await db
      .select({ id: interactions.id })
      .from(interactions)
      .where(sql`${interactions.metadata}->>'messageId' = ${messageId}`)
      .limit(1);
    if (existing) return { status: "duplicate", interactionId: existing.id };
  }

  const rawText = input.text?.trim() || (input.html ? htmlToText(input.html) : "");
  const content = stripQuotedReply(rawText).slice(0, MAX_CONTENT_CHARS);
  const subject = input.subject?.trim() || null;
  if (!content) return { status: "ignored", reason: "empty_body" };

  const [contact] = await db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.email}) = ${address}`)
    .limit(1);

  if (!contact) {
    // No link target, so no interaction row: the audit log keeps the trace
    // and the owner decides whether this stranger becomes a lead. entityId is
    // a uuid column, so the identity lives in `after`, not in the id.
    await logEvent({
      entity: "inbound_email",
      entityId: randomUUID(),
      action: "inbound_email_unmatched",
      actor: ACTOR,
      after: { from: address, subject, messageId, providerId: input.providerId ?? null },
      reason: content.slice(0, 200),
    });
    await notify(
      `📩 <b>Email de un remitente desconocido</b>\n<b>De:</b> ${escapeHtml(address)}\n` +
        (subject ? `<b>Asunto:</b> ${escapeHtml(subject)}\n` : "") +
        `\n${escapeHtml(excerpt(content, 400))}\n\n<i>No coincide con ningún contacto del CRM: no se registró en ningún hilo.</i>`
    );
    return { status: "unmatched", from: address };
  }

  // Thread the reply onto whatever we last wrote to this person; fall back to
  // their most recent lead, then to the bare contact/organization.
  const [lastDraft] = await db
    .select({
      leadId: outbox.leadId,
      organizationId: outbox.organizationId,
      ticketId: outbox.ticketId,
    })
    .from(outbox)
    .where(and(eq(outbox.contactId, contact.id), eq(outbox.status, "sent")))
    .orderBy(desc(outbox.sentAt))
    .limit(1);

  let leadId = lastDraft?.leadId ?? null;
  if (!leadId && !lastDraft) {
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.contactId, contact.id), sql`${leads.stage} != 'lost'`))
      .orderBy(desc(leads.updatedAt))
      .limit(1);
    leadId = lead?.id ?? null;
  }
  const organizationId = lastDraft?.organizationId ?? contact.organizationId ?? null;
  const senderVerified = input.senderVerified !== false;

  const [row] = await db
    .insert(interactions)
    .values({
      contactId: contact.id,
      leadId,
      organizationId,
      ticketId: lastDraft?.ticketId ?? null,
      channel: "email",
      direction: "inbound",
      content,
      metadata: {
        source: "inbound-email",
        subject,
        messageId,
        providerId: input.providerId ?? null,
        from: address,
        senderVerified,
      },
    })
    .returning();

  await logEvent({
    entity: "interaction",
    entityId: row!.id,
    action: "interaction_inbound",
    actor: ACTOR,
    after: { channel: "email", direction: "inbound", contactId: contact.id, leadId, senderVerified },
    reason: content.slice(0, 200),
  });

  // The ball is now in the owner's court: surface it today instead of letting
  // a scheduled nudge go out to someone who already answered. A spoofable
  // sender never moves follow-ups — it is only shown.
  let followUpMoved = false;
  if (senderVerified) {
    const now = new Date();
    const note = `Respondió por email${subject ? ` ("${excerpt(subject, 60)}")` : ""}: contestar`;
    if (leadId) {
      await db
        .update(leads)
        .set({ nextFollowUpAt: now, followUpNote: note, updatedAt: now })
        .where(eq(leads.id, leadId));
    } else {
      await db
        .update(contacts)
        .set({ nextFollowUpAt: now, followUpNote: note, updatedAt: now })
        .where(eq(contacts.id, contact.id));
    }
    followUpMoved = true;
  }

  // A nudge drafted before this reply is stale; the owner must know before
  // approving it. Never auto-rejected: rejecting is an owner decision.
  const stalePending = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.contactId, contact.id), inArray(outbox.status, ["pending_approval", "approved", "failed"])));

  const [org] = organizationId
    ? await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, organizationId)).limit(1)
    : [];

  await notify(
    `📩 <b>${escapeHtml(contact.name)}</b>${org ? ` (${escapeHtml(org.name)})` : ""} respondió por email\n` +
      (subject ? `<b>Asunto:</b> ${escapeHtml(subject)}\n` : "") +
      `\n${escapeHtml(excerpt(content, 600))}` +
      (senderVerified ? "" : "\n\n⚠️ <i>El remitente no pasó la verificación DMARC: podría ser suplantado. No moví el seguimiento.</i>") +
      (stalePending.length > 0
        ? `\n\n⚠️ <i>Hay ${stalePending.length} borrador(es) en el outbox para este contacto escritos antes de esta respuesta: revísalos antes de enviar.</i>`
        : "")
  );

  return { status: "logged", interactionId: row!.id, contactId: contact.id, leadId, followUpMoved };
}

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function notify(html: string): Promise<void> {
  try {
    await sendTelegramMessage(html);
  } catch (err) {
    console.error("[InboundEmail] telegram notification failed:", err);
  }
}

export interface ReplyContext {
  /** Latest inbound message that we have not answered yet. */
  at: Date;
  channel: string;
  excerpt: string;
}

/**
 * For each contact: their latest inbound interaction when it is newer than
 * our latest outbound one — i.e. they are waiting on us, not the reverse.
 */
export async function getUnansweredReplies(contactIds: string[]): Promise<Map<string, ReplyContext>> {
  const ids = [...new Set(contactIds.filter(Boolean))];
  const result = new Map<string, ReplyContext>();
  if (ids.length === 0) return result;

  const rows = await db
    .select({
      contactId: interactions.contactId,
      direction: interactions.direction,
      channel: interactions.channel,
      content: interactions.content,
      createdAt: interactions.createdAt,
    })
    .from(interactions)
    .where(inArray(interactions.contactId, ids))
    .orderBy(desc(interactions.createdAt));

  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.contactId || seen.has(row.contactId)) continue;
    seen.add(row.contactId);
    if (row.direction === "inbound") {
      result.set(row.contactId, { at: row.createdAt, channel: row.channel, excerpt: excerpt(row.content, 500) });
    }
  }
  return result;
}
