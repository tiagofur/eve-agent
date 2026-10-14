import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { dossiers, organizations, leads } from "../db/schema";
import { changeLeadStage } from "./leads";
import { logEvent } from "./events";

export interface CreateDossierInput {
  leadId?: string;
  organizationId?: string;
  companyName?: string;
  domain?: string;
  googlePlaceId?: string;
  summary: string;
  findings: Record<string, unknown>;
  sources: Array<{ url: string; retrievedAt: string; note?: string }>;
  actor: string;
}

export async function createDossier(input: CreateDossierInput) {
  let orgId = input.organizationId;

  // 1. Resolve or create organization
  if (!orgId && input.companyName) {
    const cleanName = input.companyName.trim();
    const [existingOrg] = await db
      .select()
      .from(organizations)
      .where(sql`LOWER(${organizations.name}) = LOWER(${cleanName})`)
      .limit(1);

    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      const [newOrg] = await db
        .insert(organizations)
        .values({
          name: cleanName,
          domain: input.domain,
          googlePlaceId: input.googlePlaceId,
        })
        .returning();
      if (newOrg) {
        orgId = newOrg.id;
        await logEvent({
          entity: "organization",
          entityId: newOrg.id,
          action: "created",
          actor: input.actor,
          after: { name: newOrg.name, domain: input.domain },
        });
      }
    }
  }

  if (!orgId) {
    throw new Error("Cannot create dossier: Either organizationId or companyName is required");
  }

  // 2. Insert dossier
  const [dossier] = await db
    .insert(dossiers)
    .values({
      organizationId: orgId,
      leadId: input.leadId,
      summary: input.summary,
      findings: input.findings,
      sources: input.sources,
      createdBy: input.actor,
    })
    .returning();

  if (!dossier) {
    throw new Error("Failed to insert dossier");
  }

  // 3. If tied to a lead in 'new' stage, progress it to 'researched'
  if (input.leadId) {
    const [lead] = await db.select().from(leads).where(eq(leads.id, input.leadId)).limit(1);
    if (lead && lead.stage === "new") {
      await changeLeadStage({
        leadId: input.leadId,
        targetStage: "researched",
        reason: "Detailed business dossier created by prospector",
        actor: input.actor,
      });
    }
  }

  await logEvent({
    entity: "dossier",
    entityId: dossier.id,
    action: "dossier_created",
    actor: input.actor,
    after: {
      organizationId: orgId,
      leadId: input.leadId,
      sourcesCount: input.sources.length,
    },
    reason: input.summary,
  });

  return dossier;
}
