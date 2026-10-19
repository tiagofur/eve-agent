import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, interactions, leads, organizations, tickets } from "./db/schema";
import { eq, inArray } from "drizzle-orm";

describe("T5 hilos unificados", () => {
  const opsKey = "cp_ops_t5testkey1234567890abcdef12";
  let orgId = "";
  let contactId = "";
  let leadId = "";
  let ticketId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "T5 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db.insert(organizations).values({ name: "TEST-T5 Hilos" }).returning();
    orgId = org!.id;

    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "Test Hilo", email: "t5-hilo@example.com" })
      .returning();
    contactId = contact!.id;

    const [lead] = await db
      .insert(leads)
      .values({ organizationId: orgId, contactId, stage: "contacted", source: "test", summary: "x" })
      .returning();
    leadId = lead!.id;

    const [ticket] = await db
      .insert(tickets)
      .values({
        organizationId: orgId,
        contactId,
        system: "Web",
        severity: "minor",
        status: "open",
        description: "duda comercial",
        slaDueAt: new Date(Date.now() + 24 * 3_600_000),
      })
      .returning();
    ticketId = ticket!.id;
  });

  afterAll(async () => {
    await db.delete(interactions).where(eq(interactions.organizationId, orgId));
    await db.delete(tickets).where(eq(tickets.id, ticketId));
    await db.delete(leads).where(eq(leads.id, leadId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("rechaza una interacción sin ningún vínculo", async () => {
    const res = await app.request("/api/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({ channel: "web", direction: "inbound", content: "hola" }),
    });
    expect(res.status).toBe(400);
  });

  it("registra entradas polimórficas y el hilo por contacto las agrega", async () => {
    for (const payload of [
      { organizationId: orgId, contactId, channel: "email", direction: "inbound", content: "Quiero cotizar" },
      { ticketId, contactId, channel: "email", direction: "outbound", content: "Te paso la cotización" },
      { leadId, channel: "phone", direction: "inbound", content: "Llamó para coordinar" },
    ]) {
      const res = await app.request("/api/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(201);
    }

    const byContact = await app.request(`/api/interactions/by-contact/${contactId}`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(byContact.status).toBe(200);
    const contactBody = (await byContact.json()) as { interactions: unknown[] };
    expect(contactBody.interactions.length).toBe(2);

    const byOrg = await app.request(`/api/interactions/by-organization/${orgId}`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(byOrg.status).toBe(200);
    const orgBody = (await byOrg.json()) as { interactions: unknown[] };
    expect(orgBody.interactions.length).toBe(3);
  });
});
