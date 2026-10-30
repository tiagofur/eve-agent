import { randomUUID } from "node:crypto";
import cron from "node-cron";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { contacts, events, leads, organizations, tickets } from "../db/schema";
import { logEvent } from "../domain/events";
import { escapeHtml, sendTelegramMessage } from "./telegram";

export interface DigestItem {
  kind: "lead" | "ticket" | "organization" | "contact";
  label: string;
  note: string | null;
  at: Date;
  overdue: boolean;
}

/** Seguimientos vencidos + los que vencen hoy (hora local del servidor). */
export async function getDueFollowups(now: Date = new Date()): Promise<DigestItem[]> {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const dueLeads = await db
    .select({
      id: leads.id,
      name: contacts.name,
      organizationName: organizations.name,
      note: leads.followUpNote,
      at: leads.nextFollowUpAt,
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(organizations, eq(leads.organizationId, organizations.id))
    .where(sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} <= ${endOfToday} AND ${leads.stage} != 'lost'`)
    .orderBy(asc(leads.nextFollowUpAt));

  const dueTickets = await db
    .select({
      id: tickets.id,
      system: tickets.system,
      organizationName: organizations.name,
      note: tickets.followUpNote,
      at: tickets.nextFollowUpAt,
    })
    .from(tickets)
    .leftJoin(organizations, eq(tickets.organizationId, organizations.id))
    .where(
      sql`${tickets.nextFollowUpAt} IS NOT NULL AND ${tickets.nextFollowUpAt} <= ${endOfToday} AND ${tickets.status} NOT IN ('resolved', 'closed')`
    )
    .orderBy(asc(tickets.nextFollowUpAt));

  const dueOrgs = await db
    .select({ id: organizations.id, name: organizations.name, note: organizations.followUpNote, at: organizations.nextFollowUpAt })
    .from(organizations)
    .where(sql`${organizations.nextFollowUpAt} IS NOT NULL AND ${organizations.nextFollowUpAt} <= ${endOfToday}`)
    .orderBy(asc(organizations.nextFollowUpAt));

  const dueContacts = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      organizationName: organizations.name,
      note: contacts.followUpNote,
      at: contacts.nextFollowUpAt,
    })
    .from(contacts)
    .leftJoin(organizations, eq(contacts.organizationId, organizations.id))
    .where(sql`${contacts.nextFollowUpAt} IS NOT NULL AND ${contacts.nextFollowUpAt} <= ${endOfToday}`)
    .orderBy(asc(contacts.nextFollowUpAt));

  const items: DigestItem[] = [
    ...dueLeads.map((l) => ({
      kind: "lead" as const,
      label: l.organizationName || l.name || l.id.slice(0, 8),
      note: l.note,
      at: l.at!,
      overdue: l.at! < now,
    })),
    ...dueTickets.map((t) => ({
      kind: "ticket" as const,
      label: `${t.system}${t.organizationName ? ` (${t.organizationName})` : ""}`,
      note: t.note,
      at: t.at!,
      overdue: t.at! < now,
    })),
    ...dueOrgs.map((o) => ({
      kind: "organization" as const,
      label: o.name,
      note: o.note,
      at: o.at!,
      overdue: o.at! < now,
    })),
    ...dueContacts.map((ct) => ({
      kind: "contact" as const,
      label: `${ct.name}${ct.organizationName ? ` (${ct.organizationName})` : ""}`,
      note: ct.note,
      at: ct.at!,
      overdue: ct.at! < now,
    })),
  ];

  return items.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export async function sendFollowupDigest(now: Date = new Date()): Promise<{ sent: boolean; count: number }> {
  const items = await getDueFollowups(now);
  if (items.length === 0) return { sent: false, count: 0 };

  const overdue = items.filter((i) => i.overdue);
  const today = items.filter((i) => !i.overdue);
  const line = (i: DigestItem) => {
    const tag = i.kind === "lead" ? "Lead" : i.kind === "ticket" ? "Ticket" : i.kind === "contact" ? "Contacto" : "Cliente";
    return `• [${tag}] ${escapeHtml(i.label)}${i.note ? ` — ${escapeHtml(i.note)}` : ""}`;
  };

  const parts = [`☀️ <b>Seguimientos de hoy (${items.length})</b>`];
  if (overdue.length > 0) parts.push(`\n🔴 <b>Vencidos (${overdue.length})</b>\n${overdue.map(line).join("\n")}`);
  if (today.length > 0) parts.push(`\n🟡 <b>Vencen hoy (${today.length})</b>\n${today.map(line).join("\n")}`);
  parts.push(`\nPedí detalles con /followups o mirá el Dashboard.`);

  const res = (await sendTelegramMessage(parts.join("\n"))) as { ok?: boolean };
  return { sent: res?.ok !== false, count: items.length };
}

const DIGEST_ENTITY = "followup_digest";

/** Límite del día local del servidor: comparten el cron de las 9 y el catch-up de boot. */
function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/**
 * La marca "digest ya enviado hoy" vive en la tabla events (action=digest_sent),
 * no en memoria: cada deploy recrea el contenedor y un contador en memoria
 * hacía que el catch-up de boot reenviara el digest en cada deploy.
 */
export async function wasDigestSentToday(now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.entity, DIGEST_ENTITY),
        eq(events.action, "digest_sent"),
        gte(events.createdAt, startOfLocalDay(now))
      )
    )
    .limit(1);
  return !!row;
}

export async function runDailyDigestOnce(now: Date = new Date()): Promise<void> {
  if (await wasDigestSentToday(now)) {
    console.log("[Digest] follow-ups: already sent today, skipping");
    return;
  }
  try {
    const { sent, count } = await sendFollowupDigest(now);
    console.log(`[Digest] follow-ups: sent=${sent} count=${count}`);
    // Solo se marca un envío realmente entregado: si Telegram falló, el
    // próximo boot o el cron del día siguiente reintenta.
    if (sent) {
      await logEvent({
        entity: DIGEST_ENTITY,
        entityId: randomUUID(),
        action: "digest_sent",
        actor: "system",
        after: { count },
        reason: "Marca diaria anti-reenvío del digest de seguimientos",
      });
    }
  } catch (err) {
    console.error("[Digest] failed:", err);
  }
}

let digestInFlight: Promise<void> | null = null;

/** Push matutino 9:00 (hora del servidor) + catch-up si el daemon arrancó después de las 9. */
export function startFollowupDigest(): void {
  const trigger = () => {
    if (digestInFlight) return;
    digestInFlight = runDailyDigestOnce().finally(() => {
      digestInFlight = null;
    });
  };

  cron.schedule("0 9 * * *", trigger);

  const now = new Date();
  if (now.getHours() >= 9) {
    trigger();
  }
}
