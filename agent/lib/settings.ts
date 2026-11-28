import { z } from "zod";
import { getCrmUrl, getOpsKey } from "./crm";
import {
  DEFAULT_MODEL_CATALOG,
  MODEL_MODALITIES,
  MODEL_PROVIDERS,
  REASONING_LEVELS,
  type CatalogModel,
  type ModelCatalog,
  type ModelRouting,
  type ModelSettings,
} from "./model-config";

/**
 * The owner's model settings as the CRM holds them (`GET /api/settings`,
 * Configuración → Modelos). The orchestrator asks for them before every
 * model call through eve's dynamic model, so the read is cached and never
 * throws: when the CRM cannot answer, the resolver keeps the env/code model.
 */

// Agent-side validation of what the CRM serves, typed against the shared
// types. The CRM already validates on save; this only guards a CRM that is
// older than this agent or otherwise answers something unexpected.
const catalogModelSchema = z.object({
  id: z.string().min(1),
  modality: z.enum(MODEL_MODALITIES),
  provider: z.enum(MODEL_PROVIDERS),
  label: z.string(),
  contextWindow: z.number().int().positive().nullable(),
  priceInPerM: z.number().nullable(),
  priceOutPerM: z.number().nullable(),
  pricePerUnit: z.number().nullable(),
}) satisfies z.ZodType<CatalogModel>;

const catalogSchema = z.object({ models: z.array(catalogModelSchema).min(1) }) satisfies z.ZodType<ModelCatalog>;

const routingSchema = z.object({
  text: z.object({
    orchestrator: z.string().nullable(),
    marketingCopy: z.string().nullable(),
    reasoning: z.enum(REASONING_LEVELS),
  }),
  image: z.object({ post: z.string().nullable() }),
  video: z.object({ model: z.string().nullable() }),
}) satisfies z.ZodType<ModelRouting>;

const payloadSchema = z.object({
  settings: z.array(z.object({ key: z.string(), value: z.unknown(), saved: z.boolean() })),
});

/** Throws when the payload is not usable; callers decide what to fall back to. */
export function parseModelSettings(payload: unknown): ModelSettings {
  const { settings } = payloadSchema.parse(payload);
  const catalog = settings.find((setting) => setting.key === "models.catalog");
  const routing = settings.find((setting) => setting.key === "models.routing");
  return {
    catalog: catalogSchema.parse(catalog?.value).models,
    routing: routing?.saved ? routingSchema.parse(routing.value) : null,
  };
}

const NO_SAVED_SETTINGS: ModelSettings = { catalog: DEFAULT_MODEL_CATALOG, routing: null };
const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 3_000;

let cached: { at: number; settings: ModelSettings } | null = null;
let inFlight: Promise<ModelSettings> | null = null;

async function fetchModelSettings(): Promise<ModelSettings> {
  try {
    const res = await fetch(`${getCrmUrl()}/api/settings`, {
      headers: { Authorization: `Bearer ${getOpsKey()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cached = { at: Date.now(), settings: parseModelSettings(await res.json()) };
  } catch (err) {
    // Negative results expire with the same TTL, so a turn adds at most one
    // failed request and one warning per cache window.
    cached = { at: Date.now(), settings: NO_SAVED_SETTINGS };
    console.warn("[model-settings] keeping the env/code models:", err instanceof Error ? err.message : err);
  }
  return cached.settings;
}

/** The model settings to resolve with. Never throws. */
export function getModelSettings(): Promise<ModelSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.settings);
  inFlight ??= fetchModelSettings().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test seam: forget the cache. */
export function resetModelSettingsCache(): void {
  cached = null;
}
