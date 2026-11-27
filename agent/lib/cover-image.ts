/**
 * Cover image generation for the content pipeline: standard synchronous
 * calls (seconds) or the Gemini Batch API (half the price, minutes) per the
 * brand's visual profile. Batch submits an inline one-request job and polls;
 * any failure or the timeout ceiling falls back to standard — the pack must
 * never block on the cheaper path. Verified against the live API: REST uses
 * BATCH_STATE_* states and returns `response.inlinedResponses`.
 */
import type { BrandVisualConfig } from "./visual-config";

const POLL_INTERVAL_MS = 10_000;
const BATCH_TIMEOUT_MS = 12 * 60_000;

function imagePrompt(config: BrandVisualConfig, scene: string): string {
  return [
    "Editorial cover art for a social media post, portrait 4:5.",
    config.artDirection ? `Brand art direction: ${config.artDirection}.` : "",
    `Scene: ${scene}`,
    "Absolutely no text, letters, numbers, watermarks or logos inside the image.",
    "Leave the lower third visually calm (soft focus or simple surfaces) so a headline can sit on top.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function generateStandard(config: BrandVisualConfig, scene: string): Promise<Buffer> {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const { generateImage } = await import("ai");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured — cannot generate cover art");
  }
  const google = createGoogleGenerativeAI({ apiKey });
  const result = await generateImage({
    model: google.image(config.imageModel),
    prompt: imagePrompt(config, scene),
    n: 1,
    aspectRatio: "4:5",
    providerOptions: { google: { imageSize: "1K" } },
  });
  const image = result.images[0];
  if (!image) throw new Error("image model returned no image");
  return Buffer.from(image.uint8Array);
}

/** Submits a one-request inline batch job and returns its API name. */
async function submitBatch(
  config: BrandVisualConfig,
  scene: string,
  apiKey: string
): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.imageModel}:batchGenerateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        batch: {
          display_name: `cover-${config.brand}-${Date.now().toString(36)}`,
          input_config: {
            requests: {
              requests: [
                {
                  request: {
                    contents: [{ parts: [{ text: imagePrompt(config, scene) }] }],
                    generation_config: { responseModalities: ["IMAGE"] },
                  },
                  metadata: { key: "cover" },
                },
              ],
            },
          },
        },
      }),
    }
  );
  const data = (await res.json()) as { name?: string; error?: { message?: string } };
  if (!res.ok || !data.name) {
    throw new Error(`batch submit failed: ${data.error?.message ?? `HTTP ${res.status}`}`);
  }
  return data.name;
}

/** Extracts the first inline image from a succeeded batch's response. */
function imageFromInlined(data: unknown): Buffer | undefined {
  interface InlinePart {
    inlineData?: { data?: string; mimeType?: string };
  }
  interface InlineResponse {
    response?: { candidates?: Array<{ content?: { parts?: InlinePart[] } }> };
  }
  const responses = (data as { response?: { inlinedResponses?: { inlinedResponses?: InlineResponse[] } } })
    ?.response?.inlinedResponses?.inlinedResponses;
  for (const inline of responses ?? []) {
    for (const part of inline?.response?.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, "base64");
      }
    }
  }
  return undefined;
}

async function generateBatch(config: BrandVisualConfig, scene: string): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured — cannot generate cover art");
  }
  const name = await submitBatch(config, scene, apiKey);
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      headers: { "x-goog-api-key": apiKey },
    });
    const data = (await res.json()) as {
      done?: boolean;
      metadata?: { state?: string };
      error?: { message?: string };
    };
    if (data.error) throw new Error(`batch poll failed: ${data.error.message}`);
    const state = data.metadata?.state ?? "";
    if (state.includes("FAILED") || state.includes("CANCELLED") || state.includes("EXPIRED")) {
      throw new Error(`batch job ${state}`);
    }
    if (data.done) {
      const image = imageFromInlined(data);
      if (!image) throw new Error("batch job succeeded without an image");
      return image;
    }
    if (Date.now() > deadline) throw new Error(`batch job still ${state || "running"} after ${BATCH_TIMEOUT_MS / 60000} min`);
  }
}

/**
 * The cover art. `generationMode: batch` tries the half-price path first and
 * falls back to the standard call on any failure — the tool result reports
 * which path actually ran so a silently degraded pipeline stays visible.
 */
export async function generateCoverImage(
  config: BrandVisualConfig,
  scene: string
): Promise<{ image: Buffer; via: "batch" | "standard"; batchFallback?: string }> {
  if (config.generationMode === "batch") {
    try {
      return { image: await generateBatch(config, scene), via: "batch" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "batch failed";
      return {
        image: await generateStandard(config, scene),
        via: "standard",
        batchFallback: reason,
      };
    }
  }
  return { image: await generateStandard(config, scene), via: "standard" };
}
