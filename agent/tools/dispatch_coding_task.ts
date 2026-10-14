import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateTask } from "../lib/crm";

export default defineTool({
  description: "Draft an engineering specification and queue an implementation task in Creapolis CRM for coding agents (gentle-shell / PI agent).",
  inputSchema: z.object({
    projectId: z.string().describe("UUID of the target project in CRM"),
    milestoneId: z.string().optional().describe("Associated milestone UUID"),
    title: z.string().describe("Concise task title (e.g. Implement webhook retry handler)"),
    spec: z.string().describe("Comprehensive engineering specification: context, acceptance criteria, target files, tests"),
    assignee: z.string().default("gentle-shell").describe("Target coding agent or dev runner (default: gentle-shell)"),
  }),
  async execute(input) {
    try {
      const result = await crmCreateTask({
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        title: input.title,
        spec: input.spec,
        assignee: input.assignee,
      });

      return {
        status: "task_dispatched",
        taskId: result.task.id,
        title: result.task.title,
        assignee: result.task.assignee,
        message: `Task queued in CRM ready for coding agent "${result.task.assignee}".`,
      };
    } catch (err) {
      return {
        status: "dispatch_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
