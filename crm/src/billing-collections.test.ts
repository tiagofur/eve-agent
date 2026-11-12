import { describe, expect, it, afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { pool, db } from "./db/client";
import { contacts, invoices, organizations, outbox, payments, subscriptions } from "./db/schema";
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
} from "./domain/billing";
import { createOutreachDraft } from "./domain/outbox";

/**
 * Money: invoices, payments and subscriptions. The mechanical rules under
 * test: "overdue" derived never stored, "paid" only via recorded payments,
 * renewals catch up missed periods instead of skipping them.
 */
const ACTOR = "test:billing";

const ORG = "TEST-Billing Org";
const ORG_NO_CONTACT = "TEST-Billing Org No Contact";

let orgId: string;
let orgNoContactId: string;
let contactId: string;
const createdInvoiceIds: string[] = [];
const createdSubscriptionIds: string[] = [];

beforeAll(async () => {
  const [org] = await db.insert(organizations).values({ name: ORG }).returning();
  orgId = org!.id;
  const [orgB] = await db.insert(organizations).values({ name: ORG_NO_CONTACT }).returning();
  orgNoContactId = orgB!.id;
  const [contact] = await db
    .insert(contacts)
    .values({ organizationId: orgId, name: "TEST Billing Contacto", email: "billing-test@example.invalid" })
    .returning();
  contactId = contact!.id;
});

beforeEach(async () => {
  await db.delete(outbox).where(eq(outbox.organizationId, orgId));
});

afterEach(async () => {
  if (createdInvoiceIds.length > 0) {
    const ids = [...createdInvoiceIds];
    createdInvoiceIds.length = 0;
    await db.delete(payments).where(inArray(payments.invoiceId, ids));
    await db.delete(invoices).where(inArray(invoices.id, ids));
  }
  if (createdSubscriptionIds.length > 0) {
    const ids = [...createdSubscriptionIds];
    createdSubscriptionIds.length = 0;
    await db.delete(subscriptions).where(inArray(subscriptions.id, ids));
  }
});

afterAll(async () => {
  await db.delete(contacts).where(eq(contacts.organizationId, orgId));
  await db.delete(organizations).where(inArray(organizations.id, [orgId, orgNoContactId]));
  await pool.end();
});

async function makeInvoice(overrides: Partial<Parameters<typeof createInvoice>[0]> = {}) {
  const result = await createInvoice({
    organizationId: orgId,
    amountCents: 100_000,
    dueAt: "2026-12-31",
    actor: ACTOR,
    ...overrides,
  });
  if (!result.ok) throw new Error(`fixture invoice failed: ${result.message}`);
  createdInvoiceIds.push(result.value.id);
  return result.value;
}

/** Asserts a Result failed and returns its error code for exact matching. */
function errorCode<T>(r: { ok: true } | { ok: false; code: string }): string {
  expect(r.ok).toBe(false);
  return r.ok ? "unexpected_ok" : r.code;
}

describe("createInvoice", () => {
  it("assigns a sequential INV-<year> number", async () => {
    const first = await makeInvoice();
    const second = await makeInvoice();

    expect(first.number).toMatch(/^INV-\d{4}-\d{3}$/);
    const n1 = Number.parseInt(first.number.slice(-3), 10);
    const n2 = Number.parseInt(second.number.slice(-3), 10);
    expect(n2).toBe(n1 + 1);
    expect(first.status).toBe("draft");
  });

  it("rejects non-positive or fractional amounts", async () => {
    expect((await createInvoice({ organizationId: orgId, amountCents: 0, actor: ACTOR })).ok).toBe(false);
    expect((await createInvoice({ organizationId: orgId, amountCents: 10.5, actor: ACTOR })).ok).toBe(false);
    expect((await createInvoice({ organizationId: orgId, amountCents: -5, actor: ACTOR })).ok).toBe(false);
    expect(await db.select().from(invoices).where(eq(invoices.organizationId, orgId))).toHaveLength(0);
  });
});

describe("payments drive the invoice status", () => {
  it("refuses payments on draft invoices and cannot mark paid by hand", async () => {
    const invoice = await makeInvoice();

    const beforeSend = await registerPayment({ invoiceId: invoice.id, amountCents: 50_000, actor: ACTOR });
    expect(beforeSend).toMatchObject({ ok: false, code: "invoice_not_sent" });

    const manualPaid = await updateInvoice(invoice.id, { status: "paid" }, ACTOR);
    expect(manualPaid).toMatchObject({ ok: false, code: "invoice_paid_is_mechanical" });

    await updateInvoice(invoice.id, { status: "sent" }, ACTOR);
    const partial = await registerPayment({ invoiceId: invoice.id, amountCents: 40_000, actor: ACTOR });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    // Partial payment: still sent, not paid.
    expect(partial.value.invoice.status).toBe("sent");

    const settle = await registerPayment({ invoiceId: invoice.id, amountCents: 60_000, actor: ACTOR });
    expect(settle.ok).toBe(true);
    if (!settle.ok) return;
    expect(settle.value.invoice.status).toBe("paid");
    expect(settle.value.invoice.paidAt).not.toBeNull();
  });

  it("reopens a paid invoice to sent when a payment is deleted", async () => {
    const invoice = await makeInvoice({ amountCents: 50_000 });
    await updateInvoice(invoice.id, { status: "sent" }, ACTOR);
    const paid = await registerPayment({ invoiceId: invoice.id, amountCents: 50_000, actor: ACTOR });
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;

    const removed = await deletePayment(paid.value.payment.id, ACTOR);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.invoice.status).toBe("sent");
    expect(removed.value.invoice.paidAt).toBeNull();
    expect(await db.select().from(payments).where(eq(payments.invoiceId, invoice.id))).toHaveLength(0);
  });

  it("refuses payments on cancelled invoices and cancelling paid ones", async () => {
    const invoice = await makeInvoice();
    await updateInvoice(invoice.id, { status: "cancelled" }, ACTOR);

    expect(errorCode(await registerPayment({ invoiceId: invoice.id, amountCents: 1_000, actor: ACTOR }))).toBe(
      "invoice_cancelled"
    );

    const paidInvoice = await makeInvoice({ amountCents: 10_000 });
    await updateInvoice(paidInvoice.id, { status: "sent" }, ACTOR);
    const paid = await registerPayment({ invoiceId: paidInvoice.id, amountCents: 10_000, actor: ACTOR });
    expect(paid.ok).toBe(true);
    expect(errorCode(await updateInvoice(paidInvoice.id, { status: "cancelled" }, ACTOR))).toBe("invoice_already_paid");
  });
});

describe("collections overview", () => {
  it("derives overdue, outstanding and pending-reminder flags", async () => {
    // Overdue: sent long ago, unpaid. Outstanding: sent, due in the future.
    const overdue = await makeInvoice({ amountCents: 30_000, dueAt: "2026-01-15" });
    await updateInvoice(overdue.id, { status: "sent" }, ACTOR);
    const outstanding = await makeInvoice({ amountCents: 20_000, dueAt: "2099-01-01" });
    await updateInvoice(outstanding.id, { status: "sent" }, ACTOR);

    const before = await getCollectionsOverview();
    expect(before.invoices.find((i) => i.id === overdue.id)?.status).toBe("overdue");
    expect(before.invoices.find((i) => i.id === outstanding.id)?.status).toBe("sent");
    expect(before.overdueCents.USD).toBeGreaterThanOrEqual(30_000);
    expect(before.outstandingCents.USD).toBeGreaterThanOrEqual(50_000);
    expect(before.invoices.find((i) => i.id === overdue.id)?.pendingReminder).toBe(false);

    // A reminder draft linked by metadata flags the invoice; a second draft
    // for the same person is refused (one pending reminder per recipient).
    const draft = await createOutreachDraft({
      organizationId: orgId,
      contactId,
      channel: "email",
      subject: "Recordatorio INV",
      body: "Recordatorio de pago",
      metadata: { invoiceId: overdue.id },
      actor: ACTOR,
    });
    expect(draft.success).toBe(true);

    const stacked = await createOutreachDraft({
      organizationId: orgId,
      contactId,
      channel: "email",
      body: "Otro recordatorio",
      metadata: { invoiceId: overdue.id },
      actor: ACTOR,
    });
    expect(stacked).toMatchObject({ success: false, code: "draft_already_pending" });

    const after = await getCollectionsOverview();
    expect(after.invoices.find((i) => i.id === overdue.id)?.pendingReminder).toBe(true);
    // Contacts of orgs with open money items are surfaced for targeting.
    const contactMap = await getContactsForOrganizations([orgId]);
    expect(contactMap[orgId]?.some((ct) => ct.id === contactId)).toBe(true);
  });
});

describe("subscriptions", () => {
  it("renews catching up missed periods instead of skipping them", async () => {
    const sub = await createSubscription({
      organizationId: orgId,
      name: "TEST Hosting",
      amountCents: 5_000,
      cadence: "monthly",
      // Well in the past: renewal must step forward until it lands in the future.
      nextRenewalAt: "2026-08-01",
      actor: ACTOR,
    });
    if (!sub.ok) throw new Error(sub.message);
    createdSubscriptionIds.push(sub.value.id);

    const renewed = await renewSubscription(sub.value.id, ACTOR);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(new Date(`${renewed.value.nextRenewalAt}T00:00:00Z`).getTime()).toBeGreaterThan(Date.now());
    // Monthly steps from 2026-08-01 land past today, not on the next month only.
    expect(renewed.value.nextRenewalAt).not.toBe("2026-09-01");
  });

  it("normalizes MRR by cadence and skips paused subscriptions", async () => {
    const monthly = await createSubscription({
      organizationId: orgId,
      name: "TEST Mensual",
      amountCents: 12_000,
      cadence: "monthly",
      actor: ACTOR,
    });
    const yearly = await createSubscription({
      organizationId: orgNoContactId,
      name: "TEST Anual",
      amountCents: 24_000,
      cadence: "yearly",
      actor: ACTOR,
    });
    if (!monthly.ok) throw new Error(monthly.message);
    if (!yearly.ok) throw new Error(yearly.message);
    createdSubscriptionIds.push(monthly.value.id, yearly.value.id);

    await updateSubscription(monthly.value.id, { status: "paused" }, ACTOR);

    const overview = await getCollectionsOverview();
    const ours = overview.subscriptions.filter((s) => [monthly.value.id, yearly.value.id].includes(s.id));
    expect(ours.find((s) => s.id === monthly.value.id)?.status).toBe("paused");
    // Only the yearly one counts toward MRR: 24000 / 12 = 2000.
    expect(overview.mrrCents.USD).toBeGreaterThanOrEqual(2000);
    expect(overview.mrrCents.USD).toBeLessThan(14_000);
  });

  it("rejects bad amounts", async () => {
    expect(
      errorCode(await createSubscription({ organizationId: orgId, name: "x", amountCents: 0, cadence: "monthly", actor: ACTOR }))
    ).toBe("subscription_amount_invalid");
  });
});

describe("getContactsForOrganizations", () => {
  it("maps contacts by organization and tolerates unknown orgs", async () => {
    const map = await getContactsForOrganizations([orgId, orgNoContactId]);
    expect(map[orgId]?.map((ct) => ct.id)).toContain(contactId);
    expect(map[orgNoContactId]).toBeUndefined();
    expect(await getContactsForOrganizations([])).toEqual({});
  });
});
