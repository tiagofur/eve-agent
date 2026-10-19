import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Billing and collections subagent for Creapolis.Dev: watches milestones and contracts, drafts payment reminders the owner approves before sending.",
  model: agentModel,
  // 1,048,576-token window (Meta docs, verified 2026-10-15): lets `eve build`
  // compile without an AI Gateway lookup for this subscription-routed model.
  modelContextWindowTokens: 1048576,
});
