import { defineAgent } from "eve";
import { agentModel } from "./lib/models";

export default defineAgent({
  model: agentModel,
  reasoning: "high",
});
