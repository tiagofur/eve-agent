import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateDraft } from "../lib/crm";

export default defineTool({
  description:
    "Write an outreach draft to a lead or an existing client in Creapolis CRM. Drafts ALWAYS start as pending_approval: the owner reviews them in the Desktop app or Telegram before anything is sent. Never invent contact data; use known contact UUIDs.",
  inputSchema: z.object({
    leadId: z.string().uuid().optional().describe("Lead UUID for prospecting follow-ups"),
    organizationId: z.string().uuid().optional().describe("Organization UUID for existing-client messages"),
    contactId: z.string().uuid().describe("Contact UUID of the recipient (required)"),
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
  async execute(input) {
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

      return {
        status: "draft_created_pending_approval",
        draftId: result.draft.id,
        message: "Draft queued in CRM as pending_approval. Nothing was sent.",
      };
    } catch (err) {
      return {
        status: "draft_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
