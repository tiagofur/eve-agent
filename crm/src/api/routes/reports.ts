import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql, eq, count, asc, desc } from "drizzle-orm";
import { db } from "../../db/client";
import { leads, tickets, outbox, organizations, contacts, analystReports } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { FUNNEL_STAGES } from "../../domain/lead-stages";
import { getConversions } from "../../domain/conversions";

export const reportsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Honest funnel analytics (S1): edges, rates, time-in-stage and loss
// reasons computed from the transition history of live leads — never from
// snapshot stocks. Ops only.
reportsRouter.get("/conversions", requireScope(["ops"]), async (c) => {
  const report = await getConversions();
  return c.json(report);
});

// Persisted analyst reports (S1): every analysis is stored with the frozen
// metrics snapshot it was grounded in, so trends compare saved history.
reportsRouter.post(
  "/analyst",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      periodStart: z.string().datetime({ offset: true }).optional(),
      periodEnd: z.string().datetime({ offset: true }).optional(),
      summary: z.string().min(1),
      metrics: z.record(z.string(), z.unknown()).default({}),
      createdBy: z.string().min(1),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const [report] = await db
      .insert(analystReports)
      .values({
        periodStart: data.periodStart ? new Date(data.periodStart) : null,
        periodEnd: data.periodEnd ? new Date(data.periodEnd) : null,
        summary: data.summary,
        metrics: data.metrics,
        createdBy: data.createdBy,
      })
      .returning();
    return c.json({ success: true, report }, 201);
  }
);

reportsRouter.get("/analyst", requireScope(["ops"]), async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);
  const reports = await db
    .select()
    .from(analystReports)
    .orderBy(desc(analystReports.createdAt))
    .limit(limit);
  return c.json({ reports });
});

reportsRouter.get("/funnel", requireScope(["ops"]), async (c) => {
  // Aggregate count of leads grouped by stage
  const rows = await db
    .select({
      stage: leads.stage,
      count: count(leads.id),
    })
    .from(leads)
    .groupBy(leads.stage);

  const stageCounts: Record<string, number> = {};
  for (const r of rows) {
    stageCounts[r.stage] = Number(r.count);
  }

  // Build funnel data in sequence
  let totalInFunnel = 0;
  const funnel = FUNNEL_STAGES.map((stage) => {
    const c = stageCounts[stage] ?? 0;
    totalInFunnel += c;
    return {
      stage,
      count: c,
    };
  });

  return c.json({
    funnel,
    totalInFunnel,
    lostCount: stageCounts["lost"] ?? 0,
    wonCount: stageCounts["won"] ?? 0,
  });
});

reportsRouter.get("/daily", requireScope(["ops"]), async (c) => {
  const [totalLeadsResult] = await db.select({ value: count(leads.id) }).from(leads);
  const [openTicketsResult] = await db
    .select({ value: count(tickets.id) })
    .from(tickets)
    .where(eq(tickets.status, "open"));
  const [pendingDraftsResult] = await db
    .select({ value: count(outbox.id) })
    .from(outbox)
    .where(eq(outbox.status, "pending_approval"));
  const now = new Date();
  const [overdueLeadsResult] = await db
    .select({ value: count(leads.id) })
    .from(leads)
    .where(sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} <= ${now} AND ${leads.stage} != 'lost'`);
  const [overdueTicketsResult] = await db
    .select({ value: count(tickets.id) })
    .from(tickets)
    .where(
      sql`${tickets.nextFollowUpAt} IS NOT NULL AND ${tickets.nextFollowUpAt} <= ${now} AND ${tickets.status} NOT IN ('resolved', 'closed')`
    );
  const [overdueOrgsResult] = await db
    .select({ value: count(organizations.id) })
    .from(organizations)
    .where(sql`${organizations.nextFollowUpAt} IS NOT NULL AND ${organizations.nextFollowUpAt} <= ${now}`);
  const [overdueContactsResult] = await db
    .select({ value: count(contacts.id) })
    .from(contacts)
    .where(sql`${contacts.nextFollowUpAt} IS NOT NULL AND ${contacts.nextFollowUpAt} <= ${now}`);

  return c.json({
    metrics: {
      totalLeads: Number(totalLeadsResult?.value ?? 0),
      openTickets: Number(openTicketsResult?.value ?? 0),
      pendingDraftsApproval: Number(pendingDraftsResult?.value ?? 0),
      followUpsOverdue:
        Number(overdueLeadsResult?.value ?? 0) +
        Number(overdueTicketsResult?.value ?? 0) +
        Number(overdueOrgsResult?.value ?? 0) +
        Number(overdueContactsResult?.value ?? 0),
      generatedAt: new Date().toISOString(),
    },
  });
});

// T3: unified follow-up queue (overdue first, then upcoming). Ops only.
reportsRouter.get("/followups", requireScope(["ops"]), async (c) => {
  const now = new Date();

  const overdueLeads = await db
    .select({
      id: leads.id,
      leadId: leads.id,
      contactId: leads.contactId,
      name: contacts.name,
      organizationName: organizations.name,
      detail: leads.summary,
      nextFollowUpAt: leads.nextFollowUpAt,
      followUpNote: leads.followUpNote,
      stage: leads.stage,
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(organizations, eq(leads.organizationId, organizations.id))
    .where(
      sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} <= ${now} AND ${leads.stage} != 'lost'`
    )
    .orderBy(asc(leads.nextFollowUpAt));

  const overdueTickets = await db
    .select({
      id: tickets.id,
      organizationId: tickets.organizationId,
      contactId: tickets.contactId,
      name: contacts.name,
      organizationName: organizations.name,
      detail: tickets.description,
      nextFollowUpAt: tickets.nextFollowUpAt,
      followUpNote: tickets.followUpNote,
      stage: tickets.status,
    })
    .from(tickets)
    .leftJoin(contacts, eq(tickets.contactId, contacts.id))
    .leftJoin(organizations, eq(tickets.organizationId, organizations.id))
    .where(
      sql`${tickets.nextFollowUpAt} IS NOT NULL AND ${tickets.nextFollowUpAt} <= ${now} AND ${tickets.status} NOT IN ('resolved', 'closed')`
    )
    .orderBy(asc(tickets.nextFollowUpAt));

  const overdueOrgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      nextFollowUpAt: organizations.nextFollowUpAt,
      followUpNote: organizations.followUpNote,
    })
    .from(organizations)
    .where(sql`${organizations.nextFollowUpAt} IS NOT NULL AND ${organizations.nextFollowUpAt} <= ${now}`)
    .orderBy(asc(organizations.nextFollowUpAt));

  const overdueContacts = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      organizationName: organizations.name,
      nextFollowUpAt: contacts.nextFollowUpAt,
      followUpNote: contacts.followUpNote,
    })
    .from(contacts)
    .leftJoin(organizations, eq(contacts.organizationId, organizations.id))
    .where(sql`${contacts.nextFollowUpAt} IS NOT NULL AND ${contacts.nextFollowUpAt} <= ${now}`)
    .orderBy(asc(contacts.nextFollowUpAt));

  const upcomingLeads = await db
    .select({
      id: leads.id,
      leadId: leads.id,
      contactId: leads.contactId,
      name: contacts.name,
      organizationName: organizations.name,
      detail: leads.summary,
      nextFollowUpAt: leads.nextFollowUpAt,
      followUpNote: leads.followUpNote,
      stage: leads.stage,
    })
    .from(leads)
    .leftJoin(contacts, eq(leads.contactId, contacts.id))
    .leftJoin(organizations, eq(leads.organizationId, organizations.id))
    .where(sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} > ${now} AND ${leads.stage} != 'lost'`)
    .orderBy(asc(leads.nextFollowUpAt));

  return c.json({
    overdue: [
      ...overdueLeads.map((l) => ({ kind: "lead" as const, ...l })),
      ...overdueTickets.map((t) => ({ kind: "ticket" as const, ...t })),
      ...overdueOrgs.map((o) => ({
        kind: "organization" as const,
        id: o.id,
        name: o.name,
        organizationName: o.name,
        detail: null as string | null,
        nextFollowUpAt: o.nextFollowUpAt,
        followUpNote: o.followUpNote,
        stage: null as string | null,
      })),
      ...overdueContacts.map((ct) => ({
        kind: "contact" as const,
        id: ct.id,
        name: ct.name,
        organizationName: ct.organizationName,
        detail: null as string | null,
        nextFollowUpAt: ct.nextFollowUpAt,
        followUpNote: ct.followUpNote,
        stage: null as string | null,
      })),
    ],
    upcoming: upcomingLeads.map((l) => ({ kind: "lead" as const, ...l })),
  });
});
