import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetTickets } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "List CRM support tickets, newest first (max 50), optionally filtered by status. Use it to check whether an issue a client reports is already registered or in progress BEFORE creating a new ticket — repeat reports of an open incident reuse the existing ticket ID. Staff-only.",
  inputSchema: z.object({
    status: z
      .enum(["open", "in_progress", "waiting_client", "resolved", "closed"])
      .optional()
      .describe("Filter by lifecycle status; omit to list all"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "get_support_tickets");
    try {
      const { tickets } = await crmGetTickets(input.status);
      return {
        status: "tickets_retrieved",
        count: tickets.length,
        tickets: tickets.map((t) => ({
          ticketId: t.id,
          kind: t.kind,
          system: t.system,
          severity: t.severity,
          ticketStatus: t.status,
          description: t.description.slice(0, 300),
          projectName: t.projectName,
          contactName: t.contactName,
          slaDueAt: t.slaDueAt,
          createdAt: t.createdAt,
        })),
      };
    } catch (err) {
      return {
        status: "tickets_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
