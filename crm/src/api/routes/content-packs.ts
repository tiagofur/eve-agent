import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  createContentPack,
  getPackCover,
  getPackZip,
  listContentPacks,
  markPackDownloaded,
  reviewContentPack,
} from "../../domain/content-packs";

export const contentPacksRouter = new Hono<{ Variables: AuthContextVariables }>();

const metaSchema = z.object({
  kind: z.enum(["video", "carousel", "image"]),
  topic: z.string().min(3).max(200),
  hook: z.string().max(300).optional(),
  caption: z.string().min(1).max(8000),
  captionsByPlatform: z.record(z.string(), z.string()).optional(),
  hashtags: z.array(z.string().max(60)).max(30).optional(),
  platforms: z.array(z.string().max(30)).max(10).optional(),
  notes: z.string().max(2000).optional(),
  scheduledFor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "scheduledFor must be YYYY-MM-DD")
    .optional(),
});

const COVER_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// 1. List packs (optional ?status=pending_approval|approved|rejected)
contentPacksRouter.get("/", requireScope(["ops"]), async (c) => {
  const status = c.req.query("status");
  const packs = await listContentPacks(
    status === "pending_approval" || status === "approved" || status === "rejected" ? status : undefined
  );
  return c.json({ packs });
});

// 2. Upload a pack (multipart: file=<zip>, cover?<image>, meta=<JSON>)
contentPacksRouter.post("/upload", requireScope(["ops"]), async (c) => {
  const actor = c.get("actor");

  let body: Record<string, unknown>;
  try {
    body = (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid multipart body" }, 400);
  }

  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "Missing 'file' field (ZIP)" }, 400);
  }

  let meta: unknown;
  try {
    meta = JSON.parse(String(body["meta"] ?? "{}"));
  } catch {
    return c.json({ error: "'meta' field must be valid JSON" }, 400);
  }

  const parsed = metaSchema.safeParse(meta);
  if (!parsed.success) {
    return c.json({ error: "Invalid meta", issues: parsed.error.issues }, 400);
  }

  const cover = body["cover"];
  let coverInput: { data: Buffer; ext: string } | undefined;
  if (cover instanceof File && cover.size > 0) {
    const ext = COVER_MIME_EXT[cover.type];
    if (!ext) {
      return c.json({ error: `Unsupported cover type ${cover.type} (jpeg/png/webp)` }, 400);
    }
    coverInput = { data: Buffer.from(await cover.arrayBuffer()), ext };
  }

  try {
    const result = await createContentPack({
      ...parsed.data,
      zip: { data: Buffer.from(await file.arrayBuffer()) },
      cover: coverInput,
      actor,
    });
    return c.json(result, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create content pack";
    return c.json({ error: message }, 500);
  }
});

// 3. Review (approve / reject) — owner only, rejects require a reason
contentPacksRouter.post(
  "/:id/review",
  requireScope(["owner"]),
  zValidator(
    "json",
    z.object({
      decision: z.enum(["approved", "rejected"]),
      rejectedReason: z.string().max(1000).optional(),
    })
  ),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { decision, rejectedReason } = c.req.valid("json");
    try {
      const result = await reviewContentPack({
        packId: id,
        decision,
        rejectedReason,
        actor: c.get("actor"),
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Review failed" }, 400);
    }
  }
);

// 4. Download the ZIP (marks first download)
contentPacksRouter.get("/:id/download", requireScope(["owner", "ops"]), async (c) => {
  const id = c.req.param("id") ?? "";
  try {
    const { absolutePath, filename } = await getPackZip(id);
    const data = await readFile(absolutePath);
    await markPackDownloaded(id, c.get("actor"));
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Download failed" }, 404);
  }
});

// 5. Cover image for previews
contentPacksRouter.get("/:id/cover", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id") ?? "";
  try {
    const cover = await getPackCover(id);
    if (!cover) {
      return c.json({ error: "Pack has no cover" }, 404);
    }
    const data = await readFile(cover.absolutePath);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": cover.mime,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return c.json({ error: "Cover not found" }, 404);
  }
});
