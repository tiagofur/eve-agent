import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { pool, db } from "./db/client";
import { apiKeys, contacts, events, leads, organizations, tickets } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { getDueFollowups, runDailyDigestOnce, wasDigestSentToday } from "./services/followup-digest";

vi.mock("./services/telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("./services/telegram")>();
  return {
    ...original,
    sendTelegramMessage: vi.fn(async () => ({ ok: true })),
  };
});

import { sendTelegramMessage } from "./services/telegram";

describe("Digest matutino", () => {
  let orgId = "";
  let contactId = "";
  let overdueLeadId = "";
  let futureTicketId = "";

  beforeAll(async () => {
    const [org] = await db.insert(organizations).values({ name: "TEST-Digest" }).returning();
    orgId = org!.id;
    const [contact] = await db
      .insert(contacts)
      .values({ organizationId: orgId, name: "Test Digest", email: "digest@example.com" })
      .returning();
    contactId = contact!.id;

    const past = new Date(Date.now() - 2 * 24 * 3_600_000);
    const future = new Date(Date.now() + 30 * 24 * 3_600_000);
    const [lead] = await db
      .insert(leads)
      .values({
        organizationId: orgId,
        contactId,
        stage: "contacted",
        source: "test",
        summary: "x",
        nextFollowUpAt: past,
        followUpNote: "vencido",
      })
      .returning();
    overdueLeadId = lead!.id;

    const [ticket] = await db
      .insert(tickets)
      .values({
        organizationId: orgId,
        contactId,
        system: "Web",
        severity: "minor",
        status: "open",
        description: "futuro",
        slaDueAt: future,
        nextFollowUpAt: future,
      })
      .returning();
    futureTicketId = ticket!.id;
  });

  afterAll(async () => {
    await db.delete(leads).where(eq(leads.id, overdueLeadId));
    await db.delete(tickets).where(eq(tickets.id, futureTicketId));
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool.end();
  });

  it("incluye vencidos y los de hoy, ordenados, y excluye futuros lejanos", async () => {
    const items = await getDueFollowups(new Date());
    const lead = items.find((i) => i.kind === "lead" && i.label.includes("TEST-Digest"));
    expect(lead).toBeDefined();
    expect(lead!.overdue).toBe(true);
    expect(lead!.note).toBe("vencido");
    expect(items.some((i) => i.kind === "ticket" && i.label === "Web (TEST-Digest)")).toBe(false);
    const times = items.map((i) => i.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  afterEach(async () => {
    await db
      .delete(events)
      .where(and(eq(events.entity, "followup_digest"), eq(events.action, "digest_sent")));
  });

  it("envía el digest una sola vez por día aunque el daemon reinicie", async () => {
    // Limpia marcas de corridas anteriores del mismo día en la DB de test.
    await db
      .delete(events)
      .where(and(eq(events.entity, "followup_digest"), eq(events.action, "digest_sent")));
    vi.mocked(sendTelegramMessage).mockClear();

    await runDailyDigestOnce();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(await wasDigestSentToday()).toBe(true);

    await runDailyDigestOnce(); // simula el restart del contenedor post-deploy
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("la marca de ayer no bloquea el digest de hoy", async () => {
    const yesterday = new Date(Date.now() - 26 * 3_600_000);
    await db.insert(events).values({
      entity: "followup_digest",
      entityId: randomUUID(),
      action: "digest_sent",
      actor: "system",
      createdAt: yesterday,
    });
    expect(await wasDigestSentToday()).toBe(false);
  });
});
