import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { contentPacks, type ContentPackKind, type ContentPackStatus } from "../db/schema";
import { logEvent } from "./events";
import { notifyContentPackCreated } from "../services/telegram";

/**
 * Content packs live on disk under CONTENT_DIR (one folder per pack id) and
 * their metadata/copy lives in Postgres. Paths stored here are relative to
 * CONTENT_DIR so the volume can move without a migration.
 */
export const contentDirAbsolute = () => path.resolve(process.env.CONTENT_DIR || "data/content-packs");

const KIND_LABEL: Record<ContentPackKind, string> = {
  video: "VIDEO",
  carousel: "CARRUSEL",
  image: "IMAGEN",
};

export interface CreateContentPackInput {
  kind: ContentPackKind;
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
  createdBy: string;
  createdAt: string;
}

type ContentPackRow = typeof contentPacks.$inferSelect;

const toSummary = (row: ContentPackRow): ContentPackSummary => ({
  id: row.id,
  kind: row.kind,
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
    after: { status: "pending_approval", kind: pack.kind, topic: pack.topic },
    reason: `Content pack ${KIND_LABEL[pack.kind]} created: ${pack.topic}`,
  });

  // Nightly signal for the owner: a pack is waiting for review in the desktop.
  notifyContentPackCreated(pack.id, pack.kind, pack.topic).catch((err) =>
    console.error("Failed to notify content pack on Telegram:", err)
  );

  return { success: true, pack: toSummary(pack) };
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
