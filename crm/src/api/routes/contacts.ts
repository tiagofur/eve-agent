import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { contacts } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { logEvent } from "../../domain/events";

export const contactsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Set or clear a follow-up reminder on a contact (ops only, Nivel 1)
contactsRouter.patch(
  "/:id/followup",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      nextFollowUpAt: z.string().datetime({ offset: true }).nullable(),
      followUpNote: z.string().max(500).optional(),
    })
  ),
  async (c) => {
    const contactId = c.req.param("id");
    const { nextFollowUpAt, followUpNote } = c.req.valid("json");
    const actor = c.get("actor");

    const [contact] = await db
      .select()
      .from(contacts)
      .where(sql`${contacts.id} = ${contactId}`)
      .limit(1);
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const [updated] = await db
      .update(contacts)
      .set({
        nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null,
        followUpNote: followUpNote ?? contact.followUpNote,
        updatedAt: new Date(),
      })
      .where(sql`${contacts.id} = ${contactId}`)
      .returning();

    await logEvent({
      entity: "contact",
      entityId: contactId,
      action: nextFollowUpAt ? "followup_set" : "followup_cleared",
      actor,
      after: { nextFollowUpAt, followUpNote: followUpNote ?? null },
    });

    return c.json({ success: true, contact: updated });
  }
);
