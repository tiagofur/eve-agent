import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  contacts,
  dossiers,
  events,
  leads,
  organizations,
  outbox,
  projects,
  tickets,
} from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { logEvent } from "../../domain/events";

export const organizationsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Set or clear a follow-up reminder on a client (ops only)
organizationsRouter.patch(
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
    const orgId = c.req.param("id");
    const { nextFollowUpAt, followUpNote } = c.req.valid("json");
    const actor = c.get("actor");

    const [org] = await db
      .select()
      .from(organizations)
      .where(sql`${organizations.id} = ${orgId}`)
      .limit(1);
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const [updated] = await db
      .update(organizations)
      .set({
        nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null,
        followUpNote: followUpNote ?? org.followUpNote,
        updatedAt: new Date(),
      })
      .where(sql`${organizations.id} = ${orgId}`)
      .returning();

    await logEvent({
      entity: "organization",
      entityId: orgId,
      action: nextFollowUpAt ? "followup_set" : "followup_cleared",
      actor,
      after: { nextFollowUpAt, followUpNote: followUpNote ?? null },
    });

    return c.json({ success: true, organization: updated });
  }
);

// List organizations (clients / prospects) — ops scope
organizationsRouter.get("/", requireScope(["ops"]), async (c) => {
  const result = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      domain: organizations.domain,
      website: organizations.website,
      industry: organizations.industry,
      city: organizations.city,
      country: organizations.country,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .orderBy(desc(organizations.createdAt))
    .limit(100);

  return c.json({ organizations: result });
});

// 360° summary: org + contacts + leads + projects + tickets + dossiers + drafts + timeline
organizationsRouter.get("/:id/summary", requireScope(["ops"]), async (c) => {
  const orgId = c.req.param("id");

  const [org] = await db
    .select()
    .from(organizations)
    .where(sql`${organizations.id} = ${orgId}`)
    .limit(1);

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const orgContacts = await db
    .select()
    .from(contacts)
    .where(sql`${contacts.organizationId} = ${orgId}`)
    .orderBy(desc(contacts.createdAt));

  const orgLeads = await db
    .select()
    .from(leads)
    .where(sql`${leads.organizationId} = ${orgId}`)
    .orderBy(desc(leads.createdAt));

  const orgProjects = await db
    .select()
    .from(projects)
    .where(sql`${projects.organizationId} = ${orgId}`)
    .orderBy(desc(projects.createdAt));

  const orgTickets = await db
    .select()
    .from(tickets)
    .where(sql`${tickets.organizationId} = ${orgId}`)
    .orderBy(desc(tickets.createdAt))
    .limit(50);

  const orgDossiers = await db
    .select()
    .from(dossiers)
    .where(sql`${dossiers.organizationId} = ${orgId}`)
    .orderBy(desc(dossiers.createdAt));

  const leadIds = orgLeads.map((l) => l.id);
  const drafts =
    leadIds.length > 0
      ? await db
          .select()
          .from(outbox)
          .where(inArray(outbox.leadId, leadIds))
          .orderBy(desc(outbox.createdAt))
          .limit(50)
      : [];

  const entityIds = [
    orgId,
    ...orgContacts.map((x) => x.id),
    ...leadIds,
    ...orgProjects.map((x) => x.id),
    ...orgTickets.map((x) => x.id),
  ];
  const timeline =
    entityIds.length > 0
      ? await db
          .select()
          .from(events)
          .where(sql`${events.entityId} IN (${sql.join(entityIds.map((id) => sql`${id}`), sql`, `)})`)
          .orderBy(desc(events.createdAt))
          .limit(50)
      : [];

  return c.json({
    organization: org,
    contacts: orgContacts,
    leads: orgLeads,
    projects: orgProjects,
    tickets: orgTickets,
    dossiers: orgDossiers,
    drafts,
    timeline,
  });
});
