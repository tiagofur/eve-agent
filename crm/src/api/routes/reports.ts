import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, inArray, sql, eq, count, asc, desc, gte, isNull, isNotNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  leads,
  tickets,
  outbox,
  organizations,
  contacts,
  analystReports,
  projects,
  tasks,
  milestones,
} from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { FUNNEL_STAGES } from "../../domain/lead-stages";
import { getConversions } from "../../domain/conversions";
import { getUnansweredReplies } from "../../domain/inbound-email";
import { getContactsForOrganizations } from "../../domain/billing";

export const reportsRouter = new Hono<{ Variables: AuthContextVariables }>();

/** ISO-8601 week tag ("2026-W46"): the weekly report's dedup key. */
export function isoWeekTag(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Per-project activity for the reporter subagent: only CRM facts from the
// window, with evidence. The report draft (and its approval) happens in the
// agent; this endpoint never writes anything.
reportsRouter.get("/weekly", requireScope(["ops"]), async (c) => {
  const days = Math.min(Math.max(Number.parseInt(c.req.query("days") ?? "7", 10) || 7, 1), 31);
  const since = new Date(Date.now() - days * 86_400_000);

  const openProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      organizationId: projects.organizationId,
      organizationName: organizations.name,
    })
    .from(projects)
    .leftJoin(organizations, eq(projects.organizationId, organizations.id))
    .where(
      sql`${projects.status} IN ('onboarding', 'active', 'paused', 'delivered')`
    )
    .orderBy(asc(projects.name));

  const ids = openProjects.map((p) => p.id);

  const [doneTasks, inFlightTasks, doneMilestones, upcomingMilestones, resolvedTickets, openTickets] =
    ids.length > 0
      ? await Promise.all([
          db
            .select({
              projectId: tasks.projectId,
              title: tasks.title,
              prUrl: tasks.prUrl,
              resultSummary: tasks.resultSummary,
              updatedAt: tasks.updatedAt,
            })
            .from(tasks)
            .where(and(inArray(tasks.projectId, ids), eq(tasks.status, "done"), gte(tasks.updatedAt, since)))
            .orderBy(desc(tasks.updatedAt))
            .limit(100),
          db
            .select({ projectId: tasks.projectId, title: tasks.title, status: tasks.status, updatedAt: tasks.updatedAt })
            .from(tasks)
            .where(
              and(inArray(tasks.projectId, ids), inArray(tasks.status, ["ready", "dispatched", "in_progress", "in_review", "blocked"]))
            )
            .orderBy(desc(tasks.updatedAt))
            .limit(100),
          db
            .select({ projectId: milestones.projectId, title: milestones.title, doneAt: milestones.doneAt })
            .from(milestones)
            .where(and(inArray(milestones.projectId, ids), isNotNull(milestones.doneAt), gte(milestones.doneAt, since))),
          db
            .select({ projectId: milestones.projectId, title: milestones.title, dueDate: milestones.dueDate })
            .from(milestones)
            .where(and(inArray(milestones.projectId, ids), isNull(milestones.doneAt), isNotNull(milestones.dueDate)))
            .orderBy(asc(milestones.dueDate))
            .limit(60),
          db
            .select({
              projectId: tickets.projectId,
              system: tickets.system,
              severity: tickets.severity,
              description: tickets.description,
              resolvedAt: tickets.resolvedAt,
            })
            .from(tickets)
            .where(and(inArray(tickets.projectId, ids), eq(tickets.status, "resolved"), gte(tickets.resolvedAt, since)))
            .orderBy(desc(tickets.resolvedAt)),
          db
            .select({ projectId: tickets.projectId, value: count(tickets.id) })
            .from(tickets)
            .where(and(inArray(tickets.projectId, ids), inArray(tickets.status, ["open", "in_progress", "waiting_client"])))
            .groupBy(tickets.projectId),
        ])
      : [[], [], [], [], [], []];

  const openTicketCount = new Map(openTickets.map((r) => [r.projectId, Number(r.value)]));

  const weekTag = isoWeekTag();
  // Projects whose THIS-week report draft already awaits approval: the tool
  // refuses a second one mechanically, the owner reviews the pending draft.
  const pendingReportRows = await db
    .select({ projectId: sql<string>`${outbox.metadata}->>'projectId'` })
    .from(outbox)
    .where(and(eq(outbox.status, "pending_approval"), sql`${outbox.metadata}->>'reportWeek' = ${weekTag}`));
  const pendingReportProjects = new Set(pendingReportRows.map((r) => r.projectId));

  const projectReports = openProjects.map((p) => ({
    projectId: p.id,
    projectName: p.name,
    status: p.status,
    organizationId: p.organizationId,
    organizationName: p.organizationName,
    pendingReport: pendingReportProjects.has(p.id),
    completedTasks: doneTasks
      .filter((t) => t.projectId === p.id)
      .map((t) => ({ title: t.title, prUrl: t.prUrl, resultSummary: t.resultSummary, completedAt: t.updatedAt.toISOString() })),
    inFlightTasks: inFlightTasks
      .filter((t) => t.projectId === p.id)
      .map((t) => ({ title: t.title, status: t.status })),
    milestonesCompleted: doneMilestones
      .filter((m) => m.projectId === p.id)
      .map((m) => ({ title: m.title, doneAt: m.doneAt!.toISOString() })),
    milestonesUpcoming: upcomingMilestones
      .filter((m) => m.projectId === p.id)
      .slice(0, 3)
      .map((m) => ({ title: m.title, dueDate: m.dueDate! })),
    resolvedTickets: resolvedTickets
      .filter((t) => t.projectId === p.id)
      .map((t) => ({ system: t.system, severity: t.severity, description: t.description, resolvedAt: t.resolvedAt!.toISOString() })),
    openTickets: openTicketCount.get(p.id) ?? 0,
  }));

  const contactsByOrganization = await getContactsForOrganizations(
    projectReports.map((p) => p.organizationId)
  );

  return c.json({
    weekTag,
    window: { days, since: since.toISOString(), until: new Date().toISOString() },
    projects: projectReports,
    contactsByOrganization,
  });
});

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

// Owner triage (Mission Control "Reportes"): unread count for the sidebar
// badge. A report is unread while read_at is NULL.
reportsRouter.get("/analyst/unread-count", requireScope(["ops"]), async (c) => {
  const [row] = await db
    .select({ unread: count() })
    .from(analystReports)
    .where(sql`${analystReports.readAt} IS NULL`);
  return c.json({ unread: row?.unread ?? 0 });
});

// Mark one report read/unread (the desktop auto-marks on open).
reportsRouter.post(
  "/analyst/:id/read",
  requireScope(["ops"]),
  zValidator("json", z.object({ read: z.boolean() })),
  async (c) => {
    const id = c.req.param("id");
    const { read } = c.req.valid("json");

    const [updated] = await db
      .update(analystReports)
      .set({ readAt: read ? new Date() : null })
      .where(eq(analystReports.id, id))
      .returning();
    if (!updated) return c.json({ error: "Report not found" }, 404);

    return c.json({ success: true, readAt: updated.readAt?.toISOString() ?? null });
  }
);

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

  // Who is waiting on US: an unanswered inbound message changes the right
  // move from "nudge" to "answer what they said".
  const replies = await getUnansweredReplies([
    ...overdueLeads.map((l) => l.contactId ?? ""),
    ...overdueTickets.map((t) => t.contactId ?? ""),
    ...overdueContacts.map((ct) => ct.id),
    ...upcomingLeads.map((l) => l.contactId ?? ""),
  ]);
  const replyOf = (contactId: string | null) => (contactId ? (replies.get(contactId) ?? null) : null);

  return c.json({
    overdue: [
      ...overdueLeads.map((l) => ({ kind: "lead" as const, ...l, unansweredReply: replyOf(l.contactId) })),
      ...overdueTickets.map((t) => ({ kind: "ticket" as const, ...t, unansweredReply: replyOf(t.contactId) })),
      ...overdueOrgs.map((o) => ({
        kind: "organization" as const,
        id: o.id,
        name: o.name,
        organizationName: o.name,
        detail: null as string | null,
        nextFollowUpAt: o.nextFollowUpAt,
        followUpNote: o.followUpNote,
        stage: null as string | null,
        unansweredReply: null,
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
        unansweredReply: replyOf(ct.id),
      })),
    ],
    upcoming: upcomingLeads.map((l) => ({ kind: "lead" as const, ...l, unansweredReply: replyOf(l.contactId) })),
  });
});
