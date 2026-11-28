import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
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

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports what each use resolves to and which env overrides apply", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL_ID", "gemini-4-carbon");
    // A developer's .env.local may set these; keep the assertion hermetic.
    vi.stubEnv("NANO_BANANA_MODEL_ID", "");
    vi.stubEnv("OMNI_FLASH_MODEL_ID", "");
    // The routing saved above still points the orchestrator at gemini-9-test.
    const res = await app.request("/api/settings", { headers: opsHeaders });
    const { runtime } = (await res.json()) as {
      runtime: {
        provider: string;
        envOverrides: string[];
        effective: Record<string, { modelId: string; source: string } | null>;
      };
    };

    expect(runtime.provider).toBe("google");
    expect(runtime.envOverrides).toEqual(["GEMINI_MODEL_ID"]);
    expect(runtime.effective.orchestrator).toMatchObject({ modelId: "gemini-9-test", source: "saved" });
    expect(runtime.effective.marketingCopy).toMatchObject({ modelId: "gemini-4-carbon", source: "env" });
    expect(runtime.effective.image).toMatchObject({ modelId: "gemini-nano-banana-2.1", source: "default" });
    expect(runtime.effective.video).toMatchObject({ modelId: "gemini-omni-1.2-flash", source: "default" });
  });

  const probe = (body: unknown, headers: Record<string, string> = ownerHeaders) =>
    app.request("/api/settings/models/test", { method: "POST", headers, body: JSON.stringify(body) });

  const googleJson = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /** Replaces fetch, records every call and answers like Google. */
  const stubGoogle = (respond: (url: string) => Response) => {
    const calls: Array<{ url: string; method: string | undefined; apiKey: string | null; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        calls.push({
          url: target,
          method: init?.method,
          apiKey: new Headers(init?.headers).get("x-goog-api-key"),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return respond(target);
      })
    );
    return calls;
  };

  const GOOGLE_MODELS = "https://generativelanguage.googleapis.com/v1beta/models";

  it("models/test is owner-only and validates the request", async () => {
    const valid = { provider: "google", modelId: "gemini-4-hydrogen", modality: "text" };
    const anonymous = await app.request("/api/settings/models/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect(anonymous.status).toBe(401);
    expect((await probe(valid, opsHeaders)).status).toBe(403);

    expect((await probe({ ...valid, modelId: "" })).status).toBe(400);
    const spaced = await probe({ ...valid, modelId: "gemini 4" });
    expect(((await spaced.json()) as { error: string }).error).toContain("whitespace");
    expect((await probe({ ...valid, provider: "openai" })).status).toBe(400);
  });

  it("models/test asks a text model for a few tokens", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const calls = stubGoogle((url) =>
      url.endsWith(":generateContent")
        ? googleJson(200, { candidates: [{ content: { parts: [{ text: "OK" }] } }] })
        : googleJson(404, {})
    );

    const { result } = (await (
      await probe({ provider: "google", modelId: "gemini-4-hydrogen", modality: "text" })
    ).json()) as { result: { ok: boolean; sample?: string; latencyMs?: number } };

    expect(result).toMatchObject({ ok: true, sample: "OK" });
    expect(typeof result.latencyMs).toBe("number");
    expect(calls).toHaveLength(1);
    // The probe is a real generation, but a tiny one: the budget is pinned so
    // "a few tokens" stays a few tokens.
    expect(calls[0]).toMatchObject({
      url: `${GOOGLE_MODELS}/gemini-4-hydrogen:generateContent`,
      method: "POST",
      apiKey: "test-key",
    });
    expect(calls[0]!.body).toEqual({
      contents: [{ parts: [{ text: "Responde únicamente: OK" }] }],
      generationConfig: { maxOutputTokens: 16, temperature: 0 },
    });
  });

  it("models/test only looks up image and video models, never generates", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const calls = stubGoogle(() => googleJson(200, { name: "models/gemini-3-pro-image" }));

    const { result } = (await (
      await probe({ provider: "google", modelId: "gemini-3-pro-image", modality: "image" })
    ).json()) as { result: { ok: boolean } };

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${GOOGLE_MODELS}/gemini-3-pro-image`, apiKey: "test-key" });
    // Lookup only: no generation request on an image probe.
    expect(calls[0]!.body).toBeUndefined();
  });

  it("models/test explains an unknown model, a denied key and a missing key", async () => {
    const text = { provider: "google", modelId: "gemini-4-hydrogen", modality: "text" };
    const reasonOf = async (body: unknown) =>
      ((await (await probe(body)).json()) as { result: { ok: boolean; reason: string } }).result;

    vi.stubEnv("GEMINI_API_KEY", "test-key");
    stubGoogle(() => googleJson(404, { error: { message: "not found" } }));
    const unknown = await reasonOf({ provider: "google", modelId: "gemini-99-omega", modality: "video" });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toContain("no reconoce");

    vi.stubGlobal("fetch", vi.fn(async () => googleJson(403, { error: { message: "denied" } })));
    const denied = await reasonOf(text);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("no tiene acceso");

    vi.stubEnv("GEMINI_API_KEY", "");
    const keyless = await reasonOf(text);
    expect(keyless.ok).toBe(false);
    expect(keyless.reason).toContain("GEMINI_API_KEY");
  });

  it("models/test has no probe for other providers", async () => {
    const calls = stubGoogle(() => googleJson(200, {}));
    const { result } = (await (
      await probe({ provider: "meta", modelId: "muse-spark-1.3-contributor", modality: "text" })
    ).json()) as { result: { ok: boolean | null } };

    expect(result.ok).toBeNull();
    expect(calls).toHaveLength(0);
  });

  describe("PUT /api/settings/models (combined catalog+routing)", () => {
    interface ModelsBody {
      success: boolean;
      catalog: SettingBody;
      routing: SettingBody;
    }
    const pair = (routingTextOrchestrator: string | null, catalogExtra: string[] = []) => ({
      routing: { text: { orchestrator: routingTextOrchestrator }, image: {}, video: {} },
      catalog: {
        models: [
          ...catalogExtra.map((id) => ({ id, modality: "text", provider: "google", label: id })),
          { id: "gemini-flash-latest", modality: "text", provider: "google", label: "Flash" },
          { id: "gemini-nano-banana-2.1", modality: "image", provider: "google", label: "NB" },
          { id: "gemini-3-pro-image", modality: "image", provider: "google", label: "Pro" },
        ],
      },
    });
    const revisions = async () => {
      const res = await app.request("/api/settings", { headers: opsHeaders });
      const { settings } = (await res.json()) as { settings: SettingBody[] };
      return settings.map((setting) => setting.revision);
    };

    it("is owner-only and saves the pair in one go", async () => {
      const before = await revisions();
      const anonymous = await app.request("/api/settings/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pair(null)),
      });
      expect(anonymous.status).toBe(401);
      expect((await app.request("/api/settings/models", { method: "PUT", headers: opsHeaders, body: JSON.stringify(pair(null)) })).status).toBe(403);

      const res = await save("models", pair("gemini-flash-latest", ["gemini-9-test"]));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ModelsBody;
      expect(body.routing.value.text.orchestrator).toBe("gemini-flash-latest");
      expect(body.catalog.value.models.map((model) => model.id)).toContain("gemini-9-test");
      // Both documents moved together.
      const after = await revisions();
      expect(after[0]).toBe(before[0]! + 1);
      expect(after[1]).toBe(before[1]! + 1);
    });

    it("validates the pair against the INCOMING catalog and saves neither on failure", async () => {
      // Rewire and prune together: the routing points at a model only the
      // incoming catalog has — the saved one would fail this save.
      const ok = await save("models", pair("gemini-9-fresh", ["gemini-9-fresh"]));
      expect(ok.status).toBe(200);
      const between = await revisions();

      const failing = await save("models", pair("gemini-9-missing", []));
      expect(failing.status).toBe(400);
      expect(((await failing.json()) as { error: string }).error).toContain("not in the catalog");
      // Atomic: the failed save moved no revision.
      expect(await revisions()).toEqual(between);
    });

    it("rejects a control character in a model id", async () => {
      const res = await save("models", pair(null, ["bad\u0000id"]));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("whitespace");
    });
  });
});
