import { z } from "zod";
import {
  DEFAULT_REASONING,
  MODEL_ID_MAX_LENGTH,
  MODEL_ID_PATTERN,
  MODEL_LABEL_MAX_LENGTH,
  MODEL_MODALITIES,
  MODEL_PROVIDERS,
  REASONING_LEVELS,
  type CatalogModel,
  type ModelCatalog,
  type ModelRouting,
} from "../../../agent/lib/model-config";

/**
 * Validation of the model documents on the CRM side. The types, defaults and
 * resolution rules live once in agent/lib/model-config.ts, which stays
 * dependency-free (the CRM image ships `agent/` without its node_modules);
 * `satisfies` keeps these schemas from drifting apart from those types.
 */

const modelId = z
  .string()
  .trim()
  .min(1)
  .max(MODEL_ID_MAX_LENGTH)
  .regex(MODEL_ID_PATTERN, "Model id contains whitespace or characters that are not allowed");

const price = z.number().min(0).nullable().default(null);

/** Enough for every Google/Meta family; keeps an owner-only write small. */
const MAX_CATALOG_MODELS = 200;

export const catalogModelSchema = z.object({
  id: modelId,
  modality: z.enum(MODEL_MODALITIES),
  provider: z.enum(MODEL_PROVIDERS),
  label: z.string().trim().min(1).max(MODEL_LABEL_MAX_LENGTH),
  contextWindow: z.number().int().positive().nullable().default(null),
  priceInPerM: price,
  priceOutPerM: price,
  pricePerUnit: price,
}) satisfies z.ZodType<CatalogModel>;

const hasUniqueIds = (models: CatalogModel[]) =>
  new Set(models.map((model) => model.id)).size === models.length;

export const modelCatalogSchema = z.object({
  models: z
    .array(catalogModelSchema)
    .min(1)
    .max(MAX_CATALOG_MODELS)
    .refine(hasUniqueIds, { message: "Model ids must be unique in the catalog" }),
}) satisfies z.ZodType<ModelCatalog>;

// prefault (not default): a missing block is parsed as {} so the leaf defaults
// still apply and a partial document always reads back complete.
export const modelRoutingSchema = z.object({
  text: z
    .object({
      orchestrator: modelId.nullable().default(null),
      marketingCopy: modelId.nullable().default(null),
      reasoning: z.enum(REASONING_LEVELS).default(DEFAULT_REASONING),
    })
    .prefault({}),
  image: z.object({ post: modelId.nullable().default(null) }).prefault({}),
  video: z.object({ model: modelId.nullable().default(null) }).prefault({}),
}) satisfies z.ZodType<ModelRouting>;
