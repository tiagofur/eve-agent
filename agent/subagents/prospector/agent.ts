import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist prospector agent that investigates target businesses (local businesses, Google Maps listings, public websites), extracts pain points, and builds verified dossiers.",
  model: agentModel,
  // 1,048,576-token window (Meta docs, verified 2026-10-15): lets `eve build`
  // compile without an AI Gateway lookup for this subscription-routed model.
  modelContextWindowTokens: 1048576,
});
