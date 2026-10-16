import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { outbox, contacts, leads, type ChannelType } from "../db/schema";
import { logEvent } from "./events";
import { notifyOutboxDraftCreated } from "../services/telegram";

export interface CreateDraftInput {
  leadId?: string;
  organizationId?: string;
  contactId: string;
  channel: ChannelType;
  subject?: string;
  body: string;
  rationale?: string;
  actor: string;
}

export async function createOutreachDraft(input: CreateDraftInput) {
  if (!input.leadId && !input.organizationId) {
    return {
      success: false,
      code: "target_required",
      message: "A draft must target a lead or an existing client organization.",
    };
  }
  // 1. Verify contact exists and check optOut
  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  if (!contact) {
    throw new Error(`Contact ${input.contactId} not found`);
  }

  if (contact.optOut) {
    return {
      success: false,
      code: "contact_opted_out",
      message: `Cannot create draft: Contact ${contact.name} has opted out of communication.`,
    };
  }

  // 2. WhatsApp consent verification
  if (input.channel === "whatsapp" && !contact.whatsappConsent) {
    return {
      success: false,
      code: "whatsapp_consent_missing",
      message:
        "Cannot create cold WhatsApp draft: Meta policy requires opt-in consent or previous inbound message.",
    };
  }

  // 3. Insert draft strictly as 'pending_approval'
  const [draft] = await db
    .insert(outbox)
    .values({
      leadId: input.leadId,
      organizationId: input.organizationId,
      contactId: input.contactId,
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
