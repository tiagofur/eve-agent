import { Hono } from "hono";
import { sql, eq, count } from "drizzle-orm";
import { db } from "../../db/client";
import { leads, tickets, outbox } from "../../db/schema";
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

  return c.json({
    metrics: {
      totalLeads: Number(totalLeadsResult?.value ?? 0),
      openTickets: Number(openTicketsResult?.value ?? 0),
      pendingDraftsApproval: Number(pendingDraftsResult?.value ?? 0),
      generatedAt: new Date().toISOString(),
    },
  });
});
