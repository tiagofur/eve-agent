import type { ModelSelection } from "eve/models";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createSubscriptionFetch } from "./meta-subscription";
import {
  DEFAULT_REASONING,
  activeModelRoute,
  contextWindowFor,
  resolveModel,
  type ModelRoute,
  type ModelSettings,
  type ModelUse,
} from "./model-config";

const META_BASE_URL = process.env.META_API_BASE_URL || "https://api.meta.ai/v1";

/**
 * Which provider serves a model id follows the keys set in the environment:
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
function buildModelClient(route: ModelRoute, modelId: string, env: NodeJS.ProcessEnv = process.env) {
  if (route.provider === "google") {
    return createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY! })(modelId);
  }

  if (route.provider === "gateway") {
    return modelId;
  }

  const metaKey = env.META_API_KEY || env.MODEL_API_KEY;
  if (metaKey) {
    return createOpenAI({ name: "meta", baseURL: META_BASE_URL, apiKey: metaKey })(modelId);
  }

  return createOpenAI({
    name: "meta-subscription",
    baseURL: META_BASE_URL,
    apiKey: "subscription",
    fetch: createSubscriptionFetch(),
  })(modelId);
}

/** Every provider has a text default, so a text use always resolves. */
function requireModel(use: ModelUse, settings: ModelSettings | null, env: NodeJS.ProcessEnv) {
  const resolved = resolveModel(use, settings, env);
  if (!resolved) throw new Error(`No ${use} model available for provider "${activeModelRoute(env).provider}"`);
  return resolved;
}

/**
 * The model id comes from the shared resolver (agent/lib/model-config.ts:
 * saved routing → env override → code default, e.g. GEMINI_MODEL_ID or
 * gemini-flash-latest). Subagents resolve it once here, when the process
 * starts, without the saved routing: only the orchestrator (below) reads the
 * owner's settings per turn until models-per-agent lands.
 */
export function getAgentModel() {
  const resolved = requireModel("orchestrator", null, process.env);
  return buildModelClient(activeModelRoute(), resolved.modelId);
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
    return google(process.env.ECONOMY_MODEL_ID || requireModel("orchestrator", null, process.env).modelId);
  }
  return getAgentModel();
}

export const economyModel = getEconomyModel();

/**
 * The orchestrator's model for one model call: the owner's saved routing
 * (Configuración → Modelos) with the reasoning effort and context window that
 * go with it. With nothing saved — or when the CRM cannot be reached — it is
 * the env/code model, exactly as before the settings screen.
 */
export function orchestratorSelection(
  settings: ModelSettings | null,
  env: NodeJS.ProcessEnv = process.env
): ModelSelection {
  const resolved = requireModel("orchestrator", settings, env);
  return {
    model: buildModelClient(activeModelRoute(env), resolved.modelId, env),
    reasoning: settings?.routing?.text.reasoning ?? DEFAULT_REASONING,
    modelContextWindowTokens: contextWindowFor(settings?.catalog, resolved.modelId),
  };
}
