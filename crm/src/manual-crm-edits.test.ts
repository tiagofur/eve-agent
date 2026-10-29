import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, events, leads, organizations, projects, tickets } from "./db/schema";
import { desc, eq } from "drizzle-orm";
import { ingestLead } from "./domain/leads";

describe("Edición manual del CRM (fichas 360 y leads)", () => {
  const opsKey = "cp_ops_manualedittestkey1234567890ab";
  let orgId = "";
  let orphanLeadId = "";
  let contactId = "";

  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Manual Edits Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db.insert(organizations).values({ name: "TEST Manual Edits" }).returning();
    orgId = org!.id;

    // Lead sin contacto (ingestLead no crea fila de contacto sin email/teléfono)
    const [lead] = await db
      .insert(leads)
      .values({ organizationId: orgId, stage: "new", source: "test", summary: "Lead sin contacto" })
      .returning();
    orphanLeadId = lead!.id;
  });

  afterAll(async () => {
    const orgContacts = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.organizationId, orgId));
    for (const c of orgContacts) {
      await db.delete(events).where(eq(events.entityId, c.id));
    }
    await db.delete(contacts).where(eq(contacts.organizationId, orgId));
    await db.delete(events).where(eq(events.entityId, orgId));
    await db.delete(events).where(eq(events.entityId, orphanLeadId));
    await db.delete(leads).where(eq(leads.id, orphanLeadId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("rechaza peticiones sin owner/ops key", async () => {
    const res = await app.request(`/api/organizations/${orgId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: "Guadalajara" }),
    });
    expect(res.status).toBe(401);
  });

  it("añade un contacto a la organización y aparece en el resumen 360", async () => {
    const res = await app.request(`/api/organizations/${orgId}/contacts`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "María Contabilidad",
        role: "Contabilidad",
        email: "maria@test.com",
        preferredChannel: "email",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; contact: { id: string; role: string | null } };
    expect(body.success).toBe(true);
    expect(body.contact.role).toBe("Contabilidad");
    contactId = body.contact.id;

    const summary = await app.request(`/api/organizations/${orgId}/summary`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const summaryBody = (await summary.json()) as { contacts: Array<{ id: string }> };
    expect(summaryBody.contacts.some((c) => c.id === contactId)).toBe(true);
  });

  it("edita un contacto (rol, email) y limpia campos con null", async () => {
    const res = await app.request(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ role: "Facturación y pagos", phone: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contact: { role: string; phone: string | null } };
    expect(body.contact.role).toBe("Facturación y pagos");
    expect(body.contact.phone).toBeNull();

    const audit = await db
      .select()
      .from(events)
      .where(eq(events.entityId, contactId));
    expect(audit.some((e) => e.action === "updated" && (e.before as any)?.role === "Contabilidad")).toBe(true);
  });

  it("rechaza email inválido y patch vacío de contacto", async () => {
    const badEmail = await app.request(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ email: "no-es-un-email" }),
    });
    expect(badEmail.status).toBe(400);

    const empty = await app.request(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ role: "Facturación y pagos" }),
    });
    expect(empty.status).toBe(400);
  });

  it("edita datos de la organización", async () => {
    const res = await app.request(`/api/organizations/${orgId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ website: "https://test.com", city: "Guadalajara", country: "México" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organization: { website: string; city: string } };
    expect(body.organization.website).toBe("https://test.com");
    expect(body.organization.city).toBe("Guadalajara");
  });

  it("normaliza el dominio y rechaza dominios duplicados", async () => {
    const [other] = await db
      .insert(organizations)
      .values({ name: "TEST Manual Edits 2", domain: "dup.com" })
      .returning();

    const res = await app.request(`/api/organizations/${orgId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ domain: "https://DUP.com/" }),
    });
    expect(res.status).toBe(409);

    const ok = await app.request(`/api/organizations/${orgId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ domain: "  https://ManualEdits.com/  " }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { organization: { domain: string } };
    expect(body.organization.domain).toBe("manualedits.com");

    await db.delete(organizations).where(eq(organizations.id, other!.id));
  });

  it("vincula un contacto a un lead que llegó sin contacto", async () => {
    const res = await app.request(`/api/leads/${orphanLeadId}/contact`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Stephane Lerouge", phone: "+509 0000 0000" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { contact: { id: string } };

    const details = await app.request(`/api/leads/${orphanLeadId}/details`, {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    const detailBody = (await details.json()) as { lead: { contactId: string | null; contactPhone: string | null } };
    expect(detailBody.lead.contactId).toBe(body.contact.id);
    expect(detailBody.lead.contactPhone).toBe("+509 0000 0000");

    const again = await app.request(`/api/leads/${orphanLeadId}/contact`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Otro" }),
    });
    expect(again.status).toBe(409);

    contactId = body.contact.id;
  });

  it("elimina un ticket cerrado y rechaza eliminar uno abierto", async () => {
    const [closed] = await db
      .insert(tickets)
      .values({
        organizationId: orgId,
        system: "TEST sistema de prueba",
        severity: "minor",
        status: "closed",
        description: "Ticket de prueba para eliminar",
        slaDueAt: new Date(),
      })
      .returning();

    const rejected = await app.request(`/api/tickets/${orphanLeadId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(rejected.status).toBe(404); // es un lead id, no un ticket

    const openTicket = await app.request(`/api/tickets`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        clientName: "Alguien",
        system: "TEST abierto",
        description: "abierto",
        kind: "info",
      }),
    });
    expect(openTicket.status).toBe(201);
    const openBody = (await openTicket.json()) as { ticketId: string };

    const notClosed = await app.request(`/api/tickets/${openBody.ticketId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(notClosed.status).toBe(409);

    const ok = await app.request(`/api/tickets/${closed!.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(ok.status).toBe(200);

    const [gone] = await db.select().from(tickets).where(eq(tickets.id, closed!.id)).limit(1);
    expect(gone).toBeUndefined();

    await db.delete(events).where(eq(events.entityId, openBody.ticketId));
    await db.delete(tickets).where(eq(tickets.id, openBody.ticketId));
  });

  it("elimina una organización sin proyectos y cascada sus leads y contactos", async () => {
    const [dupOrg] = await db.insert(organizations).values({ name: "TEST Eliminable" }).returning();
    const [dupLead] = await db
      .insert(leads)
      .values({ organizationId: dupOrg!.id, stage: "new", source: "test", summary: "lead duplicado" })
      .returning();
    const [dupContact] = await db
      .insert(contacts)
      .values({ organizationId: dupOrg!.id, name: "Contacto duplicado" })
      .returning();

    const noAuth = await app.request(`/api/organizations/${dupOrg!.id}`, { method: "DELETE" });
    expect(noAuth.status).toBe(401);

    const ok = await app.request(`/api/organizations/${dupOrg!.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { removedLeads: number; removedContacts: number };
    expect(body.removedLeads).toBe(1);
    expect(body.removedContacts).toBe(1);

    expect((await db.select().from(leads).where(eq(leads.id, dupLead!.id))).length).toBe(0);
    expect((await db.select().from(contacts).where(eq(contacts.id, dupContact!.id))).length).toBe(0);
    expect((await db.select().from(organizations).where(eq(organizations.id, dupOrg!.id))).length).toBe(0);
  });

  it("rechaza eliminar una organización con proyectos", async () => {
    // orgId tiene 0 proyectos aquí, pero el lead vinculado tiene organización;
    // creamos proyecto para forzar el 409
    const [project] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST proyecto bloqueante" })
      .returning();

    const res = await app.request(`/api/organizations/${orgId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(409);

    await db.delete(projects).where(eq(projects.id, project!.id));
  });

  it("reutiliza la organización existente aunque el nombre cambie de formato", async () => {
    const [org] = await db.insert(organizations).values({ name: "Creapolis.Dev" }).returning();
    try {
      const before = await db.select({ id: organizations.id }).from(organizations);
      await ingestLead({
        clientName: "Tiago Test",
        companyName: "creapolis  DEV.",
        projectSummary: "lead con variantes del mismo nombre",
        source: "test",
        actor: "test",
      });
      const after = await db.select({ id: organizations.id }).from(organizations);
      expect(after.length).toBe(before.length); // no creó una nueva
      const [freshLead] = await db
        .select()
        .from(leads)
        .where(eq(leads.organizationId, org!.id))
        .orderBy(desc(leads.createdAt))
        .limit(1);
      expect(freshLead?.summary).toBe("lead con variantes del mismo nombre");
      if (freshLead) {
        await db.delete(events).where(eq(events.entityId, freshLead.id));
        await db.delete(leads).where(eq(leads.id, freshLead.id));
      }
    } finally {
      const orgContacts = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.organizationId, org!.id));
      for (const c of orgContacts) {
        await db.delete(events).where(eq(events.entityId, c.id));
      }
      await db.delete(contacts).where(eq(contacts.organizationId, org!.id));
      await db.delete(events).where(eq(events.entityId, org!.id));
      await db.delete(organizations).where(eq(organizations.id, org!.id));
    }
  });
});
