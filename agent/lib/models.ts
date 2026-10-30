import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createSubscriptionFetch } from "./meta-subscription";

const META_BASE_URL = process.env.META_API_BASE_URL || "https://api.meta.ai/v1";
const META_MODEL_ID = process.env.META_MODEL_ID || "muse-spark-1.3-contributor";

// gemini-flash-latest tracks Google's current Flash alias; override with
// GEMINI_MODEL_ID (e.g. gemini-3-flash, gemini-3.1-flash-lite) when needed.
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || "gemini-flash-latest";

/**
 * Resolves the active model for Creapolis Eve Agents.
 *
 * Precedence (local-first, no surprise billing):
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
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const google = createGoogleGenerativeAI({ apiKey: geminiKey });
    return google(GEMINI_MODEL_ID);
  }

  const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  if (metaKey) {
    const meta = createOpenAI({
      name: "meta",
      baseURL: META_BASE_URL,
      apiKey: metaKey,
    });
    return meta(META_MODEL_ID);
  }

  if (process.env.META_USE_SUBSCRIPTION === "0") {
    return process.env.DEFAULT_MODEL || "openai/gpt-6-luna-fast";
  }

  const metaSubscription = createOpenAI({
    name: "meta-subscription",
    baseURL: META_BASE_URL,
    apiKey: "subscription",
    fetch: createSubscriptionFetch(),
  });
  return metaSubscription(META_MODEL_ID);
}

export const agentModel = getAgentModel();
