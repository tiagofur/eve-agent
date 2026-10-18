import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, leads, organizations, tickets } from "./db/schema";
import { eq } from "drizzle-orm";

describe("T3 follow-ups", () => {
  const opsKey = "cp_ops_t3testkey1234567890abcdef12";
  let orgId = "";
  let leadId = "";
  let contactId = "";
  let bareOrgId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "T3 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db.insert(organizations).values({ name: "TEST-T3 Seguimiento" }).returning();
    orgId = org!.id;

    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "Test Seguimiento", email: "t3-seguimiento@example.com" })
      .returning();
    contactId = contact!.id;

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
    if (bareOrgId) {
      await db.delete(leads).where(eq(leads.organizationId, bareOrgId));
      await db.delete(organizations).where(eq(organizations.id, bareOrgId));
    }
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

  it("expone leadId y contactId explícitos en el item de la cola", async () => {
    const res = await app.request("/api/reports/followups", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overdue: Array<{ kind: string; id: string; leadId?: string; contactId?: string | null }>;
    };
    const item = body.overdue.find((f) => f.kind === "lead" && f.id === leadId);
    expect(item).toBeTruthy();
    expect(item?.leadId).toBe(leadId);
    expect(item?.contactId).toBe(contactId);
  });

  it("expone leadId con contactId null cuando el lead no tiene contacto", async () => {
    const [org] = await db.insert(organizations).values({ name: "TEST-T3 Sin Contacto" }).returning();
    bareOrgId = org!.id;
    const [lead] = await db
      .insert(leads)
      .values({ organizationId: bareOrgId, stage: "researched", source: "test", summary: "Lead sin contacto" })
      .returning();

    const patch = await app.request(`/api/leads/${lead!.id}/followup`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` },
      body: JSON.stringify({ nextFollowUpAt: "2020-02-02T10:00:00.000Z", followUpNote: "Completar contacto" }),
    });
    expect(patch.status).toBe(200);

    const res = await app.request("/api/reports/followups", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const body = (await res.json()) as {
      overdue: Array<{ kind: string; id: string; leadId?: string; contactId?: string | null }>;
    };
    const item = body.overdue.find((f) => f.kind === "lead" && f.id === lead!.id);
    expect(item).toBeTruthy();
    expect(item?.leadId).toBe(lead!.id);
    expect(item?.contactId).toBeNull();
  });

  it("set + clear en ticket, contacto y organización", async () => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

    const uniq = Date.now();
    const [org] = await db.insert(organizations).values({ name: `TEST-T3b Followup ${uniq}` }).returning();
    const orgId2 = org!.id;
    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId2, name: "T3b Contacto", email: `t3b-${uniq}@example.com` })
      .returning();
    const contactId2 = contact!.id;
    const [ticket] = await db
      .insert(tickets)
      .values({ organizationId: orgId2, contactId: contactId2, system: "Web", severity: "minor", description: "Bug T3b", status: "open", slaDueAt: new Date("2030-01-01T00:00:00.000Z") })
      .returning();
    const ticketId = ticket!.id;

    for (const [kind, id] of [
      ["tickets", ticketId],
      ["contacts", contactId2],
      ["organizations", orgId2],
    ] as const) {
      const set = await app.request(`/api/${kind}/${id}/followup`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ nextFollowUpAt: "2020-03-03T10:00:00.000Z", followUpNote: "T3b nota" }),
      });
      expect(set.status).toBe(200);
      const setBody = (await set.json()) as { success: boolean };
      expect(setBody.success).toBe(true);

      const clear = await app.request(`/api/${kind}/${id}/followup`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ nextFollowUpAt: null }),
      });
      expect(clear.status).toBe(200);
    }

    await db.delete(tickets).where(eq(tickets.organizationId, orgId2));
    await db.delete(contacts).where(eq(contacts.organizationId, orgId2));
    await db.delete(organizations).where(eq(organizations.id, orgId2));
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

