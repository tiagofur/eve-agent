import { ZipArchive } from "archiver";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmUploadContentPack } from "../lib/crm";
import {
  MAX_SLIDES,
  countWords,
  renderPackPngs,
  type Brand,
  type PackRenderSpec,
  type SlideSpec,
} from "../lib/content-renderer";
import { requireStaff } from "../lib/guard";
import { generateCoverImage } from "../lib/cover-image";
import { fetchBrandVisualConfig } from "../lib/visual-config";

const slideSchema = z.object({
  variant: z.enum(["cover", "news", "problema_solucion", "lista", "cta"]),
  kicker: z.string().max(60).optional(),
  title: z.string().min(1).max(220),
  subtitle: z.string().max(300).optional(),
  bullets: z.array(z.string().max(180)).max(5).optional(),
  blocks: z
    .array(z.object({ heading: z.string().max(40), body: z.string().max(400) }))
    .max(2)
    .optional(),
  takeaway: z.string().max(220).optional(),
  cta: z.string().max(80).optional(),
});

/** In-memory ZIP builder (archiver v8 streams into a buffer). */
async function buildZip(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of entries) {
    archive.append(entry.data, { name: entry.name });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export default defineTool({
  description:
    "Render brand-themed slides (1080x1350 PNG) for a content pack, bundle them with per-platform captions into a ZIP and upload it to the CRM. The pack lands as pending_approval for the owner — this never publishes anything (the owner approves+publishes from Telegram). Use after writing the copy, grounded in search_product_docs and/or fetch_ai_news. Set `brand` so the visual identity matches the destination account.",
  inputSchema: z.object({
    kind: z.enum(["carousel", "image"]),
    brand: z
      .enum(["creapolis", "pepinillo", "solennix"])
      .default("creapolis")
      .describe("Visual identity + destination account of the pack"),
    topic: z.string().min(3).max(200),
    hook: z.string().max(300).optional().describe("The scroll-stopper line, shown in the desktop card"),
    caption: z.string().min(1).max(4000).describe("Main caption (Spanish, hook first, CTA at the end)"),
    captionsByPlatform: z.record(z.string(), z.string().max(2500)).optional(),
    hashtags: z.array(z.string().max(40)).max(8).optional().describe("Without the # prefix, e.g. 'IAparaEmpresas'"),
    platforms: z.array(z.string().max(30)).max(6).optional().describe("e.g. ['instagram','linkedin','tiktok','x']"),
    notes: z.string().max(1000).optional(),
    scheduledFor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    // Scene for the AI cover (brand profile hybrid/image_only). Describe the
    // IMAGE ONLY: composition, subject, mood — text is composited on top by
    // the renderer, and asking for text inside the image is forbidden.
    cover: z
      .object({
        visualPrompt: z
          .string()
          .min(10)
          .max(600)
          .describe("Scene for the cover art, in English, no text in image"),
      })
      .optional(),
    slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "render_content_pack");

    if (input.kind === "image" && input.slides.length !== 1) {
      return { status: "error", error: "kind=image requires exactly 1 slide" };
    }
    if (input.kind === "carousel" && input.slides.length < 2) {
      return { status: "error", error: "kind=carousel requires at least 2 slides" };
    }

    // The owner's per-brand visual profile decides whether the cover gets AI
    // art and how long the headline may be. Editorial = today's typography.
    const visual = await fetchBrandVisualConfig(input.brand);
    const coverSlide = input.slides[0];
    const titleWords = countWords(coverSlide.title);
    if (visual.mode !== "image_only" && titleWords > visual.coverTitleMaxWords) {
      return {
        status: "error",
        error: `Cover headline carries ${titleWords} words; the ${input.brand} visual profile caps it at ${visual.coverTitleMaxWords}. Shorten it to the hook alone and call again.`,
      };
    }

    let coverImage: Buffer | undefined;
    let coverFallback: string | undefined;
    let coverVia: "batch" | "standard" | undefined;
    if (visual.mode !== "editorial" && coverSlide.variant === "cover" && input.cover?.visualPrompt) {
      try {
        const generated = await generateCoverImage(visual, input.cover.visualPrompt);
        coverImage = generated.image;
        coverVia = generated.via;
      } catch (err) {
        // A failed generation must never block the pack: typography cover.
        coverFallback = err instanceof Error ? err.message : "cover generation failed";
      }
    } else if (visual.mode !== "editorial" && !input.cover?.visualPrompt) {
      coverFallback = `brand profile is ${visual.mode} but no cover.visualPrompt was provided`;
    }

    try {
      const spec: PackRenderSpec = {
        topic: input.topic,
        brand: input.brand as Brand,
        slides: input.slides as SlideSpec[],
      };
      const pngs = await renderPackPngs(spec, {
        coverImage,
        showLogo: visual.showLogo,
        textOnCover: visual.mode !== "image_only",
      });

      const entries: Array<{ name: string; data: Buffer }> = pngs.map((png, i) => ({
        name: `slides/slide-${String(i + 1).padStart(2, "0")}.png`,
        data: png,
      }));
      entries.push({ name: "caption.txt", data: Buffer.from(input.caption, "utf8") });
      if (input.hashtags?.length) {
        entries.push({
          name: "hashtags.txt",
          data: Buffer.from(input.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" "), "utf8"),
        });
      }
      for (const [platform, caption] of Object.entries(input.captionsByPlatform ?? {})) {
        entries.push({ name: `captions/${platform}.txt`, data: Buffer.from(caption, "utf8") });
      }
      entries.push({
        name: "LICENSES.txt",
        data: Buffer.from(
          coverImage
            ? "Portada generada con IA (Gemini image) compuesta con tipografía Inter (SIL OFL) por Creapolis.Dev.\nSin material de terceros: seguro para uso comercial.\n"
            : "Imágenes generadas programáticamente (tipografía Inter, SIL OFL) por Creapolis.Dev.\nSin material de terceros: seguro para uso comercial.\n",
          "utf8"
        ),
      });

      const zip = await buildZip(entries);

      const result = await crmUploadContentPack({
        meta: {
          kind: input.kind,
          brand: input.brand,
          topic: input.topic,
          hook: input.hook,
          caption: input.caption,
          captionsByPlatform: input.captionsByPlatform,
          hashtags: input.hashtags,
          platforms: input.platforms,
          notes: input.notes,
          scheduledFor: input.scheduledFor,
        },
        zip,
        cover: pngs[0],
      });

      return {
        status: "pack_uploaded",
        packId: result.pack.id,
        packStatus: result.pack.status,
        slides: pngs.length,
        coverMode: coverImage ? visual.mode : "editorial",
        ...(coverVia ? { coverVia } : {}),
        ...(coverVia === "batch" ? { coverCost: "batch (half price)" } : {}),
        ...(coverFallback ? { coverFallback } : {}),
        message: "Pack pending owner approval in Desktop → Contenido.",
      };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : "Render/upload failed" };
    }
  },
});

/**
 * One AI image for the cover (1:1.25 → 4:5 portrait). The heavy lifting
 * (standard synchronous vs half-price Batch with standard fallback) lives in
 * lib/cover-image; this tool only wires the brand profile in.
 */
