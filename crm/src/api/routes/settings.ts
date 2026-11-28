import { Hono } from "hono";
import {
  MODEL_USES,
  activeEnvOverrides,
  activeModelRoute,
  resolveModel,
  type ModelUse,
  type ResolvedModel,
} from "../../../../agent/lib/model-config";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { testModel, modelTestRequestSchema } from "../../domain/model-check";
import {
  SettingsValidationError,
  formatIssues,
  isSettingsKey,
  listSettingHistory,
  listSettings,
  modelSettingsFrom,
  readSetting,
  saveModels,
  saveSetting,
} from "../../domain/settings";

/**
 * Runtime configuration (Configuración in Mission Control). Reads need the
 * ops scope — the agent reads its model routing here — and writes are
 * owner-only: the agent must not be able to change the models it runs on.
 */

export const settingsRouter = new Hono<{ Variables: AuthContextVariables }>();

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// Every document with its provenance (saved vs code default), plus what each
// model use resolves to right now. docker-compose passes both the agent and
// the CRM containers the same set of model variables (GEMINI_*, META_*,
// DEFAULT_MODEL, NANO_BANANA_MODEL_ID, OMNI_FLASH_MODEL_ID), so `effective`
// describes the orchestrator's next turn as well as this process.
settingsRouter.get("/", requireScope(["ops"]), async (c) => {
  const settings = await listSettings();
  const modelSettings = modelSettingsFrom(settings);
  const effective = Object.fromEntries(
    MODEL_USES.map((use) => [use, resolveModel(use, modelSettings)])
  ) as Record<ModelUse, ResolvedModel | null>;
  return c.json({
    settings,
    runtime: { provider: activeModelRoute().provider, envOverrides: activeEnvOverrides(), effective },
  });
});

// Audit trail of one document, newest first.
settingsRouter.get("/history/:key", requireScope(["ops"]), async (c) => {
  const key = c.req.param("key") ?? "";
  if (!isSettingsKey(key)) {
    return c.json({ error: `Unknown setting: ${key}` }, 404);
  }
  return c.json({ key, history: await listSettingHistory(key) });
});

settingsRouter.get("/:key", requireScope(["ops"]), async (c) => {
  const key = c.req.param("key") ?? "";
  if (!isSettingsKey(key)) {
    return c.json({ error: `Unknown setting: ${key}` }, 404);
  }
  return c.json({ setting: await readSetting(key) });
});

// Catalog and routing as one pair: validated together (the routing against
// the incoming catalog, so rewiring and pruning fit in one save) and written
// in a single transaction — both revisions move or neither does.
settingsRouter.put("/models", requireScope(["owner"]), async (c) => {
  const body = await readBody(c);
  if (body === undefined || typeof body !== "object" || body === null) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const { catalog, routing } = body as { catalog?: unknown; routing?: unknown };
  try {
    const result = await saveModels({ catalog, routing }, c.get("actor"));
    return c.json({ success: true, catalog: result.catalog, routing: result.routing });
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// Replaces the whole document; every save leaves an audit event.
settingsRouter.put("/:key", requireScope(["owner"]), async (c) => {
  const key = c.req.param("key") ?? "";
  if (!isSettingsKey(key)) {
    return c.json({ error: `Unknown setting: ${key}` }, 404);
  }

  const body = await readBody(c);
  if (body === undefined) {
    return c.json({ error: "Request body must be JSON" }, 400);
  }

  try {
    const setting = await saveSetting(key, body, c.get("actor"));
    return c.json({ success: true, setting });
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

// Owner-only: proves a model answers before it is routed to.
settingsRouter.post("/models/test", requireScope(["owner"]), async (c) => {
  const body = await readBody(c);
  const parsed = modelTestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: formatIssues(parsed.error) }, 400);
  }
  return c.json({ result: await testModel(parsed.data) });
});
