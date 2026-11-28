import { z } from "zod";
import {
  MODEL_ID_MAX_LENGTH,
  MODEL_ID_PATTERN,
  MODEL_MODALITIES,
  MODEL_PROVIDERS,
} from "../../../agent/lib/model-config";

const GOOGLE_MODELS_API = "https://generativelanguage.googleapis.com/v1beta";

export const modelTestRequestSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  modelId: z
    .string()
    .trim()
    .min(1)
    .max(MODEL_ID_MAX_LENGTH)
    .regex(MODEL_ID_PATTERN, "Model id contains whitespace or characters that are not allowed"),
  modality: z.enum(MODEL_MODALITIES),
});
export type ModelTestRequest = z.infer<typeof modelTestRequestSchema>;

export type ModelTestResult =
  /** The model answered. */
  | { ok: true; latencyMs: number; sample?: string }
  /** The model cannot be used; `reason` tells the owner why. */
  | { ok: false; reason: string }
  /** There is no probe for that provider. */
  | { ok: null; reason: string };

interface GoogleResponse {
  error?: { message?: string };
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

async function readJson(res: Response): Promise<GoogleResponse | null> {
  try {
    return (await res.json()) as GoogleResponse;
  } catch {
    return null;
  }
}

function describe(status: number, body: GoogleResponse | null): string {
  const detail = body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : "";
  if (status === 401 || status === 403) return "La clave del servidor no tiene acceso a ese modelo";
  if (status === 429) return "Google limitó la solicitud por cuota; inténtalo en un momento";
  if (status === 400) return `Google rechazó el modelo o los parámetros${detail}`;
  return `Google respondió ${status}${detail}`;
}

/**
 * Checks that a model id really answers before the owner routes work to it
 * (eve fails the turn on an invalid model). Text models get a few real
 * tokens; image and video models are only looked up — never generated.
 */
export async function testModel(
  request: ModelTestRequest,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<ModelTestResult> {
  if (request.provider !== "google") {
    return { ok: null, reason: "Este proveedor no tiene prueba automática" };
  }
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "El servidor no tiene clave de Google (GEMINI_API_KEY)" };
  }

  const headers = { "x-goog-api-key": apiKey };
  const modelUrl = `${GOOGLE_MODELS_API}/models/${encodeURIComponent(request.modelId)}`;
  const started = Date.now();
  try {
    if (request.modality === "text") {
      const res = await fetchImpl(`${modelUrl}:generateContent`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Responde únicamente: OK" }] }],
          generationConfig: { maxOutputTokens: 16, temperature: 0 },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, reason: describe(res.status, body) };
      // A 200 with a candidate means the model exists and answers; a thinking
      // model may spend the whole budget before writing any visible text.
      const candidate = body?.candidates?.[0];
      if (!candidate) return { ok: false, reason: "Google respondió sin ningún candidato" };
      const sample = candidate.content?.parts?.map((part) => part.text ?? "").join("").trim();
      return {
        ok: true,
        latencyMs: Date.now() - started,
        ...(sample ? { sample: sample.slice(0, 80) } : {}),
      };
    }

    const res = await fetchImpl(modelUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { ok: false, reason: "Google no reconoce ese id de modelo" };
    if (!res.ok) return { ok: false, reason: describe(res.status, await readJson(res)) };
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: `No se pudo consultar a Google: ${err instanceof Error ? err.message : err}` };
  }
}
