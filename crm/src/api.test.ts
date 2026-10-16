import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { ensureDefaultApiKeys, hashApiKey } from "./auth/keys";
import { apiKeys, organizations, contacts, leads, outbox, tickets } from "./db/schema";
import { eq, inArray } from "drizzle-orm";

describe("CRM API Integration Tests", () => {
  let frontKey: string;
  let opsKey: string;
  let ownerKey: string;

  beforeAll(async () => {
    // Generate fresh keys for test run
    frontKey = "cp_front_testkey1234567890abcdef1234";
    opsKey = "cp_ops_testkey1234567890abcdef1234";
    ownerKey = "cp_owner_testkey1234567890abcdef1234";

    await db.insert(apiKeys).values([
      { name: "Test Front", scope: "front", keyHash: hashApiKey(frontKey) },
      { name: "Test Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Test Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
    ]);
  });

  afterAll(async () => {
    // Clean up this suite's OWN records so re-running against the same
    // database stays green (previous runs left a `qualified` lead that broke
    // the stage-transition test on the second run).
    const testEmails = ["carlos@logisticspro.com", "valeria@innovatech.io", "david@acme.com"];
    const testContacts = await db.select().from(contacts).where(inArray(contacts.email, testEmails));
    const contactIds = testContacts.map((c) => c.id);
    const orgIds = [
      ...new Set(
        testContacts
          .map((c) => c.organizationId)
          .filter((id): id is string => typeof id === "string")
      ),
    ];

    // tickets.organizationId is ON DELETE RESTRICT: delete tickets first.
    if (contactIds.length > 0) {
      await db.delete(tickets).where(inArray(tickets.contactId, contactIds));
      await db.delete(leads).where(inArray(leads.contactId, contactIds));
    }
    for (const orgId of orgIds) {
      await db.delete(leads).where(eq(leads.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    if (contactIds.length > 0) {
      await db.delete(contacts).where(inArray(contacts.id, contactIds));
    }

    // Contact-less test orgs (no email to key on): clean by organization name.
    const testOrgNames = ["TEST-SinContacto Corp"];
    for (const orgName of testOrgNames) {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.name, orgName))
        .limit(1);
      if (org) {
        await db.delete(leads).where(eq(leads.organizationId, org.id));
        await db.delete(contacts).where(eq(contacts.organizationId, org.id));
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
    }

    // Clean up test keys and close pool
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(frontKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(ownerKey)));
    await pool.end();
  });

  it("GET /health responds with 200 without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
  });

  it("POST /api/leads rejects requests without auth header with 401", async () => {
    const res = await app.request("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName: "Anonymous",
        contact: "+123456789",
        projectSummary: "Test",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/leads ingests a lead with front API key", async () => {
    const res = await app.request("/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frontKey}`,
      },
      body: JSON.stringify({
        clientName: "Carlos Mendez",
        companyName: "Logistics Pro Latam",
        contact: "carlos@logisticspro.com",
        serviceType: "automation",
        projectSummary: "Needs ERP webhook sync with WhatsApp dispatch bot",
        estimatedBudget: "$3k - $5k",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.stage).toBe("new");
    expect(body.leadId).toBeDefined();

    // Verify deduplication: re-ingest same contact
    const res2 = await app.request("/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frontKey}`,
      },
      body: JSON.stringify({
        clientName: "Carlos Mendez",
        companyName: "Logistics Pro Latam",
        contact: "carlos@logisticspro.com",
        serviceType: "automation",
        projectSummary: "Follow up inquiry about quote",
      }),
    });

    expect(res2.status).toBe(201);
  });

  it("POST /api/leads ingests an honest contact-less lead", async () => {
    const res = await app.request("/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frontKey}`,
      },
      body: JSON.stringify({
        clientName: "TEST-Sin Contacto",
        companyName: "TEST-SinContacto Corp",
        serviceType: "automation",
        projectSummary: "Lead de prueba sin contacto verificado para el intake honesto.",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.leadId).toBeDefined();
    expect(body.stage).toBe("new");

    const [lead] = await db.select().from(leads).where(eq(leads.id, body.leadId));
    expect(lead).toBeDefined();
    // Honest no-contact: no invented email/phone, whether or not a
    // name-only contact row exists.
    const [contact] = lead!.contactId
      ? await db.select().from(contacts).where(eq(contacts.id, lead!.contactId))
      : [undefined];
    expect(contact?.email ?? null).toBeNull();
    expect(contact?.phone ?? null).toBeNull();
  });

  it("PATCH /api/leads/:id/stage enforces stage transition rules", async () => {
    // 1. Create a lead
    const createRes = await app.request("/api/leads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frontKey}`,
      },
      body: JSON.stringify({
        clientName: "Valeria Gomez",
        contact: "valeria@innovatech.io",
        projectSummary: "AI Agent for contract validation",
      }),
    });
    const { leadId } = await createRes.json();

    // 2. Front key CANNOT transition stage (needs ops or owner)
    const unauthorizedRes = await app.request(`/api/leads/${leadId}/stage`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frontKey}`,
      },
      body: JSON.stringify({
        targetStage: "qualified",
        reason: "Client confirmed BANT criteria",
      }),
    });
    expect(unauthorizedRes.status).toBe(403);

    // 3. Ops key CANNOT jump directly from new -> won
    const illegalJumpRes = await app.request(`/api/leads/${leadId}/stage`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opsKey}`,
      },
      body: JSON.stringify({
        targetStage: "won",
        reason: "Instant close attempt",
      }),
    });
    expect(illegalJumpRes.status).toBe(400);

    // 4. Ops key CAN transition new -> qualified with valid reason
    const validTransitionRes = await app.request(`/api/leads/${leadId}/stage`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opsKey}`,
      },
      body: JSON.stringify({
        targetStage: "qualified",
        reason: "Client confirmed BANT criteria in WhatsApp call",
      }),
    });
    expect(validTransitionRes.status).toBe(200);
    const validBody = await validTransitionRes.json();
    expect(validBody.lead.stage).toBe("qualified");
  });

  it("Outbox gating: ops creates draft; only owner can approve", async () => {
    // Use THIS suite's own lead deterministically: `db.select().limit(1)` is
    // unordered and could attach the draft to a real prospect.
    const [testContact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, "carlos@logisticspro.com"))
      .limit(1);
    expect(testContact).toBeDefined();
    const [existingLead] = await db
      .select()
      .from(leads)
      .where(eq(leads.contactId, testContact!.id))
      .limit(1);
    expect(existingLead).toBeDefined();
    if (!existingLead || !existingLead.contactId) {
      throw new Error("Expected existing lead in test database");
    }

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, existingLead.contactId)).limit(1);
    expect(contact).toBeDefined();
    if (!contact) {
      throw new Error("Expected contact in test database");
    }

    // 1. Ops creates draft
    const draftRes = await app.request("/api/outbox", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opsKey}`,
      },
      body: JSON.stringify({
        leadId: existingLead.id,
        contactId: contact.id,
        channel: "email",
        subject: "Propuesta de arquitectura para Creapolis.Dev",
        body: "Hola Carlos, adjuntamos la propuesta técnica solicitada...",
        rationale: "Lead calificado esperando presupuesto técnico",
      }),
    });

    expect(draftRes.status).toBe(201);
    const { draft } = await draftRes.json();
    expect(draft.status).toBe("pending_approval");

    // 2. Ops tries to approve -> 403 Forbidden!
    const opsApproveRes = await app.request(`/api/outbox/${draft.id}/review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opsKey}`,
      },
      body: JSON.stringify({
        decision: "approved",
      }),
    });
    expect(opsApproveRes.status).toBe(403);

    // 3. Owner approves -> 200 OK!
    const ownerApproveRes = await app.request(`/api/outbox/${draft.id}/review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ownerKey}`,
      },
      body: JSON.stringify({
        decision: "approved",
      }),
    });
    expect(ownerApproveRes.status).toBe(200);
    const approvedBody = await ownerApproveRes.json();
    expect(approvedBody.draft.status).toBe("approved");
  });

  it("POST /api/tickets creates a ticket with computed SLA", async () => {
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${frontKey}`,
      },
      body: JSON.stringify({
        clientName: "David Santos",
        contact: "david@acme.com",
        system: "WhatsApp Order Bot",
        severity: "critical",
        description: "Webhook receiving 500 error from payment gateway",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.severity).toBe("critical");
    expect(body.slaHours).toBe(1); // 1 hour for critical
    expect(body.ticketId).toBeDefined();
  });

  it("GET /api/reports/funnel aggregates conversion metrics", async () => {
    const res = await app.request("/api/reports/funnel", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.funnel).toBeDefined();
    expect(Array.isArray(body.funnel)).toBe(true);
    expect(body.totalInFunnel).toBeGreaterThanOrEqual(1);
  });
});
