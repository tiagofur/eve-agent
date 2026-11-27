import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { brandVisualConfigs } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { logEvent } from "../../domain/events";

/**
 * Per-brand visual profile for the content pipeline (owner-editable from
 * Mission Control; the agent's render tool reads it on every run). One row
 * per brand, seeded by migration 0030; unknown brand → 404.
 */

export const VISUAL_MODES = ["editorial", "hybrid", "image_only"] as const;
export const GENERATION_MODES = ["standard", "batch"] as const;

const BRANDS = ["creapolis", "pepinillo", "solennix"] as const;

export const visualConfigsRouter = new Hono<{ Variables: AuthContextVariables }>();

const modeSchema = z.enum(VISUAL_MODES);

// List the three brands (missing rows render as editorial defaults).
visualConfigsRouter.get("/", requireScope(["ops"]), async (c) => {
  const rows = await db.select().from(brandVisualConfigs).orderBy(asc(brandVisualConfigs.brand));
  const byBrand = new Map(rows.map((row) => [row.brand, row]));
  const configs = BRANDS.map((brand) => {
    const row = byBrand.get(brand);
    return {
      brand,
      mode: row?.mode ?? "editorial",
      artDirection: row?.artDirection ?? "",
      coverTitleMaxWords: row?.coverTitleMaxWords ?? 8,
      showLogo: row?.showLogo ?? true,
      imageModel: row?.imageModel ?? "gemini-nano-banana-2.1",
      generationMode: row?.generationMode ?? "standard",
      configured: row !== undefined,
    };
  });
  return c.json({ configs });
});

const putSchema = z.object({
  mode: modeSchema,
  artDirection: z.string().max(2000).default(""),
  coverTitleMaxWords: z.number().int().min(2).max(15).default(8),
  showLogo: z.boolean().default(true),
  imageModel: z.string().max(80).default("gemini-nano-banana-2.1"),
  // batch = Gemini Batch API at half price (~2-5 min per cover instead of ~15s).
  generationMode: z.enum(GENERATION_MODES).default("standard"),
});

// Upsert one brand's profile; every change leaves an audit event.
visualConfigsRouter.put(
  "/:brand",
  requireScope(["ops"]),
  zValidator("json", putSchema),
  async (c) => {
    const brand = c.req.param("brand") ?? "";
    if (!BRANDS.includes(brand as (typeof BRANDS)[number])) {
      return c.json({ error: `Unknown brand: ${brand}` }, 404);
    }
    const patch = c.req.valid("json");
    const actor = c.get("actor");

    const [before] = await db
      .select()
      .from(brandVisualConfigs)
      .where(eq(brandVisualConfigs.brand, brand))
      .limit(1);

    const [config] = await db
      .insert(brandVisualConfigs)
      .values({ brand, ...patch })
      .onConflictDoUpdate({ target: brandVisualConfigs.brand, set: { ...patch, updatedAt: new Date() } })
      .returning();

    await logEvent({
      entity: "brand_visual_config",
      entityId: config!.id,
      action: "updated",
      actor,
      before: before
        ? {
            mode: before.mode,
            artDirection: before.artDirection,
            coverTitleMaxWords: before.coverTitleMaxWords,
            showLogo: before.showLogo,
            imageModel: before.imageModel,
          }
        : null,
      after: patch,
      reason: "Configuración visual de marca actualizada desde Mission Control",
    });

    return c.json({ success: true, config });
  }
);
