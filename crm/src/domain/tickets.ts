import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { tickets, contacts, organizations, type ticketSeverityEnum, type ticketStatusEnum, type ticketKindEnum } from "../db/schema";
import { logEvent } from "./events";
import { notifyCriticalTicketCreated } from "../services/telegram";

export type TicketSeverity = (typeof ticketSeverityEnum.enumValues)[number];
export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
export type TicketKind = (typeof ticketKindEnum.enumValues)[number];

export interface CreateTicketInput {
  clientName: string;
  companyName?: string;
  /**
   * Follow-up channel (email/phone). Optional for `info` questions from
   * strangers; required for `support` incidents (rejected loudly otherwise).
   */
  contact?: string;
  system: string;
  /** Meaningless for `info` (24h commercial SLA always): defaults to minor. */
  severity?: TicketSeverity;
  kind?: TicketKind;
  description: string;
  actor: string;
}

export type CreateTicketResult =
  | { success: true; ticket: typeof tickets.$inferSelect; slaHours: number }
  | { success: false; code: string; message: string };

export function computeSlaDueAt(severity: TicketSeverity, kind: TicketKind = "support"): Date {
  const now = new Date();
  // Info/sales requests always carry a commercial 24h SLA, regardless of severity.
  if (kind === "info") {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  switch (severity) {
    case "critical":
      return new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour
    case "major":
      return new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4 hours
    case "minor":
    default:
      return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
  }
}

export async function createTicket(input: CreateTicketInput): Promise<CreateTicketResult> {
  const kind = input.kind ?? "support";
  const severity = input.severity ?? "minor";
  const rawContact = input.contact?.trim() || undefined;

  // Support incidents without a follow-up channel cannot be worked:
  // refuse loudly instead of logging a dead ticket.
  if (kind === "support" && !rawContact) {
    return {
      success: false,
      code: "contact_required",
      message: "Support incidents require a contact email or phone for follow-up.",
    };
  }

  const slaDueAt = computeSlaDueAt(severity, kind);

  // 1. Resolve contact/org if possible
  const isEmail = !!rawContact && rawContact.includes("@");
  let contactId: string | undefined = undefined;

  if (rawContact) {
    const [existingContact] = await db
      .select()
      .from(contacts)
      .where(isEmail ? eq(contacts.email, rawContact.toLowerCase()) : eq(contacts.phone, rawContact))
      .limit(1);

    if (existingContact) {
      contactId = existingContact.id;
    } else {
      const [newContact] = await db
        .insert(contacts)
        .values({
          name: input.clientName.trim(),
          email: isEmail ? rawContact.toLowerCase() : undefined,
          phone: !isEmail ? rawContact : undefined,
        })
        .returning();
      if (newContact) {
        contactId = newContact.id;
      }
    }
  }

  const [ticket] = await db
    .insert(tickets)
    .values({
      contactId,
      kind,
      system: input.system,
      severity,
      status: "open",
      description: input.description,
      slaDueAt,
    })
    .returning();

  if (!ticket) {
    throw new Error("Failed to create ticket");
  }

  await logEvent({
    entity: "ticket",
    entityId: ticket.id,
    action: "ticket_created",
    actor: input.actor,
    after: {
      kind,
      severity,
      system: input.system,
      slaDueAt: slaDueAt.toISOString(),
    },
    reason: input.description,
  });

  // Only support incidents page the owner; info requests wait in the queue.
  if (kind === "support" && (severity === "critical" || severity === "major")) {
    notifyCriticalTicketCreated(ticket.id).catch((err) =>
      console.error("Failed to dispatch telegram ticket alert:", err)
    );
  }

  return {
    success: true,
    ticket,
    slaHours: kind === "info" ? 24 : severity === "critical" ? 1 : severity === "major" ? 4 : 24,
  };
}

export interface UpdateTicketStatusInput {
  ticketId: string;
  status: TicketStatus;
  actor: string;
  reason?: string;
  clientMessage?: string;
}

export async function updateTicketStatus(input: UpdateTicketStatusInput) {
  const [current] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, input.ticketId))
    .limit(1);

  if (!current) {
    return { success: false, message: "Ticket not found", code: "NOT_FOUND" as const };
  }

  const isResolving = input.status === "resolved";
  const [updated] = await db
    .update(tickets)
    .set({
      status: input.status,
      resolvedAt: isResolving ? new Date() : current.resolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, input.ticketId))
    .returning();

  await logEvent({
    entity: "ticket",
    entityId: input.ticketId,
    action: `ticket_${input.status}`,
    actor: input.actor,
    before: { status: current.status },
    after: { status: input.status, clientMessage: input.clientMessage },
    reason: input.reason || `Status changed to ${input.status}`,
  });

  return { success: true, ticket: updated };
}
