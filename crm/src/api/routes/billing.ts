import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  createInvoice,
  createSubscription,
  deletePayment,
  getCollectionsOverview,
  getContactsForOrganizations,
  registerPayment,
  renewSubscription,
  updateInvoice,
  updateSubscription,
} from "../../domain/billing";

/**
 * Money: invoices, payments, subscriptions. Manual surface for the owner
 * (desktop Cobros) and data source for the biller's reminders. "paid" is
 * never a form field: it is set only by registering payments.
 */
export const billingRouter = new Hono<{ Variables: AuthContextVariables }>();

const money = z.number().int().positive().max(2_000_000_000);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .nullish();

billingRouter.get("/overview", requireScope(["ops"]), async (c) => {
  const overview = await getCollectionsOverview();
  const contactIds = [
    ...new Set(
      overview.invoices
        .filter((i) => i.status === "sent" || i.status === "overdue")
        .map((i) => i.organizationId)
        .concat(overview.subscriptions.filter((s) => s.status === "active").map((s) => s.organizationId))
    ),
  ];
  const contacts = await getContactsForOrganizations(contactIds);
  return c.json({ ...overview, contactsByOrganization: contacts });
});

billingRouter.get("/invoices", requireScope(["ops"]), async (c) => {
  const overview = await getCollectionsOverview();
  const status = c.req.query("status");
  const organizationId = c.req.query("organizationId");
  let invoices = overview.invoices;
  if (status) invoices = invoices.filter((i) => i.status === status);
  if (organizationId) invoices = invoices.filter((i) => i.organizationId === organizationId);
  return c.json({ invoices });
});

billingRouter.post(
  "/invoices",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      organizationId: z.string().uuid(),
      projectId: z.string().uuid().nullish(),
      milestoneId: z.string().uuid().nullish(),
      amountCents: money,
      currency: z.string().trim().min(3).max(8).optional(),
      issuedAt: isoDate,
      dueAt: isoDate,
      notes: z.string().max(2000).nullish(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const result = await createInvoice({ ...data, actor: c.get("actor") });
    if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
    return c.json({ invoice: result.value }, 201);
  }
);

billingRouter.patch(
  "/invoices/:id",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      status: z.enum(["draft", "sent", "cancelled"]).optional(),
      amountCents: money.optional(),
      currency: z.string().trim().min(3).max(8).optional(),
      issuedAt: isoDate,
      dueAt: isoDate,
      notes: z.string().max(2000).nullish(),
      projectId: z.string().uuid().nullish(),
      milestoneId: z.string().uuid().nullish(),
    })
  ),
  async (c) => {
    const result = await updateInvoice(c.req.param("id"), c.req.valid("json"), c.get("actor"));
    if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
    return c.json({ invoice: result.value });
  }
);

billingRouter.post(
  "/invoices/:id/payments",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      amountCents: money,
      currency: z.string().trim().min(3).max(8).optional(),
      method: z.enum(["transfer", "card", "cash", "crypto", "other"]).optional(),
      receivedAt: z.string().datetime({ offset: true }).optional(),
      note: z.string().max(500).nullish(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const result = await registerPayment({
      invoiceId: c.req.param("id"),
      amountCents: data.amountCents,
      currency: data.currency,
      method: data.method,
      receivedAt: data.receivedAt ? new Date(data.receivedAt) : undefined,
      note: data.note ?? null,
      actor: c.get("actor"),
    });
    if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
    return c.json({ payment: result.value.payment, invoice: result.value.invoice }, 201);
  }
);

billingRouter.delete("/payments/:id", requireScope(["ops"]), async (c) => {
  const result = await deletePayment(c.req.param("id")!, c.get("actor")!);
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
  return c.json({ invoice: result.value.invoice });
});

billingRouter.get("/subscriptions", requireScope(["ops"]), async (c) => {
  const overview = await getCollectionsOverview();
  return c.json({ subscriptions: overview.subscriptions });
});

billingRouter.post(
  "/subscriptions",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      organizationId: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      amountCents: money,
      currency: z.string().trim().min(3).max(8).optional(),
      cadence: z.enum(["monthly", "quarterly", "yearly"]),
      nextRenewalAt: isoDate,
      notes: z.string().max(2000).nullish(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const result = await createSubscription({ ...data, actor: c.get("actor") });
    if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
    return c.json({ subscription: result.value }, 201);
  }
);

billingRouter.patch(
  "/subscriptions/:id",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      name: z.string().trim().min(1).max(200).optional(),
      amountCents: money.optional(),
      currency: z.string().trim().min(3).max(8).optional(),
      cadence: z.enum(["monthly", "quarterly", "yearly"]).optional(),
      nextRenewalAt: isoDate,
      status: z.enum(["active", "paused", "cancelled"]).optional(),
      notes: z.string().max(2000).nullish(),
    })
  ),
  async (c) => {
    const result = await updateSubscription(c.req.param("id"), c.req.valid("json"), c.get("actor"));
    if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
    return c.json({ subscription: result.value });
  }
);

// Mechanical advance by one cadence step (missed periods catch up, never skip).
billingRouter.post("/subscriptions/:id/renew", requireScope(["ops"]), async (c) => {
  const result = await renewSubscription(c.req.param("id")!, c.get("actor")!);
  if (!result.ok) return c.json({ error: result.message, code: result.code }, 400);
  return c.json({ subscription: result.value });
});
