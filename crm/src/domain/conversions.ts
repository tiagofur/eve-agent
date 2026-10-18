import { asc, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { events, leads } from "../db/schema";

/** Below this many live leads, rates are noise: report counts, not confidence. */
export const MIN_ANALYST_SAMPLE = 10;

export interface ConversionEdge {
  from: string;
  to: string;
  count: number;
  /** Flow-through: transitions from→to divided by entries into `from`. */
  rate: number;
}

export interface LossReasonCount {
  reason: string;
  count: number;
}

export interface ConversionsReport {
  sampleSize: number;
  minSample: number;
  sufficientData: boolean;
  entries: Record<string, number>;
  edges: ConversionEdge[];
  medianMsInStage: Record<string, number>;
  lossReasons: LossReasonCount[];
}

interface Transition {
  leadId: string;
  from: string;
  to: string;
  at: Date;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Honest funnel analytics (S1): every number derives from the transition
 * history of leads that still exist. Deleted test leads — and their
 * hundreds of transition events — drop out through the live-lead join, so
 * test-actor noise can never inflate a rate. Leads are always created in
 * `new`; inbound skips and lost→new re-entries are ordinary transitions.
 */
export async function getConversions(): Promise<ConversionsReport> {
  const liveLeads = await db
    .select({
      id: leads.id,
      stage: leads.stage,
      lostReason: leads.lostReason,
      createdAt: leads.createdAt,
    })
    .from(leads);

  const liveIds = new Set(liveLeads.map((l) => l.id));
  const createdById = new Map(liveLeads.map((l) => [l.id, l.createdAt]));

  const rows = liveIds.size
    ? await db
        .select({
          entityId: events.entityId,
          before: events.before,
          after: events.after,
          createdAt: events.createdAt,
        })
        .from(events)
        .where(inArray(events.entityId, [...liveIds]))
        .orderBy(asc(events.createdAt), asc(events.id))
    : [];

  const transitions: Transition[] = [];
  for (const row of rows) {
    const before = row.before as { stage?: unknown } | null;
    const after = row.after as { stage?: unknown } | null;
    const from = typeof before?.stage === "string" ? before.stage : null;
    const to = typeof after?.stage === "string" ? after.stage : null;
    if (!from || !to || from === to) continue;
    transitions.push({ leadId: row.entityId, from, to, at: row.createdAt });
  }

  // Entries: transitions in, plus creations (every lead starts in `new`).
  const entries: Record<string, number> = {};
  for (const t of transitions) {
    entries[t.to] = (entries[t.to] ?? 0) + 1;
  }
  entries["new"] = (entries["new"] ?? 0) + liveLeads.length;

  const edgeCounts = new Map<string, number>();
  for (const t of transitions) {
    const key = `${t.from}→${t.to}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  const edges: ConversionEdge[] = [...edgeCounts.entries()].map(([key, count]) => {
    const [from, to] = key.split("→") as [string, string];
    return { from, to, count, rate: count / (entries[from] ?? 1) };
  });
  edges.sort((a, b) => b.count - a.count);

  // Closed durations per stage: entry → exit. The current (open) stage per
  // lead is censored out — only completed stays count toward the median.
  const durations: Record<string, number[]> = {};
  const byLead = new Map<string, Transition[]>();
  for (const t of transitions) {
    const list = byLead.get(t.leadId) ?? [];
    list.push(t);
    byLead.set(t.leadId, list);
  }
  for (const [leadId, list] of byLead) {
    let entryStage = "new";
    let entryAt = createdById.get(leadId);
    if (!entryAt) continue;
    for (const t of list) {
      if (t.from === entryStage) {
        const bucket = durations[entryStage] ?? [];
        bucket.push(t.at.getTime() - entryAt.getTime());
        durations[entryStage] = bucket;
      }
      entryStage = t.to;
      entryAt = t.at;
    }
  }
  const medianMsInStage: Record<string, number> = {};
  for (const [stage, values] of Object.entries(durations)) {
    const m = median(values);
    if (m !== null && m >= 0) medianMsInStage[stage] = Math.round(m);
  }

  const lossCounts = new Map<string, number>();
  for (const lead of liveLeads) {
    if (lead.stage === "lost" && lead.lostReason && lead.lostReason.trim()) {
      const reason = lead.lostReason.trim();
      lossCounts.set(reason, (lossCounts.get(reason) ?? 0) + 1);
    }
  }
  const lossReasons: LossReasonCount[] = [...lossCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    sampleSize: liveLeads.length,
    minSample: MIN_ANALYST_SAMPLE,
    sufficientData: liveLeads.length >= MIN_ANALYST_SAMPLE,
    entries,
    edges,
    medianMsInStage,
    lossReasons,
  };
}
