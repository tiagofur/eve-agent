import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetProjectTasks } from "../lib/crm";

export default defineTool({
  description:
    "Read every task of a project with specs, statuses, PR urls and verification evidence. Use it to review coding-agent output against acceptance criteria before any client sign-off — never approve blind.",
  inputSchema: z.object({
    projectId: z.string().uuid().describe("Project UUID to review"),
  }),
  async execute(input) {
    try {
      const data = await crmGetProjectTasks(input.projectId);
      return {
        status: "tasks_retrieved",
        tasks: data.tasks,
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "tasks_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
