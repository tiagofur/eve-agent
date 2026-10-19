import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Follow-up and closing subagent for Creapolis.Dev: works the overdue queue and drafts nudges that the owner approves before sending.",
  model: agentModel,
  // 1,048,576-token window (Meta docs, verified 2026-10-15): lets `eve build`
  // compile without an AI Gateway lookup for this subscription-routed model.
  modelContextWindowTokens: 1048576,
});
