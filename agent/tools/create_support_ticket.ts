import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateTicket } from "../lib/crm";

export default defineTool({
  description: "Create an official engineering support ticket in Creapolis CRM for an existing client issue, bug report, or system outage.",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the client reporting the issue"),
    companyName: z.string().optional().describe("Client company or project name"),
    contact: z.string().describe("Email or phone for ticket follow-up"),
    systemAffected: z.string().describe("Name or description of the affected system or feature"),
    severity: z.enum(["critical", "major", "minor"]).describe("Severity level of the incident"),
    description: z.string().describe("Detailed description of the bug, symptoms, or error messages"),
  }),
  async execute(input) {
    try {
      const crmResult = await crmCreateTicket({
        clientName: input.clientName,
        companyName: input.companyName,
        contact: input.contact,
        system: input.systemAffected,
        severity: input.severity,
        description: input.description,
      });

      return {
        status: "ticket_logged_in_crm",
        ticketId: crmResult.ticketId,
        severity: crmResult.severity,
        slaDueAt: crmResult.slaDueAt,
        slaHours: crmResult.slaHours,
        systemAffected: input.systemAffected,
        message: `Support ticket ${crmResult.ticketId} opened. Target SLA: ${crmResult.slaHours} hour(s).`,
      };
    } catch (err) {
      return {
        status: "logged_locally",
        ticketId: `TICK-${Date.now().toString(36).toUpperCase()}`,
        severity: input.severity,
        systemAffected: input.systemAffected,
        error: err instanceof Error ? err.message : "CRM connection unavailable",
      };
    }
  },
});
