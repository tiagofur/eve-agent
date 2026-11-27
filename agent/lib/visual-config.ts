/**
 * The owner's per-brand visual profile (crm `brand_visual_configs`, edited
 * from Mission Control → Contenido → Configuración Visual). The render tool
 * consults it on every run, so a mode flip or a new image model applies on
 * the next pack without touching code. Failures fall back to editorial:
 * a broken CRM read must never block content production.
 */
import { getCrmUrl, getOpsKey } from "./crm";

export type VisualMode = "editorial" | "hybrid" | "image_only";
export type GenerationMode = "standard" | "batch";

export interface BrandVisualConfig {
  brand: string;
  mode: VisualMode;
  artDirection: string;
  coverTitleMaxWords: number;
  showLogo: boolean;
  imageModel: string;
  /** batch = Gemini Batch API (half price, minutes of latency). */
  generationMode: GenerationMode;
}

const EDITORIAL_DEFAULT: Omit<BrandVisualConfig, "brand"> = {
  mode: "editorial",
  artDirection: "",
  coverTitleMaxWords: 8,
  showLogo: true,
  imageModel: "gemini-nano-banana-2.1",
  generationMode: "standard",
};

export const EDITORIAL_FALLBACK = EDITORIAL_DEFAULT;

export async function fetchBrandVisualConfig(brand: string): Promise<BrandVisualConfig> {
  try {
    const res = await fetch(`${getCrmUrl()}/api/visual-configs`, {
      headers: { Authorization: `Bearer ${getOpsKey()}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { configs: BrandVisualConfig[] };
    const config = data.configs.find((cfg) => cfg.brand === brand);
    if (!config) throw new Error(`no profile for ${brand}`);
    return config;
  } catch (err) {
    console.warn(
      `[visual-config] falling back to editorial for ${brand}:`,
      err instanceof Error ? err.message : err
    );
    return { brand, ...EDITORIAL_DEFAULT };
  }
}
