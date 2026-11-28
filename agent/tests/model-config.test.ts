import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MODEL_CATALOG,
  MODEL_ID_PATTERN,
  activeEnvOverrides,
  activeModelRoute,
  contextWindowFor,
  resolveModel,
  resolveModelId,
  type ModelRouting,
  type ModelSettings,
} from "../lib/model-config";

const NO_ROUTING: ModelRouting = {
  text: { orchestrator: null, marketingCopy: null, reasoning: "high" },
  image: { post: null },
  video: { model: null },
};

/** Saved settings over the default catalog; unset fields stay unassigned. */
const withRouting = (patch: {
  text?: Partial<ModelRouting["text"]>;
  image?: Partial<ModelRouting["image"]>;
  video?: Partial<ModelRouting["video"]>;
}): ModelSettings => ({
  catalog: DEFAULT_MODEL_CATALOG,
  routing: {
    text: { ...NO_ROUTING.text, ...patch.text },
    image: { ...NO_ROUTING.image, ...patch.image },
    video: { ...NO_ROUTING.video, ...patch.video },
  },
});

const GEMINI = { GEMINI_API_KEY: "gemini-key" };
const META = { META_API_KEY: "meta-key" };

describe("model-config resolution", () => {
  it("runs on the code defaults when nothing is saved", () => {
    expect(resolveModelId("orchestrator", null, GEMINI)).toBe("gemini-flash-latest");
    expect(resolveModelId("marketingCopy", null, GEMINI)).toBe("gemini-flash-latest");
    expect(resolveModelId("image", null, GEMINI)).toBe("gemini-nano-banana-2.1");
    expect(resolveModelId("video", null, GEMINI)).toBe("gemini-omni-1.2-flash");
    expect(resolveModelId("orchestrator", null, META)).toBe("muse-spark-1.3-contributor");
    expect(resolveModelId("image", null, META)).toBe("muse-image-1.0");
    // No video without a Gemini key.
    expect(resolveModelId("video", null, META)).toBeNull();
  });

  it("keeps the legacy env overrides when nothing is saved", () => {
    expect(resolveModelId("orchestrator", null, { ...GEMINI, GEMINI_MODEL_ID: "gemini-4-hydrogen" })).toBe(
      "gemini-4-hydrogen"
    );
    expect(resolveModelId("image", null, { ...GEMINI, NANO_BANANA_MODEL_ID: "gemini-3-pro-image" })).toBe(
      "gemini-3-pro-image"
    );
    expect(resolveModelId("video", null, { ...GEMINI, OMNI_FLASH_MODEL_ID: "omni-next" })).toBe("omni-next");
    expect(resolveModelId("marketingCopy", null, { ...META, META_MODEL_ID: "muse-next" })).toBe("muse-next");
  });

  it("a saved routing wins over the env override and leaves the rest on defaults", () => {
    const settings = withRouting({
      text: { orchestrator: "gemini-4-hydrogen" },
      image: { post: "gemini-3-pro-image" },
    });
    expect(resolveModelId("orchestrator", settings, { ...GEMINI, GEMINI_MODEL_ID: "gemini-4-neon" })).toBe(
      "gemini-4-hydrogen"
    );
    expect(resolveModelId("marketingCopy", settings, GEMINI)).toBe("gemini-flash-latest");
    expect(resolveModelId("image", settings, GEMINI)).toBe("gemini-3-pro-image");
    expect(resolveModelId("video", settings, GEMINI)).toBe("gemini-omni-1.2-flash");
  });

  it("never routes to a provider this process has no key for", () => {
    const settings = withRouting({ text: { orchestrator: "gemini-4-hydrogen" } });
    expect(resolveModelId("orchestrator", settings, META)).toBe("muse-spark-1.3-contributor");
  });

  it("ignores a saved model that cannot serve the use", () => {
    // An image model saved as the orchestrator.
    const settings = withRouting({ text: { orchestrator: "gemini-nano-banana-2.1" } });
    expect(resolveModelId("orchestrator", settings, GEMINI)).toBe("gemini-flash-latest");
    // A model the catalog no longer lists.
    const gone = withRouting({ text: { orchestrator: "gemini-removed" } });
    expect(resolveModelId("orchestrator", gone, GEMINI)).toBe("gemini-flash-latest");
  });

  it("resolves the gateway escape hatch", () => {
    expect(activeModelRoute({ META_USE_SUBSCRIPTION: "0" })).toEqual({ provider: "gateway" });
    expect(resolveModelId("orchestrator", null, { META_USE_SUBSCRIPTION: "0" })).toBe("openai/gpt-6-luna-fast");
    expect(
      resolveModelId("orchestrator", null, { META_USE_SUBSCRIPTION: "0", DEFAULT_MODEL: "openai/custom" })
    ).toBe("openai/custom");
  });

  it("treats a keyless process as the Muse subscription", () => {
    expect(activeModelRoute({})).toEqual({ provider: "meta", keyed: false });
  });
});

describe("resolveModel provenance", () => {
  it("says where each model comes from", () => {
    const settings = withRouting({ text: { orchestrator: "gemini-4-hydrogen" } });
    expect(resolveModel("orchestrator", settings, GEMINI)).toEqual({
      modelId: "gemini-4-hydrogen",
      provider: "google",
      source: "saved",
    });
    expect(resolveModel("orchestrator", null, { ...GEMINI, GEMINI_MODEL_ID: "gemini-4-neon" })).toMatchObject({
      source: "env",
    });
    expect(resolveModel("orchestrator", null, GEMINI)).toMatchObject({ source: "default" });
  });

  it("lists the env overrides in force for the active provider", () => {
    expect(activeEnvOverrides({ ...GEMINI, GEMINI_MODEL_ID: "gemini-4-neon" })).toEqual(["GEMINI_MODEL_ID"]);
    // Only the active provider's overrides count: Meta's key here, not Gemini's.
    expect(activeEnvOverrides({ META_API_KEY: "m", GEMINI_MODEL_ID: "x" })).toEqual([]);
    expect(activeEnvOverrides(GEMINI)).toEqual([]);
  });

  it("uses the catalog's context window, else the pinned default", () => {
    const flash = DEFAULT_MODEL_CATALOG[0]!;
    expect(contextWindowFor([{ ...flash, contextWindow: 200_000 }], flash.id)).toBe(200_000);
    expect(contextWindowFor(DEFAULT_MODEL_CATALOG, flash.id)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowFor(null, "anything")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

describe("MODEL_ID_PATTERN", () => {
  it("accepts provider ids and gateway-style paths, rejects control chars", () => {
    for (const id of ["gemini-4-hydrogen", "muse-spark-1.3-contributor", "openai/gpt-6-luna-fast"]) {
      expect(MODEL_ID_PATTERN.test(id)).toBe(true);
    }
    for (const id of ["ge\u0000mini", "gemini 4", "id\nnew", ""]) {
      expect(MODEL_ID_PATTERN.test(id)).toBe(false);
    }
  });
});
