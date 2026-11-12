import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmCreateDraft, crmGetWeeklyActivity } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Queue the weekly client status report draft for ONE project in Creapolis CRM. Run get_weekly_activity first: the report must cite only what it shows. The draft ALWAYS starts as pending_approval — the owner reviews it in Desktop or Telegram before anything is sent. One report per project per week; pass the endpoint's weekTag and never draft when pendingReport is already true.",
  inputSchema: z.object({
    projectId: z.string().uuid().describe("Project UUID from get_weekly_activity"),
    contactId: z.string().uuid().describe("Client contact UUID from get_weekly_activity contactsByOrganization"),
    weekTag: z.string().regex(/^\d{4}-W\d{2}$/).describe("ISO week tag from get_weekly_activity, e.g. 2026-W46"),
    subject: z.string().min(1).describe("Subject line, e.g. 'Avance semanal — <proyecto> (<weekTag>)'"),
    body: z.string().min(1).describe("Full report text in Spanish: logrado esta semana / en curso / próximo / lo que necesito de ti"),
    rationale: z.string().optional().describe("Anything the owner should know before approving"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "draft_weekly_report");
    try {
      const weekly = await crmGetWeeklyActivity();
      const project = weekly.projects.find((p) => p.projectId === input.projectId);
      if (!project) return { status: "not_found", error: "Project not in this week's activity." };
      if (project.pendingReport) {
        return {
          status: "report_already_pending",
          error: "This project's weekly report already awaits approval. Review that draft instead.",
        };
      }

      const result = await crmCreateDraft({
        organizationId: project.organizationId,
        contactId: input.contactId,
        channel: "email",
        subject: input.subject,
        body: input.body,
        rationale: input.rationale ?? `Reporte semanal ${input.weekTag} del proyecto ${project.projectName}.`,
        metadata: { reportWeek: input.weekTag, projectId: input.projectId },
      });

      return {
        status: "report_created_pending_approval",
        draftId: result.draft.id,
        weekTag: input.weekTag,
        message: "Weekly report queued in CRM as pending_approval. Nothing was sent.",
      };
    } catch (err) {
      return {
        status: "report_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
