import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MODEL_CATALOG, type ModelSettings } from "../lib/model-config";
import { orchestratorSelection } from "../lib/models";
import { getModelSettings, parseModelSettings, resetModelSettingsCache } from "../lib/settings";

const GOOGLE_KEY = { GEMINI_API_KEY: "gemini-key" };

/** What `GET /api/settings` returns once the owner routed the orchestrator. */
const payload = (routingSaved = true) => ({
  settings: [
    {
      key: "models.catalog",
      saved: true,
      value: {
        models: [
          {
            id: "gemini-4-hydrogen",
            modality: "text",
            provider: "google",
            label: "Gemini 4 Hydrogen",
            contextWindow: 200_000,
            priceInPerM: 0.5,
            priceOutPerM: 7.5,
            pricePerUnit: null,
          },
        ],
      },
    },
    {
      key: "models.routing",
      saved: routingSaved,
      value: {
        text: { orchestrator: "gemini-4-hydrogen", marketingCopy: null, reasoning: "low" },
        image: { post: null },
        video: { model: null },
      },
    },
  ],
});

describe("parseModelSettings", () => {
  it("reads the catalog and the saved routing", () => {
    const settings = parseModelSettings(payload());
    expect(settings.catalog.map((model) => model.id)).toEqual(["gemini-4-hydrogen"]);
    expect(settings.routing?.text).toEqual({ orchestrator: "gemini-4-hydrogen", marketingCopy: null, reasoning: "low" });
  });

  it("ignores a routing the owner never saved", () => {
    expect(parseModelSettings(payload(false)).routing).toBeNull();
  });

  it("throws on a payload it cannot trust", () => {
    expect(() => parseModelSettings({ settings: [] })).toThrow();
    expect(() => parseModelSettings({ settings: [{ key: "models.catalog", saved: true, value: { models: [] } }] })).toThrow();
    expect(() => parseModelSettings({ settings: [{ key: "models.catalog", saved: true, value: { models: [{ id: "x", modality: "hologram", provider: "google", label: "X", contextWindow: null, priceInPerM: null, priceOutPerM: null, pricePerUnit: null }] } }] })).toThrow();
  });
});

describe("getModelSettings", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  beforeEach(() => {
    resetModelSettingsCache();
    vi.stubEnv("CRM_API_URL", "http://crm.test");
    vi.stubEnv("CRM_OPS_KEY", "ops-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads the settings from the CRM with the ops key and caches them", async () => {
    const fetchMock = vi.fn(async () => json(payload()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getModelSettings();
    const second = await getModelSettings();

    expect(first.routing?.text.orchestrator).toBe("gemini-4-hydrogen");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://crm.test/api/settings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ops-key");
  });

  it("falls back to no saved routing when the CRM is unreachable, without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));
    const offline = await getModelSettings();
    expect(offline).toEqual({ catalog: DEFAULT_MODEL_CATALOG, routing: null });

    // A CRM older than this agent answers 404 for the route.
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "not found" }, 404)));
    resetModelSettingsCache();
    expect((await getModelSettings()).routing).toBeNull();

    // Garbage is not trusted either.
    vi.stubGlobal("fetch", vi.fn(async () => json({ settings: "nope" })));
    resetModelSettingsCache();
    expect((await getModelSettings()).routing).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("orchestratorSelection", () => {
  const settings: ModelSettings = parseModelSettings(payload());

  it("runs the saved model with its reasoning effort and context window", () => {
    const selection = orchestratorSelection(settings, GOOGLE_KEY);
    expect(selection.model).toMatchObject({ modelId: "gemini-4-hydrogen" });
    expect(selection.reasoning).toBe("low");
    expect(selection.modelContextWindowTokens).toBe(200_000);
  });

  it("is the env/code model when nothing is saved", () => {
    expect(orchestratorSelection(null, GOOGLE_KEY)).toMatchObject({
      model: { modelId: "gemini-flash-latest" },
      reasoning: "high",
      modelContextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
    expect(orchestratorSelection(null, { ...GOOGLE_KEY, GEMINI_MODEL_ID: "gemini-4-neon" }).model).toMatchObject({
      modelId: "gemini-4-neon",
    });
  });

  it("ignores a saved model its provider has no key for", () => {
    const otherProvider: ModelSettings = {
      catalog: settings.catalog,
      routing: { ...settings.routing!, text: { ...settings.routing!.text, orchestrator: "muse-spark-1.3-contributor" } },
    };
    expect(orchestratorSelection(otherProvider, GOOGLE_KEY).model).toMatchObject({ modelId: "gemini-flash-latest" });
  });

  it("hands eve a gateway id on the escape hatch", () => {
    expect(orchestratorSelection(null, { META_USE_SUBSCRIPTION: "0" }).model).toBe("openai/gpt-6-luna-fast");
  });
});
