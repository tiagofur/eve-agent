import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../../db/client";
import { channelEnum, contacts } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { logEvent } from "../../domain/events";

export const contactsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Edit contact fields manually (ops only). Used from the Client 360 sheet and
// from the lead drawer: a lead's contactName/Email/Phone are joins on this row.
contactsRouter.patch(
  "/:id",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(200).optional(),
      role: z.string().max(120).nullable().optional(),
      email: z.string().email().max(200).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
      preferredChannel: z.enum(channelEnum.enumValues).nullable().optional(),
    })
  ),
  async (c) => {
    const contactId = c.req.param("id");
    const patch = c.req.valid("json");
    const actor = c.get("actor");

    const [contact] = await db
      .select()
      .from(contacts)
      .where(sql`${contacts.id} = ${contactId}`)
      .limit(1);
    if (!contact) {
      return c.json({ error: "Contact not found" }, 404);
    }

    const before: Record<string, unknown> = {};
    const changed: Record<string, unknown> = {};
    for (const key of ["name", "role", "email", "phone", "preferredChannel"] as const) {
      const next = patch[key];
      if (next === undefined) continue;
      const current = contact[key];
      if (current !== next) {
        before[key] = current;
        changed[key] = next;
      }
    }
    if (Object.keys(changed).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const [updated] = await db
      .update(contacts)
      .set({ ...changed, updatedAt: new Date() } as Partial<typeof contacts.$inferInsert>)
      .where(sql`${contacts.id} = ${contactId}`)
      .returning();

    await logEvent({
      entity: "contact",
      entityId: contactId,
      action: "updated",
      actor,
      before,
      after: changed,
    });

    return c.json({ success: true, contact: updated });
  }
);

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
