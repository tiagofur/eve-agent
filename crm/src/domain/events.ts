import { db } from "../db/client";
import { events } from "../db/schema";

/** A drizzle transaction handle, so callers can share one transaction. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LogEventParams {
  entity: string;
  entityId: string;
  action: string;
  actor: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  /** Write the audit row on this transaction instead of its own connection. */
  tx?: DbTx;
}

export async function logEvent(params: LogEventParams): Promise<void> {
  await (params.tx ?? db).insert(events).values({
    entity: params.entity,
    entityId: params.entityId,
    action: params.action,
    actor: params.actor,
    before: params.before ?? null,
    after: params.after ?? null,
    reason: params.reason ?? null,
  });
}
