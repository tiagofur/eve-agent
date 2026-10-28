import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateProject } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description: "Initialize an active client project and deliverables milestones in Creapolis CRM, moving the won lead to onboarding.",
  inputSchema: z.object({
    organizationId: z.string().describe("Organization UUID in the CRM"),
    leadId: z.string().optional().describe("Associated won lead UUID"),
    name: z.string().describe("Project name (e.g. Acme Auto-Billing System)"),
    repoUrl: z.string().url().optional().describe("Git repository URL"),
    milestones: z
      .array(
        z.object({
          title: z.string().min(1).describe("Milestone deliverable title"),
          dueDate: z.string().optional().describe("Target delivery date (YYYY-MM-DD)"),
        })
      )
      .optional()
      .describe("Initial milestone schedule"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "create_project");
    try {
      const result = await crmCreateProject({
        organizationId: input.organizationId,
        leadId: input.leadId,
        name: input.name,
        repoUrl: input.repoUrl,
        milestonesList: input.milestones,
      });

      return {
        status: "project_created",
        projectId: result.project.id,
        name: result.project.name,
        projectStatus: result.project.status,
        message: `Project "${result.project.name}" initialized and moved to onboarding.`,
      };
    } catch (err) {
      return {
        status: "creation_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
