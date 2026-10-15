import { describe, expect, it, afterAll } from "vitest";
import { pool, db } from "../db/client";
import { ingestLead, changeLeadStage } from "../domain/leads";
import { leads, organizations, contacts } from "../db/schema";
import { eq } from "drizzle-orm";

describe("prospect quality: dedup guard", () => {
  const createdOrgNames = ["TEST-Dedup Corp", "TEST-Otra Empresa"];

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
});
