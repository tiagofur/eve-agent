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
  events,
} from "./db/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";

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
    // Defensive sweep: a crashed previous run leaves its fixtures behind
    // (failed afterAlls cascade), and the key hashes collide on re-insert.
    await db
      .delete(apiKeys)
      .where(inArray(apiKeys.keyHash, [hashApiKey(opsKey), hashApiKey(ownerKey)]));
    const [staleProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.name, "TEST-Lifecycle App"))
      .limit(1);
    if (staleProject) await db.delete(tasks).where(eq(tasks.projectId, staleProject.id));
    await db.delete(projects).where(eq(projects.name, "TEST-Lifecycle App"));
    const [staleOrg] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, "TEST-Lifecycle Org"))
      .limit(1);
    if (staleOrg) {
      await db.delete(outbox).where(eq(outbox.organizationId, staleOrg.id));
      await db.delete(tickets).where(eq(tickets.organizationId, staleOrg.id));
      await db.delete(contacts).where(eq(contacts.organizationId, staleOrg.id));
      await db.delete(organizations).where(eq(organizations.id, staleOrg.id));
    }
    // A stale reporter contact can outlive its org (set null on unlink).
    await db
      .delete(contacts)
      .where(
        inArray(contacts.email, ["lifecycle@test.example", "fresh-reporter@test.example"])
      );

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
    try {
      if (contactId) await db.delete(interactions).where(eq(interactions.contactId, contactId));
      // Per-org sweep catches every draft of this run, linked or not.
      if (orgId) await db.delete(outbox).where(eq(outbox.organizationId, orgId));
      for (const id of taskIds) await db.delete(tasks).where(eq(tasks.id, id));
      for (const id of ticketIds) await db.delete(tickets).where(eq(tickets.id, id));
      if (contactId) await db.delete(contacts).where(eq(contacts.id, contactId));
      if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
      if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
    } finally {
      // Keys are swept unconditionally: even a mid-run failure must not make
      // the next run collide on the hash unique index.
      await db
        .delete(apiKeys)
        .where(inArray(apiKeys.keyHash, [hashApiKey(opsKey), hashApiKey(ownerKey)]));
      await pool.end();
    }
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

  // Since GATE 1 approval auto-dispatches the correction, tests walk the
  // auto-created task instead of dispatching manually.
  const newestTaskFor = async (ticketId: string) =>
    (
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.ticketId, ticketId))
        .orderBy(desc(tasks.createdAt))
        .limit(1)
    )[0]!;

  const walkToDone = async (taskId: string, resultSummary = "tests + typecheck OK") => {
    await app.request(`/api/projects/tasks/${taskId}/approve`, { method: "POST", headers: ownerHeaders });
    for (const status of ["dispatched", "in_progress", "in_review", "done"]) {
      const res = await app.request(`/api/projects/tasks/${taskId}/status`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status, resultSummary, prUrl: "https://github.com/x/y/pull/1" }),
      });
      expect(res.status).toBe(200);
    }
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

  it("owner approval auto-dispatches the correction and keeps the ticket in_progress", async () => {
    const { body } = await createTicket("Lifecycle App flow");
    const ticketId = body.ticketId;

    // Gate 1 is mechanical: ops key (the agent) CANNOT approve its own ticket.
    const opsTry = await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "in_progress", reason: "Agent trying to triage itself" }),
    });
    expect(opsTry.status).toBe(403);

    // Owner triage: open → in_progress (approval to start work).
    const approve = await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress", reason: "Owner approved attention" }),
    });
    expect(approve.status).toBe(200);

    // Approval IS the dispatch order: the correction task exists, linked.
    const task = await newestTaskFor(ticketId);
    taskIds.push(task.id);
    expect(task.status).toBe("pending_approval");
    expect(task.kind).toBe("correction");
    expect(task.projectId).toBe(projectId);
    expect(task.spec).toContain(ticketId);

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(ticket!.status).toBe("in_progress");
  });

  it("auto-resolves the ticket and queues a client notification when the task completes", async () => {
    const { body } = await createTicket("Lifecycle App autoresolve");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });

    const task = await newestTaskFor(ticketId);
    taskIds.push(task.id);
    await walkToDone(task.id);

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
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const task = await newestTaskFor(ticketId);
    taskIds.push(task.id);
    await walkToDone(task.id, "OK");

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
      headers: ownerHeaders,
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
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const task = await newestTaskFor(ticketId);
    taskIds.push(task.id);

    const res = await app.request(`/api/tickets/${ticketId}/details`, { headers });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tasks: Array<{ id: string }>; ticket: { projectName: string | null } };
    expect(json.tasks.map((t) => t.id)).toContain(task.id);
    expect(json.ticket.projectName).toBe("TEST-Lifecycle App");
  });

  it("recomputes slaDueAt when ticket severity changes", async () => {
    const { body } = await createTicket("Lifecycle App sla-edit");
    const [original] = await db.select().from(tickets).where(eq(tickets.id, body.ticketId));
    const originalDue = new Date(original!.slaDueAt).getTime();

    // Changing minor (24h) to critical (1h) recomputes slaDueAt closer to now.
    await app.request(`/api/tickets/${body.ticketId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ severity: "critical" }),
    });

    const [updated] = await db.select().from(tickets).where(eq(tickets.id, body.ticketId));
    const newDue = new Date(updated!.slaDueAt).getTime();
    expect(newDue).toBeLessThan(originalDue);
  });

  it("rejects dispatch on closed tickets and on project mismatches", async () => {
    const { body } = await createTicket("Lifecycle App closed-dispatch");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "closed", reason: "Rejected" }),
    });

    const closedDispatch = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId, ticketId, title: "On closed", spec: "spec", kind: "correction" }),
    });
    expect(closedDispatch.status).toBe(400);
    expect(((await closedDispatch.json()) as { code: string }).code).toBe("ticket_closed");

    // Project mismatch: create another project and try to bind this ticket to it
    const [otherProj] = await db
      .insert(projects)
      .values({ organizationId: orgId, name: "TEST Other Proj", status: "active" })
      .returning();

    const { body: t2 } = await createTicket("Lifecycle App mismatch");
    await app.request(`/api/tickets/${t2.ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });

    const mismatchDispatch = await app.request("/api/projects/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: otherProj!.id,
        ticketId: t2.ticketId,
        title: "Wrong project",
        spec: "spec",
        kind: "correction",
      }),
    });
    expect(mismatchDispatch.status).toBe(400);
    expect(((await mismatchDispatch.json()) as { code: string }).code).toBe("ticket_project_mismatch");

    await db.delete(projects).where(eq(projects.id, otherProj!.id));
  });

  it("rework supersedes previous pending notification draft with latest fix", async () => {
    const { body } = await createTicket("Lifecycle App supersede");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });

    // Run 1: the auto-dispatched correction -> done creates draft 1
    const t1 = await newestTaskFor(ticketId);
    taskIds.push(t1.id);
    await walkToDone(t1.id, "Run 1 fix");

    const [firstDraft] = await db.select().from(outbox).where(eq(outbox.ticketId, ticketId));
    expect(firstDraft!.body).toContain("Run 1 fix");

    // Client says "still broken": reopen -> re-approval auto-dispatches task 2
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "open", reason: "Still broken" }),
    });
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });

    const t2 = await newestTaskFor(ticketId);
    taskIds.push(t2.id);
    expect(t2.id).not.toBe(t1.id);
    await walkToDone(t2.id, "Run 2 real fix");

    // Still only ONE pending draft, updated with Run 2 fix instead of stale Run 1!
    const drafts = await db.select().from(outbox).where(eq(outbox.ticketId, ticketId));
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.body).toContain("Run 2 real fix");
    await db.delete(outbox).where(eq(outbox.id, drafts[0]!.id));
  });

  it("audits failure when markDraftSent cannot sync an already closed ticket", async () => {
    const { body } = await createTicket("Lifecycle App audit-sync");
    const ticketId = body.ticketId;
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });
    const task = await newestTaskFor(ticketId);
    taskIds.push(task.id);
    await walkToDone(task.id);

    const [draft] = await db.select().from(outbox).where(eq(outbox.ticketId, ticketId));
    await app.request(`/api/outbox/${draft!.id}/review`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });

    // Manually force-close the ticket before sending
    await app.request(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "closed", reason: "Premature close" }),
    });

    // markDraftSent succeeds for the draft, but audits the sync failure (closed -> waiting_client is invalid)
    const sent = await app.request(`/api/outbox/${draft!.id}/sent`, {
      method: "POST",
      headers: ownerHeaders,
    });
    expect(sent.status).toBe(200);

    const [audit] = await db
      .select()
      .from(events)
      .where(sql`${events.action} = 'draft_sent_ticket_sync_failed' AND ${events.entityId} = ${draft!.id}`);
    expect(audit).not.toBeUndefined();
    await db.delete(outbox).where(eq(outbox.id, draft!.id));
  });

  it("auto-resolves first-time reporter with auto-created org", async () => {
    const freshEmail = "fresh-reporter@test.example";
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientName: "Fresh Reporter",
        companyName: "Brand New Client Corp",
        contact: freshEmail,
        system: "Fresh System",
        severity: "minor",
        kind: "support",
        description: "Brand new client bug",
        projectId,
      }),
    });
    const body = (await res.json()) as { ticketId: string };
    ticketIds.push(body.ticketId);

    // Verify contact and org were linked
    const [freshTicket] = await db.select().from(tickets).where(eq(tickets.id, body.ticketId));
    expect(freshTicket!.organizationId).not.toBeNull();

    await app.request(`/api/tickets/${body.ticketId}/status`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ status: "in_progress" }),
    });

    const task = await newestTaskFor(body.ticketId);
    taskIds.push(task.id);
    await walkToDone(task.id, "Fresh fix verified");

    const [freshDraft] = await db.select().from(outbox).where(eq(outbox.ticketId, body.ticketId));
    expect(freshDraft).not.toBeUndefined();
    expect(freshDraft!.status).toBe("pending_approval");

    // Clean up fresh contact and org
    await db.delete(outbox).where(eq(outbox.id, freshDraft!.id));
    await db.delete(contacts).where(eq(contacts.email, freshEmail));
    await db.delete(organizations).where(eq(organizations.name, "Brand New Client Corp"));
  });
});
