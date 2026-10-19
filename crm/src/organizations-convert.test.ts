import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, leads, organizations, projects } from "./db/schema";
import { eq } from "drizzle-orm";

describe("T1+T2 Clientes 360 y convertir lead", () => {
  const opsKey = "cp_ops_t1t2testkey1234567890abcdef";
  let orgId = "";
  let wonLeadId = "";
  let newLeadId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "T1T2 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db
      .insert(organizations)
      .values({ name: "TEST-T1T2 Cliente 360" })
      .returning();
    orgId = org!.id;

    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "Test Cliente", email: "t1t2-cliente@example.com" })
      .returning();

    const [won] = await db
      .insert(leads)
      .values({
        organizationId: orgId,
        contactId: contact!.id,
        stage: "won",
        source: "test",
        summary: "Lead ganado para convertir",
      })
      .returning();
    wonLeadId = won!.id;

    const [fresh] = await db
      .insert(leads)
      .values({
        organizationId: orgId,
        contactId: contact!.id,
        stage: "new",
        source: "test",
        summary: "Lead nuevo que no debe convertirse",
      })
      .returning();
    newLeadId = fresh!.id;
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.organizationId, orgId));
    await db.delete(leads).where(eq(leads.organizationId, orgId));
    await db.delete(contacts).where(eq(contacts.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("rechaza convertir un lead que no está en won", async () => {
    const res = await app.request(`/api/leads/${newLeadId}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({ projectName: "No debe crearse" }),
    });
    expect(res.status).toBe(400);
  });

  it("convierte un lead won en proyecto y lo deja en onboarding", async () => {
    const res = await app.request(`/api/leads/${wonLeadId}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({ projectName: "TEST Proyecto Cliente 360" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; project: { id: string; name: string } };
    expect(body.success).toBe(true);
    expect(body.project.name).toBe("TEST Proyecto Cliente 360");

    const [lead] = await db.select().from(leads).where(eq(leads.id, wonLeadId)).limit(1);
    expect(lead!.stage).toBe("onboarding");
  });

  it("expone el resumen 360 con proyecto incluido", async () => {
    const res = await app.request(`/api/organizations/${orgId}/summary`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      organization: { id: string };
      contacts: unknown[];
      leads: unknown[];
      projects: Array<{ name: string }>;
    };
    expect(body.organization.id).toBe(orgId);
    expect(body.leads.length).toBe(2);
    expect(body.projects.some((p) => p.name === "TEST Proyecto Cliente 360")).toBe(true);
  });
});
