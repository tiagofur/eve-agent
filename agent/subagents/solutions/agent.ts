import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Senior solutions architect subagent that analyzes technical requirements, defines software stacks, and designs custom AI and automation architectures for Creapolis.Dev clients.",
  model: agentModel,
});
