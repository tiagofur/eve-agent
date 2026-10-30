import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description:
    "Daily AI intelligence analyst: curates AI news (what's now possible, problems/solutions) into an actionable brief for Creapolis.Dev content and service opportunities.",
  model: agentModel,
  modelContextWindowTokens: 1048576,
});
