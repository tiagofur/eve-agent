import { defineAgent } from "eve";
import { agentModel } from "./lib/models";

export default defineAgent({
  model: agentModel,
  reasoning: "high",
  build: {
    // Native .node addon: must stay external or `eve build` tries to bundle
    // the binary and fails with UNLOADABLE_DEPENDENCY.
    externalDependencies: ["@resvg/resvg-js"],
  },
  // Verified 2026-10-15 against Meta Model API docs / OpenRouter / Vercel
  // AI Gateway: muse-spark-1.3-contributor has a 1,048,576-token window.
  // Lets `eve build` compile compaction without an AI Gateway metadata
  // lookup for this subscription-routed model ID.
  modelContextWindowTokens: 1048576,
  // No authored tool or subagent runs shell commands (coding agents are
  // dispatched through the CRM), so the built-in bash/read_file/write_file
  // defaults stay off to keep the public-facing surface minimal.
  defaultTools: false,
  limits: {
    // eve defaults without these: 40M input tokens per session and a
    // 30-day session lifetime — too generous for sessions that anonymous
    // visitors can keep alive from the public chat and WhatsApp.
    maxInputTokensPerSession: 2_000_000,
    maxOutputTokensPerSession: 60_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
