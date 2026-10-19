import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, leads, organizations, outbox } from "./db/schema";
import { eq, inArray } from "drizzle-orm";

describe("T6 outbox para clientes existentes", () => {
  const opsKey = "cp_ops_t6testkey1234567890abcdef12";
  let orgId = "";
  let contactId = "";
  let leadId = "";
  const createdIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "T6 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db.insert(organizations).values({ name: "TEST-T6 Outbox Clientes" }).returning();
    orgId = org!.id;

    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "Test Outbox", email: "t6-outbox@example.com", whatsappConsent: true })
      .returning();
    contactId = contact!.id;

    const [lead] = await db
      .insert(leads)
      .values({ organizationId: orgId, contactId, stage: "new", source: "test", summary: "x" })
      .returning();
    leadId = lead!.id;
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await db.delete(outbox).where(inArray(outbox.id, createdIds));
    }
    await db.delete(leads).where(eq(leads.id, leadId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("rechaza un borrador sin lead ni organización", async () => {
    const res = await app.request("/api/outbox", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({ contactId, channel: "email", body: "Hola" }),
    });
    expect(res.status).toBe(400);
  });

  it("crea un borrador directo para un cliente existente", async () => {
    const res = await app.request("/api/outbox", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({
        organizationId: orgId,
        contactId,
        channel: "email",
        subject: "Seguimiento",
        body: "Hola, ¿cómo va el proyecto?",
        rationale: "Follow-up post-entrega",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      draft: { id: string; leadId: string | null; organizationId: string };
    };
    expect(body.success).toBe(true);
    expect(body.draft.leadId).toBeNull();
    expect(body.draft.organizationId).toBe(orgId);
    createdIds.push(body.draft.id);
  });

  it("el borrador de cliente aparece en pending y en el summary 360", async () => {
    const pending = await app.request("/api/outbox/pending", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const pendingBody = (await pending.json()) as {
      drafts: Array<{ id: string; organizationId: string | null; organizationName: string | null }>;
    };
    const found = pendingBody.drafts.find((d) => d.organizationId === orgId);
    expect(found).toBeDefined();
    expect(found!.organizationName).toBe("TEST-T6 Outbox Clientes");

    const summary = await app.request(`/api/organizations/${orgId}/summary`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const summaryBody = (await summary.json()) as { drafts: Array<{ id: string }> };
    expect(summaryBody.drafts.some((d) => d.id === found!.id)).toBe(true);
  });

  it("el borrador clásico con lead sigue funcionando", async () => {
    const res = await app.request("/api/outbox", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({
        leadId,
        contactId,
        channel: "email",
        body: "Primer contacto",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { draft: { id: string; leadId: string } };
    expect(body.draft.leadId).toBe(leadId);
    createdIds.push(body.draft.id);
  });
});
