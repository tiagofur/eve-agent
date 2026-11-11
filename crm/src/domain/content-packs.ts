import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  contentPacks,
  type ContentPackBrand,
  type ContentPackKind,
  type ContentPackStatus,
} from "../db/schema";
import { logEvent } from "./events";
import { publishInstagramMedia, type PublishBrand } from "../services/meta-graph";
import { notifyContentPackCreated } from "../services/telegram";

/**
 * Content packs live on disk under CONTENT_DIR (one folder per pack id) and
 * their metadata/copy lives in Postgres. Paths stored here are relative to
 * CONTENT_DIR so the volume can move without a migration.
 */
export const contentDirAbsolute = () => path.resolve(process.env.CONTENT_DIR || "data/content-packs");

/** Public origin Meta fetches slide PNGs from (the CRM's public HTTPS URL). */
export const publicContentBaseUrl = () =>
  (process.env.PUBLIC_CONTENT_BASE_URL || "https://crm.creapolis.dev").replace(/\/+$/, "");

const KIND_LABEL: Record<ContentPackKind, string> = {
  video: "VIDEO",
  carousel: "CARRUSEL",
  image: "IMAGEN",
};

export interface CreateContentPackInput {
  kind: ContentPackKind;
  brand?: ContentPackBrand;
  topic: string;
  hook?: string;
  caption: string;
  captionsByPlatform?: Record<string, string>;
  hashtags?: string[];
  platforms?: string[];
  notes?: string;
  scheduledFor?: string;
  zip: { data: Buffer };
  cover?: { data: Buffer; ext: string };
  actor: string;
}

export interface ContentPackSummary {
  id: string;
  kind: ContentPackKind;
  brand: ContentPackBrand;
  /** Unguessable public id — the slide URLs hang off it. */
  publicId: string;
  topic: string;
  hook: string | null;
  caption: string;
  captionsByPlatform: Record<string, string> | null;
  hashtags: string[];
  platforms: string[];
  notes: string | null;
  scheduledFor: string | null;
  status: ContentPackStatus;
  rejectedReason: string | null;
  hasCover: boolean;
  approvedAt: string | null;
  downloadedAt: string | null;
  publishedAt: string | null;
  externalPostUrl: string | null;
  createdBy: string;
  createdAt: string;
}

type ContentPackRow = typeof contentPacks.$inferSelect;

const toSummary = (row: ContentPackRow): ContentPackSummary => ({
  id: row.id,
  kind: row.kind,
  brand: row.brand,
  publicId: row.publicId,
  topic: row.topic,
  hook: row.hook,
  caption: row.caption,
  captionsByPlatform: row.captionsByPlatform ?? null,
  hashtags: row.hashtags,
  platforms: row.platforms,
  notes: row.notes,
  scheduledFor: row.scheduledFor,
  status: row.status,
  rejectedReason: row.rejectedReason,
  hasCover: Boolean(row.coverPath),
  approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
  downloadedAt: row.downloadedAt ? row.downloadedAt.toISOString() : null,
  publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  externalPostUrl: row.externalPostUrl ?? null,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "pack";

export async function createContentPack(input: CreateContentPackInput) {
  const id = randomUUID();
  const packDir = path.join(contentDirAbsolute(), id);
  await mkdir(packDir, { recursive: true });

  const zipPath = path.join(id, "pack.zip");
  await writeFile(path.join(packDir, "pack.zip"), input.zip.data);

  // Extract the slide PNGs from the ZIP: publishing serves them individually
  // from the public slide URLs (Instagram fetches each image by URL), and the
  // desktop cover preview stays independent of the ZIP.
  const extractedSlides = await extractSlides(packDir, input.zip.data);

  let coverPath: string | null = null;
  if (input.cover) {
    coverPath = path.join(id, `cover.${input.cover.ext}`);
    await writeFile(path.join(packDir, `cover.${input.cover.ext}`), input.cover.data);
  }

  const [pack] = await db
    .insert(contentPacks)
    .values({
      id,
      kind: input.kind,
      brand: input.brand ?? "creapolis",
      topic: input.topic,
      hook: input.hook,
      caption: input.caption,
      captionsByPlatform: input.captionsByPlatform,
      hashtags: input.hashtags ?? [],
      platforms: input.platforms ?? [],
      notes: input.notes,
      zipPath,
      coverPath,
      scheduledFor: input.scheduledFor,
      status: "pending_approval",
      createdBy: input.actor,
    })
    .returning();

  if (!pack) {
    throw new Error("Failed to insert content pack");
  }

  await logEvent({
    entity: "content_pack",
    entityId: pack.id,
    action: "pack_created",
    actor: input.actor,
    after: { status: "pending_approval", kind: pack.kind, brand: pack.brand, topic: pack.topic },
    reason: `Content pack ${KIND_LABEL[pack.kind]} created: ${pack.topic}`,
  });

  // Nightly signal for the owner: a pack is waiting for 1-click
  // approve(+publish) on Telegram (cover preview + buttons).
  notifyContentPackCreated(pack.id, pack.kind, pack.brand, pack.topic).catch((err) =>
    console.error("Failed to notify content pack on Telegram:", err)
  );

  return { success: true, pack: toSummary(pack), slides: extractedSlides };
}

/** Unzips slides/*.png next to the pack ZIP; returns the written file names. */
async function extractSlides(packDir: string, zip: Buffer): Promise<string[]> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(zip));
  } catch (err) {
    // Not every stored pack is a parseable ZIP (legacy/video QA uploads);
    // without extracted slides the pack just isn't 1-click publishable.
    console.warn("[ContentPacks] slide extraction skipped (unparseable zip):", (err as Error).message);
    return [];
  }
  const written: string[] = [];
  for (const [name, data] of Object.entries(unzipped)) {
    // Only flat slides/<file>.png entries; the basename check blocks traversal.
    const base = path.basename(name);
    if (!/^slides\/[^/]+\.png$/i.test(name.replace(/\\/g, "/")) || base.includes("..")) continue;
    const target = path.join(packDir, "slides", base);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(data));
    written.push(base);
  }
  return written;
}

/** Sorted slide files of a pack on disk (empty when none were extracted). */
export async function listPackSlideFiles(packId: string): Promise<string[]> {
  const dir = path.join(contentDirAbsolute(), packId, "slides");
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.toLowerCase().endsWith(".png")).sort();
  } catch {
    return [];
  }
}

/** Absolute path of one slide (already sorted) by index, or null. */
export async function getPackSlidePath(packId: string, index: number): Promise<string | null> {
  const files = await listPackSlideFiles(packId);
  const name = files[index];
  return name ? path.join(contentDirAbsolute(), packId, "slides", name) : null;
}

export async function listContentPacks(status?: ContentPackStatus) {
  const rows = status
    ? await db.select().from(contentPacks).where(eq(contentPacks.status, status)).orderBy(desc(contentPacks.createdAt)).limit(100)
    : await db.select().from(contentPacks).orderBy(desc(contentPacks.createdAt)).limit(100);
  return rows.map(toSummary);
}

async function getPackOrThrow(packId: string) {
  const [pack] = await db.select().from(contentPacks).where(eq(contentPacks.id, packId)).limit(1);
  if (!pack) {
    throw new Error(`Content pack ${packId} not found`);
  }
  return pack;
}

export interface ReviewContentPackInput {
  packId: string;
  decision: "approved" | "rejected";
  rejectedReason?: string;
  actor: string;
}

export async function reviewContentPack(input: ReviewContentPackInput) {
  const pack = await getPackOrThrow(input.packId);

  if (pack.status !== "pending_approval") {
    throw new Error(`Content pack ${input.packId} already reviewed (status: ${pack.status})`);
  }
  if (input.decision === "rejected" && !input.rejectedReason?.trim()) {
    throw new Error("Rejecting a content pack requires a rejectedReason");
  }

  const [updated] = await db
    .update(contentPacks)
    .set({
      status: input.decision,
      approvedAt: input.decision === "approved" ? new Date() : null,
      rejectedReason: input.decision === "rejected" ? input.rejectedReason : null,
    })
    .where(eq(contentPacks.id, input.packId))
    .returning();

  await logEvent({
    entity: "content_pack",
    entityId: input.packId,
    action: `pack_${input.decision}`,
    actor: input.actor,
    before: { status: pack.status },
    after: { status: input.decision },
    reason: input.decision === "rejected" ? input.rejectedReason : `Approved ${pack.kind}: ${pack.topic}`,
  });

  return { success: true, pack: toSummary(updated!) };
}

export async function getPackZip(packId: string) {
  const pack = await getPackOrThrow(packId);
  return {
    absolutePath: path.join(contentDirAbsolute(), pack.zipPath),
    filename: `${slugify(pack.topic)}-${packId.slice(0, 8)}.zip`,
  };
}

export async function getPackCover(packId: string) {
  const pack = await getPackOrThrow(packId);
  if (!pack.coverPath) {
    return null;
  }
  const ext = path.extname(pack.coverPath).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return {
    absolutePath: path.join(contentDirAbsolute(), pack.coverPath),
    mime,
  };
}

/** Marks the pack as downloaded (first download only) for the nightly flow. */
export async function markPackDownloaded(packId: string, actor: string) {
  const pack = await getPackOrThrow(packId);
  if (pack.downloadedAt) return;

  await db.update(contentPacks).set({ downloadedAt: new Date() }).where(eq(contentPacks.id, packId));
  await logEvent({
    entity: "content_pack",
    entityId: packId,
    action: "pack_downloaded",
    actor,
    after: { downloaded: true },
    reason: `ZIP downloaded for manual upload: ${pack.topic}`,
  });
}

/* ------------------------------------------------------------------ */
/* 1-click publish (Telegram / endpoint)                               */
/* ------------------------------------------------------------------ */

/** Domain error carrying the HTTP status the route should answer with. */
export class PackPublishError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

/**
 * Publishes an APPROVED pack to its brand's Instagram account (single image
 * or carousel — the public slide URLs are what Meta downloads). The caption
 * uses the Instagram variant when the pack carries one. Idempotent guard:
 * an already-published pack fails loudly instead of double-posting.
 */
export async function publishContentPack(packId: string, actor = "owner:telegram") {
  const pack = await getPackOrThrow(packId);

  if (pack.status === "published") {
    throw new PackPublishError(`Pack ${packId} already published (${pack.externalPostUrl ?? "no URL"})`, 409);
  }
  if (pack.status !== "approved") {
    throw new PackPublishError(
      `Pack ${packId} is "${pack.status}" — approve it before publishing (Telegram "Aprobar y publicar" does both).`,
      400
    );
  }
  if (pack.kind === "video") {
    throw new PackPublishError("Video packs are not auto-publishable; download the ZIP and upload manually.", 400);
  }

  const slides = await listPackSlideFiles(packId);
  if (slides.length === 0) {
    throw new PackPublishError(`Pack ${packId} has no extracted slides on disk to publish.`, 500);
  }

  const imageUrls = slides.map(
    (_, i) => `${publicContentBaseUrl()}/api/public/content/${pack.publicId}/slides/${i}`
  );
  const caption = pack.captionsByPlatform?.instagram ?? pack.caption;

  const result = await publishInstagramMedia({
    brand: pack.brand as PublishBrand,
    imageUrls,
    caption,
    hashtags: pack.hashtags,
  });

  const [updated] = await db
    .update(contentPacks)
    .set({
      status: "published",
      publishedAt: new Date(),
      externalPostId: result.externalPostId,
      externalPostUrl: result.externalPostUrl ?? null,
    })
    .where(eq(contentPacks.id, packId))
    .returning();

  await logEvent({
    entity: "content_pack",
    entityId: packId,
    action: "pack_published",
    actor,
    before: { status: "approved" },
    after: { status: "published", brand: pack.brand, externalPostUrl: result.externalPostUrl ?? null },
    reason: `Published ${KIND_LABEL[pack.kind]} to Instagram (${pack.brand}): ${pack.topic}`,
  });

  return { success: true, pack: toSummary(updated!) };
}
