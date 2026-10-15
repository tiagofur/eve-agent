import { describe, expect, it, afterAll } from "vitest";
import { pool, db } from "../db/client";
import { eq } from "drizzle-orm";
import { leads, organizations, contacts, dossiers } from "../db/schema";
import { ingestLead } from "./leads";
import { researchAndSaveProspect } from "./prospect-intake";
import type { DiscoveredContact } from "./contact-discovery";

/**
 * Full prospect-intake behavior: every research request must leave the CRM
 * with the COMPLETE record (dossier with the 4-key findings template,
 * researched stage), completing name-only partial leads instead of skipping.
 */
const ACTOR = "test:prospect-intake";

const noWebsite = async (): Promise<DiscoveredContact> => ({
  website: null,
  verifiedEmails: [],
  verifiedPhones: [],
  suggestedEmails: [],
  domainHasMx: false,
  pagesChecked: [],
  confidence: "none",
});

const withSite = async (): Promise<DiscoveredContact> => ({
  website: "testlab-prospect.com",
  verifiedEmails: ["info@testlab-prospect.com"],
  verifiedPhones: ["+52 322 123 4567"],
  suggestedEmails: [],
  domainHasMx: true,
  pagesChecked: [
    "https://testlab-prospect.com",
    "https://testlab-prospect.com/contacto",
  ],
  confidence: "page",
});

const COMPLETE_INPUT = {
  companyName: "TEST-Lab Prospecto Completo",
  summary:
    "Laboratorio clínico con diagnóstico ejecutivo completo de más de veinte caracteres.",
  pains: ["Agenda manual por teléfono", "Sin recordatorios automáticos"],
  techStack: ["WordPress", "WhatsApp manual"],
  proposedSolution:
    "Reservas online con recordatorios automáticos por WhatsApp.",
  outreachAngle:
    "Felicitar por su reputación y proponer una recepcionista digital 24/7.",
};

const cleanupOrg = async (name: string) => {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, name))
    .limit(1);
  if (org) {
    await db.delete(leads).where(eq(leads.organizationId, org.id));
    await db.delete(contacts).where(eq(contacts.organizationId, org.id));
    await db.delete(organizations).where(eq(organizations.id, org.id));
  }
};

describe("researchAndSaveProspect", () => {
  const orgNames = [
    "TEST-Lab Prospecto Completo",
    "TEST-Negocio Sin Web",
    "TEST-Parcial SA",
  ];

  afterAll(async () => {
    for (const name of orgNames) {
      await cleanupOrg(name);
    }
    await pool.end();
  });

  it("creates a complete prospect: full findings template, real sources, researched stage", async () => {
    const result = await researchAndSaveProspect(COMPLETE_INPUT, {
      actor: ACTOR,
      discover: withSite,
    });

    expect(result.outcome).toBe("created");
    expect(result.contact).toBe("info@testlab-prospect.com");
    expect(result.contactConfidence).toBe("page");
    expect(result.stage).toBe("researched");
    expect(result.dossierId).toBeTruthy();

    const [dossier] = await db
      .select()
      .from(dossiers)
      .where(eq(dossiers.id, result.dossierId!));
    expect(dossier).toBeTruthy();

    const findings = dossier!.findings as Record<string, unknown>;
    expect(findings.pains).toEqual(COMPLETE_INPUT.pains);
    expect(findings.techStack).toEqual(COMPLETE_INPUT.techStack);
    expect(findings.solution).toBe(COMPLETE_INPUT.proposedSolution);
    expect(findings.outreachAngle).toBe(COMPLETE_INPUT.outreachAngle);

    const urls = (dossier!.sources as Array<{ url: string }>).map((s) => s.url);
    expect(urls).toContain("https://testlab-prospect.com");
    expect(urls).toContain("https://testlab-prospect.com/contacto");

    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, result.leadId));
    expect(lead?.stage).toBe("researched");
    expect(lead?.summary).toBe(COMPLETE_INPUT.summary);
  });

  it("saves the prospect without inventing a contact when nothing is published", async () => {
    const result = await researchAndSaveProspect(
      {
        ...COMPLETE_INPUT,
        companyName: "TEST-Negocio Sin Web",
      },
      { actor: ACTOR, discover: noWebsite }
    );

    expect(result.outcome).toBe("created");
    expect(result.contact).toBeNull();
    expect(result.contactConfidence).toBe("none");
    expect(result.stage).toBe("researched");
    expect(result.message).toContain("SIN contacto verificado");
  });

  it("completes a name-only partial lead instead of skipping it", async () => {
    const partial = await ingestLead({
      clientName: "TEST-Parcial SA",
      companyName: "TEST-Parcial SA",
      projectSummary: "",
      source: "orchestrator_chat",
      actor: ACTOR,
    });
    expect(partial.duplicate).toBe(false);
    expect(partial.lead.summary ?? "").toBe("");

    const result = await researchAndSaveProspect(
      {
        ...COMPLETE_INPUT,
        companyName: "TEST-Parcial SA",
      },
      { actor: ACTOR, discover: noWebsite }
    );

    expect(result.outcome).toBe("completed_partial");
    expect(result.leadId).toBe(partial.lead.id);

    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, partial.lead.id));
    expect(lead?.stage).toBe("researched");
    expect(lead?.summary).toBe(COMPLETE_INPUT.summary);

    const orgLeads = await db
      .select()
      .from(leads)
      .where(eq(leads.organizationId, partial.lead.organizationId!));
    expect(orgLeads).toHaveLength(1);

    const orgDossiers = await db
      .select()
      .from(dossiers)
      .where(eq(dossiers.leadId, partial.lead.id));
    expect(orgDossiers).toHaveLength(1);
  });

  it("does not duplicate the dossier when the prospect is already complete", async () => {
    const second = await researchAndSaveProspect(
      { ...COMPLETE_INPUT, companyName: "TEST-Parcial SA" },
      { actor: ACTOR, discover: noWebsite }
    );

    expect(second.outcome).toBe("already_complete");

    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, second.leadId));
    const orgDossiers = await db
      .select()
      .from(dossiers)
      .where(eq(dossiers.organizationId, lead!.organizationId!));
    expect(orgDossiers).toHaveLength(1);
  });

  it("throws before writing anything when required fields are missing", async () => {
    await expect(
      researchAndSaveProspect(
        { companyName: "TEST-Parcial SA" },
        { actor: ACTOR, discover: noWebsite }
      )
    ).rejects.toThrow(/nombres EXACTOS/);

    const orgLeads = await db
      .select({ id: leads.id })
      .from(leads)
      .innerJoin(organizations, eq(leads.organizationId, organizations.id))
      .where(eq(organizations.name, "TEST-Parcial SA"));
    expect(orgLeads).toHaveLength(1); // still only the partial lead
  });
});
