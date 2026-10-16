import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, tickets } from "./db/schema";
import { eq, inArray } from "drizzle-orm";

describe("T4 tickets info vs soporte", () => {
  const frontKey = "cp_front_t4testkey1234567890abcdef";
  const opsKey = "cp_ops_t4testkey1234567890abcdef12";
  const contactEmail = "t4-cliente@example.com";
  const createdIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "T4 Front", scope: "front", keyHash: hashApiKey(frontKey) },
      { name: "T4 Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
    ]);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await db.delete(tickets).where(inArray(tickets.id, createdIds));
    }
    await db.delete(contacts).where(eq(contacts.email, contactEmail));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(frontKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("crea un ticket info con SLA comercial de 24h", async () => {
    const before = Date.now();
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${frontKey}` },
      body: JSON.stringify({
        clientName: "Cliente Info",
        contact: contactEmail,
        system: "Cotización app móvil",
        severity: "minor",
        kind: "info",
        description: "Quiero saber cuánto cuesta una app",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      ticketId: string;
      kind: string;
      slaHours: number;
      slaDueAt: string;
    };
    expect(body.kind).toBe("info");
    expect(body.slaHours).toBe(24);
    const deltaH = (new Date(body.slaDueAt).getTime() - before) / 3_600_000;
    expect(deltaH).toBeGreaterThan(23);
    expect(deltaH).toBeLessThan(25);
    createdIds.push(body.ticketId);
  });

  it("el ticket soporte por defecto mantiene SLA por severidad", async () => {
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${frontKey}` },
      body: JSON.stringify({
        clientName: "Cliente Soporte",
        contact: contactEmail,
        system: "Web App",
        severity: "critical",
        description: "Caída total",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ticketId: string; kind: string; slaHours: number };
    expect(body.kind).toBe("support");
    expect(body.slaHours).toBe(1);
    createdIds.push(body.ticketId);
  });

  it("el listado filtra por kind", async () => {
    const res = await app.request("/api/tickets?kind=info", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tickets: Array<{ kind: string }> };
    expect(body.tickets.length).toBeGreaterThanOrEqual(1);
    expect(body.tickets.every((t) => t.kind === "info")).toBe(true);
  });
});
