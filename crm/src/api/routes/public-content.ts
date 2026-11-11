import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { contentPacks } from "../../db/schema";
import { getPackSlidePath } from "../../domain/content-packs";

/**
 * Public (unauthenticated) slide URLs for content packs. Instagram's servers
 * download each slide from here when the owner publishes a pack — Meta cannot
 * send our API key, so the gate is the unguessable 32-hex publicId and slides
 * are non-sensitive marketing images.
 */
export const publicContentRouter = new Hono();

publicContentRouter.get("/:publicId/slides/:index", async (c) => {
  const publicId = c.req.param("publicId") ?? "";
  const indexParam = c.req.param("index") ?? "";
  // Strict shapes: no auth on this route, so nothing else may probe.
  if (!/^[0-9a-f]{32}$/i.test(publicId)) return c.json({ error: "Not found" }, 404);
  if (!/^\d+$/.test(indexParam)) return c.json({ error: "Not found" }, 404);

  const [pack] = await db
    .select({ id: contentPacks.id })
    .from(contentPacks)
    .where(eq(contentPacks.publicId, publicId))
    .limit(1);
  if (!pack) return c.json({ error: "Not found" }, 404);

  const absolutePath = await getPackSlidePath(pack.id, Number(indexParam));
  if (!absolutePath) return c.json({ error: "Not found" }, 404);

  try {
    const data = await readFile(absolutePath);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/png",
        // Slides never change once written; Meta re-fetches containers for a
        // short window after publish, and a long cache keeps that cheap.
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});
