import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetCollections } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read collections from Creapolis CRM: unpaid invoices (overdue first, each with number, amount, due date, balance and whether a reminder draft is already pending), recurring subscriptions with their next renewal, totals by currency (outstanding, overdue, MRR) and the staff contacts of each organization involved. Use it to report cashflow and to pick targets for draft_billing_reminder. Drafting is always the separate, owner-approved step.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireStaff(ctx, "get_collections");
    try {
      const data = await crmGetCollections();
      const openInvoices = data.invoices.filter((i) => i.status === "sent" || i.status === "overdue");
      const renewalHorizonDays = 14;
      const dueSubscriptions = data.subscriptions.filter(
        (s) =>
          s.status === "active" &&
          s.nextRenewalAt !== null &&
          (s.dueInDays === null || s.dueInDays <= renewalHorizonDays)
      );
      return {
        status: "collections_retrieved",
        openInvoices: openInvoices
          .sort((a, b) => (a.status === b.status ? (a.dueAt ?? "").localeCompare(b.dueAt ?? "") : a.status === "overdue" ? -1 : 1))
          .map((i) => ({
            invoiceId: i.id,
            number: i.number,
            organizationId: i.organizationId,
            organizationName: i.organizationName,
            context: [i.projectName, i.milestoneTitle].filter(Boolean).join(" · ") || null,
            status: i.status,
            amountCents: i.amountCents,
            paidCents: i.paidCents,
            balanceCents: i.amountCents - i.paidCents,
            currency: i.currency,
            dueAt: i.dueAt,
            reminderAlreadyPending: i.pendingReminder,
            lastReminderAt: i.lastReminderAt,
          })),
        dueSubscriptions: dueSubscriptions.map((s) => ({
          subscriptionId: s.id,
          organizationId: s.organizationId,
          organizationName: s.organizationName,
          name: s.name,
          amountCents: s.amountCents,
          currency: s.currency,
          cadence: s.cadence,
          nextRenewalAt: s.nextRenewalAt,
          dueInDays: s.dueInDays,
          reminderAlreadyPending: s.pendingReminder,
          lastReminderAt: s.lastReminderAt,
        })),
        totals: {
          outstandingCents: data.outstandingCents,
          overdueCents: data.overdueCents,
          mrrCents: data.mrrCents,
        },
        contactsByOrganization: data.contactsByOrganization,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "collections_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
