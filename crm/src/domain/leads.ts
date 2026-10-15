import { eq, and, or, not, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  organizations,
  contacts,
  leads,
  interactions,
  type LeadStage,
  type serviceTypeEnum,
  type channelEnum,
} from "../db/schema";
import { validateTransition } from "./lead-stages";
import { logEvent } from "./events";

export type ServiceType = (typeof serviceTypeEnum.enumValues)[number];
export type ChannelType = (typeof channelEnum.enumValues)[number];

export interface IngestLeadInput {
  clientName: string;
  companyName?: string;
  contact?: string; // email, phone, or whatsapp number. Omit when unknown: the lead is saved without verified contact.
  serviceType?: ServiceType;
  projectSummary: string;
  estimatedBudget?: string;
  source: string; // e.g. "front_agent", "whatsapp", "google_maps", "referral"
  actor: string;
}

export async function ingestLead(input: IngestLeadInput) {
  const rawContact = input.contact?.trim() || undefined;
  const isEmail = !!rawContact && rawContact.includes("@");
  const email = rawContact && isEmail ? rawContact.toLowerCase() : undefined;
  const phone = rawContact && !isEmail ? rawContact : undefined;

  // 1. Resolve or create organization
  let orgId: string | undefined = undefined;
  if (input.companyName && input.companyName.trim().length > 0) {
    const cleanName = input.companyName.trim();
    const [existingOrg] = await db
      .select()
      .from(organizations)
      .where(sql`LOWER(${organizations.name}) = LOWER(${cleanName})`)
      .limit(1);

    if (existingOrg) {
      orgId = existingOrg.id;
    } else {
      const [newOrg] = await db
        .insert(organizations)
        .values({
          name: cleanName,
        })
        .returning();
      if (newOrg) {
        orgId = newOrg.id;
        await logEvent({
          entity: "organization",
          entityId: newOrg.id,
          action: "created",
          actor: input.actor,
          after: { name: newOrg.name },
        });
      }
    }
  }

  // 2. Resolve or create contact with deduplication
  let contactId: string | undefined = undefined;
  let hasOptOut = false;

  if (email) {
    const [existingContact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);

    if (existingContact) {
      contactId = existingContact.id;
      hasOptOut = existingContact.optOut;
    }
  }

  if (!contactId && phone) {
    const [existingContact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, phone))
      .limit(1);

    if (existingContact) {
      contactId = existingContact.id;
      hasOptOut = existingContact.optOut;
    }
  }

  if (!contactId) {
    const [newContact] = await db
      .insert(contacts)
      .values({
        organizationId: orgId,
        name: input.clientName.trim(),
        email,
        phone,
        preferredChannel: email ? "email" : phone ? "whatsapp" : undefined,
        whatsappConsent: !!phone, // Only a phone the contact themselves provided implies consent
      })
      .returning();

    if (newContact) {
      contactId = newContact.id;
      await logEvent({
        entity: "contact",
        entityId: newContact.id,
        action: "created",
        actor: input.actor,
        after: { name: newContact.name, email, phone },
      });
    }
  }

  // 2b. Duplicate guard: if an open lead already exists for the same
  // organization or contact, the business is already prospected.
  // Return it instead of creating a duplicate row.
  if (orgId || contactId) {
    const [existingLead] = await db
      .select()
      .from(leads)
      .where(
        and(
          or(
            ...(orgId ? [eq(leads.organizationId, orgId)] : []),
            ...(contactId ? [eq(leads.contactId, contactId)] : [])
          ),
          not(inArray(leads.stage, ["lost", "won"]))
        )
      )
      .limit(1);

    if (existingLead) {
      return { lead: existingLead, hasOptOut, duplicate: true as const };
    }
  }

  // 3. Create lead
  const initialStage: LeadStage = "new";
  const [lead] = await db
    .insert(leads)
    .values({
      organizationId: orgId,
      contactId,
      stage: initialStage,
      source: input.source,
      serviceType: input.serviceType,
      summary: input.projectSummary,
    })
    .returning();

  if (!lead) {
    throw new Error("Failed to create lead record");
  }

  // Record initial interaction note (only when we have a real channel)
  if (contactId && (email || phone)) {
    await db.insert(interactions).values({
      leadId: lead.id,
      contactId,
      channel: isEmail ? "email" : "whatsapp",
      direction: "inbound",
      content: input.projectSummary,
      metadata: {
        budget: input.estimatedBudget,
        source: input.source,
      },
    });
  }

  // Record creation event
  await logEvent({
    entity: "lead",
    entityId: lead.id,
    action: "created",
    actor: input.actor,
    after: {
      stage: initialStage,
      source: input.source,
      serviceType: input.serviceType,
      summary: input.projectSummary,
    },
    reason: "New inbound lead ingested",
  });

  return {
    lead,
    hasOptOut,
    duplicate: false as const,
  };
}

export interface TransitionLeadStageInput {
  leadId: string;
  targetStage: LeadStage;
  reason: string;
  lostReason?: string;
  actor: string;
}

export async function changeLeadStage(input: TransitionLeadStageInput) {
  const [currentLead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, input.leadId))
    .limit(1);

  if (!currentLead) {
    throw new Error(`Lead ${input.leadId} not found`);
  }

  const validation = validateTransition({
    from: currentLead.stage,
    to: input.targetStage,
    reason: input.reason,
    lostReason: input.lostReason,
  });

  if (!validation.ok) {
    return {
      success: false,
      code: validation.code,
      message: validation.message,
    };
  }

  const [updatedLead] = await db
    .update(leads)
    .set({
      stage: input.targetStage,
      stageChangedAt: new Date(),
      lostReason: input.targetStage === "lost" ? input.lostReason : null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, input.leadId))
    .returning();

  await logEvent({
    entity: "lead",
    entityId: input.leadId,
    action: "stage_transition",
    actor: input.actor,
    before: { stage: currentLead.stage },
    after: { stage: input.targetStage, lostReason: input.lostReason },
    reason: input.reason,
  });

  return {
    success: true,
    lead: updatedLead,
  };
}
