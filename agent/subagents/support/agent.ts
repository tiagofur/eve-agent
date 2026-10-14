import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Customer support and incident triage subagent for Creapolis.Dev clients, handling bug reports, system health inquiries, and maintenance requests.",
  model: agentModel,
});
