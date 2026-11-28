import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { appSettings, brandVisualConfigs, events } from "../db/schema";
import {
  DEFAULT_MODEL_CATALOG,
  MODEL_USES,
  savedModelId,
  useModality,
  type ModelCatalog,
  type ModelRouting,
  type ModelSettings,
} from "../../../agent/lib/model-config";
import { logEvent, type DbTx } from "./events";
import { modelCatalogSchema, modelRoutingSchema } from "./model-schemas";

/**
 * Runtime configuration edited from Mission Control → Configuración. Each
 * key is a JSON document whose schema and code default are declared here;
 * a missing row means "the previous behavior", so deploying a new key never
 * changes production until the owner saves.
 */

const REGISTRY = {
  "models.catalog": {
    schema: modelCatalogSchema,
    fallback: () => modelCatalogSchema.parse({ models: DEFAULT_MODEL_CATALOG }),
  },
  "models.routing": {
    schema: modelRoutingSchema,
    fallback: () => modelRoutingSchema.parse({}),
  },
} as const;

export type SettingsKey = keyof typeof REGISTRY;
type SettingValue<K extends SettingsKey> = z.infer<(typeof REGISTRY)[K]["schema"]>;

const SETTING_EVENT_ENTITY = "app_setting";

export const isSettingsKey = (key: string): key is SettingsKey =>
  Object.prototype.hasOwnProperty.call(REGISTRY, key);

export interface SettingRecord<K extends SettingsKey = SettingsKey> {
  key: K;
  value: SettingValue<K>;
  /** false while the key runs on its code default (nothing saved yet). */
  saved: boolean;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A document that would leave the system unrunnable; the API answers 400. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

type SettingsRow = typeof appSettings.$inferSelect;

function toRecord<K extends SettingsKey>(key: K, row: SettingsRow | undefined): SettingRecord<K> {
  const entry = REGISTRY[key];
  const parsed = row ? entry.schema.safeParse(row.value) : null;
  if (row && !parsed?.success) {
    // A document that no longer validates (the schema evolved) must not take
    // the API down: run on the default and say so.
    console.warn(`[settings] stored "${key}" no longer validates; using the code default`);
  }
  return {
    key,
    value: (parsed?.success ? parsed.data : entry.fallback()) as SettingValue<K>,
    saved: parsed?.success ?? false,
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export async function listSettings(): Promise<SettingRecord[]> {
  const rows = await db.select().from(appSettings).orderBy(appSettings.key);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return (Object.keys(REGISTRY) as SettingsKey[]).map((key) => toRecord(key, byKey.get(key)));
}

export async function readSetting<K extends SettingsKey>(key: K): Promise<SettingRecord<K>> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return toRecord(key, row);
}

/** The models a settings list resolves with: saved routing, else defaults. */
export function modelSettingsFrom(settings: SettingRecord[]): ModelSettings {
  const catalog = settings.find((setting) => setting.key === "models.catalog");
  const routing = settings.find((setting) => setting.key === "models.routing");
  return {
    catalog: (catalog?.value as ModelCatalog | undefined)?.models ?? [],
    routing: routing?.saved ? (routing.value as ModelRouting) : null,
  };
}

/** The models as they should run right now. */
export async function readModelSettings(): Promise<ModelSettings> {
  return modelSettingsFrom(await listSettings());
}

function assertRoutedModelsExist(routing: ModelRouting, catalog: ModelCatalog): void {
  for (const use of MODEL_USES) {
    const id = savedModelId(use, routing);
    const entry = id ? catalog.models.find((model) => model.id === id) : undefined;
    const modality = useModality(use);
    if (id && !entry) {
      throw new SettingsValidationError(`Model "${id}" is not in the catalog`);
    }
    if (id && entry && entry.modality !== modality) {
      throw new SettingsValidationError(
        `Model "${id}" generates ${entry.modality}, but "${use}" needs a ${modality} model`
      );
    }
  }
}

async function listBrandCoverModels(): Promise<Array<{ brand: string; imageModel: string }>> {
  // Cover art is stored per brand, outside the catalog document.
  return db
    .select({ brand: brandVisualConfigs.brand, imageModel: brandVisualConfigs.imageModel })
    .from(brandVisualConfigs);
}

function assertCatalogKeepsCoverModels(brands: Array<{ brand: string; imageModel: string }>, catalog: ModelCatalog): void {
  for (const { brand, imageModel } of brands) {
    const kept = catalog.models.some((model) => model.id === imageModel && model.modality === "image");
    if (!kept) {
      throw new SettingsValidationError(
        `Model "${imageModel}" is the cover model of brand "${brand}"; switch that brand first or keep the model in the catalog`
      );
    }
  }
}

/**
 * A saved document must leave the system runnable: every routed model exists
 * with the right modality, and the catalog keeps whatever is in use (the
 * routing and each brand's cover model).
 */
async function assertUsable(key: SettingsKey, value: unknown): Promise<void> {
  if (key === "models.routing") {
    const catalog = await readSetting("models.catalog");
    assertRoutedModelsExist(value as ModelRouting, catalog.value);
    return;
  }

  const routing = await readSetting("models.routing");
  assertRoutedModelsExist(routing.value, value as ModelCatalog);
  assertCatalogKeepsCoverModels(await listBrandCoverModels(), value as ModelCatalog);
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Upsert (revision + 1) and audit event, on one connection so callers can wrap them in a transaction. */
async function upsertSettingTx<K extends SettingsKey>(
  tx: DbTx,
  key: K,
  value: Record<string, unknown>,
  actor: string
): Promise<SettingRecord<K>> {
  const [before] = await tx.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  const [row] = await tx
    .insert(appSettings)
    .values({ key, value, updatedBy: actor })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: sql`excluded.value`,
        updatedBy: actor,
        revision: sql`${appSettings.revision} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error(`Saving "${key}" returned no row`);

  await logEvent({
    entity: SETTING_EVENT_ENTITY,
    entityId: row.id,
    action: "updated",
    actor,
    before: before?.value ?? null,
    after: value,
    reason: `Configuración "${key}" guardada desde Mission Control`,
    tx,
  });

  return toRecord(key, row);
}

/** Validates, upserts (revision + 1) and audits — all in one transaction. */
export async function saveSetting<K extends SettingsKey>(
  key: K,
  input: unknown,
  actor: string
): Promise<SettingRecord<K>> {
  const parsed = REGISTRY[key].schema.safeParse(input);
  if (!parsed.success) {
    throw new SettingsValidationError(`Invalid value for "${key}": ${formatIssues(parsed.error)}`);
  }
  await assertUsable(key, parsed.data);
  return db.transaction((tx) => upsertSettingTx(tx, key, parsed.data as Record<string, unknown>, actor));
}

/**
 * Catalog and routing in one transaction, validated as a pair: the routing is
 * checked against the incoming catalog (not the saved one), so the owner can
 * rewire and prune in a single save. Both revisions move together or neither
 * does.
 */
export async function saveModels(
  input: { catalog: unknown; routing: unknown },
  actor: string
): Promise<{ catalog: SettingRecord<"models.catalog">; routing: SettingRecord<"models.routing"> }> {
  const catalogParsed = modelCatalogSchema.safeParse(input.catalog);
  const routingParsed = modelRoutingSchema.safeParse(input.routing);
  if (!catalogParsed.success) {
    throw new SettingsValidationError(`Invalid value for "models.catalog": ${formatIssues(catalogParsed.error)}`);
  }
  if (!routingParsed.success) {
    throw new SettingsValidationError(`Invalid value for "models.routing": ${formatIssues(routingParsed.error)}`);
  }
  assertRoutedModelsExist(routingParsed.data, catalogParsed.data);
  assertCatalogKeepsCoverModels(await listBrandCoverModels(), catalogParsed.data);

  return db.transaction(async (tx) => ({
    catalog: await upsertSettingTx(tx, "models.catalog", catalogParsed.data as Record<string, unknown>, actor),
    routing: await upsertSettingTx(tx, "models.routing", routingParsed.data as Record<string, unknown>, actor),
  }));
}

export interface SettingHistoryEntry {
  action: string;
  actor: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
}

/** Audit trail of one document, newest first. */
export async function listSettingHistory(key: SettingsKey, limit = 50): Promise<SettingHistoryEntry[]> {
  const [row] = await db
    .select({ id: appSettings.id })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  if (!row) return [];

  const audit = await db
    .select({
      action: events.action,
      actor: events.actor,
      before: events.before,
      after: events.after,
      reason: events.reason,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.entity, SETTING_EVENT_ENTITY), eq(events.entityId, row.id)))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(limit);

  return audit.map((entry) => ({
    action: entry.action,
    actor: entry.actor,
    before: entry.before,
    after: entry.after,
    reason: entry.reason,
    createdAt: entry.createdAt.toISOString(),
  }));
}
