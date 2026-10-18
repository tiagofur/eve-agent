import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tickets, contacts, events } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { createTicket, updateTicketStatus, type TicketStatus } from "../../domain/tickets";
import { logEvent } from "../../domain/events";

export const ticketsRouter = new Hono<{ Variables: AuthContextVariables }>();

ticketsRouter.post(
  "/",
  requireScope(["front", "ops"]),
  zValidator(
    "json",
    z.object({
      clientName: z.string().min(1),
      companyName: z.string().optional(),
      contact: z.string().min(1).optional(),
      system: z.string().min(1),
      severity: z.enum(["critical", "major", "minor"]).optional(),
      kind: z.enum(["support", "info"]).default("support"),
      description: z.string().min(1),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const result = await createTicket({
      ...data,
      actor,
    });

    if (!result.success) {
      return c.json({ error: result.message, code: result.code }, 400);
    }

    return c.json(
      {
        success: true,
        ticketId: result.ticket.id,
        kind: result.ticket.kind,
        severity: result.ticket.severity,
        slaDueAt: result.ticket.slaDueAt,
        slaHours: result.slaHours,
        status: result.ticket.status,
      },
      201
    );
  }
);

ticketsRouter.get("/", requireScope(["ops"]), async (c) => {
  const kind = c.req.query("kind");
  const query = db
    .select({
      id: tickets.id,
      kind: tickets.kind,
      system: tickets.system,
      severity: tickets.severity,
      status: tickets.status,
      description: tickets.description,
      slaDueAt: tickets.slaDueAt,
      createdAt: tickets.createdAt,
      contactName: contacts.name,
      contactEmail: contacts.email,
    })
    .from(tickets)
    .leftJoin(contacts, eq(tickets.contactId, contacts.id))
    .orderBy(desc(tickets.createdAt))
    .limit(50);
  const result =
    kind === "support" || kind === "info"
      ? await query.where(sql`${tickets.kind} = ${kind}`)
      : await query;

  return c.json({ tickets: result });
});

// Full ticket details with client contact and timeline events
ticketsRouter.get("/:id/details", requireScope(["ops"]), async (c) => {
  const ticketId = c.req.param("id");

  const [ticket] = await db
    .select({
      id: tickets.id,
      kind: tickets.kind,
      system: tickets.system,
      severity: tickets.severity,
      status: tickets.status,
      description: tickets.description,
      slaDueAt: tickets.slaDueAt,
      resolvedAt: tickets.resolvedAt,
      nextFollowUpAt: tickets.nextFollowUpAt,
      followUpNote: tickets.followUpNote,
      createdAt: tickets.createdAt,
      updatedAt: tickets.updatedAt,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
    })
    .from(tickets)
    .leftJoin(contacts, eq(tickets.contactId, contacts.id))
    .where(sql`${tickets.id} = ${ticketId}`);

  if (!ticket) {
    return c.json({ error: "Ticket not found" }, 404);
  }

  const timeline = await db
    .select()
    .from(events)
    .where(sql`${events.entityId} = ${ticketId}`)
    .orderBy(desc(events.createdAt))
    .limit(30);

  return c.json({ ticket, timeline });
});

// Set or clear a follow-up reminder on a ticket (ops only)
ticketsRouter.patch(
  "/:id/followup",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      nextFollowUpAt: z.string().datetime({ offset: true }).nullable(),
      followUpNote: z.string().max(500).optional(),
    })
  ),
  async (c) => {
    const ticketId = c.req.param("id");
    const { nextFollowUpAt, followUpNote } = c.req.valid("json");
    const actor = c.get("actor");

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(sql`${tickets.id} = ${ticketId}`)
      .limit(1);
    if (!ticket) {
      return c.json({ error: "Ticket not found" }, 404);
    }

    const [updated] = await db
      .update(tickets)
      .set({
        nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null,
        followUpNote: followUpNote ?? ticket.followUpNote,
        updatedAt: new Date(),
      })
      .where(sql`${tickets.id} = ${ticketId}`)
      .returning();

    await logEvent({
      entity: "ticket",
      entityId: ticketId,
      action: nextFollowUpAt ? "followup_set" : "followup_cleared",
      actor,
      after: { nextFollowUpAt, followUpNote: followUpNote ?? null },
    });

    return c.json({ success: true, ticket: updated });
  }
);

// Update ticket status (approve/start work, reject, resolve)
ticketsRouter.patch(
  "/:id/status",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      status: z.enum(["open", "in_progress", "waiting_client", "resolved", "closed"]),
      reason: z.string().optional(),
      clientMessage: z.string().optional(),
    })
  ),
  async (c) => {
    const ticketId = c.req.param("id");
    const { status, reason, clientMessage } = c.req.valid("json");
    const actor = c.get("actor");

    const result = await updateTicketStatus({
      ticketId,
      status: status as TicketStatus,
      actor,
      reason,
      clientMessage,
    });

    if (!result.success) {
      return c.json({ error: result.message, code: result.code }, 400);
    }

    return c.json({ success: true, ticket: result.ticket });
  }
);
