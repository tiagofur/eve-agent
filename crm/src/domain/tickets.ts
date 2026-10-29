import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  tickets,
  tasks,
  contacts,
  organizations,
  outbox,
  projects,
  type ticketSeverityEnum,
  type ticketStatusEnum,
  type ticketKindEnum,
} from "../db/schema";
import { logEvent } from "./events";
import { notifySupportTicketCreated } from "../services/telegram";
import { createOutreachDraft } from "./outbox";
// Runtime-only cycle with ./projects (both modules only call each other's
// exports inside function bodies): safe for ESM live bindings. Do not add a
// module-scope call on either side.
import { createTask, rejectTask } from "./projects";

export type TicketSeverity = (typeof ticketSeverityEnum.enumValues)[number];
export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
export type TicketKind = (typeof ticketKindEnum.enumValues)[number];

export interface CreateTicketInput {
  clientName: string;
  companyName?: string;
  /**
   * Follow-up channel (email/phone). Optional for `info` questions from
   * strangers; required for `support` incidents (rejected loudly otherwise).
   */
  contact?: string;
  system: string;
  /** Meaningless for `info` (24h commercial SLA always): defaults to minor. */
  severity?: TicketSeverity;
  kind?: TicketKind;
  description: string;
  /** Affected client project, when known. Validated to exist when provided. */
  projectId?: string;
  actor: string;
}

export type CreateTicketResult =
  | { success: true; ticket: typeof tickets.$inferSelect; slaHours: number; duplicate?: boolean }
  | { success: false; code: string; message: string };

export function computeSlaDueAt(severity: TicketSeverity, kind: TicketKind = "support"): Date {
  const now = new Date();
  // Info/sales requests always carry a commercial 24h SLA, regardless of severity.
  if (kind === "info") {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  switch (severity) {
    case "critical":
      return new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour
    case "major":
      return new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4 hours
    case "minor":
    default:
      return new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
  }
}

export async function createTicket(input: CreateTicketInput): Promise<CreateTicketResult> {
  const kind = input.kind ?? "support";
  const severity = input.severity ?? "minor";
  const rawContact = input.contact?.trim() || undefined;

  // Support incidents without a follow-up channel cannot be worked:
  // refuse loudly instead of logging a dead ticket.
  if (kind === "support" && !rawContact) {
    return {
      success: false,
      code: "contact_required",
      message: "Support incidents require a contact email or phone for follow-up.",
    };
  }

  const slaDueAt = computeSlaDueAt(severity, kind);

  // 0. Optional project link: reject ghost projects loudly (S1) instead of
  // silently dropping the linkage or failing on the FK at insert time.
  let linkedProjectId: string | undefined;
  if (input.projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) {
      return {
        success: false,
        code: "project_not_found",
        message: `Project ${input.projectId} not found`,
      };
    }
    linkedProjectId = input.projectId;
  }

  // 1. Resolve contact/org if possible
  const isEmail = !!rawContact && rawContact.includes("@");
  let contactId: string | undefined = undefined;
  let organizationId: string | undefined = undefined;

  if (rawContact) {
    const [existingContact] = await db
      .select()
      .from(contacts)
      .where(isEmail ? eq(contacts.email, rawContact.toLowerCase()) : eq(contacts.phone, rawContact))
      .limit(1);

    if (existingContact) {
      contactId = existingContact.id;
      organizationId = existingContact.organizationId ?? undefined;
    } else {
      const [newContact] = await db
        .insert(contacts)
        .values({
          name: input.clientName.trim(),
          email: isEmail ? rawContact.toLowerCase() : undefined,
          phone: !isEmail ? rawContact : undefined,
        })
        .returning();
      if (newContact) {
        contactId = newContact.id;
      }
    }

    // A first-time reporter has no org on their contact, which would make
    // the resolution notification unaddressable. companyName (or the client
    // name as company) resolves to an existing org or creates one — the same
    // way lead intake does — so the auto-notification can always draft.
    if (contactId && !organizationId) {
      const orgName = input.companyName?.trim() || input.clientName.trim();
      if (orgName) {
        const [existingOrg] = await db
          .select()
          .from(organizations)
          .where(sql`LOWER(${organizations.name}) = LOWER(${orgName})`)
          .limit(1);
        const org =
          existingOrg ??
          (await db.insert(organizations).values({ name: orgName }).returning())[0];
        if (org) {
          organizationId = org.id;
          await db.update(contacts).set({ organizationId: org.id }).where(eq(contacts.id, contactId));
        }
      }
    }
  }

  // 2. Open-ticket dedup (S1): same contact + system + kind with a ticket
  // still open (not resolved/closed) is the same incident — return it
  // instead of duplicating and re-paging the owner. System matches
  // case-insensitively; contact-less info tickets always log fresh.
  if (contactId) {
    const [openTicket] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.contactId, contactId),
          sql`LOWER(${tickets.system}) = LOWER(${input.system.trim()})`,
          eq(tickets.kind, kind),
          not(inArray(tickets.status, ["resolved", "closed"]))
        )
      )
      .orderBy(desc(tickets.createdAt))
      .limit(1);

    if (openTicket) {
      await logEvent({
        entity: "ticket",
        entityId: openTicket.id,
        action: "ticket_duplicate_skipped",
        actor: input.actor,
        after: { kind, system: input.system },
        reason: "Repeat report of an open incident",
      });
      return {
        success: true,
        ticket: openTicket,
        slaHours: kind === "info" ? 24 : openTicket.severity === "critical" ? 1 : openTicket.severity === "major" ? 4 : 24,
        duplicate: true as const,
      };
    }
  }

  const [ticket] = await db
    .insert(tickets)
    .values({
      contactId,
      organizationId,
      projectId: linkedProjectId,
      kind,
      system: input.system,
      severity,
      status: "open",
      description: input.description,
      slaDueAt,
    })
    .returning();

  if (!ticket) {
    throw new Error("Failed to create ticket");
  }

  await logEvent({
    entity: "ticket",
    entityId: ticket.id,
    action: "ticket_created",
    actor: input.actor,
    after: {
      kind,
      severity,
      system: input.system,
      slaDueAt: slaDueAt.toISOString(),
    },
    reason: input.description,
  });

  // Every support incident pages the owner for triage (approve/reject);
  // critical and major carry SLA urgency in the message. Info requests
  // wait in the queue without paging.
  if (kind === "support") {
    notifySupportTicketCreated(ticket.id).catch((err) =>
      console.error("Failed to dispatch telegram ticket alert:", err)
    );
  }

  return {
    success: true,
    ticket,
    slaHours: kind === "info" ? 24 : severity === "critical" ? 1 : severity === "major" ? 4 : 24,
  };
}

export interface UpdateTicketContentInput {
  ticketId: string;
  /** Corrected/expanded problem statement. The audit event keeps before/after. */
  description?: string;
  system?: string;
  severity?: TicketSeverity;
  kind?: TicketKind;
  projectId?: string | null;
  actor: string;
  reason?: string;
}

export type UpdateTicketContentResult =
  | { success: true; ticket: typeof tickets.$inferSelect }
  | { success: false; code: string; message: string };

/**
 * Edit a ticket's content (description, system, severity, kind, project).
 * This is the correction path for tickets logged with vague or wrong data:
 * fixing the record beats superseding it with a new ticket.
 */
export async function updateTicketContent(
  input: UpdateTicketContentInput
): Promise<UpdateTicketContentResult> {
  const [current] = await db.select().from(tickets).where(eq(tickets.id, input.ticketId)).limit(1);
  if (!current) {
    return { success: false, code: "ticket_not_found", message: `Ticket ${input.ticketId} not found` };
  }

  if (input.projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) {
      return {
        success: false,
        code: "project_not_found",
        message: `Project ${input.projectId} not found`,
      };
    }
  }

  // Severity/kind edits re-arm the SLA clock: a minor corrected to critical
  // must not keep parading a 24h deadline the desk treats as truth.
  const nextSeverity = input.severity ?? current.severity;
  const nextKind = input.kind ?? current.kind;
  const slaChanged =
    (input.severity !== undefined && input.severity !== current.severity) ||
    (input.kind !== undefined && input.kind !== current.kind);

  const [updated] = await db
    .update(tickets)
    .set({
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.system !== undefined ? { system: input.system } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(slaChanged ? { slaDueAt: computeSlaDueAt(nextSeverity, nextKind) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, input.ticketId))
    .returning();

  if (!updated) {
    return { success: false, code: "ticket_not_found", message: `Ticket ${input.ticketId} not found` };
  }

  await logEvent({
    entity: "ticket",
    entityId: input.ticketId,
    action: "ticket_updated",
    actor: input.actor,
    before: {
      description: current.description,
      system: current.system,
      severity: current.severity,
      kind: current.kind,
      projectId: current.projectId,
    },
    after: {
      description: updated.description,
      system: updated.system,
      severity: updated.severity,
      kind: updated.kind,
      projectId: updated.projectId,
    },
    reason: input.reason || "Ticket content corrected",
  });

  // Any project change on an approved support ticket supersedes pending
  // corrections aimed at the old link — unlinking included: a pending
  // correction must never outlive the project it was dispatched from.
  // Re-linking to a NEW project then re-dispatches to the right target;
  // approved or in-flight work is never touched (rejectTask only accepts
  // pending).
  const projectChanged =
    input.projectId !== undefined && input.projectId !== current.projectId;
  if (projectChanged && updated.kind === "support" && updated.status === "in_progress") {
    const pendingCorrections = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.ticketId, input.ticketId), eq(tasks.status, "pending_approval")));
    for (const pending of pendingCorrections) {
      await rejectTask({
        taskId: pending.id,
        reason: input.projectId
          ? "Superseded: the ticket was re-linked to a different project"
          : "Superseded: the ticket's project link was removed",
        actor: input.actor,
      });
    }
    if (input.projectId) {
      await maybeDispatchCorrection(input.ticketId, input.actor);
    }
  }

  return { success: true, ticket: updated };
}

/**
 * Ticket lifecycle machine. `open` is triage: it can only start work
 * (in_progress) or be rejected (closed). Reopening goes through `open`.
 * resolved → waiting_client happens when the resolution notification
 * reaches the client; resolved → in_progress covers rework dispatches.
 */
const TICKET_MACHINE: Record<TicketStatus, TicketStatus[]> = {
  open: ["in_progress", "closed"],
  in_progress: ["waiting_client", "resolved", "closed", "open"],
  waiting_client: ["resolved", "in_progress", "closed", "open"],
  resolved: ["closed", "open", "in_progress", "waiting_client"],
  closed: ["open"],
};

export interface UpdateTicketStatusInput {
  ticketId: string;
  status: TicketStatus;
  actor: string;
  reason?: string;
  clientMessage?: string;
}

export async function updateTicketStatus(input: UpdateTicketStatusInput) {
  const [current] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, input.ticketId))
    .limit(1);

  if (!current) {
    return { success: false, message: "Ticket not found", code: "NOT_FOUND" as const };
  }

  const from = current.status;
  if (from === input.status) {
    return { success: true, ticket: current };
  }
  if (!TICKET_MACHINE[from].includes(input.status)) {
    return {
      success: false,
      code: "invalid_transition",
      message: `Invalid ticket transition: ${from} → ${input.status}`,
    };
  }

  const isResolving = input.status === "resolved";
  // Any exit from `resolved` clears the stale resolution timestamp: a ticket
  // back in rework must not parade a resolvedAt it no longer has.
  const leavingResolved = from === "resolved" && !isResolving;
  const [updated] = await db
    .update(tickets)
    .set({
      status: input.status,
      resolvedAt: isResolving ? new Date() : leavingResolved ? null : current.resolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, input.ticketId))
    .returning();

  await logEvent({
    entity: "ticket",
    entityId: input.ticketId,
    action: `ticket_${input.status}`,
    actor: input.actor,
    before: { status: current.status },
    after: { status: input.status, clientMessage: input.clientMessage },
    reason: input.reason || `Status changed to ${input.status}`,
  });

  // GATE 1 handoff is mechanical: owner approval IS the dispatch order. The
  // correction task lands in the coding queue (pending_approval, GATE 2)
  // without depending on the agent noticing the approval.
  if (from === "open" && input.status === "in_progress") {
    await maybeDispatchCorrection(input.ticketId, input.actor);
  }

  return { success: true, ticket: updated };
}

/** Task statuses that count as an in-flight correction attempt. */
const ACTIVE_CORRECTION_STATUSES = [
  "pending_approval",
  "approved",
  "ready",
  "dispatched",
  "in_progress",
  "in_review",
  "blocked",
] as const;

/**
 * Dispatch the ticket's correction to the coding queue when the pipeline
 * expects one: an approved `support` ticket with a linked project and no
 * active correction task. A rejected/done task never blocks a fresh attempt.
 * The owner-blocking skip (no project linked) is audited on the timeline;
 * an info ticket or an already-active attempt returns silently. This hook
 * must never break the transition that triggered it.
 *
 * Race safety lives in the DB: the partial unique index
 * `tasks_one_active_correction_per_ticket` rejects a second active attempt
 * even when two approvals race the check-then-insert (a row lock here would
 * deadlock against the task insert's FK check on this same row).
 */
export async function maybeDispatchCorrection(ticketId: string, actor: string): Promise<void> {
  try {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    if (!ticket || ticket.kind !== "support") return;

    if (!ticket.projectId) {
      await logEvent({
        entity: "ticket",
        entityId: ticketId,
        action: "correction_dispatch_blocked",
        actor,
        after: { reason: "ticket has no project linked — link one to dispatch the correction" },
      });
      return;
    }

    const [active] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(eq(tasks.ticketId, ticketId), inArray(tasks.status, [...ACTIVE_CORRECTION_STATUSES]))
      )
      .limit(1);
    if (active) return;

    const spec =
      `Origen: ticket de soporte ${ticket.id} (severidad ${ticket.severity}, ` +
      `SLA ${ticket.slaDueAt.toISOString()}).\n` +
      `Sistema afectado: ${ticket.system}.\n\n` +
      "Problema reportado (cliente):\n" +
      `${ticket.description}\n\n` +
      "Criterios de aceptación:\n" +
      "- Reproducir el problema descrito y corregirlo en el repo del proyecto.\n" +
      "- Demostrar la corrección con la verificación del proyecto (tests/typecheck/build) " +
      "y resumir en resultSummary qué se ejecutó y el resultado.";

    const result = await createTask({
      projectId: ticket.projectId,
      ticketId: ticket.id,
      title: `Corrección: ${ticket.system}`.slice(0, 200),
      spec,
      assignee: "gentle-shell",
      kind: "correction",
      actor,
    });

    if (!result.success) {
      if (result.code === "correction_already_active") {
        // A concurrent dispatch won the race: one active attempt exists, which
        // is the invariant — audit it and move on.
        await logEvent({
          entity: "ticket",
          entityId: ticketId,
          action: "correction_dispatch_duplicate",
          actor,
          after: { reason: "a concurrent dispatch already created the active correction" },
        });
        return;
      }
      await logEvent({
        entity: "ticket",
        entityId: ticketId,
        action: "correction_auto_dispatch_failed",
        actor,
        after: { code: result.code, error: result.message },
      });
      return;
    }

    await logEvent({
      entity: "ticket",
      entityId: ticketId,
      action: "correction_auto_dispatched",
      actor,
      after: { taskId: result.task.id, title: result.task.title },
      reason: "Owner approval dispatched the correction to the coding queue (GATE 2 pending)",
    });
  } catch (err) {
    await logEvent({
      entity: "ticket",
      entityId: ticketId,
      action: "correction_auto_dispatch_failed",
      actor,
      after: { error: err instanceof Error ? err.message : "unknown error" },
    }).catch(() => {});
  }
}

/**
 * System hook called when a correction task linked to a ticket moves to
 * `done`: resolves the ticket (ITIL: fix applied) and queues a
 * pending_approval outbox draft so the owner can notify the client through
 * their channel. Draft failures never block the resolution — they are
 * audited and surfaced to the owner instead.
 */
export async function autoResolveTicketFromTask(input: {
  ticketId: string;
  taskTitle: string;
  resultSummary: string | null;
  prUrl: string | null;
}): Promise<void> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, input.ticketId)).limit(1);
  if (!ticket || ticket.status === "resolved" || ticket.status === "closed") return;

  const resolution = await updateTicketStatus({
    ticketId: input.ticketId,
    status: "resolved",
    actor: "system:task-done",
    reason: `Correction task completed: ${input.taskTitle}`,
  });

  if (!resolution.success) {
    await logEvent({
      entity: "ticket",
      entityId: input.ticketId,
      action: "ticket_auto_resolve_failed",
      actor: "system:task-done",
      after: { linkedTask: input.taskTitle, error: resolution.message },
    });
    return;
  }

  // Queue the client notification as an owner-approved draft. Requires a
  // contact AND an organization (outbox targets orgs/leads, not bare
  // contacts); skip loudly otherwise. The whole phase is guarded: it runs
  // after the task is already done, so a throw here must degrade to an
  // audit event, never bubble into a 500 the owner cannot recover from
  // (retrying `done` no-ops and would never re-enter this hook).
  try {
    if (!ticket.contactId || !ticket.organizationId) {
      await logEvent({
        entity: "ticket",
        entityId: input.ticketId,
        action: "client_notification_skipped",
        actor: "system:task-done",
        after: { reason: "ticket has no contact or no organization to address the draft" },
      });
      return;
    }

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, ticket.contactId))
      .limit(1);

    const channel = contact?.email ? ("email" as const) : ("whatsapp" as const);
    const evidence = input.prUrl ? `\n\nReferencia técnica: ${input.prUrl}` : "";
    const subject = `Resuelto: ${ticket.system}`;
    const body =
      `Hola${contact?.name ? ` ${contact.name}` : ""},\n\n` +
      `Tu reporte sobre "${ticket.system}" fue atendido y resuelto. ` +
      `Resumen de la solución:\n${(input.resultSummary ?? input.taskTitle).slice(0, 600)}${evidence}\n\n` +
      `Si el problema persiste, responde a este mensaje y reabrimos el caso de inmediato.`;
    const rationale = `Auto-draft: ticket ${input.ticketId} resolved by correction task "${input.taskTitle}".`;

    // Rework supersede: if a pending draft for this recipient still cites the
    // PREVIOUS (failed) fix, refresh it with the latest resolution instead of
    // skipping — the owner must review the current truth, not stale content.
    const [pending] = await db
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.organizationId, ticket.organizationId),
          eq(outbox.contactId, ticket.contactId),
          eq(outbox.status, "pending_approval")
        )
      )
      .limit(1);

    if (pending) {
      await db
        .update(outbox)
        .set({ ticketId: input.ticketId, subject, body, rationale, updatedAt: new Date() })
        .where(eq(outbox.id, pending.id));
      await logEvent({
        entity: "outbox",
        entityId: pending.id,
        action: "draft_refreshed",
        actor: "system:task-done",
        after: { reason: `Superseded by newer resolution of ticket ${input.ticketId}` },
      });
      return;
    }

    const draft = await createOutreachDraft({
      organizationId: ticket.organizationId,
      contactId: ticket.contactId,
      ticketId: input.ticketId,
      channel,
      subject,
      body,
      rationale,
      actor: "system:task-done",
    });

    if (!draft.success) {
      await logEvent({
        entity: "ticket",
        entityId: input.ticketId,
        action: "client_notification_skipped",
        actor: "system:task-done",
        after: { reason: draft.message, code: draft.code },
      });
    }
  } catch (err) {
    await logEvent({
      entity: "ticket",
      entityId: input.ticketId,
      action: "client_notification_failed",
      actor: "system:task-done",
      after: {
        linkedTask: input.taskTitle,
        error: err instanceof Error ? err.message : "unknown error",
      },
    }).catch(() => {});
  }
}
