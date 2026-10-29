import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { count, desc, sql } from "drizzle-orm";
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
import { channelEnum } from "../../db/schema";

export const organizationsRouter = new Hono<{ Variables: AuthContextVariables }>();

const contactPayloadSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().max(120).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  preferredChannel: z.enum(channelEnum.enumValues).nullable().optional(),
});

/**
 * Manual ops corrections from the Client 360 sheet (agent-first: humans can
 * fix or complete company data without going through the orchestrator).
 */
organizationsRouter.patch(
  "/:id",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(200).optional(),
      domain: z.string().min(1).max(200).nullable().optional(),
      website: z.string().max(300).nullable().optional(),
      industry: z.string().max(120).nullable().optional(),
      city: z.string().max(120).nullable().optional(),
      country: z.string().max(120).nullable().optional(),
    })
  ),
  async (c) => {
    const orgId = c.req.param("id");
    const patch = c.req.valid("json");
    const actor = c.get("actor");

    const [org] = await db
      .select()
      .from(organizations)
      .where(sql`${organizations.id} = ${orgId}`)
      .limit(1);
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (patch.domain != null) {
      const normalized = patch.domain
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "")
        .toLowerCase();
      if (!normalized) {
        return c.json({ error: "Domain cannot be empty" }, 400);
      }
      const [clash] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(
          sql`${organizations.domain} = ${normalized} AND ${organizations.id} <> ${orgId}`
        )
        .limit(1);
      if (clash) {
        return c.json({ error: "That domain already belongs to another organization" }, 409);
      }
      patch.domain = normalized;
    }

    const before: Record<string, unknown> = {};
    const changed: Record<string, unknown> = {};
    for (const key of ["name", "domain", "website", "industry", "city", "country"] as const) {
      const next = patch[key];
      if (next === undefined) continue;
      const current = org[key];
      if (current !== next) {
        before[key] = current;
        changed[key] = next;
      }
    }
    if (Object.keys(changed).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const [updated] = await db
      .update(organizations)
      .set({ ...changed, updatedAt: new Date() } as Partial<typeof organizations.$inferInsert>)
      .where(sql`${organizations.id} = ${orgId}`)
      .returning();

    await logEvent({
      entity: "organization",
      entityId: orgId,
      action: "updated",
      actor,
      before,
      after: changed,
    });

    return c.json({ success: true, organization: updated });
  }
);

// Delete an organization manually (ops only). Only allowed while it has no
// projects — projects are the org's real work and their FK is restrict. The
// org's leads, contacts, dossiers, interactions and outbox drafts are removed
// with it; tickets and estimates keep history with the org link nulled, and
// audit events survive as history.
organizationsRouter.delete("/:id", requireScope(["ops"]), async (c) => {
  const orgId = c.req.param("id") ?? "";
  const actor = c.get("actor");

  const [org] = await db
    .select()
    .from(organizations)
    .where(sql`${organizations.id} = ${orgId}`)
    .limit(1);
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const orgProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(sql`${projects.organizationId} = ${orgId}`);
  if (orgProjects.length > 0) {
    return c.json(
      {
        error: `No se puede eliminar: la organización tiene ${orgProjects.length} proyecto(s). Reasígnalos o elimínalos primero.`,
      },
      409
    );
  }

  const orgLeads = await db
    .select({ id: leads.id })
    .from(leads)
    .where(sql`${leads.organizationId} = ${orgId}`);
  const orgContacts = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`${contacts.organizationId} = ${orgId}`);

  // FK cascades handle the rest per row: leads cascade their
  // interactions/outbox/dossiers, contacts cascade theirs; deleting the org
  // cascades what is still linked at the org level and nulls tickets/estimates.
  await db.delete(leads).where(sql`${leads.organizationId} = ${orgId}`);
  await db.delete(contacts).where(sql`${contacts.organizationId} = ${orgId}`);
  await db.delete(organizations).where(sql`${organizations.id} = ${orgId}`);

  await logEvent({
    entity: "organization",
    entityId: orgId,
    action: "deleted",
    actor,
    after: {
      name: org.name,
      domain: org.domain,
      removedLeads: orgLeads.length,
      removedContacts: orgContacts.length,
    },
  });

  return c.json({ success: true, removedLeads: orgLeads.length, removedContacts: orgContacts.length });
});

// Add a contact manually from the Client 360 sheet (ops only). Manual rows do
// not attest WhatsApp consent: ingestLead only implies consent when the contact
// themselves provided the phone.
organizationsRouter.post(
  "/:id/contacts",
  requireScope(["ops"]),
  zValidator("json", contactPayloadSchema),
  async (c) => {
    const orgId = c.req.param("id");
    const { name, role, email, phone, preferredChannel } = c.req.valid("json");
    const actor = c.get("actor");

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.id} = ${orgId}`)
      .limit(1);
    if (!org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    const [created] = await db
      .insert(contacts)
      .values({
        organizationId: orgId,
        name: name.trim(),
        role: role ?? null,
        email: email ?? null,
        phone: phone ?? null,
        preferredChannel: preferredChannel ?? null,
        whatsappConsent: false,
      })
      .returning();

    await logEvent({
      entity: "contact",
      entityId: created!.id,
      action: "created",
      actor,
      after: { name: created!.name, role: role ?? null, email: email ?? null, phone: phone ?? null, organizationId: orgId },
    });

    return c.json({ success: true, contact: created }, 201);
  }
);

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

  const projectCounts = await db
    .select({ organizationId: projects.organizationId, count: count(projects.id) })
    .from(projects)
    .groupBy(projects.organizationId);
  const leadCounts = await db
    .select({ organizationId: leads.organizationId, count: count(leads.id) })
    .from(leads)
    .groupBy(leads.organizationId);
  const projectByOrg = new Map(projectCounts.map((r) => [r.organizationId, Number(r.count)]));
  const leadByOrg = new Map(leadCounts.map((r) => [r.organizationId, Number(r.count)]));

  return c.json({
    organizations: result.map((o) => ({
      ...o,
      projectCount: projectByOrg.get(o.id) ?? 0,
      leadCount: leadByOrg.get(o.id) ?? 0,
    })),
  });
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
  const draftConds = [sql`${outbox.organizationId} = ${orgId}`];
  if (leadIds.length > 0) {
    draftConds.push(
      sql`${outbox.leadId} IN (${sql.join(leadIds.map((id) => sql`${id}`), sql`, `)})`
    );
  }
  const drafts = await db
    .select()
    .from(outbox)
    .where(sql.join(draftConds, sql` OR `))
    .orderBy(desc(outbox.createdAt))
    .limit(50);

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
