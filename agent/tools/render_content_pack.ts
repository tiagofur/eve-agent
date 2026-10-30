import { ZipArchive } from "archiver";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmUploadContentPack } from "../lib/crm";
import {
  MAX_SLIDES,
  renderPackPngs,
  type PackRenderSpec,
  type SlideSpec,
} from "../lib/content-renderer";
import { requireStaff } from "../lib/guard";

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
    "Render branded slides (1080x1350 PNG) for a content pack, bundle them with per-platform captions into a ZIP and upload it to the CRM. The pack lands as pending_approval for the owner — this never publishes anything. Use after writing the copy, grounded in search_product_docs and/or fetch_ai_news.",
  inputSchema: z.object({
    kind: z.enum(["carousel", "image"]),
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

    try {
      const spec: PackRenderSpec = { topic: input.topic, slides: input.slides as SlideSpec[] };
      const pngs = await renderPackPngs(spec);

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
          "Imágenes generadas programáticamente (tipografía Inter, SIL OFL) por Creapolis.Dev.\nSin material de terceros: seguro para uso comercial.\n",
          "utf8"
        ),
      });

      const zip = await buildZip(entries);

      const result = await crmUploadContentPack({
        meta: {
          kind: input.kind,
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
        message: "Pack pending owner approval in Desktop → Contenido.",
      };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : "Render/upload failed" };
    }
  },
});
