import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { leads, organizations, contacts, dossiers, outbox, events } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { ingestLead, changeLeadStage } from "../../domain/leads";
import { logEvent } from "../../domain/events";
import { createProject } from "../../domain/projects";
import { LEAD_STAGES } from "../../domain/lead-stages";

export const leadsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Ingest a lead (callable by front agent, ops agent, or owner)
leadsRouter.post(
  "/",
  requireScope(["front", "ops"]),
  zValidator(
    "json",
    z.object({
      clientName: z.string().min(1),
      companyName: z.string().optional(),
      contact: z.string().min(1).optional(),
      serviceType: z.enum(["software_development", "automation", "ai_implementation", "consulting"]).optional(),
      projectSummary: z.string().min(1),
      estimatedBudget: z.string().optional(),
      source: z.string().default("front_agent"),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const result = await ingestLead({
      ...data,
      actor,
    });

    return c.json(
      {
        success: true,
        leadId: result.lead.id,
        contactId: result.lead.contactId,
        stage: result.lead.stage,
        hasOptOut: result.hasOptOut,
        recordedAt: result.lead.createdAt,
      },
      201
    );
  }
);

// Transition lead stage (strictly ops or owner)
leadsRouter.patch(
  "/:id/stage",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      targetStage: z.enum(LEAD_STAGES),
      reason: z.string().min(1),
      lostReason: z.string().optional(),
    })
  ),
  async (c) => {
    const leadId = c.req.param("id");
    const { targetStage, reason, lostReason } = c.req.valid("json");
    const actor = c.get("actor");

    const result = await changeLeadStage({
      leadId,
      targetStage,
      reason,
      lostReason,
      actor,
    });

    if (!result.success) {
      return c.json({ error: result.message, code: result.code }, 400);
    }

    return c.json({ success: true, lead: result.lead });
  }
);

// Convert a won lead into a client project in one click (ops only)
leadsRouter.post(
  "/:id/convert",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      projectName: z.string().min(1).optional(),
      repoUrl: z.string().url().optional(),
      reason: z.string().min(1).default("Lead convertido en cliente/proyecto"),
      milestonesList: z
        .array(
          z.object({
            title: z.string().min(1),
            dueDate: z.string().optional(),
          })
        )
        .optional(),
    })
  ),
  async (c) => {
    const leadId = c.req.param("id");
    const { projectName, repoUrl, reason, milestonesList } = c.req.valid("json");
    const actor = c.get("actor");

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return c.json({ error: "Lead not found" }, 404);
    }
    if (lead.stage !== "won") {
      return c.json(
        { error: `Only leads in "won" can be converted (current: "${lead.stage}")` },
        400
      );
    }
    if (!lead.organizationId) {
      return c.json({ error: "Lead has no organization; cannot convert" }, 400);
    }

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, lead.organizationId))
      .limit(1);
    const name = projectName?.trim() || `${org?.name ?? "Cliente"} — Proyecto`;

    const project = await createProject({
      organizationId: lead.organizationId,
      leadId: lead.id,
      name,
      repoUrl,
      milestonesList,
      actor: `${actor}: ${reason}`,
    });

    return c.json({ success: true, project }, 201);
  }
);

// Set or clear a follow-up reminder on a lead (ops only)
leadsRouter.patch(
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
    const leadId = c.req.param("id");
    const { nextFollowUpAt, followUpNote } = c.req.valid("json");
    const actor = c.get("actor");

    const [lead] = await db.select().from(leads).where(sql`${leads.id} = ${leadId}`).limit(1);
    if (!lead) {
      return c.json({ error: "Lead not found" }, 404);
    }

    const [updated] = await db
      .update(leads)
      .set({
        nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null,
        followUpNote: followUpNote ?? lead.followUpNote,
        updatedAt: new Date(),
      })
      .where(sql`${leads.id} = ${leadId}`)
      .returning();

    await logEvent({
      entity: "lead",
      entityId: leadId,
      action: nextFollowUpAt ? "followup_set" : "followup_cleared",
      actor,
      after: { nextFollowUpAt, followUpNote: followUpNote ?? null },
    });

    return c.json({ success: true, lead: updated });
  }
);

// List leads (ops or owner only)
leadsRouter.get("/", requireScope(["ops"]), async (c) => {
  const result = await db
    .select({
      id: leads.id,
      stage: leads.stage,
      stageChangedAt: leads.stageChangedAt,
      source: leads.source,
      serviceType: leads.serviceType,
      summary: leads.summary,
      createdAt: leads.createdAt,
      organizationName: organizations.name,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
    })
    .from(leads)
    .leftJoin(organizations, eq(leads.organizationId, organizations.id))
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .orderBy(desc(leads.createdAt))
    .limit(50);

  return c.json({ leads: result });
});

// Full lead details with AI intelligence, dossiers, outbox drafts, and history
leadsRouter.get("/:id/details", requireScope(["ops"]), async (c) => {
  const leadId = c.req.param("id");

  const [lead] = await db
    .select({
      id: leads.id,
      stage: leads.stage,
      stageChangedAt: leads.stageChangedAt,
      source: leads.source,
      serviceType: leads.serviceType,
      summary: leads.summary,
      organizationId: leads.organizationId,
      contactId: leads.contactId,
      nextFollowUpAt: leads.nextFollowUpAt,
      followUpNote: leads.followUpNote,
      createdAt: leads.createdAt,
      organizationName: organizations.name,
      organizationDomain: organizations.domain,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
    })
    .from(leads)
    .leftJoin(organizations, eq(leads.organizationId, organizations.id))
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .where(sql`${leads.id} = ${leadId}`);

  if (!lead) {
    return c.json({ error: "Lead not found" }, 404);
  }

  // Associated dossiers
  const leadDossiers = await db
    .select()
    .from(dossiers)
    .where(
      lead.organizationId
        ? sql`${dossiers.leadId} = ${leadId} OR ${dossiers.organizationId} = ${lead.organizationId}`
        : sql`${dossiers.leadId} = ${leadId}`
    )
    .orderBy(desc(dossiers.createdAt));

  // Outreach drafts
  const drafts = await db
    .select()
    .from(outbox)
    .where(sql`${outbox.leadId} = ${leadId}`)
    .orderBy(desc(outbox.createdAt));

  // Timeline / audit events
  const auditEvents = await db
    .select()
    .from(events)
    .where(sql`${events.entityId} = ${leadId}`)
    .orderBy(desc(events.createdAt))
    .limit(30);

  return c.json({
    lead,
    dossiers: leadDossiers,
    drafts,
    timeline: auditEvents,
  });
});
