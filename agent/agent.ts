import { defineAgent, defineDynamic } from "eve";
import { DEFAULT_REASONING } from "./lib/model-config";
import { orchestratorSelection } from "./lib/models";
import { getModelSettings } from "./lib/settings";

export default defineAgent({
  // The owner picks the orchestrator's model and reasoning in Configuración
  // (crm app_settings, read through the CRM). Resolved once per turn: a change
  // applies on the next turn, and a turn never switches models mid-way — that
  // would drop prompt-cache reuse. Declared subagents keep the model resolved
  // at boot (agent/lib/models.ts) until models-per-agent lands. The selection
  // carries the model's context window, so eve still compiles compaction
  // without an AI Gateway metadata lookup.
  model: defineDynamic(async (ctx) => {
    const settings = await ctx.memo(["model-settings", ctx.turn?.id ?? null], getModelSettings);
    return orchestratorSelection(settings);
  }),
  // Inherited when a selection omits it; orchestratorSelection always sets it.
  reasoning: DEFAULT_REASONING,
  build: {
    // Native .node addon: must stay external or `eve build` tries to bundle
    // the binary and fails with UNLOADABLE_DEPENDENCY.
    externalDependencies: ["@resvg/resvg-js"],
  },
  // No authored tool or subagent runs shell commands (coding agents are
  // dispatched through the CRM), so the built-in bash/read_file/write_file
  // defaults stay off to keep the public-facing surface minimal.
  defaultTools: false,
  limits: {
    // eve defaults without these: 40M input tokens per session and a
    // 30-day session lifetime — too generous for sessions that anonymous
    // visitors can keep alive from the public chat and WhatsApp.
    // eve 1.0 replaced maxInput/maxOutputTokensPerSession with this callback.
    // Same caps as before: 2M input (includes cache reads) + 60K output.
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
    sessionUsage: ({ total }) =>
      total.inputTokens + total.outputTokens >= 2_000_000 + 60_000,
  },
});
