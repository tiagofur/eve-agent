import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import {
  apiKeys,
  organizations,
  projects,
  tasks,
  tickets,
  contacts,
  outbox,
  interactions,
} from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Support lifecycle (ITIL-inspired): ticket → owner triage → linked
 * correction task → done auto-resolves the ticket + queues a client
 * notification draft → owner approves + marks sent → ticket waits for the
 * client → closed. The mechanical gates are enforced by the CRM, not by
 * agent behavior.
 */
describe("support ticket → correction → client notification lifecycle", () => {
  const opsKey = "cp_ops_lifecycle1234567890abcdef1234";
  const ownerKey = "cp_owner_lifecycle1234567890abcdef12";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const ownerHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` };

  let orgId = "";
  let projectId = "";
  let contactId = "";
  const ticketIds: string[] = [];
  const taskIds: string[] = [];
  const draftIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Lifecycle Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Lifecycle Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
    ]);
    const [org] = await db
      .insert(organizations)
      .values({ name: "TEST-Lifecycle Org" })
      .returning();
    orgId = org!.id;
    const [project] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST-Lifecycle App", status: "active" })
      .returning();
    projectId = project!.id;
    const [contact] = await db
      .insert(contacts)
      .values({
        name: "Lifecycle Client",
        email: "lifecycle@test.example",
        organizationId: orgId,
      })
      .returning();
    contactId = contact!.id;
  });

  afterAll(async () => {
    await db.delete(interactions).where(eq(interactions.contactId, contactId));
    // Per-org sweep catches every draft of this run, linked or not.
    await db.delete(outbox).where(eq(outbox.organizationId, orgId));
    for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
    for (const id of ticketIds) await db.delete(tickets).where(eq(tickets.id, id));
    await db.delete(contacts).where(eq(contacts.id, contactId));
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(ownerKey)));
    await pool.end();
  });

  const createTicket = async (system: string) => {
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientName: "Lifecycle Client",
        contact: "lifecycle@test.example",
        system,
        severity: "minor",
        kind: "support",
        description: "Real problem description with repro steps",
        projectId,
      }),
    });
    const body = (await res.json()) as { ticketId: string };
    ticketIds.push(body.ticketId);
    return { res, body };
  };

  it("creates a ticket linked to the project and organization", async () => {
    const { res, body } = await createTicket("Lifecycle App login");

    expect(res.status).toBe(201);
    const [row] = await db.select().from(tickets).where(eq(tickets.id, body.ticketId));
    expect(row!.projectId).toBe(projectId);
    expect(row!.organizationId).toBe(orgId);
    expect(row!.contactId).toBe(contactId);
    expect(row!.status).toBe("open");
  });

  it("rejects a correction dispatch while the ticket awaits triage (mechanical gate)", async () => {
    const { body } = await createTicket("Lifecycle App gate");
    const res = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId,
        ticketId: body.ticketId,
        title: "Fix gate",
        spec: "spec",
        kind: "correction",
      }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("ticket_not_approved");
  });

  it("allows dispatch after owner triage and keeps the ticket in_progress", async () => {
    const { body } = await createTicket("Lifecycle App flow");
    const ticketId = body.ticketId;

    // Owner triage: open → in_progress (approval to start work).
    const approve = await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress", reason: "Owner approved attention" }),
    });
    expect(approve.status).toBe(200);

    const dispatch = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId,
        ticketId,
        title: "Fix the real problem",
        spec: "Full engineering spec",
        kind: "correction",
      }),
    });
    expect(dispatch.status).toBe(201);
    const taskJson = (await dispatch.json()) as { task: { id: string } };
    taskIds.push(taskJson.task.id);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskJson.task.id));
    expect(task!.ticketId).toBe(ticketId);

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.status).toBe("in_progress");
  });

  it("auto-resolves the ticket and queues a client notification when the task completes", async () => {
    const { body } = await createTicket("Lifecycle App autoresolve");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });

    const dispatch = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId,
        ticketId,
        title: "Fix autoresolve",
        spec: "spec",
        kind: "correction",
      }),
    });
    const taskJson = (await dispatch.json()) as { task: { id: string } };
    const taskId = taskJson.task.id;
    taskIds.push(taskId);

    // Walk the machine to done: approve (owner) → dispatched → in_progress → in_review → done.
    await app.request(`/api/projects/tasks/${taskId}/approve`, { method: "POST", headers: ownerHeaders });
    for (const status of ["dispatched", "in_progress", "in_review", "done"]) {
      const res = await app.request(`/api/projects/tasks/${taskId}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status, resultSummary: "tests + typecheck OK", prUrl: "https://github.com/x/y/pull/1" }),
      });
      expect(res.status).toBe(200);
    }

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.status).toBe("resolved");
    expect(ticket!.resolvedAt).not.toBeNull();

    const drafts = await db.select().from(outbox).where(eq(outbox.ticketId, ticketId));
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.status).toBe("pending_approval");
    expect(drafts[0]!.channel).toBe("email");
    // Remove immediately: the pending-draft dedup (one per org+contact) must
    // not leak into the next test's auto-draft.
    await db.delete(outbox).where(eq(outbox.id, drafts[0]!.id));
  });

  it("sent draft logs the interaction and moves the ticket to waiting_client", async () => {
    const { body } = await createTicket("Lifecycle App sent");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const dispatch = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, ticketId, title: "Fix sent", spec: "spec", kind: "correction" }),
    });
    const taskJson = (await dispatch.json()) as { task: { id: string } };
    taskIds.push(taskJson.task.id);
    await app.request(`/api/projects/tasks/${taskJson.task.id}/approve`, { method: "POST", headers: ownerHeaders });
    for (const status of ["dispatched", "in_progress", "in_review", "done"]) {
      await app.request(`/api/projects/tasks/${taskJson.task.id}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status, resultSummary: "OK" }),
      });
    }

    const [draft] = await db.select().from(outbox).where(eq(outbox.ticketId, ticketId));
    draftIds.push(draft!.id);

    const review = await app.request(`/api/outbox/${draft!.id}/review`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(review.status).toBe(200);

    const sent = await app.request(`/api/outbox/${draft!.id}/sent`, {
      method: "POST",
      headers: ownerHeaders,
    });
    expect(sent.status).toBe(200);

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.status).toBe("waiting_client");

    const logged = await db.select().from(interactions).where(eq(interactions.ticketId, ticketId));
    expect(logged.length).toBe(1);
    expect(logged[0]!.direction).toBe("outbound");
  });

  it("closes after client confirmation and reopening clears resolvedAt", async () => {
    const { body } = await createTicket("Lifecycle App close");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "resolved", reason: "Fixed directly" }),
    });

    const close = await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "closed", reason: "Client confirmed" }),
    });
    expect(close.status).toBe(200);

    const reopen = await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "open", reason: "Client reports it persists" }),
    });
    expect(reopen.status).toBe(200);

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.status).toBe("open");
    expect(ticket!.resolvedAt).toBeNull();
  });

  it("rejects invalid ticket transitions", async () => {
    const { body } = await createTicket("Lifecycle App invalid");
    const ticketId = body.ticketId;

    const res = await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_transition");
  });

  it("edits ticket content with audit (the fix-a-vague-ticket path)", async () => {
    const { body } = await createTicket("Lifecycle App edit");
    const res = await app.request(`/api/tickets/${body.ticketId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        description: "Corrected real description: login fails on session expiry, repro: ...",
        severity: "major",
        reason: "Intake captured a placeholder description",
      }),
    });
    expect(res.status).toBe(200);

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, body.ticketId));
    expect(ticket!.description).toContain("Corrected real description");
    expect(ticket!.severity).toBe("major");
  });

  it("exposes linked tasks in ticket details", async () => {
    const { body } = await createTicket("Lifecycle App details");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const dispatch = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, ticketId, title: "Fix details", spec: "spec", kind: "correction" }),
    });
    const taskJson = (await dispatch.json()) as { task: { id: string } };
    taskIds.push(taskJson.task.id);

    const res = await app.request(`/api/tickets/${ticketId}/details`, { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tasks: Array<{ id: string }> };
    expect(json.tasks.map((t) => t.id)).toContain(taskJson.task.id);
  });
});
