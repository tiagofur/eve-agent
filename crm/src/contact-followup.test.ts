import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, organizations } from "./db/schema";
import { eq } from "drizzle-orm";

describe("Nivel 1 slot por contacto", () => {
  const opsKey = "cp_ops_n1testkey1234567890abcdef12";
  let orgId = "";
  let contactId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "N1 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-N1 Contacto" }).returning();
    orgId = org!.id;
    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "María N1", email: "n1@example.com" })
      .returning();
    contactId = contact!.id;
  });

  afterAll(async () => {
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("programa un follow-up en un contacto y aparece en /followups", async () => {
    const res = await app.request(`/api/contacts/${contactId}/followup`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({
        nextFollowUpAt: "2020-02-02T10:00:00.000Z",
        followUpNote: "Llamar a María por la cotización",
      }),
    });
    expect(res.status).toBe(200);

    const queue = await app.request("/api/reports/followups", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const body = (await queue.json()) as {
      overdue: Array<{ kind: string; id: string; followUpNote: string; organizationName: string | null }>;
    };
    const found = body.overdue.find((f) => f.kind === "contact" && f.id === contactId);
    expect(found).toBeDefined();
    expect(found!.organizationName).toBe("TEST-N1 Contacto");
  });

  it("el hilo del contacto expone su seguimiento", async () => {
    const res = await app.request(`/api/interactions/by-contact/${contactId}`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contact: { id: string; nextFollowUpAt: string; followUpNote: string };
    };
    expect(body.contact.nextFollowUpAt).toContain("2020-02-02");
  });
});
