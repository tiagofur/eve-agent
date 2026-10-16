import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { pool, db } from "./db/client";
import { apiKeys, contacts, leads, organizations, tickets } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { eq } from "drizzle-orm";
import { getDueFollowups } from "./services/followup-digest";

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
});
