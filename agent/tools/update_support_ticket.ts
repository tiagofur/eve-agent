import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmUpdateTicketContent, crmUpdateTicketStatus } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Update an existing CRM support ticket: correct or expand its content (description captured vaguely at intake), and/or advance its lifecycle status. Status semantics: in_progress = owner-approved work started; waiting_client = resolution notified, awaiting client confirmation; resolved = fix applied (clientMessage becomes the client-facing explanation); closed = done/rejected; open = reopened. CRM failures fail loudly. Staff-only.",
  inputSchema: z.object({
    ticketId: z.string().uuid().describe("Ticket UUID to update"),
    description: z
      .string()
      .optional()
      .describe("Corrected/expanded real problem statement (what happens, expected, impact, repro steps)"),
    system: z.string().optional().describe("Corrected affected system name"),
    severity: z.enum(["critical", "major", "minor"]).optional().describe("Corrected severity"),
    status: z
      .enum(["open", "in_progress", "waiting_client", "resolved", "closed"])
      .optional()
      .describe("New lifecycle status (omit when only editing content)"),
    reason: z.string().optional().describe("Internal audit note: why this change"),
    clientMessage: z
      .string()
      .optional()
      .describe("Client-facing explanation (used with resolved/closed); recorded on the ticket timeline"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "update_support_ticket");
    try {
      if (input.description || input.system || input.severity) {
        await crmUpdateTicketContent(input.ticketId, {
          description: input.description,
          system: input.system,
          severity: input.severity,
          reason: input.reason,
        });
      }

      if (input.status) {
        await crmUpdateTicketStatus(input.ticketId, input.status, {
          reason: input.reason,
          clientMessage: input.clientMessage,
        });
      }

      return {
        status: "ticket_updated",
        ticketId: input.ticketId,
        ...(input.status ? { newStatus: input.status } : {}),
        message: input.status
          ? `Ticket ${input.ticketId} is now ${input.status}.`
          : `Ticket ${input.ticketId} content corrected.`,
      };
    } catch (err) {
      return {
        status: "ticket_update_failed",
        ticketId: input.ticketId,
        error: err instanceof Error ? err.message : "CRM connection unavailable",
      };
    }
  },
});
