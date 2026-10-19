import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, estimates, leads, organizations } from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Persisted estimates (S1): every proposal is saved against its lead with
 * scope, phases and timeline — retrievable by lead for real
 * pending-proposal context. Money appears only when quoted, never guessed.
 */
describe("estimates persistence", () => {
  const opsKey = "cp_ops_estimatekey1234567890abcdef12";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let orgId = "";
  let leadId = "";
  const createdIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Estimate Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Estimates" }).returning();
    orgId = org!.id;
    const [lead] = await db
      .insert(leads)
      .values({ organizationId: orgId, stage: "qualified", source: "test", summary: "Lead con estimado" })
      .returning();
    leadId = lead!.id;
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await db.delete(estimates).where(eq(estimates.id, id));
    }
    await db.delete(leads).where(eq(leads.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("saves an unquoted estimate and reads it back by lead", async () => {
    const res = await app.request("/api/estimates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        leadId,
        organizationId: orgId,
        category: "workflow_automation",
        complexity: "standard",
        scopeSummary: "Bot de citas por WhatsApp con agenda y recordatorios.",
        phases: [{ title: "MVP", timeframe: "2-4 semanas" }],
        timelineText: "2 - 4 weeks",
        createdBy: "solutions:test",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      estimate: { id: string; valueCents: number | null; scopeSummary: string };
    };
    expect(body.success).toBe(true);
    expect(body.estimate.valueCents).toBeNull();
    createdIds.push(body.estimate.id);

    const listed = await app.request(`/api/estimates?leadId=${leadId}`, { headers });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      estimates: Array<{ id: string; scopeSummary: string }>;
    };
    expect(listedBody.estimates.some((e) => e.id === body.estimate.id)).toBe(true);
  });

  it("saves a quoted estimate with its agreed value", async () => {
    const res = await app.request("/api/estimates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId: orgId,
        category: "web_mobile_app",
        complexity: "mvp",
        scopeSummary: "Landing + reservas.",
        timelineText: "3 - 5 weeks",
        valueCents: 180000,
        currency: "MXN",
        createdBy: "solutions:test",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      estimate: { id: string; valueCents: number; currency: string };
    };
    expect(body.estimate.valueCents).toBe(180000);
    expect(body.estimate.currency).toBe("MXN");
    createdIds.push(body.estimate.id);
  });

  it("rejects an estimate without scope or target", async () => {
    const res = await app.request("/api/estimates", {
      method: "POST",
      headers,
      body: JSON.stringify({
        category: "workflow_automation",
        complexity: "standard",
        createdBy: "solutions:test",
      }),
    });
    expect(res.status).toBe(400);
  });
});
