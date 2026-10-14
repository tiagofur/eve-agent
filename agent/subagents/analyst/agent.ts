import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist business intelligence analyst that evaluates CRM conversion funnels, response times, bottleneck detection, and daily actionable improvements for Creapolis.Dev.",
  model: agentModel,
});
