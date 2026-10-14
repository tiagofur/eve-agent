import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist agent for drafting, customizing, and validating software development, workflow automation, and enterprise AI implementation service contracts.",
  model: agentModel,
});
