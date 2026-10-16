import { describe, expect, it, afterAll } from "vitest";
import { pool, db } from "../db/client";
import { ingestLead, changeLeadStage } from "../domain/leads";
import { createDossier } from "../domain/dossiers";
import { leads, organizations, contacts } from "../db/schema";
import { eq } from "drizzle-orm";

describe("prospect quality: dedup guard", () => {
  const createdOrgNames = ["TEST-Dedup Corp", "TEST-Otra Empresa", "TEST-AutoLead Corp", "TEST-AutoLead Dos"];

  afterAll(async () => {
    for (const name of createdOrgNames) {
      const [org] = await db.select().from(organizations).where(eq(organizations.name, name)).limit(1);
      if (org) {
        await db.delete(leads).where(eq(leads.organizationId, org.id));
        await db.delete(contacts).where(eq(contacts.organizationId, org.id));
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
    }
    await pool.end();
  });

  it("second ingest of the same business returns duplicate without creating a lead", async () => {
    const first = await ingestLead({
      clientName: "TEST-Dedup Corp",
      companyName: "TEST-Dedup Corp",
      contact: "hola@test-dedup.com",
      serviceType: "automation",
      projectSummary: "Necesita automatizar reservas con un diagnóstico ejecutivo completo del negocio.",
      source: "orchestrator_chat",
      actor: "test:dedup",
    });
    expect(first.duplicate ?? false).toBe(false);

    const second = await ingestLead({
      clientName: "TEST-Dedup Corp",
      companyName: "TEST-Dedup Corp",
      contact: "hola@test-dedup.com",
      serviceType: "automation",
      projectSummary: "Segundo intento con otro resumen distinto pero el mismo negocio ya prospectado.",
      source: "orchestrator_chat",
      actor: "test:dedup",
    });
    expect(second.duplicate).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);

    const rows = await db.select().from(leads).where(eq(leads.organizationId, first.lead.organizationId!));
    expect(rows.length).toBe(1);
  });

  it("dedups by organization even when contact is unknown", async () => {
    const first = await ingestLead({
      clientName: "TEST-Otra Empresa",
      companyName: "TEST-Otra Empresa",
      serviceType: "automation",
      projectSummary: "Primer registro sin contacto conocido para esta empresa de prueba.",
      source: "orchestrator_chat",
      actor: "test:dedup",
    });
    expect(first.duplicate ?? false).toBe(false);

    const second = await ingestLead({
      clientName: "TEST-Otra Empresa",
      companyName: "TEST-Otra Empresa",
      serviceType: "automation",
      projectSummary: "Segundo registro sin contacto para la misma empresa de prueba.",
      source: "orchestrator_chat",
      actor: "test:dedup",
    });
    expect(second.duplicate).toBe(true);
    expect(second.lead.id).toBe(first.lead.id);
  });

  it("moves a researched lead to the researched stage", async () => {
    const created = await ingestLead({
      clientName: "TEST-Dedup Corp",
      companyName: "TEST-Dedup Corp",
      contact: "etapa@test-dedup.com",
      serviceType: "automation",
      projectSummary: "Lead para verificar la transición de etapa a researched con dossier.",
      source: "orchestrator_chat",
      actor: "test:dedup",
    });
    // Same org already has an open lead from the first test: dedup returns it.
    const targetId = created.lead.id;
    const moved = await changeLeadStage({
      leadId: targetId,
      targetStage: "researched",
      reason: "dossier verificado",
      actor: "test:dedup",
    });
    expect(moved).toMatchObject({ success: true });
  });

  it("createDossier without leadId auto-creates an honest contact-less lead and links it", async () => {
    const dossier = await createDossier({
      companyName: "TEST-AutoLead Corp",
      summary: "Diagnóstico ejecutivo de prueba para auto-lead honesto.",
      findings: { pains: ["Sin reservas online"] },
      sources: [{ url: "https://example.com", retrievedAt: new Date().toISOString() }],
      actor: "test:autolead",
    });
    expect(dossier.leadId).toBeTruthy();

    const [lead] = await db.select().from(leads).where(eq(leads.id, dossier.leadId!));
    expect(lead?.stage).toBe("researched");
    expect(lead?.organizationId).toBe(dossier.organizationId);
    expect(lead?.source).toBe("prospector_agent");
    // Honest no-contact: no invented email/phone, whether or not a
    // name-only contact row exists.
    if (lead?.contactId) {
      const [contact] = await db.select().from(contacts).where(eq(contacts.id, lead.contactId));
      expect(contact?.email ?? null).toBeNull();
      expect(contact?.phone ?? null).toBeNull();
    }
  });

  it("createDossier reuses the open lead instead of duplicating it", async () => {
    const first = await createDossier({
      companyName: "TEST-AutoLead Dos",
      summary: "Primer dossier para probar dedup de auto-lead.",
      findings: {},
      sources: [{ url: "https://example.com/uno", retrievedAt: new Date().toISOString() }],
      actor: "test:autolead",
    });
    const second = await createDossier({
      companyName: "TEST-AutoLead Dos",
      summary: "Segundo dossier para la misma empresa.",
      findings: {},
      sources: [{ url: "https://example.com/dos", retrievedAt: new Date().toISOString() }],
      actor: "test:autolead",
    });
    expect(second.leadId).toBe(first.leadId);
    const orgLeads = await db.select().from(leads).where(eq(leads.organizationId, first.organizationId!));
    expect(orgLeads).toHaveLength(1);
  });
});
