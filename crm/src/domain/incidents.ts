import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { tickets } from "../db/schema";
import { computeSlaDueAt } from "./tickets";
import { logEvent } from "./events";
import { escapeHtml, sendTelegramMessage } from "../services/telegram";

/**
 * Infrastructure incidents (own CI, uptime monitors) as machine-created
 * tickets. Different lifecycle from client support: no client contact (the
 * follow-up channel is the owner's Telegram), mechanical dedup by
 * `metadata.incidentKey`, and "up" pings auto-resolve the open incident.
 */

const ACTOR = "system:incident-webhook";

export type IncidentSource = "github_ci" | "uptime" | "manual";

export interface IncidentInput {
  source: IncidentSource;
  /** Idempotency key: run id, check id — retries never stack tickets. */
  key: string;
  title: string;
  description?: string | null;
  url?: string | null;
  severity?: "critical" | "major" | "minor";
}

export type IncidentResult =
  | { status: "ticket_created"; ticketId: string }
  | { status: "duplicate"; ticketId: string }
  | { status: "resolved"; ticketIds: string[] };

async function openIncidentByKey(source: string, key: string) {
  const [row] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        sql`${tickets.metadata}->>'incidentSource' = ${source}`,
        sql`${tickets.metadata}->>'incidentKey' = ${key}`,
        notInArray(tickets.status, ["resolved", "closed"])
      )
    )
    .limit(1);
  return row?.id ?? null;
}

export async function reportIncident(input: IncidentInput): Promise<IncidentResult> {
  const key = input.key.trim();
  const source = input.source;
  if (!key) throw new Error("Incident key is required");

  const existing = await openIncidentByKey(source, key);
  if (existing) return { status: "duplicate", ticketId: existing };

  const severity = input.severity ?? (source === "uptime" ? "major" : "minor");
  const kind = "support" as const;
  const detail = [
    input.title,
    input.description || null,
    input.url ? `Detalle: ${input.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const [row] = await db
    .insert(tickets)
    .values({
      system: source,
      kind,
      severity,
      status: "open",
      description: detail.slice(0, 8000),
      slaDueAt: computeSlaDueAt(severity, kind),
      metadata: { incidentSource: source, incidentKey: key },
    })
    .returning();

  await logEvent({
    entity: "ticket",
    entityId: row!.id,
    action: "incident_ticket_created",
    actor: ACTOR,
    after: { source, key, severity, url: input.url ?? null },
    reason: input.title.slice(0, 200),
  });

  notify(
    `🚨 <b>Incidente: ${escapeHtml(input.title)}</b>\n` +
      `<b>Origen:</b> ${escapeHtml(source)} · severidad ${escapeHtml(severity)}\n` +
      (input.url ? `<a href="${escapeHtml(input.url)}">ver detalle</a>\n` : "") +
      `\n<i>Abierto ticket ${row!.id} (SLA ${escapeHtml(computeSlaDueAt(severity, kind).toISOString())}).</i>`
  );

  return { status: "ticket_created", ticketId: row!.id };
}

/** An "up" ping closes every open incident ticket for that key. */
export async function resolveIncident(source: IncidentSource, key: string): Promise<IncidentResult> {
  const open = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        sql`${tickets.metadata}->>'incidentSource' = ${source}`,
        sql`${tickets.metadata}->>'incidentKey' = ${key}`,
        inArray(tickets.status, ["open", "in_progress", "waiting_client"])
      )
    );
  if (open.length === 0) return { status: "resolved", ticketIds: [] };

  const ids = open.map((r) => r.id);
  await db
    .update(tickets)
    .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
    .where(inArray(tickets.id, ids));

  await logEvent({
    entity: "ticket",
    entityId: ids[0]!,
    action: "incident_tickets_auto_resolved",
    actor: ACTOR,
    after: { source, key, ticketIds: ids },
  });
  notify(`✅ Recuperado: <b>${escapeHtml(source)}</b> incidente <code>${escapeHtml(key)}</code> — ${ids.length} ticket(s) resueltos automáticamente.`);
  return { status: "resolved", ticketIds: ids };
}

async function notify(html: string): Promise<void> {
  try {
    await sendTelegramMessage(html);
  } catch (err) {
    console.error("[Incidents] telegram notification failed:", err);
  }
}
