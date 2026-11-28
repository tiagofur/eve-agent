import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { apiKeys, appSettings, brandVisualConfigs } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";
import { readModelSettings, readSetting } from "./domain/settings";
import { resolveModelId } from "../../agent/lib/model-config";

/**
 * Runtime configuration: every document starts on its code default, only the
 * owner can save, a save must leave the models runnable, and every change is
 * audited with before/after.
 */
describe("Settings API", () => {
  const ownerKey = "cp_owner_settingskey1234567890abcdef";
  const opsKey = "cp_ops_settingskey1234567890abcdefghij";
  const withAuth = (key: string) => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  });
  const ownerHeaders = withAuth(ownerKey);
  const opsHeaders = withAuth(opsKey);

  const save = (key: string, body: unknown, headers: Record<string, string> = ownerHeaders) =>
    app.request(`/api/settings/${key}`, { method: "PUT", headers, body: JSON.stringify(body) });

  interface SettingBody {
    key: string;
    saved: boolean;
    revision: number;
    value: {
      text: { orchestrator: string | null; reasoning: string };
      image: { post: string | null };
      video: { model: string | null };
      models: Array<{ id: string; modality: string; provider: string; label: string }>;
    };
  }
  interface HistoryBody {
    history: Array<{
      actor: string;
      before: { text: { orchestrator: string | null } } | null;
      after: { text: { orchestrator: string | null } };
      createdAt: string;
    }>;
  }

  beforeAll(async () => {
    await db.delete(appSettings);
    await db.insert(apiKeys).values([
      { name: "Settings Test Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
      { name: "Settings Test Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
    ]);
    await db
      .delete(brandVisualConfigs)
      .where(eq(brandVisualConfigs.brand, "settings-test"));
    // A brand whose cover model the catalog must keep.
    await db.insert(brandVisualConfigs).values({ brand: "settings-test", imageModel: "gemini-3-pro-image" });
  });

  afterAll(async () => {
    await db.delete(appSettings);
    await db.delete(brandVisualConfigs).where(eq(brandVisualConfigs.brand, "settings-test"));
    await db.delete(apiKeys).where(like(apiKeys.name, "Settings Test %"));
    await pool.end();
  });

  it("has no history before the first save", async () => {
    const res = await app.request("/api/settings/history/models.routing", { headers: opsHeaders });
    expect(res.status).toBe(200);
    expect(((await res.json()) as HistoryBody).history).toEqual([]);
  });

  it("requires auth; ops can read but only the owner can write", async () => {
    expect((await app.request("/api/settings")).status).toBe(401);
    expect((await app.request("/api/settings", { headers: opsHeaders })).status).toBe(200);
    const write = await save("models.routing", {}, opsHeaders);
    expect(write.status).toBe(403);
  });

  it("answers 404 for unknown keys", async () => {
    expect((await app.request("/api/settings/models.unknown", { headers: opsHeaders })).status).toBe(404);
    expect((await save("models.unknown", {})).status).toBe(404);
  });

  it("returns every document on its code default before anything is saved", async () => {
    const res = await app.request("/api/settings", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const { settings } = (await res.json()) as { settings: SettingBody[] };

    expect(settings.map((setting) => setting.key)).toEqual([
      "models.catalog",
      "models.routing",
    ]);
    for (const setting of settings) {
      expect(setting.saved).toBe(false);
      expect(setting.revision).toBe(0);
    }

    const catalog = settings.find((setting) => setting.key === "models.catalog")!;
    expect(catalog.value.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["gemini-flash-latest", "gemini-nano-banana-2.1", "gemini-omni-1.2-flash"])
    );

    const routing = settings.find((setting) => setting.key === "models.routing")!;
    expect(routing.value).toEqual({
      text: { orchestrator: null, marketingCopy: null, reasoning: "high" },
      image: { post: null },
      video: { model: null },
    });
  });

  it("rejects a body that is not JSON or does not match the schema", async () => {
    const notJson = await app.request("/api/settings/models.routing", {
      method: "PUT",
      headers: ownerHeaders,
      body: "{not json",
    });
    expect(notJson.status).toBe(400);

    const badReasoning = await save("models.routing", { text: { reasoning: "ultra" } });
    expect(badReasoning.status).toBe(400);
    expect(((await badReasoning.json()) as { error: string }).error).toContain("reasoning");
  });

  it("saves a routing that persists, bumps the revision and drives the resolver", async () => {
    const first = await save("models.routing", {
      text: { orchestrator: "gemini-4-hydrogen" },
      image: { post: "gemini-3-pro-image" },
    });
    expect(first.status).toBe(200);
    const saved = ((await first.json()) as { setting: SettingBody }).setting;
    expect(saved.saved).toBe(true);
    expect(saved.revision).toBe(1);
    // Fields the owner left out get their defaults.
    expect(saved.value.video).toEqual({ model: null });
    expect(saved.value.text.reasoning).toBe("high");

    const settings = await readModelSettings();
    expect(settings.routing?.text.orchestrator).toBe("gemini-4-hydrogen");
    // Saved beats the env override.
    expect(
      resolveModelId("orchestrator", settings, { GEMINI_API_KEY: "k", GEMINI_MODEL_ID: "gemini-4-neon" })
    ).toBe("gemini-4-hydrogen");
    expect(resolveModelId("image", settings, { GEMINI_API_KEY: "k" })).toBe("gemini-3-pro-image");

    const second = await save("models.routing", { text: { orchestrator: "gemini-4-neon" } });
    expect(((await second.json()) as { setting: SettingBody }).setting.revision).toBe(2);
    expect((await readModelSettings()).routing?.image.post).toBeNull();
  });

  it("rejects a routing that points outside the catalog or at the wrong modality", async () => {
    const unknown = await save("models.routing", { text: { orchestrator: "gemini-99-omega" } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("not in the catalog");

    const wrongModality = await save("models.routing", { image: { post: "gemini-4-hydrogen" } });
    expect(wrongModality.status).toBe(400);
    expect(((await wrongModality.json()) as { error: string }).error).toContain("needs a image model");
  });

  it("rejects a catalog with duplicate or malformed model ids", async () => {
    const { models } = (await readSetting("models.catalog")).value;

    const duplicate = await save("models.catalog", { models: [...models, models[0]!] });
    expect(duplicate.status).toBe(400);
    expect(((await duplicate.json()) as { error: string }).error).toContain("unique");

    const spaced = await save("models.catalog", {
      models: [...models, { id: "gemini 4", modality: "text", provider: "google", label: "Spaced" }],
    });
    expect(spaced.status).toBe(400);
    expect(((await spaced.json()) as { error: string }).error).toContain("whitespace");
  });

  it("rejects a catalog that drops a model still in use", async () => {
    const { models } = (await readSetting("models.catalog")).value;

    // Routed by models.routing.
    const routed = await save("models.catalog", {
      models: models.filter((model) => model.id !== "gemini-4-neon"),
    });
    expect(routed.status).toBe(400);
    expect(((await routed.json()) as { error: string }).error).toContain("not in the catalog");

    // A brand's cover model.
    const cover = await save("models.catalog", {
      models: models.filter((model) => model.id !== "gemini-3-pro-image"),
    });
    expect(cover.status).toBe(400);
    expect(((await cover.json()) as { error: string }).error).toContain('brand "settings-test"');
  });

  it("lets the owner add a model and route to it without a deploy", async () => {
    const { models } = (await readSetting("models.catalog")).value;
    const added = await save("models.catalog", {
      models: [...models, { id: "gemini-9-test", modality: "text", provider: "google", label: "Gemini 9 Test" }],
    });
    expect(added.status).toBe(200);

    const routed = await save("models.routing", { text: { orchestrator: "gemini-9-test" } });
    expect(routed.status).toBe(200);

    const settings = await readModelSettings();
    expect(resolveModelId("orchestrator", settings, { GEMINI_API_KEY: "k" })).toBe("gemini-9-test");
  });

  it("audits every save with before/after, newest first", async () => {
    const res = await app.request("/api/settings/history/models.routing", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const { history } = (await res.json()) as HistoryBody;

    expect(history.length).toBeGreaterThanOrEqual(3);
    expect(history[0]!.actor).toMatch(/^owner:/);
    expect(history[0]!.after.text.orchestrator).toBe("gemini-9-test");
    // The save right before this one left the orchestrator on Neon.
    expect(history[1]!.after.text.orchestrator).toBe("gemini-4-neon");
    expect(history[0]!.before?.text.orchestrator).toBe("gemini-4-neon");
    expect(new Date(history[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(history[history.length - 1]!.createdAt).getTime()
    );
  });
});
