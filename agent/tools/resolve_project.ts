import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmListProjects } from "../lib/crm";
import { scoreProject } from "../lib/project-match";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Find the CRM project UUID from a name or description the user gives (e.g. 'eve-agent', 'la app de Creapolis'). Staff-only. Call this BEFORE dispatch_coding_task or get_project_tasks whenever you have a name instead of a UUID: never ask the user for a project ID. Returns the single match plus alternatives when ambiguous.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Project name or description as the user said it"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "resolve_project");
    try {
      const { projects } = await crmListProjects();
      const ranked = projects
        .map((p) => ({ project: p, score: scoreProject(p, input.query) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

      const candidates = ranked.map((r) => ({
        id: r.project.id,
        name: r.project.name,
        status: r.project.status,
        organizationName: r.project.organizationName,
        repoUrl: r.project.repoUrl,
        hasLocalFolder: !!r.project.localPath,
      }));

      if (ranked.length === 0) {
        return {
          status: "no_match",
          query: input.query,
          projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
          message: `No project matches "${input.query}". Listed all ${projects.length} CRM project(s) — ask the user which one, offering these names.`,
        };
      }

      const best = ranked[0]!;
      const ambiguous =
        ranked.length > 1 &&
        (best.score === ranked[1]!.score ||
          (ranked[1]!.score >= 30 && best.score - ranked[1]!.score < 20));

      if (ambiguous) {
        return {
          status: "ambiguous",
          query: input.query,
          candidates,
          message: `Multiple projects match "${input.query}": ask the user which one by NAME (never a UUID), then proceed.`,
        };
      }

      return {
        status: "resolved",
        projectId: best.project.id,
        projectName: best.project.name,
        projectStatus: best.project.status,
        organizationName: best.project.organizationName,
        hasLocalFolder: !!best.project.localPath,
        alternatives: candidates.slice(1, 4),
        message: `Resolved "${input.query}" to project ${best.project.name} (${best.project.id}).`,
      };
    } catch (err) {
      return {
        status: "resolve_failed",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
