import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, organizations, projects, tasks, tickets, events } from "./db/schema";
import { and, eq, sql } from "drizzle-orm";

/**
 * GATE 1 handoff is mechanical: approving a support ticket (open →
 * in_progress) dispatches its correction to the coding queue
 * (pending_approval, GATE 2) without waiting for the agent to notice.
 * Tickets without a project (or `info` tickets) never dispatch; every skip
 * is audited on the ticket timeline.
 */
describe("ticket approval auto-dispatches the correction", () => {
  const opsKey = "cp_ops_autodispq7z42xk90abcdef12345678";
  const ownerKey = "cp_owner_autodispq7z42xk90abcdef123456";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const ownerHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` };

  let orgId = "";
  let projectId = "";
  let otherProjectId = "";
  const ticketIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "AutoDisp Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "AutoDisp Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
    ]);
    const [org] = await db
      .insert(organizations)
      .values({ name: "TEST-AutoDisp Org" })
      .returning();
    orgId = org!.id;
    const [project] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST-AutoDisp App", status: "active" })
      .returning();
    projectId = project!.id;
    const [other] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST-AutoDisp Other", status: "active" })
      .returning();
    otherProjectId = other!.id;
  });

  afterAll(async () => {
    // Project deletion cascades to tasks (auto-dispatched ones included).
    for (const id of ticketIds) await db.delete(tickets).where(eq(tickets.id, id));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(projects).where(eq(projects.id, otherProjectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(ownerKey)));
    await pool.end();
  });

  const createTicket = async (system: string, extra: Record<string, unknown> = {}) => {
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientName: "AutoDisp Client",
        contact: "autodisp@test.example",
        system,
        severity: "minor",
        kind: "support",
        description: "Real problem: schedule comes out in the wrong timezone",
        ...extra,
      }),
    });
    const body = (await res.json()) as { ticketId: string };
    ticketIds.push(body.ticketId);
    return body.ticketId;
  };

  const approve = (ticketId: string) =>
    app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress", reason: "Owner approved attention" }),
    });

  const linkedTasks = (ticketId: string) =>
    db.select().from(tasks).where(eq(tasks.ticketId, ticketId));

  const ticketEvent = (ticketId: string, action: string) =>
    db
      .select()
      .from(events)
      .where(and(eq(events.entityId, ticketId), eq(events.action, action)));

  it("approval creates the pending correction linked to the ticket and project", async () => {
    const ticketId = await createTicket("AutoDisp App timezone", { projectId });

    const res = await approve(ticketId);
    expect(res.status).toBe(200);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("pending_approval");
    expect(rows[0]!.kind).toBe("correction");
    expect(rows[0]!.projectId).toBe(projectId);
    expect(rows[0]!.assignee).toBe("gentle-shell");
    expect(rows[0]!.spec).toContain(ticketId);
    expect(rows[0]!.spec).toContain("timezone");

    const [audit] = await ticketEvent(ticketId, "correction_auto_dispatched");
    expect(audit).not.toBeUndefined();
  });

  it("re-approval does not duplicate the correction while one is active", async () => {
    const ticketId = await createTicket("AutoDisp App dup", { projectId });
    await approve(ticketId);

    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "open", reason: "Reopen attention" }),
    });
    await approve(ticketId);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(1);
  });

  it("a rejected correction does not block a fresh dispatch on re-approval", async () => {
    const ticketId = await createTicket("AutoDisp App retry", { projectId });
    await approve(ticketId);
    const [first] = await linkedTasks(ticketId);

    const reject = await app.request(`/api/projects/tasks/${first!.id}/reject`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ reason: "Wrong approach, try again" }),
    });
    expect(reject.status).toBe(200);

    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "open", reason: "Needs another attempt" }),
    });
    await approve(ticketId);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(2);
    expect(rows.filter((t) => t.status === "pending_approval").length).toBe(1);
  });

  it("approving without a project blocks the dispatch with an audit event", async () => {
    const ticketId = await createTicket("AutoDisp App nolink");

    const res = await approve(ticketId);
    expect(res.status).toBe(200);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(0);
    const [blocked] = await ticketEvent(ticketId, "correction_dispatch_blocked");
    expect(blocked).not.toBeUndefined();
  });

  it("linking a project to an approved ticket dispatches the held correction", async () => {
    const ticketId = await createTicket("AutoDisp App late-link");
    await approve(ticketId);
    expect((await linkedTasks(ticketId)).length).toBe(0);

    const link = await app.request(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ projectId, reason: "Owner picked the right project" }),
    });
    expect(link.status).toBe(200);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.projectId).toBe(projectId);
  });

  it("re-linking to a different project supersedes the pending correction and re-dispatches", async () => {
    const ticketId = await createTicket("AutoDisp App relink", { projectId });
    await approve(ticketId);
    expect((await linkedTasks(ticketId)).length).toBe(1);

    const relink = await app.request(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ projectId: otherProjectId, reason: "Owner corrected the target" }),
    });
    expect(relink.status).toBe(200);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(2);
    expect(rows.filter((t) => t.status === "rejected").length).toBe(1);
    const [pending] = rows.filter((t) => t.status === "pending_approval");
    expect(pending!.projectId).toBe(otherProjectId);
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.projectId).toBe(otherProjectId);
  });

  it("info tickets never dispatch corrections", async () => {
    const ticketId = await createTicket("AutoDisp App info", {
      kind: "info",
      projectId,
    });

    const res = await approve(ticketId);
    expect(res.status).toBe(200);

    const rows = await linkedTasks(ticketId);
    expect(rows.length).toBe(0);
  });

  it("ticket details expose the linked project for owner verification", async () => {
    const ticketId = await createTicket("AutoDisp App details", { projectId });

    const res = await app.request(`/api/tickets/${ticketId}/details`, { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ticket: { projectId: string | null; projectName: string | null } };
    expect(json.ticket.projectId).toBe(projectId);
    expect(json.ticket.projectName).toBe("TEST-AutoDisp App");
  });
});
