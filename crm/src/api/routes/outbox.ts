import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { db } from "../../db/client";
import { outbox, contacts, leads, organizations } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { createOutreachDraft, reviewOutreachDraft } from "../../domain/outbox";

export const outboxRouter = new Hono<{ Variables: AuthContextVariables }>();

// Create outreach draft (strictly starts in pending_approval)
outboxRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      leadId: z.string().uuid().optional(),
      organizationId: z.string().uuid().optional(),
      contactId: z.string().uuid().optional(),
      channel: z.enum(["email", "linkedin", "whatsapp", "phone", "telegram", "web", "other"]),
      subject: z.string().optional(),
      body: z.string().min(1),
      rationale: z.string().optional(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const result = await createOutreachDraft({
      ...data,
      actor,
    });

    if (!result.success) {
      return c.json({ error: result.message, code: result.code }, 400);
    }

    return c.json({ success: true, draft: result.draft }, 201);
  }
);

// List drafts pending approval (for owner or ops dashboard)
outboxRouter.get("/pending", requireScope(["ops"]), async (c) => {
  const pending = await db
    .select({
      id: outbox.id,
      leadId: outbox.leadId,
      organizationId: outbox.organizationId,
      contactId: outbox.contactId,
      channel: outbox.channel,
      subject: outbox.subject,
      body: outbox.body,
      rationale: outbox.rationale,
      status: outbox.status,
      createdAt: outbox.createdAt,
      createdBy: outbox.createdBy,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
      organizationName: organizations.name,
    })
    .from(outbox)
    .leftJoin(contacts, eq(outbox.contactId, contacts.id))
    .leftJoin(organizations, eq(outbox.organizationId, organizations.id))
    .where(eq(outbox.status, "pending_approval"))
    .orderBy(desc(outbox.createdAt));

  return c.json({ drafts: pending });
});

// Review draft: APPROVE or REJECT (owner scope required!)
outboxRouter.post(
  "/:id/review",
  requireScope(["owner"]),
  zValidator(
    "json",
    z.object({
      decision: z.enum(["approved", "rejected"]),
      rejectedReason: z.string().optional(),
    })
  ),
  async (c) => {
    const draftId = c.req.param("id");
    const { decision, rejectedReason } = c.req.valid("json");
    const actor = c.get("actor");

    const result = await reviewOutreachDraft({
      draftId,
      decision,
      rejectedReason,
      actor,
    });

    if (!result.success) {
      return c.json({ error: result.message, code: result.code }, 400);
    }

    return c.json({ success: true, draft: result.draft });
  }
);
