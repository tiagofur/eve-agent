import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { dossiers, organizations, leads } from "../db/schema";
import { changeLeadStage, ingestLead, resolveOrCreateContact } from "./leads";
import { logEvent } from "./events";

export interface DossierContactInput {
  /** Person name when research identified a decision maker. */
  name?: string;
  /** Verified email published by the business. Never guessed. */
  email?: string;
  /** Verified phone/WhatsApp published by the business. Never guessed. */
  phone?: string;
}

/**
 * Normalize dossier findings to the canonical template (S-spec): subagents
 * write variant keys (pain_points, tech_stack, key_contacts…); the stored
 * dossier always carries the canonical ones. Aliases merge losslessly
 * (lists union, scalars prefer canonical); unknown keys are preserved
 * untouched — never dropped, never invented into.
 */
export function normalizeDossierFindings(
  findings: Record<string, unknown>
): Record<string, unknown> {
  const pick = (...names: string[]): unknown => {
    for (const name of names) {
      const value = findings[name];
      if (Array.isArray(value)) return value;
      if (typeof value === "string" && value.trim()) return value;
      if (value && typeof value === "object") return value;
    }
    return undefined;
  };

  const toList = (value: unknown): string[] => {
    const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n+/) : [];
    return items
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  };

  const unionLists = (...names: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of names) {
      for (const item of toList(findings[name])) {
        if (!seen.has(item)) {
          seen.add(item);
          out.push(item);
        }
      }
    }
    return out;
  };

  const str = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = findings[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };

  const normalized: Record<string, unknown> = { ...findings };

  const pains = unionLists("pains", "pain_points", "painpoints", "operational_pains", "operationalPains", "dolores");
  if (pains.length > 0) {
    normalized["pains"] = pains;
    for (const alias of ["pain_points", "painpoints", "operational_pains", "operationalPains", "dolores"]) {
      delete normalized[alias];
    }
  }

  const techStack = unionLists("techStack", "tech_stack", "techstack", "stack", "tools", "tecnologias");
  if (techStack.length > 0) {
    normalized["techStack"] = techStack;
    for (const alias of ["tech_stack", "techstack", "stack", "tools", "tecnologias"]) {
      delete normalized[alias];
    }
  }

  const solution = str("solution", "proposedSolution", "proposed_solution", "opportunity", "solucion", "propuesta");
  if (solution) normalized["solution"] = solution;

  const outreachAngle = str("outreachAngle", "outreach_angle", "angle", "outreach", "angulo", "apertura");
  if (outreachAngle) normalized["outreachAngle"] = outreachAngle;

  const keyContacts = pick("keyContacts", "key_contacts");
  if (keyContacts !== undefined) {
    normalized["keyContacts"] = keyContacts;
    delete normalized["key_contacts"];
  }

  return normalized;
}

export interface CreateDossierInput {
  leadId?: string;
  organizationId?: string;
  companyName?: string;
  domain?: string;
  googlePlaceId?: string;
  summary: string;
  findings: Record<string, unknown>;
  sources: Array<{ url: string; retrievedAt: string; note?: string }>;
  /** Verified contact discovered during research (S7): linked to the lead. */
  contact?: DossierContactInput;
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

  // 1b. Ensure a pipeline lead: when the caller didn't tie one, ingest it
  // honestly (possibly contact-less) so every dossier lands in the pipeline.
  // ingestLead dedups against open leads, so re-runs reuse instead of duplicating.
  let leadId = input.leadId;
  let autoCreatedLeadId: string | null = null;
  if (!leadId) {
    let companyName = input.companyName;
    if (!companyName && orgId) {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      companyName = org?.name;
    }
    if (!companyName) {
      throw new Error("Cannot create dossier: organization not found and no companyName provided");
    }
    const ingested = await ingestLead({
      clientName: input.contact?.name?.trim() || companyName,
      companyName,
      contact: input.contact?.email ?? input.contact?.phone,
      projectSummary: input.summary,
      source: "prospector_agent",
      actor: input.actor,
    });
    leadId = ingested.lead.id;
    if (!ingested.duplicate) autoCreatedLeadId = ingested.lead.id;
  }

  // 1c. Caller-provided lead: link a verified research contact the lead
  // still lacks (S7) — never overwrite an existing contact.
  if (input.contact && (input.contact.email || input.contact.phone)) {
    const [lead] = leadId
      ? await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)
      : [];
    if (lead && !lead.contactId) {
      const { contactId } = await resolveOrCreateContact({
        orgId,
        clientName: input.contact.name?.trim() || input.companyName || "Contacto verificado",
        email: input.contact.email?.toLowerCase(),
        phone: input.contact.phone,
        actor: input.actor,
      });
      if (contactId) {
        await db
          .update(leads)
          .set({ contactId, updatedAt: new Date() })
          .where(eq(leads.id, lead.id));
        await logEvent({
          entity: "lead",
          entityId: lead.id,
          action: "contact_linked",
          actor: input.actor,
          before: { contactId: null },
          after: { contactId },
          reason: "Verified contact from dossier research",
        });
      }
    }
  }

  // 2. Insert dossier (rolls back a self-created lead when the insert fails)
  // Findings are normalized to the canonical template: variant keys from
  // subagents merge losslessly, unknown keys pass through untouched.
  let dossier: typeof dossiers.$inferSelect | undefined;
  try {
    [dossier] = await db
      .insert(dossiers)
      .values({
        organizationId: orgId,
        leadId,
        summary: input.summary,
        findings: normalizeDossierFindings(input.findings),
        sources: input.sources,
        createdBy: input.actor,
      })
      .returning();
    if (!dossier) throw new Error("Failed to insert dossier");
  } catch (err) {
    if (autoCreatedLeadId) {
      await db.delete(leads).where(eq(leads.id, autoCreatedLeadId));
    }
    throw err;
  }

  // 3. If tied to a lead in 'new' stage (caller-provided or auto-created
  // above), progress it to 'researched'.
  if (leadId) {
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (lead && lead.stage === "new") {
      await changeLeadStage({
        leadId,
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
      leadId,
      sourcesCount: input.sources.length,
    },
    reason: input.summary,
  });

  return dossier;
}
