import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tickets, contacts, events, tasks, projects } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  createTicket,
  updateTicketStatus,
  updateTicketContent,
  type TicketStatus,
} from "../../domain/tickets";
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
      projectId: z.string().uuid().optional(),
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
      const status = result.code === "project_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
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
        duplicate: result.duplicate ?? false,
      },
      result.duplicate ? 200 : 201
    );
  }
);

ticketsRouter.get("/", requireScope(["ops"]), async (c) => {
  const kind = c.req.query("kind");
  const status = c.req.query("status");
  const query = db
    .select({
      id: tickets.id,
      kind: tickets.kind,
      system: tickets.system,
      severity: tickets.severity,
      status: tickets.status,
      description: tickets.description,
      slaDueAt: tickets.slaDueAt,
      projectId: tickets.projectId,
      projectName: projects.name,
      createdAt: tickets.createdAt,
      contactName: contacts.name,
      contactEmail: contacts.email,
    })
    .from(tickets)
    .leftJoin(contacts, eq(tickets.contactId, contacts.id))
    .leftJoin(projects, eq(tickets.projectId, projects.id))
    .orderBy(desc(tickets.createdAt))
    .limit(50);

  const conditions = [];
  if (kind === "support" || kind === "info") conditions.push(sql`${tickets.kind} = ${kind}`);
  if (
    status === "open" ||
    status === "in_progress" ||
    status === "waiting_client" ||
    status === "resolved" ||
    status === "closed"
  ) {
    conditions.push(sql`${tickets.status} = ${status}`);
  }
  const result =
    conditions.length > 0 ? await query.where(sql.join(conditions, sql` AND `)) : await query;

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

  // Correction tasks spawned from this ticket: shows the owner the linked
  // work (status, PR, verification evidence) right in the ticket drawer.
  const linkedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      kind: tasks.kind,
      prUrl: tasks.prUrl,
      resultSummary: tasks.resultSummary,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(sql`${tasks.ticketId} = ${ticketId}`)
    .orderBy(desc(tasks.createdAt));

  return c.json({ ticket, timeline, tasks: linkedTasks });
});

// Correct a ticket's content: description captured wrong or vaguely at
// intake gets fixed here instead of superseding the ticket with a new one.
ticketsRouter.patch(
  "/:id",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      description: z.string().min(1).optional(),
      system: z.string().min(1).optional(),
      severity: z.enum(["critical", "major", "minor"]).optional(),
      kind: z.enum(["support", "info"]).optional(),
      projectId: z.string().uuid().nullable().optional(),
      reason: z.string().max(500).optional(),
    })
  ),
  async (c) => {
    const ticketId = c.req.param("id");
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const result = await updateTicketContent({ ticketId, ...data, actor });

    if (!result.success) {
      const status = result.code === "ticket_not_found" || result.code === "project_not_found" ? 404 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }

    return c.json({ success: true, ticket: result.ticket });
  }
);

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
