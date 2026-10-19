import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { pool, db } from "../db/client";
import { eq } from "drizzle-orm";
import { leads, organizations, contacts, outbox } from "../db/schema";
import { createOutreachDraft, reviewOutreachDraft } from "./outbox";

/**
 * Lead-addressed outreach drafts (S5): a first-touch message must be
 * queueable for a lead even before any contact is verified, and the
 * contact-less draft cannot be approved until a contact exists.
 */
const ACTOR = "test:outbox";

const ORG_NAME = "TEST-Outbox Lab";
const ORG_NAME_LINKED = "TEST-Outbox Linked";

let orgId: string;
let linkedOrgId: string;
let linkedContactId: string;
let linkedLeadId: string;
let bareLeadId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(organizations)
    .values({ name: ORG_NAME })
    .returning();
  orgId = org!.id;

  const [linkedOrg] = await db
    .insert(organizations)
    .values({ name: ORG_NAME_LINKED })
    .returning();
  linkedOrgId = linkedOrg!.id;

  const [contact] = await db
    .insert(contacts)
    .values({
      organizationId: linkedOrgId,
      name: "TEST Outbox Contacto",
      phone: "+52 322 000 1111",
      whatsappConsent: true,
    })
    .returning();
  linkedContactId = contact!.id;

  const [linkedLead] = await db
    .insert(leads)
    .values({
      organizationId: linkedOrgId,
      contactId: linkedContactId,
      source: "test",
      stage: "researched",
    })
    .returning();
  linkedLeadId = linkedLead!.id;

  const [bareLead] = await db
    .insert(leads)
    .values({ organizationId: orgId, source: "test", stage: "researched" })
    .returning();
  bareLeadId = bareLead!.id;
});

const cleanupDrafts = async () => {
  await db.delete(outbox).where(eq(outbox.leadId, bareLeadId));
  await db.delete(outbox).where(eq(outbox.leadId, linkedLeadId));
};

afterAll(async () => {
  await cleanupDrafts();
  await db.delete(leads).where(eq(leads.organizationId, orgId));
  await db.delete(leads).where(eq(leads.organizationId, linkedOrgId));
  await db.delete(contacts).where(eq(contacts.organizationId, linkedOrgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, linkedOrgId));
  await pool.end();
});

describe("createOutreachDraft (lead-only)", () => {
  it("creates a pending_approval draft for a lead without any contact", async () => {
    const result = await createOutreachDraft({
      leadId: bareLeadId,
      channel: "whatsapp",
      body: "Hola, vi su clínica y creo que podemos ayudarles con las citas.",
      rationale: "Primer contacto basado en el dossier.",
      actor: ACTOR,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.draft.status).toBe("pending_approval");
    expect(result.draft.leadId).toBe(bareLeadId);
    expect(result.draft.contactId).toBeNull();
    expect(result.contactResolution).toBe("missing");
  });

  it("resolves the lead's contact server-side when the lead has one", async () => {
    const result = await createOutreachDraft({
      leadId: linkedLeadId,
      channel: "whatsapp",
      body: "Hola Nancy, retomo el hilo de su agenda de citas.",
      actor: ACTOR,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.draft.contactId).toBe(linkedContactId);
    expect(result.contactResolution).toBe("lead");
  });

  it("still rejects drafts that target neither a lead nor an organization", async () => {
    const result = await createOutreachDraft({
      channel: "email",
      body: "Sin destino.",
      actor: ACTOR,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("target_required");
  });

  it("still rejects unknown explicit contacts instead of guessing", async () => {
    const result = await createOutreachDraft({
      leadId: bareLeadId,
      contactId: "00000000-0000-0000-0000-000000000000",
      channel: "email",
      body: "Contacto inexistente.",
      actor: ACTOR,
    });

    expect(result.success).toBe(false);
  });
});

describe("reviewOutreachDraft (contact gate)", () => {
  it("blocks approving a contact-less draft with contact_missing", async () => {
    const created = await createOutreachDraft({
      leadId: bareLeadId,
      channel: "whatsapp",
      body: "Borrador sin contacto.",
      actor: ACTOR,
    });
    if (!created.success) throw new Error("setup failed");

    const result = await reviewOutreachDraft({
      draftId: created.draft.id,
      decision: "approved",
      actor: "owner:test",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("contact_missing");

    const [fresh] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.id, created.draft.id))
      .limit(1);
    expect(fresh?.status).toBe("pending_approval");
  });

  it("allows approving once the draft has a contact", async () => {
    const created = await createOutreachDraft({
      leadId: linkedLeadId,
      channel: "whatsapp",
      body: "Borrador con contacto resuelto.",
      actor: ACTOR,
    });
    if (!created.success) throw new Error("setup failed");

    const result = await reviewOutreachDraft({
      draftId: created.draft.id,
      decision: "approved",
      actor: "owner:test",
    });

    expect(result.success).toBe(true);
  });

  it("still allows rejecting a contact-less draft", async () => {
    const created = await createOutreachDraft({
      leadId: bareLeadId,
      channel: "email",
      body: "Borrador rechoncho.",
      actor: ACTOR,
    });
    if (!created.success) throw new Error("setup failed");

    const result = await reviewOutreachDraft({
      draftId: created.draft.id,
      decision: "rejected",
      rejectedReason: "no aplica",
      actor: "owner:test",
    });

    expect(result.success).toBe(true);
  });
});
