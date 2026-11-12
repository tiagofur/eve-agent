import { defineAgent } from "eve";
import { economyModel } from "../../lib/models";

export default defineAgent({
  description:
    "Daily AI intelligence analyst: curates AI news (what's now possible, problems/solutions) into an actionable brief for Creapolis.Dev content and service opportunities.",
  model: economyModel,
  modelContextWindowTokens: 1048576,
});
