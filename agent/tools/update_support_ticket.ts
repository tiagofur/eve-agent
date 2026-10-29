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
        "Relink the ticket to this project by name (owner asked to fix the target). Prefer the exact project name; a loose match is flagged in the result, and ambiguous matches fail loudly instead of guessing."
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
      let projectIdInput: string | undefined;
      let linkedProjectName: string | null = null;
      let matchNote: string | undefined;
      if (input.projectName) {
        const { projects } = await crmListProjects();
        // The owner is correcting a target: exact (case-insensitive) name
        // wins; fuzzy matching only fills in and is flagged in the result.
        const exact = projects.find(
          (p) => p.name.toLowerCase() === input.projectName!.trim().toLowerCase()
        );
        const match = exact
          ? { project: exact, ambiguous: false }
          : resolveProjectLoose(projects, input.projectName);
        if (!match || match.ambiguous) {
          return {
            status: "project_not_resolved",
            ticketId: input.ticketId,
            error: !match
              ? `projectName '${input.projectName}' matched no project — ticket left unchanged. Ask the owner which project.`
              : `projectName '${input.projectName}' matched multiple projects — ticket left unchanged. Ask the owner to pick one.`,
          };
        }
        projectIdInput = match.project.id;
        linkedProjectName = match.project.name;
        if (!exact) {
          matchNote = `Matched '${match.project.name}' loosely from '${input.projectName}' — confirm the name with the owner.`;
        }
      }

      let relinked = false;
      if (input.description || input.system || input.severity || projectIdInput) {
        await crmUpdateTicketContent(input.ticketId, {
          description: input.description,
          system: input.system,
          severity: input.severity,
          ...(projectIdInput ? { projectId: projectIdInput } : {}),
          reason: input.reason,
        });
        relinked = Boolean(linkedProjectName);
      }

      // Status applies together with the relink: dropping it silently would
      // leave a half-applied update.
      if (input.status) {
        await crmUpdateTicketStatus(input.ticketId, input.status, {
          reason: input.reason,
          clientMessage: input.clientMessage,
        });
      }

      const parts: string[] = [];
      if (relinked && linkedProjectName) {
        parts.push(
          `Ticket ${input.ticketId} relinked to project ${linkedProjectName}. If the ticket is owner-approved, the correction (re)dispatches to that project automatically.`
        );
      } else if (matchNote) {
        parts.push(matchNote);
      }
      if (input.status) {
        parts.push(`Ticket ${input.ticketId} is now ${input.status}.`);
      }
      if (parts.length === 0) {
        parts.push(`Ticket ${input.ticketId} content corrected.`);
      }

      return {
        status: "ticket_updated",
        ticketId: input.ticketId,
        ...(input.status ? { newStatus: input.status } : {}),
        ...(linkedProjectName ? { linkedProjectName } : {}),
        message: parts.join(" "),
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
