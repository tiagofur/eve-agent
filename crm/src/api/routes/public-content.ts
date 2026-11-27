import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { contentPacks, socialPosts } from "../../db/schema";
import { getPackSlidePath } from "../../domain/content-packs";
import { socialVideosDir } from "../../domain/marketing";

/**
 * Public (unauthenticated) asset URLs for the social pipeline: content-pack
 * slides (Meta downloads each when the owner publishes a pack) and social
 * video clips (IG Reels/Stories + FB video fetch the mp4 from here). Meta
 * cannot send our API key, so the gate is the unguessable 32-hex publicId
 * and the assets are non-sensitive marketing media.
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

/**
 * Social video clip by publicId. Supports single HTTP Range requests so
 * Meta's video fetcher (and Telegram previews) can stream partial bytes.
 */
publicContentRouter.get("/social/:publicId/video.mp4", async (c) => {
  const publicId = c.req.param("publicId") ?? "";
  if (!/^[0-9a-f]{32}$/i.test(publicId)) return c.json({ error: "Not found" }, 404);

  const [post] = await db
    .select({ videoPath: socialPosts.videoPath })
    .from(socialPosts)
    .where(eq(socialPosts.publicId, publicId))
    .limit(1);
  if (!post?.videoPath) return c.json({ error: "Not found" }, 404);

  try {
    const info = await stat(post.videoPath);
    const size = info.size;
    const baseHeaders: Record<string, string> = {
      "Content-Type": "video/mp4",
      // Same contract as slides: the clip never changes once written.
      "Cache-Control": "public, max-age=86400, immutable",
      "Accept-Ranges": "bytes",
    };

    const range = c.req.header("Range");
    const rangeMatch = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (rangeMatch) {
      const start = rangeMatch[1] ? Number(rangeMatch[1]) : 0;
      // "" suffix means "last N bytes"; cap end at size-1 either way.
      const end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), size - 1) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      const stream = Readable.toWeb(createReadStream(post.videoPath, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }

    const stream = Readable.toWeb(createReadStream(post.videoPath)) as ReadableStream;
    return new Response(stream, {
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});
