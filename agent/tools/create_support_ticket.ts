import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateTicket, crmListProjects } from "../lib/crm";
import { resolveProjectLoose } from "../lib/project-match";

export default defineTool({
  description:
    "Create an official ticket in Creapolis CRM: kind 'support' for existing-client bugs/outages (severity SLA, requires a contact channel), kind 'info' for service questions from new or existing clients (24h commercial SLA, no paging, contact optional). Repeat reports of an open incident return the existing ticket instead of duplicating. CRM failures fail loudly: never invent ticket IDs.",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the client reporting the issue"),
    companyName: z.string().optional().describe("Client company or project name"),
    contact: z
      .string()
      .optional()
      .describe(
        "Email or phone for ticket follow-up. Required for support incidents; optional for info questions from strangers."
      ),
    systemAffected: z.string().describe("Name or description of the affected system or requested service"),
    severity: z
      .enum(["critical", "major", "minor"])
      .optional()
      .describe("Severity level (support tickets only; info defaults to minor)"),
    kind: z
      .enum(["support", "info"])
      .default("support")
      .describe("support = bug/outage with severity SLA; info = service question with 24h commercial SLA"),
    description: z
      .string()
      .describe(
        "The client's REAL problem, in their words plus structure: what happens, what was expected, impact, steps to reproduce. Never a placeholder or 'test' text."
      ),
    projectName: z
      .string()
      .optional()
      .describe(
        "Affected Creapolis project name as the client said it (e.g. 'eve-agent'). Linked automatically when it matches one project unambiguously."
      ),
  }),
  async execute(input) {
    // Best-effort project link: a mismatch never blocks logging the incident.
    let projectId: string | undefined;
    let projectNote: string | undefined;
    if (input.projectName) {
      try {
        const { projects } = await crmListProjects();
        const match = resolveProjectLoose(projects, input.projectName);
        if (match && !match.ambiguous) {
          projectId = match.project.id;
        } else if (match?.ambiguous) {
          projectNote = `projectName '${input.projectName}' matched multiple projects — ticket left unlinked`;
        } else {
          projectNote = `projectName '${input.projectName}' matched no project — ticket left unlinked`;
        }
      } catch {
        projectNote = "project lookup unavailable — ticket left unlinked";
      }
    }

    try {
      const crmResult = await crmCreateTicket({
        clientName: input.clientName,
        companyName: input.companyName,
        contact: input.contact,
        system: input.systemAffected,
        severity: input.severity,
        kind: input.kind,
        description: input.description,
        projectId,
      });

      if (crmResult.duplicate) {
        return {
          status: "ticket_already_open",
          ticketId: crmResult.ticketId,
          kind: crmResult.kind,
          severity: crmResult.severity,
          slaDueAt: crmResult.slaDueAt,
          systemAffected: input.systemAffected,
          linkedProjectId: projectId ?? null,
          message: `This incident is already open as ticket ${crmResult.ticketId} — no duplicate created, owner not re-paged.`,
        };
      }

      return {
        status: "ticket_logged_in_crm",
        ticketId: crmResult.ticketId,
        kind: crmResult.kind,
        severity: crmResult.severity,
        slaDueAt: crmResult.slaDueAt,
        slaHours: crmResult.slaHours,
        systemAffected: input.systemAffected,
        linkedProjectId: projectId ?? null,
        ...(projectNote ? { projectNote } : {}),
        message: `Support ticket ${crmResult.ticketId} opened (${crmResult.kind}). Target SLA: ${crmResult.slaHours} hour(s). The owner was paged for triage (support kind). Next step: the OWNER must approve the ticket before any correction is dispatched.`,
      };
    } catch (err) {
      return {
        status: "ticket_failed",
        error: err instanceof Error ? err.message : "CRM connection unavailable",
      };
    }
  },
});
