import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description: "Specialist agent for marketing, technical copywriting, social media strategy (LinkedIn, X, Instagram), and developer brand storytelling for Creapolis.Dev.",
  model: agentModel,
});
