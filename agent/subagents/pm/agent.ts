import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist Project Manager subagent that oversees client onboarding, milestone breakdown, and dispatches precise technical tasks with specs to coding agents (gentle-shell / PI agent).",
  model: agentModel,
});
