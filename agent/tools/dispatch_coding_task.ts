import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateTask } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Draft an engineering specification and queue an implementation task in Creapolis CRM for coding agents (gentle-shell / PI agent). The task lands in pending_approval: the owner reviews the issue and approves it before the desktop launcher runs gentle-shell. Corrections must reference their originating support ticket (ticketId) and that ticket must already be approved by the owner (not 'open') — if the CRM rejects with ticket_not_approved, ask the owner to triage the ticket instead of retrying.",
  inputSchema: z.object({
    projectId: z.string().describe("UUID of the target project in CRM"),
    milestoneId: z.string().optional().describe("Associated milestone UUID"),
    ticketId: z.string().optional().describe("Originating support ticket UUID (required for corrections)"),
    title: z.string().describe("Concise task title (e.g. Implement webhook retry handler)"),
    spec: z.string().describe("Comprehensive engineering specification: context, acceptance criteria, target files, tests"),
    assignee: z.string().default("gentle-shell").describe("Target coding agent or dev runner (default: gentle-shell)"),
    kind: z.enum(["feature", "correction"]).default("correction").describe("correction = fix on an existing app; feature = regular delivery task"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "dispatch_coding_task");
    try {
      const result = await crmCreateTask({
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        ticketId: input.ticketId,
        title: input.title,
        spec: input.spec,
        assignee: input.assignee,
        kind: input.kind,
      });

      return {
        status: "task_queued_for_approval",
        taskId: result.task.id,
        title: result.task.title,
        assignee: result.task.assignee,
        taskStatus: result.task.status,
        linkedTicketId: input.ticketId ?? null,
        message: `Task queued in CRM as ${result.task.status}; the owner approves it and the desktop launcher runs "${result.task.assignee}" on the project folder.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "CRM API error";
      return {
        status: message.includes("ticket_not_approved") ? "ticket_not_approved" : "dispatch_failed",
        error: message,
      };
    }
  },
});
