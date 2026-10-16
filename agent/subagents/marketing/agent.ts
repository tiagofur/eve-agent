import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist agent for marketing, technical copywriting, social media strategy (LinkedIn, X, Instagram), and developer brand storytelling for Creapolis.Dev.",
  model: agentModel,
  // 1,048,576-token window (Meta docs, verified 2026-10-15): lets `eve build`
  // compile without an AI Gateway lookup for this subscription-routed model.
  modelContextWindowTokens: 1048576,
});
