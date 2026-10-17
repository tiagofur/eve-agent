import { describe, expect, it, afterAll } from "vitest";
import { pool, db } from "../db/client";
import { eq } from "drizzle-orm";
import { leads, organizations, contacts, dossiers } from "../db/schema";
import { createDossier } from "./dossiers";
import { ingestLead } from "./leads";

/**
 * Contact linking in the dossier path (S7): when research verifies a
 * contact, the pipeline lead must carry it — at creation time when the
 * dossier brings contact data, and by backfill when a later ingest
 * resolves a contact the existing lead still lacks.
 */
const ACTOR = "test:dossiers";

const ORG_A = "TEST-Dossier Contacto Nuevo";
const ORG_B = "TEST-Dossier Backfill";
const ORG_C = "TEST-Dossier Ingest Backfill";

const cleanupOrg = async (name: string) => {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, name))
    .limit(1);
  if (org) {
    await db.delete(leads).where(eq(leads.organizationId, org.id));
    await db.delete(dossiers).where(eq(dossiers.organizationId, org.id));
    await db.delete(contacts).where(eq(contacts.organizationId, org.id));
    await db.delete(organizations).where(eq(organizations.id, org.id));
  }
};

const SOURCES = [
  { url: "https://test-dossier.example.com", retrievedAt: "2026-10-17T00:00:00.000Z" },
];

afterAll(async () => {
  await cleanupOrg(ORG_A);
  await cleanupOrg(ORG_B);
  await cleanupOrg(ORG_C);
  await pool.end();
});

describe("createDossier contact linking", () => {
  it("auto-creates the lead WITH the verified contact linked", async () => {
    const dossier = await createDossier({
      companyName: ORG_A,
      domain: "test-dossier.example.com",
      summary: "Negocio local con citas manuales por WhatsApp y sin reserva online.",
      findings: { pains: ["Agenda manual"], techStack: ["WhatsApp manual"] },
      sources: SOURCES,
      contact: { name: "TEST Dossier Decisora", phone: "+52 322 999 8888" },
      actor: ACTOR,
    });

    expect(dossier.leadId).toBeTruthy();

    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, dossier.leadId!))
      .limit(1);
    expect(lead?.contactId).toBeTruthy();

    const [contact] = lead?.contactId
      ? await db.select().from(contacts).where(eq(contacts.id, lead.contactId)).limit(1)
      : [];
    expect(contact?.phone).toBe("+52 322 999 8888");
    expect(contact?.name).toBe("TEST Dossier Decisora");
  });

  it("links the contact onto an existing contact-less lead", async () => {
    const [org] = await db
      .insert(organizations)
      .values({ name: ORG_B })
      .returning();
    const [bareLead] = await db
      .insert(leads)
      .values({ organizationId: org!.id, source: "test", stage: "researched" })
      .returning();

    const dossier = await createDossier({
      leadId: bareLead!.id,
      organizationId: org!.id,
      companyName: ORG_B,
      summary: "Segunda pasada sobre un lead ya registrado sin contacto.",
      findings: { pains: ["Sin CRM"], techStack: ["Manual Phone"] },
      sources: SOURCES,
      contact: { email: "decisora@test-dossier-backfill.example.com" },
      actor: ACTOR,
    });

    expect(dossier.leadId).toBe(bareLead!.id);

    const [lead] = await db
      .select()
      .from(leads)
      .where(eq(leads.id, bareLead!.id))
      .limit(1);
    expect(lead?.contactId).toBeTruthy();
  });
});

describe("ingestLead duplicate backfill", () => {
  it("backfills the newly resolved contact onto the existing open lead", async () => {
    // First ingest: contact-less (how the dossier path used to create leads).
    const first = await ingestLead({
      clientName: ORG_C,
      companyName: ORG_C,
      projectSummary: "Primer registro sin contacto verificado.",
      source: "test",
      actor: ACTOR,
    });
    const leadId = first.lead.id;

    // Second ingest after discovery verified a phone: same business, so the
    // duplicate guard must return the SAME lead — now with the contact.
    const second = await ingestLead({
      clientName: "TEST Dossier Ingest Contacto",
      companyName: ORG_C,
      contact: "+52 322 777 6666",
      projectSummary: "Contacto verificado en la web del negocio.",
      source: "test",
      actor: ACTOR,
    });

    expect(second.lead.id).toBe(leadId);
    expect(second.duplicate).toBe(true);

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    expect(lead?.contactId).toBeTruthy();

    const [contact] = lead?.contactId
      ? await db.select().from(contacts).where(eq(contacts.id, lead.contactId)).limit(1)
      : [];
    expect(contact?.phone).toBe("+52 322 777 6666");
  });
});
