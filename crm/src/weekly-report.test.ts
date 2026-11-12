import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contacts, milestones, organizations, projects, tasks, tickets, outbox } from "./db/schema";
import { isoWeekTag } from "./api/routes/reports";

/**
 * Weekly activity for the reporter: CRM facts from the window per project,
 * with the current week tag and the pending-report flag for mechanical dedup.
 */
const OPS_KEY = "cp_ops_weeklytestkey1234567890ab";
const ORG = "TEST-Weekly Org";

let orgId: string;
let projectId: string;
let contactId: string;

beforeAll(async () => {
  await db.insert(apiKeys).values({ name: "Weekly Ops", scope: "ops", keyHash: hashApiKey(OPS_KEY) });
  const [org] = await db.insert(organizations).values({ name: ORG }).returning();
  orgId = org!.id;
  const [contact] = await db
    .insert(contacts)
    .values({ organizationId: orgId, name: "TEST Weekly Contacto", email: "weekly-test@example.invalid" })
    .returning();
  contactId = contact!.id;
  const [project] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: "TEST Weekly App", status: "active" })
    .returning();
  projectId = project!.id;

  await db.insert(tasks).values([
    { projectId, title: "Hecha esta semana", status: "done", resultSummary: "tests verdes", updatedAt: new Date() },
    { projectId, title: "En curso", status: "in_progress", updatedAt: new Date() },
  ]);
  await db.insert(milestones).values([
    { projectId, title: "Hito cerrado", doneAt: new Date() },
    { projectId, title: "Hito próximo", dueDate: "2099-01-15" },
  ]);
  await db.insert(tickets).values([
    {
      projectId,
      organizationId: orgId,
      system: "web",
      severity: "minor",
      status: "resolved",
      description: "Botón roto",
      slaDueAt: new Date(),
      resolvedAt: new Date(),
    },
    {
      projectId,
      organizationId: orgId,
      system: "web",
      severity: "major",
      status: "open",
      description: "Abierto",
      slaDueAt: new Date(),
    },
  ]);
});

afterAll(async () => {
  await db.delete(tickets).where(eq(tickets.projectId, projectId));
  await db.delete(milestones).where(eq(milestones.projectId, projectId));
  await db.delete(tasks).where(eq(tasks.projectId, projectId));
  await db.delete(outbox).where(eq(outbox.organizationId, orgId));
  await db.delete(contacts).where(eq(contacts.id, contactId));
  await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(OPS_KEY)));
  await pool.end();
});

describe("GET /api/reports/weekly", () => {
  it("aggregates the week's facts per project with evidence and pending flag", async () => {
    const res = await app.request("/api/reports/weekly", {
      headers: { Authorization: `Bearer ${OPS_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      weekTag: string;
      window: { days: number };
      projects: Array<{
        projectId: string;
        pendingReport: boolean;
        completedTasks: Array<{ title: string; resultSummary: string | null }>;
        inFlightTasks: Array<{ title: string; status: string }>;
        milestonesCompleted: unknown[];
        milestonesUpcoming: Array<{ title: string }>;
        resolvedTickets: unknown[];
        openTickets: number;
      }>;
      contactsByOrganization: Record<string, Array<{ id: string }>>;
    };

    expect(body.weekTag).toMatch(/^\d{4}-W\d{2}$/);
    expect(body.window.days).toBe(7);

    const mine = body.projects.find((p) => p.projectId === projectId);
    expect(mine).toBeDefined();
    expect(mine!.pendingReport).toBe(false);
    expect(mine!.completedTasks.map((t) => t.title)).toEqual(["Hecha esta semana"]);
    expect(mine!.completedTasks[0]!.resultSummary).toBe("tests verdes");
    expect(mine!.inFlightTasks.map((t) => t.title)).toEqual(["En curso"]);
    expect(mine!.milestonesUpcoming.map((m) => m.title)).toContain("Hito próximo");
    expect(mine!.resolvedTickets).toHaveLength(1);
    expect(mine!.openTickets).toBe(1);
    expect(body.contactsByOrganization[orgId]?.some((ct) => ct.id === contactId)).toBe(true);
  });

  it("flags a project whose weekly report is already pending approval", async () => {
    await db.insert(outbox).values({
      organizationId: orgId,
      contactId,
      channel: "email",
      subject: "Avance semanal",
      body: "x",
      status: "pending_approval",
      metadata: { reportWeek: isoWeekTag(), projectId },
      createdBy: "test",
    });

    const res = await app.request("/api/reports/weekly", {
      headers: { Authorization: `Bearer ${OPS_KEY}` },
    });
    const body = (await res.json()) as { projects: Array<{ projectId: string; pendingReport: boolean }> };
    expect(body.projects.find((p) => p.projectId === projectId)?.pendingReport).toBe(true);
  });

  it("requires ops scope", async () => {
    const res = await app.request("/api/reports/weekly");
    expect(res.status).toBe(401);
  });
});

describe("isoWeekTag", () => {
  it("computes ISO-8601 weeks including year boundaries", () => {
    // 2026-01-01 is a Thursday: ISO week 1 of 2026.
    expect(isoWeekTag(new Date("2026-01-01T12:00:00Z"))).toBe("2026-W01");
    // 2024-12-30 falls in ISO week 1 of 2025.
    expect(isoWeekTag(new Date("2024-12-30T12:00:00Z"))).toBe("2025-W01");
    expect(isoWeekTag(new Date("2026-11-12T12:00:00Z"))).toBe("2026-W46");
  });
});
