/**
 * Single source of truth for which model serves each use: the orchestrator,
 * the Marketing Studio copy, post images and video. Pure data and resolution
 * only — no provider client is built here — so the CRM imports this module
 * too and neither side keeps its own copy of the defaults.
 *
 * Precedence for every use:
 *   1. The owner's saved routing (crm `app_settings`, edited from
 *      Configuración), but only when that model's provider is the one this
 *      process holds credentials for.
 *   2. The env override for the active provider (GEMINI_MODEL_ID, ...).
 *   3. The code default.
 * A missing or unreachable setting therefore behaves exactly as before the
 * settings screen existed.
 */
import { z } from "zod";

export const MODEL_MODALITIES = ["text", "image", "video"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** google = GEMINI_API_KEY; meta = Meta Model API key or Muse Code subscription. */
export const MODEL_PROVIDERS = ["google", "meta"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Reasoning effort eve forwards to the orchestrator's model calls. */
export const REASONING_LEVELS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^\S+$/, "Model id cannot contain whitespace");

export const catalogModelSchema = z.object({
  /** The provider's own model id (e.g. gemini-4-hydrogen); unique in the catalog. */
  id: modelIdSchema,
  modality: z.enum(MODEL_MODALITIES),
  provider: z.enum(MODEL_PROVIDERS),
  label: z.string().trim().min(1).max(80),
  /** Tokens; null = not recorded (eve then compacts at the pinned default window). */
  contextWindow: z.number().int().positive().nullable().default(null),
  /** USD per million tokens, in and out. */
  priceInPerM: z.number().min(0).nullable().default(null),
  priceOutPerM: z.number().min(0).nullable().default(null),
  /** USD per generated image or video clip. */
  pricePerUnit: z.number().min(0).nullable().default(null),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

const hasUniqueIds = (models: CatalogModel[]) => new Set(models.map((model) => model.id)).size === models.length;

export const modelCatalogSchema = z.object({
  models: z
    .array(catalogModelSchema)
    .min(1)
    .refine(hasUniqueIds, { message: "Model ids must be unique in the catalog" }),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

// prefault (not default): a missing block is parsed as {} so the leaf defaults
// below still apply and a partial document always reads back complete.
export const modelRoutingSchema = z.object({
  text: z
    .object({
      /** Root agent (the brain behind chats, Telegram and crons). */
      orchestrator: modelIdSchema.nullable().default(null),
      /** Post captions the CRM writes with generateText. */
      marketingCopy: modelIdSchema.nullable().default(null),
      reasoning: z.enum(REASONING_LEVELS).default("high"),
    })
    .prefault({}),
  image: z
    .object({
      /** Marketing Studio post image. Cover art stays per brand in brand_visual_configs. */
      post: modelIdSchema.nullable().default(null),
    })
    .prefault({}),
  video: z
    .object({
      model: modelIdSchema.nullable().default(null),
    })
    .prefault({}),
});
export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const MODEL_USES = ["orchestrator", "marketingCopy", "image", "video"] as const;
export type ModelUse = (typeof MODEL_USES)[number];

const USE_MODALITY: Record<ModelUse, ModelModality> = {
  orchestrator: "text",
  marketingCopy: "text",
  image: "image",
  video: "video",
};

export const useModality = (use: ModelUse): ModelModality => USE_MODALITY[use];

/** Catalog entry; whatever is not recorded (prices, context window) stays null. */
const model = (
  id: string,
  modality: ModelModality,
  provider: ModelProvider,
  label: string,
  facts: Partial<Pick<CatalogModel, "contextWindow" | "priceInPerM" | "priceOutPerM" | "pricePerUnit">> = {}
): CatalogModel => ({
  id,
  modality,
  provider,
  label,
  contextWindow: null,
  priceInPerM: null,
  priceOutPerM: null,
  pricePerUnit: null,
  ...facts,
});

/**
 * The catalog before the owner edits it. Prices are the ones verified for
 * this project; null = not recorded, never a guess.
 */
export const DEFAULT_MODEL_CATALOG: CatalogModel[] = [
  model("gemini-flash-latest", "text", "google", "Gemini Flash (latest)"),
  model("gemini-4-hydrogen", "text", "google", "Gemini 4 Hydrogen", { priceInPerM: 0.5, priceOutPerM: 7.5 }),
  model("gemini-4-carbon", "text", "google", "Gemini 4 Carbon"),
  model("gemini-4-neon", "text", "google", "Gemini 4 Neon"),
  model("muse-spark-1.3-contributor", "text", "meta", "Muse Spark 1.3 Contributor"),
  model("gemini-nano-banana-2.1", "image", "google", "Nano Banana 2.1"),
  model("gemini-3-pro-image", "image", "google", "Nano Banana Pro", { pricePerUnit: 0.134 }),
  model("muse-image-1.0", "image", "meta", "Muse Image 1.0"),
  model("gemini-omni-1.2-flash", "video", "google", "Gemini Omni 1.2 Flash", { pricePerUnit: 0.35 }),
];

type DefaultModelIds = Partial<Record<ModelModality, string>>;

/** What runs when neither a saved routing nor an env override applies. */
export const DEFAULT_MODEL_IDS: Record<ModelProvider | "gateway", DefaultModelIds> = {
  google: {
    text: "gemini-flash-latest",
    image: "gemini-nano-banana-2.1",
    video: "gemini-omni-1.2-flash",
  },
  meta: { text: "muse-spark-1.3-contributor", image: "muse-image-1.0" },
  gateway: { text: "openai/gpt-6-luna-fast" },
};

/** Legacy env overrides, one per provider and modality. */
const ENV_MODEL_OVERRIDE: Record<ModelProvider | "gateway", Partial<Record<ModelModality, string>>> = {
  google: { text: "GEMINI_MODEL_ID", image: "NANO_BANANA_MODEL_ID", video: "OMNI_FLASH_MODEL_ID" },
  meta: { text: "META_MODEL_ID" },
  gateway: { text: "DEFAULT_MODEL" },
};

export type ModelRoute =
  | { provider: "google" }
  /** keyed = META_API_KEY / MODEL_API_KEY; otherwise the Muse Code subscription. */
  | { provider: "meta"; keyed: boolean }
  /** META_USE_SUBSCRIPTION=0: eve resolves the gateway id itself. */
  | { provider: "gateway" };

/** Same precedence as agent/lib/models.ts: an explicit key always wins. */
export function activeModelRoute(env: NodeJS.ProcessEnv = process.env): ModelRoute {
  if (env.GEMINI_API_KEY) return { provider: "google" };
  if (env.META_API_KEY || env.MODEL_API_KEY) return { provider: "meta", keyed: true };
  if (env.META_USE_SUBSCRIPTION === "0") return { provider: "gateway" };
  return { provider: "meta", keyed: false };
}

export interface ModelSettings {
  catalog: CatalogModel[];
  /** null when nothing was ever saved or the CRM could not be reached. */
  routing: ModelRouting | null;
}

/** The model id a routing document assigns to `use`; null = inherit. */
export function savedModelId(use: ModelUse, routing: ModelRouting | null): string | null {
  if (!routing) return null;
  switch (use) {
    case "orchestrator":
      return routing.text.orchestrator;
    case "marketingCopy":
      return routing.text.marketingCopy;
    case "image":
      return routing.image.post;
    case "video":
      return routing.video.model;
  }
}

function defaultModelId(modality: ModelModality, route: ModelRoute, env: NodeJS.ProcessEnv): string | null {
  const override = ENV_MODEL_OVERRIDE[route.provider][modality];
  if (override && env[override]) return env[override];
  return DEFAULT_MODEL_IDS[route.provider][modality] ?? null;
}

/**
 * The model id serving `use` right now, or null when the active provider has
 * none for that modality (no video without a Gemini key). A saved model only
 * applies when its provider is the one this process has credentials for:
 * nothing may route work to a provider without a key.
 */
export function resolveModelId(
  use: ModelUse,
  settings: ModelSettings | null,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const route = activeModelRoute(env);
  const modality = useModality(use);
  const saved = savedModelId(use, settings?.routing ?? null);
  const entry = saved ? settings?.catalog.find((model) => model.id === saved) : undefined;
  if (entry && entry.modality === modality && entry.provider === route.provider) return entry.id;
  return defaultModelId(modality, route, env);
}
