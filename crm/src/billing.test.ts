import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contracts, milestones, organizations, projects } from "./db/schema";
import { eq } from "drizzle-orm";

describe("T7 billing endpoint", () => {
  const opsKey = "cp_ops_t7testkey1234567890abcdef12";
  let orgId = "";
  let projectId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "T7 Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);

    const [org] = await db.insert(organizations).values({ name: "TEST-T7 Billing" }).returning();
    orgId = org!.id;

    const [project] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST Proyecto Cobro", status: "active" })
      .returning();
    projectId = project!.id;

    await db.insert(milestones).values({ projectId, title: "Anticipo", dueDate: "2020-01-15" });
    await db.insert(contracts).values({ projectId, title: "Contrato base", body: "términos", status: "sent" });
  });

  afterAll(async () => {
    await db.delete(contracts).where(eq(contracts.projectId, projectId));
    await db.delete(milestones).where(eq(milestones.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("crea un proyecto con montos en los hitos", async () => {
    const [org] = await db.insert(organizations).values({ name: "TEST-T7b Montos" }).returning();
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

    const res = await app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({
        organizationId: org!.id,
        name: "TEST Proyecto Con Monto",
        milestonesList: [
          { title: "Anticipo 50%", dueDate: "2026-11-01", amountCents: 250000, currency: "MXN" },
          { title: "Entrega final" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; project: { id: string } };
    expect(body.success).toBe(true);

    const rows = await db.select().from(milestones).where(eq(milestones.projectId, body.project.id));
    const anticipo = rows.find((m) => m.title === "Anticipo 50%");
    expect(anticipo?.amountCents).toBe(250000);
    expect(anticipo?.currency).toBe("MXN");
    const entrega = rows.find((m) => m.title === "Entrega final");
    expect(entrega?.amountCents).toBeNull();

    await db.delete(milestones).where(eq(milestones.projectId, body.project.id));
    await db.delete(projects).where(eq(projects.id, body.project.id));
    await db.delete(organizations).where(eq(organizations.id, org!.id));
  });

  it("lista proyectos abiertos con hitos y contratos", async () => {
    const res = await app.request("/api/projects/billing", {
      headers: { Authorization: `Bearer ${opsKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Array<{
        id: string;
        name: string;
        organizationName: string | null;
        milestones: Array<{ title: string; dueDate: string | null; doneAt: string | null }>;
        contracts: Array<{ title: string; status: string }>;
      }>;
    };
    const found = body.projects.find((p) => p.id === projectId);
    expect(found).toBeDefined();
    expect(found!.organizationName).toBe("TEST-T7 Billing");
    expect(found!.milestones.some((m) => m.title === "Anticipo")).toBe(true);
    expect(found!.contracts.some((c) => c.title === "Contrato base" && c.status === "sent")).toBe(true);
  });

  it("marca vencidos, próximos (7d) y no firmados desde el servidor", async () => {
    const opsHeaders = { Authorization: `Bearer ${opsKey}` };
    const day = 24 * 60 * 60 * 1000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const now = Date.now();

    const [org] = await db.insert(organizations).values({ name: "TEST-T7b Flags" }).returning();
    const [project] = await db
      .insert(projects)
      .values({ organizationId: org!.id, name: "TEST Flags", status: "active" })
      .returning();
    const pid = project!.id;

    await db.insert(milestones).values([
      { projectId: pid, title: "Vencido", dueDate: "2020-01-01", amountCents: 100000, currency: "MXN" },
      { projectId: pid, title: "Hecho", dueDate: "2020-01-01", doneAt: new Date("2020-02-01T00:00:00Z") },
      { projectId: pid, title: "Pronto", dueDate: iso(now + 3 * day) },
      { projectId: pid, title: "Lejos", dueDate: iso(now + 30 * day) },
      { projectId: pid, title: "Sin fecha" },
    ]);
    await db.insert(contracts).values([
      { projectId: pid, title: "Enviado", body: "t", status: "sent" },
      { projectId: pid, title: "Firmado", body: "t", status: "signed" },
      { projectId: pid, title: "Anulado", body: "t", status: "void" },
    ]);

    const res = await app.request("/api/projects/billing", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Array<{
        id: string;
        overdueMilestones: Array<{ title: string; amountCents: number | null }>;
        dueSoonMilestones: Array<{ title: string }>;
        unsignedContracts: Array<{ title: string; status: string }>;
      }>;
    };
    const found = body.projects.find((p) => p.id === pid);
    expect(found).toBeDefined();
    expect(found!.overdueMilestones.map((m) => m.title)).toEqual(["Vencido"]);
    expect(found!.overdueMilestones[0]!.amountCents).toBe(100000);
    expect(found!.dueSoonMilestones.map((m) => m.title)).toEqual(["Pronto"]);
    expect(found!.unsignedContracts.map((c) => c.title)).toEqual(["Enviado"]);

    await db.delete(contracts).where(eq(contracts.projectId, pid));
    await db.delete(milestones).where(eq(milestones.projectId, pid));
    await db.delete(projects).where(eq(projects.id, pid));
    await db.delete(organizations).where(eq(organizations.id, org!.id));
  });
});

