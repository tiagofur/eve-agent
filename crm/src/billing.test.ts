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
});
