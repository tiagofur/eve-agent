import { defineAgent } from "eve";
import { agentModel } from "../../lib/models";

export default defineAgent({
  description:
    "Daily content designer: produces the day's image/carousel packs (news + services) with branded rendered slides, ready for owner review in Desktop → Contenido.",
  model: agentModel,
  modelContextWindowTokens: 1048576,
});
