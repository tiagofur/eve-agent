import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { asc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { contacts, interactions, leads, tickets } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { logEvent } from "../../domain/events";

export const interactionsRouter = new Hono<{ Variables: AuthContextVariables }>();

const linkSchema = z.object({
  leadId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  ticketId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  channel: z.enum(["whatsapp", "email", "telegram", "linkedin", "phone", "web", "other"]),
  direction: z.enum(["inbound", "outbound"]),
  content: z.string().min(1).max(4000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Log one thread entry (human, owner tooling, or agents via front/ops scopes)
interactionsRouter.post(
  "/",
  requireScope(["front", "ops"]),
  zValidator("json", linkSchema),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    if (!data.leadId && !data.organizationId && !data.ticketId && !data.projectId && !data.contactId) {
      return c.json({ error: "At least one link (lead, organization, ticket, project, contact) is required" }, 400);
    }

    const [row] = await db
      .insert(interactions)
      .values({
        leadId: data.leadId,
        organizationId: data.organizationId,
        ticketId: data.ticketId,
        projectId: data.projectId,
        contactId: data.contactId,
        channel: data.channel,
        direction: data.direction,
        content: data.content,
        metadata: data.metadata ?? {},
      })
      .returning();

    await logEvent({
      entity: "interaction",
      entityId: row!.id,
      action: `interaction_${data.direction}`,
      actor,
      after: { channel: data.channel, direction: data.direction },
      reason: data.content.slice(0, 200),
    });

    return c.json({ success: true, interaction: row }, 201);
  }
);

// Unified thread for one contact: every interaction + linked lead/ticket context
interactionsRouter.get("/by-contact/:contactId", requireScope(["ops"]), async (c) => {
  const contactId = c.req.param("contactId");

  const [contact] = await db
    .select()
    .from(contacts)
    .where(sql`${contacts.id} = ${contactId}`)
    .limit(1);
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }

  const entries = await db
    .select()
    .from(interactions)
    .where(sql`${interactions.contactId} = ${contactId}`)
    .orderBy(asc(interactions.createdAt))
    .limit(100);

  return c.json({
    contact: {
      id: contact.id,
      name: contact.name,
      nextFollowUpAt: contact.nextFollowUpAt,
      followUpNote: contact.followUpNote,
    },
    interactions: entries,
  });
});

// Unified thread for one organization: direct + via its leads and tickets
interactionsRouter.get("/by-organization/:orgId", requireScope(["ops"]), async (c) => {
  const orgId = c.req.param("orgId");

  const orgLeads = await db
    .select({ id: leads.id })
    .from(leads)
    .where(sql`${leads.organizationId} = ${orgId}`);
  const orgTickets = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(sql`${tickets.organizationId} = ${orgId}`);
  const leadIds = orgLeads.map((l) => l.id);
  const ticketIds = orgTickets.map((t) => t.id);

  const conds = [sql`${interactions.organizationId} = ${orgId}`];
  if (leadIds.length > 0) {
    conds.push(sql`${interactions.leadId} IN (${sql.join(leadIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  if (ticketIds.length > 0) {
    conds.push(sql`${interactions.ticketId} IN (${sql.join(ticketIds.map((id) => sql`${id}`), sql`, `)})`);
  }

  const entries = await db
    .select()
    .from(interactions)
    .where(sql.join(conds, sql` OR `))
    .orderBy(asc(interactions.createdAt))
    .limit(200);

  return c.json({ interactions: entries });
});
