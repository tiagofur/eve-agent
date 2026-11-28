import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createSubscriptionFetch } from "./meta-subscription";
import { activeModelRoute, resolveModelId } from "./model-config";

const META_BASE_URL = process.env.META_API_BASE_URL || "https://api.meta.ai/v1";

/**
 * Resolves the active model for Creapolis Eve Agents.
 *
 * The model id comes from the shared resolver (agent/lib/model-config.ts:
 * saved routing → env override → code default, e.g. GEMINI_MODEL_ID or
 * gemini-flash-latest). Which provider serves it follows the keys set here:
 *
 *   0. GEMINI_API_KEY → Gemini API (pay-as-you-go). Set on the VPS when the
 *      billing/credit is active; removing the key falls back to Muse with no
 *      code change. Same key will power TTS/Veo later.
 *   1. META_API_KEY / MODEL_API_KEY → direct Meta Model API (pay-as-you-go).
 *      An explicit key always wins, like in the Muse Code CLI.
 *   2. META_USE_SUBSCRIPTION=0 → explicit DEFAULT_MODEL gateway id.
 *      Escape hatch back to the previous behavior.
 *   3. Otherwise → Muse Code subscription via one-time OAuth device login
 *      (`node scripts/meta-login.mjs`). LOCAL-ONLY: the short-lived key is
 *      re-minted from the browser session on this machine; a deployment must
 *      set META_API_KEY instead.
 */
export function getAgentModel() {
  const route = activeModelRoute();
  // Nothing is saved yet, so this is the env override or the code default.
  const modelId = resolveModelId("orchestrator", null);
  if (!modelId) throw new Error(`No text model available for provider "${route.provider}"`);

  if (route.provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY! });
    return google(modelId);
  }

  if (route.provider === "gateway") {
    return modelId;
  }

  const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  if (metaKey) {
    const meta = createOpenAI({
      name: "meta",
      baseURL: META_BASE_URL,
      apiKey: metaKey,
    });
    return meta(modelId);
  }

  const metaSubscription = createOpenAI({
    name: "meta-subscription",
    baseURL: META_BASE_URL,
    apiKey: "subscription",
    fetch: createSubscriptionFetch(),
  });
  return metaSubscription(modelId);
}

export const agentModel = getAgentModel();

/**
 * Cheaper model for high-volume, low-judgment subagents (intel, analyst,
 * biller): a Gemini Flash/Lite alias when a Gemini key exists — the same
 * family as the primary — and the main model otherwise. A missing key never
 * silently routes work to an unknown provider; it just keeps today's cost.
 * Override the tier with ECONOMY_MODEL_ID (e.g. gemini-3-flash-lite).
 */
export function getEconomyModel() {
  if (activeModelRoute().provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY! });
    return google(process.env.ECONOMY_MODEL_ID || (resolveModelId("orchestrator", null) as string));
  }
  return getAgentModel();
}

export const economyModel = getEconomyModel();
