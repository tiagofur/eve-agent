import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  contacts,
  invoices,
  organizations,
  outbox,
  payments,
  projects,
  subscriptions,
} from "../db/schema";
import { logEvent } from "./events";

/**
 * Money: invoices, payments and recurring subscriptions.
 *
 * Rules that cannot drift:
 *  - "overdue" is derived (sent + past due + unpaid balance), never stored.
 *  - payments are append-only facts: an invoice flips to paid mechanically
 *    when recorded payments cover the amount, and back to sent when a payment
 *    is deleted. Nobody marks an invoice paid by hand.
 *  - subscriptions renew by cadence arithmetic from their own renewal date,
 *    so a missed renewal never silently skips a period.
 *  - every mutation lands in the audit log with its actor.
 */

export type InvoiceStatus = "draft" | "sent" | "paid" | "cancelled";
export type SubscriptionCadence = "monthly" | "quarterly" | "yearly";
export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface CreateInvoiceInput {
  organizationId: string;
  projectId?: string | null;
  milestoneId?: string | null;
  amountCents: number;
  currency?: string;
  issuedAt?: string | null;
  dueAt?: string | null;
  notes?: string | null;
  actor: string;
}

export interface RegisterPaymentInput {
  invoiceId: string;
  amountCents: number;
  currency?: string;
  method?: "transfer" | "card" | "cash" | "crypto" | "other";
  receivedAt?: Date;
  note?: string | null;
  actor: string;
}

export type BillingError =
  | "invoice_not_found"
  | "invoice_amount_invalid"
  | "invoice_already_paid"
  | "invoice_cancelled"
  | "invoice_not_sent"
  | "invoice_paid_is_mechanical"
  | "payment_not_found"
  | "subscription_not_found"
  | "subscription_amount_invalid";

export type Result<T> = { ok: true; value: T } | { ok: false; code: BillingError; message: string };

const fail = (code: BillingError, message: string): Result<never> => ({ ok: false, code, message });

/** INV-2026-017: one series per year, max + 1. Agency scale: no locking needed. */
async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const [row] = await db
    .select({ number: invoices.number })
    .from(invoices)
    .where(sql`${invoices.number} LIKE ${`${prefix}%`}`)
    .orderBy(desc(invoices.number))
    .limit(1);
  const last = row?.number ? Number.parseInt(row.number.slice(prefix.length), 10) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

function addCadence(from: Date, cadence: SubscriptionCadence): Date {
  const d = new Date(from);
  if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cadence === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function createInvoice(
  input: CreateInvoiceInput
): Promise<Result<typeof invoices.$inferSelect>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail("invoice_amount_invalid", "amountCents must be a positive integer (minor units)");
  }
  const number = await nextInvoiceNumber();
  const [row] = await db
    .insert(invoices)
    .values({
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      number,
      amountCents: input.amountCents,
      currency: input.currency?.trim() || "USD",
      issuedAt: input.issuedAt ?? null,
      dueAt: input.dueAt ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  await logEvent({
    entity: "invoice",
    entityId: row!.id,
    action: "invoice_created",
    actor: input.actor,
    after: { number, amountCents: input.amountCents, currency: row!.currency, organizationId: input.organizationId },
  });
  return { ok: true, value: row! };
}

/**
 * Manual edits stay out of the mechanical path: "paid" is set only by
 * recorded payments, so the money trail always matches the status.
 */
export async function updateInvoice(
  id: string,
  patch: {
    /** "paid" is in the type so the mechanical-guard below can reject it. */
    status?: InvoiceStatus;
    amountCents?: number;
    currency?: string;
    issuedAt?: string | null;
    dueAt?: string | null;
    notes?: string | null;
    projectId?: string | null;
    milestoneId?: string | null;
  },
  actor: string
): Promise<Result<typeof invoices.$inferSelect>> {
  const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!current) return fail("invoice_not_found", "Invoice does not exist");
  if (patch.status === "paid") {
    return fail("invoice_paid_is_mechanical", "Register a payment instead: paid is set only when payments cover the amount");
  }
  if (patch.amountCents !== undefined && (!Number.isInteger(patch.amountCents) || patch.amountCents <= 0)) {
    return fail("invoice_amount_invalid", "amountCents must be a positive integer (minor units)");
  }
  if (patch.status === "cancelled" && current.status === "paid") {
    return fail("invoice_already_paid", "A paid invoice cannot be cancelled; delete its payments first if this was a mistake");
  }

  const [row] = await db
    .update(invoices)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(invoices.id, id))
    .returning();
  await logEvent({ entity: "invoice", entityId: id, action: "invoice_updated", actor, after: patch });
  return { ok: true, value: row! };
}

async function paidCentsFor(invoiceId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountCents}), 0)::int` })
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId));
  return row?.total ?? 0;
}

export async function registerPayment(
  input: RegisterPaymentInput
): Promise<Result<{ payment: typeof payments.$inferSelect; invoice: typeof invoices.$inferSelect }>> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1);
  if (!invoice) return fail("invoice_not_found", "Invoice does not exist");
  if (invoice.status === "cancelled") return fail("invoice_cancelled", "Cannot pay a cancelled invoice");
  if (invoice.status === "draft") return fail("invoice_not_sent", "Send the invoice before recording payments");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail("invoice_amount_invalid", "amountCents must be a positive integer (minor units)");
  }

  const [payment] = await db
    .insert(payments)
    .values({
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      currency: input.currency?.trim() || invoice.currency,
      method: input.method ?? "transfer",
      receivedAt: input.receivedAt ?? new Date(),
      note: input.note ?? null,
      createdBy: input.actor,
    })
    .returning();

  const total = await paidCentsFor(input.invoiceId);
  let current = invoice;
  if (total >= invoice.amountCents && invoice.status === "sent") {
    const [updated] = await db
      .update(invoices)
      .set({ status: "paid", paidAt: payment!.receivedAt, updatedAt: new Date() })
      .where(eq(invoices.id, input.invoiceId))
      .returning();
    current = updated!;
  }

  await logEvent({
    entity: "payment",
    entityId: payment!.id,
    action: "payment_registered",
    actor: input.actor,
    after: { invoiceId: input.invoiceId, amountCents: input.amountCents, method: payment!.method, invoiceStatus: current.status },
  });
  return { ok: true, value: { payment: payment!, invoice: current } };
}

export async function deletePayment(paymentId: string, actor: string): Promise<Result<{ invoice: typeof invoices.$inferSelect }>> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!payment) return fail("payment_not_found", "Payment does not exist");

  await db.delete(payments).where(eq(payments.id, paymentId));
  const total = await paidCentsFor(payment.invoiceId);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, payment.invoiceId)).limit(1);
  if (invoice && invoice.status === "paid" && total < invoice.amountCents) {
    const [reopened] = await db
      .update(invoices)
      .set({ status: "sent", paidAt: null, updatedAt: new Date() })
      .where(eq(invoices.id, invoice.id))
      .returning();
    await logEvent({
      entity: "payment",
      entityId: paymentId,
      action: "payment_deleted_reopened_invoice",
      actor,
      before: { amountCents: payment.amountCents },
      after: { invoiceId: invoice.id, invoiceStatus: "sent" },
    });
    return { ok: true, value: { invoice: reopened! } };
  }

  await logEvent({
    entity: "payment",
    entityId: paymentId,
    action: "payment_deleted",
    actor,
    before: { amountCents: payment.amountCents, invoiceId: payment.invoiceId },
  });
  return { ok: true, value: { invoice: invoice! } };
}

/* ------------------------------------------------------------------ */
/* Subscriptions                                                       */
/* ------------------------------------------------------------------ */

export interface CreateSubscriptionInput {
  organizationId: string;
  name: string;
  amountCents: number;
  currency?: string;
  cadence: SubscriptionCadence;
  nextRenewalAt?: string | null;
  notes?: string | null;
  actor: string;
}

export async function createSubscription(
  input: CreateSubscriptionInput
): Promise<Result<typeof subscriptions.$inferSelect>> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail("subscription_amount_invalid", "amountCents must be a positive integer (minor units)");
  }
  const [row] = await db
    .insert(subscriptions)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      amountCents: input.amountCents,
      currency: input.currency?.trim() || "USD",
      cadence: input.cadence,
      nextRenewalAt: input.nextRenewalAt ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  await logEvent({
    entity: "subscription",
    entityId: row!.id,
    action: "subscription_created",
    actor: input.actor,
    after: { name: input.name, cadence: input.cadence, amountCents: input.amountCents, nextRenewalAt: input.nextRenewalAt ?? null },
  });
  return { ok: true, value: row! };
}

export async function updateSubscription(
  id: string,
  patch: {
    name?: string;
    amountCents?: number;
    currency?: string;
    cadence?: SubscriptionCadence;
    nextRenewalAt?: string | null;
    status?: SubscriptionStatus;
    notes?: string | null;
  },
  actor: string
): Promise<Result<typeof subscriptions.$inferSelect>> {
  const [current] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  if (!current) return fail("subscription_not_found", "Subscription does not exist");
  if (patch.amountCents !== undefined && (!Number.isInteger(patch.amountCents) || patch.amountCents <= 0)) {
    return fail("subscription_amount_invalid", "amountCents must be a positive integer (minor units)");
  }
  const [row] = await db
    .update(subscriptions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(subscriptions.id, id))
    .returning();
  await logEvent({ entity: "subscription", entityId: id, action: "subscription_updated", actor, after: patch });
  return { ok: true, value: row! };
}

/**
 * Advances the renewal by one cadence step; when the date is in the past it
 * steps forward until it lands in the future, so months owed are never
 * silently skipped (capped to keep a corrupt date from looping forever).
 */
export async function renewSubscription(
  id: string,
  actor: string
): Promise<Result<typeof subscriptions.$inferSelect>> {
  const [current] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  if (!current) return fail("subscription_not_found", "Subscription does not exist");

  const today = new Date(isoDay(new Date()));
  let next = current.nextRenewalAt ? new Date(`${current.nextRenewalAt}T00:00:00Z`) : today;
  let steps = 0;
  do {
    next = addCadence(next, current.cadence);
    steps += 1;
  } while (next <= today && steps < 24);
  const nextIso = isoDay(next);

  const [row] = await db
    .update(subscriptions)
    .set({ nextRenewalAt: nextIso, updatedAt: new Date() })
    .where(eq(subscriptions.id, id))
    .returning();
  await logEvent({
    entity: "subscription",
    entityId: id,
    action: "subscription_renewed",
    actor,
    before: { nextRenewalAt: current.nextRenewalAt },
    after: { nextRenewalAt: nextIso, steps },
  });
  return { ok: true, value: row! };
}

/* ------------------------------------------------------------------ */
/* Collections overview (desktop Cobros + biller)                      */
/* ------------------------------------------------------------------ */

export interface InvoiceView {
  id: string;
  number: string;
  organizationId: string;
  organizationName: string | null;
  projectId: string | null;
  projectName: string | null;
  milestoneId: string | null;
  milestoneTitle: string | null;
  status: InvoiceStatus | "overdue";
  amountCents: number;
  paidCents: number;
  currency: string;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  notes: string | null;
  /** Pending/approved reminder draft exists for this invoice: don't stack another. */
  pendingReminder: boolean;
  lastReminderAt: string | null;
}

export interface SubscriptionView {
  id: string;
  organizationId: string;
  organizationName: string | null;
  name: string;
  amountCents: number;
  currency: string;
  cadence: SubscriptionCadence;
  nextRenewalAt: string | null;
  status: SubscriptionStatus;
  /** Negative = days overdue. */
  dueInDays: number | null;
  pendingReminder: boolean;
  lastReminderAt: string | null;
}

export interface CollectionsOverview {
  invoices: InvoiceView[];
  subscriptions: SubscriptionView[];
  /** Unpaid balance (sent + overdue), by currency, in minor units. */
  outstandingCents: Record<string, number>;
  overdueCents: Record<string, number>;
  /** Active subscriptions normalized to a monthly amount, by currency. */
  mrrCents: Record<string, number>;
}

/** Reminder link state per entity id: pending draft exists / last sent. */
async function reminderState(kind: "invoiceId" | "subscriptionId", ids: string[]) {
  const pending = new Set<string>();
  const lastAt = new Map<string, string>();
  if (ids.length === 0) return { pending, lastAt };

  const rows = await db
    .select({
      metadata: outbox.metadata,
      status: outbox.status,
      sentAt: outbox.sentAt,
      updatedAt: outbox.updatedAt,
    })
    .from(outbox)
    .where(
      // Fully parameterized OR over ids: `metadata->>$k = $id` per entity.
      sql.join(
        ids.map((id) => sql`${outbox.metadata}->>${kind} = ${id}`),
        sql` OR `
      )
    );

  for (const row of rows) {
    const id = (row.metadata as Record<string, string> | null)?.[kind];
    if (!id) continue;
    if (row.status === "pending_approval" || row.status === "approved") pending.add(id);
    if (row.status === "sent") {
      const at = row.sentAt ?? row.updatedAt;
      const prev = lastAt.get(id);
      if (at && (!prev || at.toISOString() > prev)) lastAt.set(id, at.toISOString());
    }
  }
  return { pending, lastAt };
}

export async function getCollectionsOverview(): Promise<CollectionsOverview> {
  const today = isoDay(new Date());

  const invoiceRows = await db
    .select({
      invoice: invoices,
      organizationName: organizations.name,
      projectName: projects.name,
      milestoneTitle: sql<string | null>`(select title from milestones m where m.id = ${invoices.milestoneId})`,
      paidCents: sql<number>`coalesce((select sum(p.amount_cents)::int from payments p where p.invoice_id = ${invoices.id}), 0)`,
    })
    .from(invoices)
    .leftJoin(organizations, eq(invoices.organizationId, organizations.id))
    .leftJoin(projects, eq(invoices.projectId, projects.id))
    .orderBy(desc(invoices.createdAt));

  const { pending: pendingInvoices, lastAt: lastInvoiceReminder } = await reminderState(
    "invoiceId",
    invoiceRows.map((r) => r.invoice.id)
  );

  const invoiceViews: InvoiceView[] = invoiceRows.map((r) => {
    const balance = r.invoice.amountCents - r.paidCents;
    const overdue = r.invoice.status === "sent" && !!r.invoice.dueAt && r.invoice.dueAt < today && balance > 0;
    return {
      id: r.invoice.id,
      number: r.invoice.number,
      organizationId: r.invoice.organizationId,
      organizationName: r.organizationName,
      projectId: r.invoice.projectId,
      projectName: r.projectName,
      milestoneId: r.invoice.milestoneId,
      milestoneTitle: r.milestoneTitle,
      status: overdue ? "overdue" : r.invoice.status,
      amountCents: r.invoice.amountCents,
      paidCents: r.paidCents,
      currency: r.invoice.currency,
      issuedAt: r.invoice.issuedAt,
      dueAt: r.invoice.dueAt,
      paidAt: r.invoice.paidAt?.toISOString() ?? null,
      notes: r.invoice.notes,
      pendingReminder: pendingInvoices.has(r.invoice.id),
      lastReminderAt: lastInvoiceReminder.get(r.invoice.id) ?? null,
    };
  });

  const subscriptionRows = await db
    .select({ subscription: subscriptions, organizationName: organizations.name })
    .from(subscriptions)
    .leftJoin(organizations, eq(subscriptions.organizationId, organizations.id))
    .orderBy(desc(subscriptions.createdAt));

  const { pending: pendingSubs, lastAt: lastSubReminder } = await reminderState(
    "subscriptionId",
    subscriptionRows.map((r) => r.subscription.id)
  );

  const subscriptionViews: SubscriptionView[] = subscriptionRows.map((r) => {
    const sub = r.subscription;
    let dueInDays: number | null = null;
    if (sub.nextRenewalAt) {
      const diff = new Date(`${sub.nextRenewalAt}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime();
      dueInDays = Math.round(diff / 86_400_000);
    }
    return {
      id: sub.id,
      organizationId: sub.organizationId,
      organizationName: r.organizationName,
      name: sub.name,
      amountCents: sub.amountCents,
      currency: sub.currency,
      cadence: sub.cadence,
      nextRenewalAt: sub.nextRenewalAt,
      status: sub.status,
      dueInDays,
      pendingReminder: pendingSubs.has(sub.id),
      lastReminderAt: lastSubReminder.get(sub.id) ?? null,
    };
  });

  const outstandingCents: Record<string, number> = {};
  const overdueCents: Record<string, number> = {};
  for (const inv of invoiceViews) {
    const balance = inv.amountCents - inv.paidCents;
    if (inv.status === "sent" || inv.status === "overdue") {
      outstandingCents[inv.currency] = (outstandingCents[inv.currency] ?? 0) + balance;
      if (inv.status === "overdue") overdueCents[inv.currency] = (overdueCents[inv.currency] ?? 0) + balance;
    }
  }

  const mrrCents: Record<string, number> = {};
  for (const sub of subscriptionViews) {
    if (sub.status !== "active") continue;
    const monthly = sub.cadence === "monthly" ? sub.amountCents : sub.cadence === "quarterly" ? sub.amountCents / 3 : sub.amountCents / 12;
    mrrCents[sub.currency] = (mrrCents[sub.currency] ?? 0) + monthly;
  }

  return { invoices: invoiceViews, subscriptions: subscriptionViews, outstandingCents, overdueCents, mrrCents };
}

/**
 * Staff contacts for the organizations the biller may write to: reminder
 * drafts need a person, and the approve gate re-checks opt-out anyway.
 */
export async function getContactsForOrganizations(organizationIds: string[]): Promise<
  Record<string, Array<{ id: string; name: string; email: string | null }>>
> {
  const ids = [...new Set(organizationIds.filter(Boolean))];
  const map: Record<string, Array<{ id: string; name: string; email: string | null }>> = {};
  if (ids.length === 0) return map;

  const rows = await db
    .select({ id: contacts.id, organizationId: contacts.organizationId, name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(and(inArray(contacts.organizationId, ids)))
    .orderBy(asc(contacts.createdAt));

  for (const row of rows) {
    if (!row.organizationId) continue;
    (map[row.organizationId] ??= []).push({ id: row.id, name: row.name, email: row.email });
  }
  return map;
}
