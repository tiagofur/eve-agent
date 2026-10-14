import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist prospector agent that investigates target businesses (local businesses, Google Maps listings, public websites), extracts pain points, and builds verified dossiers.",
  model: agentModel,
});
