import { Hono } from "hono";
import { sql, eq, count } from "drizzle-orm";
import { db } from "../../db/client";
import { leads, tickets, outbox, organizations, contacts } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { FUNNEL_STAGES } from "../../domain/lead-stages";

export const reportsRouter = new Hono<{ Variables: AuthContextVariables }>();

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

  return c.json({
    metrics: {
      totalLeads: Number(totalLeadsResult?.value ?? 0),
      openTickets: Number(openTicketsResult?.value ?? 0),
      pendingDraftsApproval: Number(pendingDraftsResult?.value ?? 0),
      followUpsOverdue:
        Number(overdueLeadsResult?.value ?? 0) +
        Number(overdueTicketsResult?.value ?? 0) +
        Number(overdueOrgsResult?.value ?? 0),
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
    );

  const overdueTickets = await db
    .select({
      id: tickets.id,
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
    );

  const overdueOrgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      nextFollowUpAt: organizations.nextFollowUpAt,
      followUpNote: organizations.followUpNote,
    })
    .from(organizations)
    .where(sql`${organizations.nextFollowUpAt} IS NOT NULL AND ${organizations.nextFollowUpAt} <= ${now}`);

  const upcomingLeads = await db
    .select({
      id: leads.id,
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
    .where(sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} > ${now} AND ${leads.stage} != 'lost'`);

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
    ],
    upcoming: upcomingLeads.map((l) => ({ kind: "lead" as const, ...l })),
  });
});
