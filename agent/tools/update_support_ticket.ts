import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmListProjects, crmUpdateTicketContent, crmUpdateTicketStatus } from "../lib/crm";
import { resolveProjectLoose } from "../lib/project-match";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Update an existing CRM support ticket: correct or expand its content (description captured vaguely at intake, or the linked project the owner asked to change), and/or advance its lifecycle status. Status semantics: in_progress = owner-approved work started (the CRM auto-dispatches the correction to the coding queue on owner approval); waiting_client = resolution notified, awaiting client confirmation; resolved = fix applied (clientMessage becomes the client-facing explanation); closed = done/rejected; open = reopened. CRM failures fail loudly. Staff-only.",
  inputSchema: z.object({
    ticketId: z.string().uuid().describe("Ticket UUID to update"),
    description: z
      .string()
      .optional()
      .describe("Corrected/expanded real problem statement (what happens, expected, impact, repro steps)"),
    system: z.string().optional().describe("Corrected affected system name"),
    severity: z.enum(["critical", "major", "minor"]).optional().describe("Corrected severity"),
    projectName: z
      .string()
      .optional()
      .describe(
        "Relink the ticket to this project by name (owner asked to fix the target). Must match exactly one project — ambiguous matches fail loudly instead of guessing."
      ),
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
      let projectNameInput = input.projectName;
      let linkedProjectName: string | null = null;
      if (projectNameInput) {
        const { projects } = await crmListProjects();
        const match = resolveProjectLoose(projects, projectNameInput);
        if (!match || match.ambiguous) {
          return {
            status: "project_not_resolved",
            ticketId: input.ticketId,
            error: !match
              ? `projectName '${projectNameInput}' matched no project — ticket left unchanged. Ask the owner which project.`
              : `projectName '${projectNameInput}' matched multiple projects — ticket left unchanged. Ask the owner to pick one.`,
          };
        }
        projectNameInput = match.project.id;
        linkedProjectName = match.project.name;
      }

      if (input.description || input.system || input.severity || projectNameInput) {
        await crmUpdateTicketContent(input.ticketId, {
          description: input.description,
          system: input.system,
          severity: input.severity,
          ...(projectNameInput ? { projectId: projectNameInput } : {}),
          reason: input.reason,
        });
        if (linkedProjectName) {
          return {
            status: "ticket_updated",
            ticketId: input.ticketId,
            linkedProjectName,
            message: `Ticket ${input.ticketId} relinked to project ${linkedProjectName}. If the ticket is owner-approved, the correction (re)dispatches to that project automatically.`,
          };
        }
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
