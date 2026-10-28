import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { outbox, contacts, leads, interactions, type ChannelType } from "../db/schema";
import { logEvent } from "./events";
import { notifyOutboxDraftCreated } from "../services/telegram";

export interface CreateDraftInput {
  leadId?: string;
  organizationId?: string;
  /**
   * Optional (S5): when omitted, the draft is addressed to the lead and the
   * contact is resolved server-side from `leads.contact_id`. A lead without
   * a contact still gets its draft (contactResolution "missing"); approval
   * is blocked until a contact exists.
   */
  contactId?: string;
  /** Support-ticket notification (e.g. automatic resolution notice). */
  ticketId?: string;
  channel: ChannelType;
  subject?: string;
  body: string;
  rationale?: string;
  actor: string;
}

export type ContactResolution = "explicit" | "lead" | "missing";

interface ResolvedContact {
  contactId: string | null;
  resolution: ContactResolution;
}

/**
 * Opt-out and WhatsApp-consent rules apply only when a contact is known:
 * a contact-less lead draft carries no person to protect yet. The approve
 * gate re-checks both once the contact exists.
 */
function assertContactRules(
  contact: { name: string; optOut: boolean; whatsappConsent: boolean },
  channel: ChannelType
): { code: string; message: string } | null {
  if (contact.optOut) {
    return {
      code: "contact_opted_out",
      message: `Cannot create draft: Contact ${contact.name} has opted out of communication.`,
    };
  }
  if (channel === "whatsapp" && !contact.whatsappConsent) {
    return {
      code: "whatsapp_consent_missing",
      message:
        "Cannot create cold WhatsApp draft: Meta policy requires opt-in consent or previous inbound message.",
    };
  }
  return null;
}

export async function createOutreachDraft(
  input: CreateDraftInput
): Promise<
  | { success: true; draft: typeof outbox.$inferSelect; contactResolution: ContactResolution }
  | { success: false; code: string; message: string }
> {
  if (!input.leadId && !input.organizationId) {
    return {
      success: false,
      code: "target_required",
      message: "A draft must target a lead or an existing client organization.",
    };
  }

  // 0. Dedup (S1): one pending draft per lead. A second nudge while the
  // first still awaits approval stacks noise in the outbox; the owner
  // reviews the pending one instead. Resolved/rejected/approved drafts
  // never block — only the pending one does.
  if (input.leadId) {
    const [pending] = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.leadId, input.leadId), eq(outbox.status, "pending_approval")))
      .limit(1);

    if (pending) {
      return {
        success: false,
        code: "draft_already_pending",
        message: `Lead already has pending draft ${pending.id} awaiting approval. Review that one instead of stacking another.`,
      };
    }
  }

  // Same rule per recipient for existing-client drafts: one pending
  // reminder per organization + contact. A second finding for the same
  // person waits for the owner to review the pending one first.
  if (input.organizationId && input.contactId) {
    const [pendingOrg] = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.organizationId, input.organizationId),
          eq(outbox.contactId, input.contactId),
          eq(outbox.status, "pending_approval")
        )
      )
      .limit(1);

    if (pendingOrg) {
      return {
        success: false,
        code: "draft_already_pending",
        message: `This recipient already has pending draft ${pendingOrg.id} awaiting approval. Review that one instead of stacking another.`,
      };
    }
  }

  // 1. Resolve the recipient: explicit contactId > the lead's contact > none.
  let resolved: ResolvedContact;
  if (input.contactId) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .limit(1);

    if (!contact) {
      return {
        success: false,
        code: "contact_not_found",
        message: `Contact ${input.contactId} not found`,
      };
    }

    const violation = assertContactRules(contact, input.channel);
    if (violation) return { success: false, ...violation };

    resolved = { contactId: contact.id, resolution: "explicit" };
  } else if (input.leadId) {
    const [lead] = await db.select().from(leads).where(eq(leads.id, input.leadId)).limit(1);

    if (!lead) {
      return {
        success: false,
        code: "lead_not_found",
        message: `Lead ${input.leadId} not found`,
      };
    }

    if (lead.contactId) {
      const [contact] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, lead.contactId))
        .limit(1);

      if (contact) {
        const violation = assertContactRules(contact, input.channel);
        if (violation) return { success: false, ...violation };
        resolved = { contactId: contact.id, resolution: "lead" };
      } else {
        resolved = { contactId: null, resolution: "missing" };
      }
    } else {
      resolved = { contactId: null, resolution: "missing" };
    }
  } else {
    // Organization-targeted drafts still require an explicit contact.
    return {
      success: false,
      code: "contact_required",
      message: "A draft for an existing client organization requires contactId.",
    };
  }

  // 2. Insert draft strictly as 'pending_approval'
  const [draft] = await db
    .insert(outbox)
    .values({
      leadId: input.leadId,
      organizationId: input.organizationId,
      contactId: resolved.contactId,
      ticketId: input.ticketId,
      channel: input.channel,
      subject: input.subject,
      body: input.body,
      rationale: input.rationale,
      status: "pending_approval",
      createdBy: input.actor,
    })
    .returning();

  if (!draft) {
    throw new Error("Failed to insert outbox draft");
  }

  await logEvent({
    entity: "outbox",
    entityId: draft.id,
    action: "draft_created",
    actor: input.actor,
    after: {
      status: "pending_approval",
      channel: input.channel,
      leadId: input.leadId ?? null,
      organizationId: input.organizationId ?? null,
    },
    reason: input.rationale,
  });

  notifyOutboxDraftCreated(draft.id).catch((err) =>
    console.error("Failed to dispatch telegram outbox notification:", err)
  );

  return {
    success: true,
    draft,
    contactResolution: resolved.resolution,
  };
}

export interface ReviewDraftInput {
  draftId: string;
  decision: "approved" | "rejected";
  rejectedReason?: string;
  actor: string; // Must be owner
}

export async function reviewOutreachDraft(input: ReviewDraftInput) {
  const [draft] = await db
    .select()
    .from(outbox)
    .where(eq(outbox.id, input.draftId))
    .limit(1);

  if (!draft) {
    throw new Error(`Draft ${input.draftId} not found`);
  }

  if (draft.status !== "pending_approval") {
    return {
      success: false,
      code: "invalid_status",
      message: `Draft is in status "${draft.status}", can only review pending_approval drafts.`,
    };
  }

  // Approve gate (S5): nothing leaves the outbox without a recipient.
  if (input.decision === "approved") {
    if (!draft.contactId) {
      return {
        success: false,
        code: "contact_missing",
        message:
          "Cannot approve: this draft has no contact yet. Complete the lead's contact first, then approve.",
      };
    }

    // The contact may have been linked after creation: re-check the rules
    // that creation could only apply to a known recipient.
    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, draft.contactId))
      .limit(1);

    if (!contact) {
      return {
        success: false,
        code: "contact_missing",
        message: "Cannot approve: the draft's contact no longer exists.",
      };
    }

    const violation = assertContactRules(contact, draft.channel);
    if (violation) return { success: false, ...violation };
  }

  const newStatus = input.decision === "approved" ? "approved" : "rejected";

  const [updated] = await db
    .update(outbox)
    .set({
      status: newStatus,
      approvedBy: input.decision === "approved" ? input.actor : null,
      approvedAt: input.decision === "approved" ? new Date() : null,
      rejectedReason: input.decision === "rejected" ? input.rejectedReason : null,
      updatedAt: new Date(),
    })
    .where(eq(outbox.id, input.draftId))
    .returning();

  await logEvent({
    entity: "outbox",
    entityId: input.draftId,
    action: `draft_${input.decision}`,
    actor: input.actor,
    before: { status: draft.status },
    after: { status: newStatus },
    reason: input.rejectedReason ?? "Owner review decision",
  });

  return {
    success: true,
    draft: updated,
  };
}

export interface MarkDraftSentInput {
  draftId: string;
  /** Owner confirms the message physically left through the channel. */
  actor: string;
}

export type MarkDraftSentResult =
  | { success: true; draft: typeof outbox.$inferSelect }
  | { success: false; code: string; message: string };

/**
 * Owner confirms an approved draft was actually sent (sending itself stays
 * manual copy-paste for now). Side effects: the outbound interaction is
 * logged automatically, and a ticket-linked draft moves its ticket to
 * `waiting_client` — the ITIL state between resolution and confirmation.
 */
export async function markDraftSent(input: MarkDraftSentInput): Promise<MarkDraftSentResult> {
  const [draft] = await db.select().from(outbox).where(eq(outbox.id, input.draftId)).limit(1);
  if (!draft) {
    return { success: false, code: "draft_not_found", message: `Draft ${input.draftId} not found` };
  }
  if (draft.status === "sent") {
    return { success: true, draft };
  }
  if (draft.status !== "approved") {
    return {
      success: false,
      code: "invalid_status",
      message: `Draft is in status "${draft.status}"; only approved drafts can be marked as sent.`,
    };
  }

  const [updated] = await db
    .update(outbox)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(outbox.id, input.draftId))
    .returning();

  await logEvent({
    entity: "outbox",
    entityId: input.draftId,
    action: "draft_sent",
    actor: input.actor,
    before: { status: draft.status },
    after: { status: "sent", channel: draft.channel },
    reason: "Owner confirmed manual send",
  });

  // The client-facing record of what was communicated, on the unified thread.
  await db.insert(interactions).values({
    organizationId: draft.organizationId,
    contactId: draft.contactId,
    leadId: draft.leadId,
    ticketId: draft.ticketId,
    channel: draft.channel,
    direction: "outbound",
    content: draft.body,
    metadata: { outboxDraftId: draft.id, subject: draft.subject ?? null },
  });

  // Ticket-linked notification: the client now has the answer in flight.
  if (draft.ticketId) {
    const { updateTicketStatus } = await import("./tickets");
    await updateTicketStatus({
      ticketId: draft.ticketId,
      status: "waiting_client",
      actor: input.actor,
      reason: "Resolution notification sent to the client",
    });
  }

  return { success: true, draft: updated! };
}
