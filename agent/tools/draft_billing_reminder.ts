import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateDraft, crmGetCollections } from "../lib/crm";
import { requireStaff } from "../lib/guard";

const CHANNELS = ["email", "linkedin", "whatsapp", "phone", "telegram", "web", "other"] as const;

/** Formats minor units the way the owner reads them: USD 1,234.50. */
function money(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default defineTool({
  description:
    "Queue a payment or renewal reminder draft in Creapolis CRM, linked to a specific invoice or subscription. Use get_collections first: it lists what is due and each organization's contacts. The draft ALWAYS starts as pending_approval — the owner reviews it in Desktop or Telegram before anything is sent. Only cite amounts and dates exactly as get_collections reported them; a missing amount means asking the owner, never inventing one.",
  inputSchema: z.object({
    invoiceId: z.string().uuid().optional().describe("Invoice UUID from get_collections (for payment reminders)"),
    subscriptionId: z.string().uuid().optional().describe("Subscription UUID from get_collections (for renewal notices)"),
    contactId: z.string().uuid().describe("Contact UUID of the person to address, from get_collections contactsByOrganization"),
    channel: z.enum(CHANNELS).default("email").describe("Channel; email unless the relationship says otherwise"),
    subject: z.string().optional().describe("Subject line (email-style messages)"),
    body: z.string().min(1).describe("Full message text: warm, factual, one clear next step (pay / confirm renewal)"),
    rationale: z.string().optional().describe("Why now, why this tone: the owner reads it before approving"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "draft_billing_reminder");
    if (!input.invoiceId && !input.subscriptionId) {
      return {
        status: "target_required",
        error: "Provide invoiceId or subscriptionId: reminders are always linked to what is due.",
      };
    }
    if (input.invoiceId && input.subscriptionId) {
      return { status: "ambiguous_target", error: "Link exactly one of invoiceId / subscriptionId." };
    }

    try {
      const collections = await crmGetCollections();
      const linkKey = input.invoiceId ? "invoiceId" : "subscriptionId";
      const linkId = input.invoiceId ?? input.subscriptionId!;

      let organizationId: string;
      let moneyLine: string;
      if (input.invoiceId) {
        const invoice = collections.invoices.find((i) => i.id === input.invoiceId);
        if (!invoice) return { status: "not_found", error: "Invoice not in collections overview." };
        if (invoice.status === "paid") return { status: "already_paid", error: "The invoice is already paid: no reminder." };
        if (invoice.status === "cancelled") return { status: "cancelled_invoice", error: "The invoice is cancelled: no reminder." };
        if (invoice.pendingReminder) {
          return {
            status: "reminder_already_pending",
            error: "A reminder draft for this invoice already awaits approval. Review that one instead.",
          };
        }
        organizationId = invoice.organizationId;
        moneyLine = `Cobro ${invoice.number} — ${money(invoice.amountCents, invoice.currency)}${
          invoice.dueAt ? `, vence ${invoice.dueAt}` : ""
        }, saldo ${money(invoice.amountCents - invoice.paidCents, invoice.currency)}`;
      } else {
        const sub = collections.subscriptions.find((s) => s.id === input.subscriptionId);
        if (!sub) return { status: "not_found", error: "Subscription not in collections overview." };
        if (sub.status !== "active") return { status: "inactive_subscription", error: `Subscription is ${sub.status}: no notice.` };
        if (sub.pendingReminder) {
          return {
            status: "reminder_already_pending",
            error: "A renewal notice for this subscription already awaits approval. Review that one instead.",
          };
        }
        organizationId = sub.organizationId;
        moneyLine = `Renovación ${sub.name} — ${money(sub.amountCents, sub.currency)} / ${sub.cadence}${
          sub.nextRenewalAt ? `, próxima ${sub.nextRenewalAt}` : ""
        }`;
      }

      const result = await crmCreateDraft({
        organizationId,
        contactId: input.contactId,
        channel: input.channel,
        subject: input.subject,
        body: input.body,
        rationale: input.rationale
          ? `${input.rationale} [${moneyLine}]`
          : `Recordatorio de cobro. [${moneyLine}]`,
        metadata: { [linkKey]: linkId },
      });

      return {
        status: "reminder_created_pending_approval",
        draftId: result.draft.id,
        linkKey,
        linkId,
        message:
          "Reminder queued in CRM as pending_approval. Nothing was sent: the owner approves it in Desktop or Telegram.",
      };
    } catch (err) {
      return {
        status: "reminder_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
