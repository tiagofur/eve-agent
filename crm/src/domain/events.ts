import { db } from "../db/client";
import { events } from "../db/schema";

export interface LogEventParams {
  entity: string;
  entityId: string;
  action: string;
  actor: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function logEvent(params: LogEventParams): Promise<void> {
  await db.insert(events).values({
    entity: params.entity,
    entityId: params.entityId,
    action: params.action,
    actor: params.actor,
    before: params.before ?? null,
    after: params.after ?? null,
    reason: params.reason ?? null,
  });
}
