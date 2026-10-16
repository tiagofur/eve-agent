import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, leads, organizations } from "./db/schema";
import { eq } from "drizzle-orm";

describe("T3 follow-ups", () => {
  const opsKey = "cp_ops_t3testkey1234567890abcdef12";
  let orgId = "";
  let leadId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "T3 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db.insert(organizations).values({ name: "TEST-T3 Seguimiento" }).returning();
    orgId = org!.id;

    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "Test Seguimiento", email: "t3-seguimiento@example.com" })
      .returning();

    const [lead] = await db
      .insert(leads)
      .values({
        organizationId: orgId,
        contactId: contact!.id,
        stage: "contacted",
        source: "test",
        summary: "Lead con seguimiento vencido",
      })
      .returning();
    leadId = lead!.id;
  });

  afterAll(async () => {
    await db.delete(leads).where(eq(leads.organizationId, orgId));
    await db.delete(contacts).where(eq(contacts.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("programa un follow-up en un lead", async () => {
    const res = await app.request(`/api/leads/${leadId}/followup`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({
        nextFollowUpAt: "2020-01-01T10:00:00.000Z",
        followUpNote: "Llamar para cerrar",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; lead: { followUpNote: string } };
    expect(body.success).toBe(true);
    expect(body.lead.followUpNote).toBe("Llamar para cerrar");
  });

  it("el reporte /followups lista el vencido y /daily lo cuenta", async () => {
    const res = await app.request("/api/reports/followups", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overdue: Array<{ kind: string; id: string; followUpNote: string }>;
    };
    expect(body.overdue.some((f) => f.kind === "lead" && f.id === leadId)).toBe(true);

    const daily = await app.request("/api/reports/daily", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const dailyBody = (await daily.json()) as { metrics: { followUpsOverdue: number } };
    expect(dailyBody.metrics.followUpsOverdue).toBeGreaterThanOrEqual(1);
  });

  it("limpia el follow-up con null", async () => {
    const res = await app.request(`/api/leads/${leadId}/followup`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({ nextFollowUpAt: null }),
    });
    expect(res.status).toBe(200);

    const check = await app.request("/api/reports/followups", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const body = (await check.json()) as { overdue: Array<{ id: string }> };
    expect(body.overdue.some((f) => f.id === leadId)).toBe(false);
  });
});
