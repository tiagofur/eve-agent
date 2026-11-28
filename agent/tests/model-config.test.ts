import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CATALOG,
  activeModelRoute,
  modelCatalogSchema,
  modelRoutingSchema,
  resolveModelId,
  type ModelSettings,
} from "../lib/model-config";

const catalog = modelCatalogSchema.parse({ models: DEFAULT_MODEL_CATALOG }).models;

const GEMINI = { GEMINI_API_KEY: "gemini-key" };
const META = { META_API_KEY: "meta-key" };

const withRouting = (routing: Record<string, unknown>): ModelSettings => ({
  catalog,
  routing: modelRoutingSchema.parse(routing),
});

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

  it("a saved routing wins over the env override and fills the rest with defaults", () => {
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

describe("model catalog schema", () => {
  const model = (id: string) => ({
    id,
    modality: "text",
    provider: "google",
    label: id,
  });

  it("rejects duplicate ids", () => {
    const parsed = modelCatalogSchema.safeParse({ models: [model("gemini-a"), model("gemini-a")] });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty or spaced ids", () => {
    expect(modelCatalogSchema.safeParse({ models: [model("")] }).success).toBe(false);
    expect(modelCatalogSchema.safeParse({ models: [model("gemini 4")] }).success).toBe(false);
  });

  it("rejects an unknown reasoning level", () => {
    expect(modelRoutingSchema.safeParse({ text: { reasoning: "ultra" } }).success).toBe(false);
  });
});
