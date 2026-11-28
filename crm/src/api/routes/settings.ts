import { Hono } from "hono";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  SettingsValidationError,
  isSettingsKey,
  listSettingHistory,
  listSettings,
  readSetting,
  saveSetting,
} from "../../domain/settings";

/**
 * Runtime configuration (Configuración in Mission Control). Reads need the
 * ops scope — the agent reads its model routing here — and writes are
 * owner-only: the agent must not be able to change the models it runs on.
 */

export const settingsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Every document with its provenance (saved vs code default).
settingsRouter.get("/", requireScope(["ops"]), async (c) => {
  return c.json({ settings: await listSettings() });
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

// Replaces the whole document; every save leaves an audit event.
settingsRouter.put("/:key", requireScope(["owner"]), async (c) => {
  const key = c.req.param("key") ?? "";
  if (!isSettingsKey(key)) {
    return c.json({ error: `Unknown setting: ${key}` }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
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
