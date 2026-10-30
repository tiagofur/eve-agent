import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description:
    "Weekly editorial strategist: plans next week's content slots (2 news + 2 services per day) balancing reach and conversion, so the daily designer has a decided focus.",
  model: agentModel,
  modelContextWindowTokens: 1048576,
});
