import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateDraft } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Write an outreach draft addressed to a lead (or an existing client) in Creapolis CRM. First-touch prospecting drafts are addressed by leadId: the CRM resolves the lead's contact server-side and, when none is verified yet, the draft is saved anyway and approval is blocked until the contact is completed. Drafts ALWAYS start as pending_approval: the owner reviews them in the Desktop app or Telegram before anything is sent. Never invent contact data or UUIDs.",
  inputSchema: z.object({
    leadId: z.string().uuid().optional().describe("Lead UUID — the target for prospecting and follow-up drafts"),
    organizationId: z.string().uuid().optional().describe("Organization UUID for existing-client messages (requires contactId)"),
    contactId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Contact UUID when you already know it (e.g. from a queue or thread). Optional for lead drafts: the CRM links the lead's verified contact for you"
      ),
    channel: z
      .enum(["email", "linkedin", "whatsapp", "phone", "telegram", "web", "other"])
      .describe("Channel for the message"),
    subject: z.string().optional().describe("Subject line (email-style messages)"),
    body: z.string().min(1).describe("Full message text"),
    rationale: z
      .string()
      .optional()
      .describe("Why this message, why this angle: the owner reads it before approving"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "create_outreach_draft");
    try {
      const result = await crmCreateDraft({
        leadId: input.leadId,
        organizationId: input.organizationId,
        contactId: input.contactId,
        channel: input.channel,
        subject: input.subject,
        body: input.body,
        rationale: input.rationale,
      });

      const contactPart =
        result.contactResolution === "missing"
          ? "No verified contact yet: the draft is queued for the lead and cannot be approved until the contact is completed."
          : "The lead's verified contact was linked automatically.";

      return {
        status: "draft_created_pending_approval",
        draftId: result.draft.id,
        contactResolution: result.contactResolution ?? "explicit",
        message: `Draft queued in CRM as pending_approval. Nothing was sent. ${contactPart}`,
      };
    } catch (err) {
      return {
        status: "draft_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
