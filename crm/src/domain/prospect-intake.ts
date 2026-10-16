/**
 * Complete prospect intake for the orchestrator chat: one research request
 * must always leave the CRM with the FULL record (lead + dossier with the
 * complete findings template + `researched` stage), never a name-only row.
 *
 * Guarantees:
 *   - Input is normalized/validated BEFORE any DB write; invalid input throws
 *     so the orchestrator model can retry with the exact field names.
 *   - A name-only partial lead from a previous attempt is COMPLETED (dossier
 *     created, summary backfilled) instead of being skipped as "duplicate".
 *   - Contact discovery never fabricates data: no verified contact means the
 *     lead is saved without one for manual completion.
 *   - Pages actually fetched during discovery are persisted as dossier
 *     sources, so dossiers carry real, verifiable URLs.
 *   - A failure between lead creation and dossier creation rolls back the
 *     lead it just created (pre-existing partial leads are never deleted).
 */
import { desc, eq, or } from "drizzle-orm";
import { db } from "../db/client";
import { dossiers, leads } from "../db/schema";
import { ingestLead } from "./leads";
import { createDossier } from "./dossiers";
import { discoverContact, type DiscoveredContact } from "./contact-discovery";
import { normalizeResearchInput, type NormalizedResearchInput } from "./research-input";

export type ProspectOutcome = "created" | "completed_partial" | "already_complete";

export interface ResearchAndSaveResult {
  ok: true;
  outcome: ProspectOutcome;
  leadId: string;
  organizationId: string | null;
  dossierId: string | null;
  stage: string;
  contact: string | null;
  contactConfidence: "given" | "page" | "domain" | "none";
  suggestedEmails: string[];
  website: string | null;
  sourcesCount: number;
  hasOptOut: boolean;
  message: string;
}

export interface ResearchAndSaveOptions {
  actor: string;
  /** Lead source tag. Defaults to "orchestrator_chat". */
  source?: string;
  /** Injectable discovery for tests. Defaults to the real website discovery. */
  discover?: (input: {
    companyName: string;
    domain?: string;
  }) => Promise<DiscoveredContact>;
}

interface ResolvedResearch {
  research: NormalizedResearchInput;
  email?: string;
  phone?: string;
  website: string | null;
  contactConfidence: "given" | "page" | "domain" | "none";
  suggestedEmails: string[];
  discoveryPages: string[];
}

async function resolveContact(
  research: NormalizedResearchInput,
  discover: ResearchAndSaveOptions["discover"]
): Promise<ResolvedResearch> {
  let email = research.contactEmail;
  let phone = research.contactPhone;
  let website: string | null = research.domain ?? null;
  let contactConfidence: ResolvedResearch["contactConfidence"] =
    email || phone ? "given" : "none";
  let suggestedEmails: string[] = [];
  let discoveryPages: string[] = [];

  if (!email && !phone) {
    const discovery = await (discover ?? discoverContact)({
      companyName: research.companyName,
      domain: research.domain,
    });
    email = discovery.verifiedEmails[0];
    phone = discovery.verifiedPhones[0];
    if (discovery.website) website = discovery.website;
    suggestedEmails = discovery.suggestedEmails;
    contactConfidence = discovery.confidence;
    discoveryPages = discovery.pagesChecked;
  }

  return {
    research,
    email,
    phone,
    website,
    contactConfidence,
    suggestedEmails,
    discoveryPages,
  };
}

function buildSources(resolved: ResolvedResearch): Array<{
  url: string;
  retrievedAt: string;
  note?: string;
}> {
  const retrievedAt = new Date().toISOString();
  const byUrl = new Map<string, { url: string; retrievedAt: string; note?: string }>();

  for (const source of resolved.research.sources) {
    byUrl.set(source.url, { url: source.url, retrievedAt, note: source.note });
  }
  for (const page of resolved.discoveryPages) {
    if (!byUrl.has(page)) {
      byUrl.set(page, {
        url: page,
        retrievedAt,
        note: "Página del negocio verificada durante el descubrimiento de contactos",
      });
    }
  }

  return [...byUrl.values()];
}

async function findExistingDossier(
  leadId: string,
  organizationId: string | null
): Promise<string | null> {
  const rows = await db
    .select({ id: dossiers.id })
    .from(dossiers)
    .where(
      organizationId
        ? or(eq(dossiers.leadId, leadId), eq(dossiers.organizationId, organizationId))
        : eq(dossiers.leadId, leadId)
    )
    .orderBy(desc(dossiers.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function researchAndSaveProspect(
  rawInput: unknown,
  options: ResearchAndSaveOptions
): Promise<ResearchAndSaveResult> {
  // 1. Validate FIRST: nothing is written to the DB until input is good.
  const normalized = normalizeResearchInput(rawInput);
  if (!normalized.ok) throw new Error(normalized.error);

  const resolved = await resolveContact(normalized.value, options.discover);
  const { research } = resolved;
  const sources = buildSources(resolved);

  // 2. Ingest the lead (dedup guard returns an existing open lead).
  const ingested = await ingestLead({
    clientName: research.companyName,
    companyName: research.companyName,
    contact: resolved.email ?? resolved.phone,
    serviceType: "automation",
    projectSummary: research.summary,
    source: options.source ?? "orchestrator_chat",
    actor: options.actor,
  });

  const leadId = ingested.lead.id;
  const organizationId = ingested.lead.organizationId ?? null;

  // 3. Already fully prospected? Never stack a second dossier.
  if (ingested.duplicate) {
    const existingDossierId = await findExistingDossier(leadId, organizationId);
    if (existingDossierId) {
      return {
        ok: true,
        outcome: "already_complete",
        leadId,
        organizationId,
        dossierId: existingDossierId,
        stage: ingested.lead.stage,
        contact: resolved.email ?? resolved.phone ?? null,
        contactConfidence: resolved.contactConfidence,
        suggestedEmails: resolved.suggestedEmails,
        website: resolved.website,
        sourcesCount: sources.length,
        hasOptOut: ingested.hasOptOut,
        message: `Este negocio ya estaba prospectado con dossier (etapa ${ingested.lead.stage}). No se creó un duplicado.`,
      };
    }
  }

  // 4. Name-only partial lead: backfill what the first attempt left empty.
  if (ingested.duplicate) {
    const backfill: Partial<{ summary: string; serviceType: "automation" }> = {};
    if (!ingested.lead.summary || ingested.lead.summary.trim() === "") {
      backfill.summary = research.summary;
    }
    if (!ingested.lead.serviceType) {
      backfill.serviceType = "automation";
    }
    if (Object.keys(backfill).length > 0) {
      await db.update(leads).set(backfill).where(eq(leads.id, leadId));
    }
  }

  // 5. Persist the complete dossier. createDossier moves `new` leads to
  //    `researched`. On failure, roll back ONLY the lead created this turn.
  let dossier;
  try {
    dossier = await createDossier({
      leadId,
      organizationId: organizationId ?? undefined,
      companyName: research.companyName,
      domain: resolved.website ?? undefined,
      summary: research.summary,
      findings: {
        pains: research.pains,
        techStack: research.techStack,
        solution: research.proposedSolution,
        outreachAngle: research.outreachAngle,
      },
      sources,
      actor: options.actor,
    });
  } catch (err) {
    if (!ingested.duplicate) {
      await db.delete(leads).where(eq(leads.id, leadId));
    }
    throw new Error(
      `No se pudo guardar el dossier${ingested.duplicate ? "" : " y se descartó el lead parcial"}. Causa: ${
        err instanceof Error ? err.message : String(err)
      }. Reintenta con datos completos.`
    );
  }

  // 6. Report the persisted stage (never assume the transition happened).
  const [freshLead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  const stage = freshLead?.stage ?? ingested.lead.stage;
  const contact = resolved.email ?? resolved.phone ?? null;

  const contactPart =
    contact || resolved.contactConfidence === "page" || resolved.contactConfidence === "domain"
      ? `Prospecto con contacto verificado (confianza: ${resolved.contactConfidence}).`
      : "Prospecto registrado SIN contacto verificado: completar manualmente antes de hacer outreach.";

  const outcomePart =
    ingested.duplicate
      ? "Registro previo a medias completado con dossier completo."
      : "Prospecto registrado con dossier completo.";

  return {
    ok: true,
    outcome: ingested.duplicate ? "completed_partial" : "created",
    leadId,
    organizationId,
    dossierId: dossier.id,
    stage,
    contact,
    contactConfidence: resolved.contactConfidence,
    suggestedEmails: resolved.suggestedEmails,
    website: resolved.website,
    sourcesCount: sources.length,
    hasOptOut: ingested.hasOptOut,
    message: `${outcomePart} ${contactPart} Etapa: ${stage}. Fuentes guardadas: ${sources.length}.`,
  };
}
