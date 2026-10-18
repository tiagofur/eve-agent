import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, tickets } from "./db/schema";
import { eq, like } from "drizzle-orm";

/**
 * Contact-optional info tickets (S1): a stranger's service question logs
 * without contact data; support incidents still require a follow-up channel.
 */
describe("info tickets without contact", () => {
  const opsKey = "cp_ops_ticketinfokey1234567890abcdef";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const createdIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Ticket Info Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await db.delete(tickets).where(eq(tickets.id, id));
    }
    await db.delete(tickets).where(like(tickets.description, "TEST-Ticket info%"));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("logs an info question without contact and defaults severity", async () => {
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientName: "TEST Visitante",
        system: "Automatizaciones",
        kind: "info",
        description: "TEST-Ticket info: ¿hacen integraciones con SAP?",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      ticketId: string;
      kind: string;
      severity: string;
      slaHours: number;
    };
    expect(body.success).toBe(true);
    expect(body.kind).toBe("info");
    expect(body.severity).toBe("minor");
    expect(body.slaHours).toBe(24);
    createdIds.push(body.ticketId);

    const [row] = await db.select().from(tickets).where(eq(tickets.id, body.ticketId)).limit(1);
    expect(row?.contactId).toBeNull();
  });

  it("still requires a contact channel for support incidents", async () => {
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientName: "TEST Cliente",
        system: "WhatsApp Bot",
        severity: "major",
        description: "TEST-Ticket info: bot caído",
      }),
    });
    expect(res.status).toBe(400);
  });
});
