import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmSetFollowup } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Move a follow-up reminder after working it: reschedule a lead, ticket, organization or contact to a new ISO datetime, or clear it with null when no further nudge is needed. Use it right after drafting the nudge so the same item never resurfaces as overdue. This only moves the reminder — it never changes stages, approves drafts, or closes tickets.",
  inputSchema: z.object({
    entity: z
      .enum(["lead", "ticket", "organization", "contact"])
      .describe("Which queue item the reminder belongs to (matches the queue item kind)"),
    id: z.string().uuid().describe("UUID of the lead, ticket, organization or contact"),
    nextFollowUpAt: z
      .string()
      .nullable()
      .describe("New ISO datetime with offset (e.g. 2026-10-25T10:00:00-06:00), or null to clear the reminder"),
    followUpNote: z
      .string()
      .max(500)
      .optional()
      .describe("Short note on why it was moved (e.g. 'nudge drafted, waiting owner approval')"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "set_followup");
    try {
      await crmSetFollowup({
        entity: input.entity,
        id: input.id,
        nextFollowUpAt: input.nextFollowUpAt,
        followUpNote: input.followUpNote,
      });

      return {
        status: input.nextFollowUpAt ? "followup_rescheduled" : "followup_cleared",
        message:
          input.nextFollowUpAt
            ? `Reminder moved to ${input.nextFollowUpAt}.`
            : "Reminder cleared; the item leaves the queue.",
      };
    } catch (err) {
      return {
        status: "followup_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
