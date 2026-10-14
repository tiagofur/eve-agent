import { createOpenAI } from "@ai-sdk/openai";

/**
 * Resolves the active model for Creapolis Eve Agents.
 * When META_API_KEY is configured, it points directly to Meta's Model API
 * serving the Muse Spark family (e.g. muse-spark-1.3-contributor).
 *
 * Otherwise, it falls back to the default OpenAI/Gateway model.
 */
export function getAgentModel() {
  const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  if (metaKey) {
    const meta = createOpenAI({
      name: "meta",
      baseURL: process.env.META_API_BASE_URL || "https://api.meta.ai/v1",
      apiKey: metaKey,
    });
    return meta(process.env.META_MODEL_ID || "muse-spark-1.3-contributor");
  }

  return process.env.DEFAULT_MODEL || "openai/gpt-6-luna-fast";
}

export const agentModel = getAgentModel();
