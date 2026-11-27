import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmListSchedules } from "../lib/crm";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "List the scheduled tasks (agent cronjobs): cadence, prompt, category, next/last run, status and what each one spent in tokens over the last 7 days (usage7d; delegated subagents included). Use this before creating or changing one to avoid duplicates, to see the exact `name` used by the other schedule tools, and to answer what a task costs.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    requireStaff(ctx, "list_schedules");
    try {
      const data = await crmListSchedules();
      return {
        status: "schedules_listed",
        serverNow: data.serverNow,
        timezone: data.timezone,
        schedules: data.schedules.map((s) => ({
          name: s.name,
          title: s.title,
          cron: s.cron,
          enabled: s.enabled,
          source: s.source,
          category: s.category,
          nextRunAt: s.nextRunAt,
          lastRun: s.lastRun
            ? {
                status: s.lastRun.status,
                startedAt: s.lastRun.startedAt,
                error: s.lastRun.error,
                inputTokens: s.lastRun.inputTokens ?? null,
                outputTokens: s.lastRun.outputTokens ?? null,
              }
            : null,
          usage7d: s.usage7d ?? null,
          promptPreview: s.prompt.slice(0, 200),
        })),
        retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        status: "schedules_unavailable",
        error: err instanceof Error ? err.message : "CRM API unreachable",
      };
    }
  },
});
