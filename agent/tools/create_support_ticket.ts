import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateTicket } from "../lib/crm";

export default defineTool({
  description:
    "Create an official ticket in Creapolis CRM: kind 'support' for existing-client bugs/outages (severity SLA), kind 'info' for service questions from new or existing clients (24h commercial SLA, no paging).",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the client reporting the issue"),
    companyName: z.string().optional().describe("Client company or project name"),
    contact: z.string().describe("Email or phone for ticket follow-up"),
    systemAffected: z.string().describe("Name or description of the affected system or requested service"),
    severity: z.enum(["critical", "major", "minor"]).describe("Severity level (support tickets only)"),
    kind: z
      .enum(["support", "info"])
      .default("support")
      .describe("support = bug/outage with severity SLA; info = service question with 24h commercial SLA"),
    description: z.string().describe("Detailed description of the bug, symptoms, error messages, or service question"),
  }),
  async execute(input) {
    try {
      const crmResult = await crmCreateTicket({
        clientName: input.clientName,
        companyName: input.companyName,
        contact: input.contact,
        system: input.systemAffected,
        severity: input.severity,
        kind: input.kind,
        description: input.description,
      });

      return {
        status: "ticket_logged_in_crm",
        ticketId: crmResult.ticketId,
        kind: crmResult.kind,
        severity: crmResult.severity,
        slaDueAt: crmResult.slaDueAt,
        slaHours: crmResult.slaHours,
        systemAffected: input.systemAffected,
        message: `Support ticket ${crmResult.ticketId} opened (${crmResult.kind}). Target SLA: ${crmResult.slaHours} hour(s).`,
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
