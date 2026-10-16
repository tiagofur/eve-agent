import { Hono } from "hono";
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

export const organizationsRouter = new Hono<{ Variables: AuthContextVariables }>();

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
