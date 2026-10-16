import { defineAgent } from "eve";
import { agentModel } from "./lib/models";

export default defineAgent({
  model: agentModel,
  reasoning: "high",
  // Verified 2026-10-15 against Meta Model API docs / OpenRouter / Vercel
  // AI Gateway: muse-spark-1.3-contributor has a 1,048,576-token window.
  // Lets `eve build` compile compaction without an AI Gateway metadata
  // lookup for this subscription-routed model ID.
  modelContextWindowTokens: 1048576,
});
