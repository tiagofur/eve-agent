import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/client";
import {
  socialPosts,
  type SocialPlatform,
  type SocialPostStatus,
} from "../db/schema";
import { logEvent } from "./events";
import { publicContentBaseUrl } from "./content-packs";
import { notifySocialPostCreated } from "../services/telegram";

/** Video clips live under CONTENT_DIR/social-videos (one mp4 per post id). */
export const socialVideosDir = () => path.join(
  path.resolve(process.env.CONTENT_DIR || "data/content-packs"),
  "social-videos"
);

const isVideoDataUri = (imageUrl?: string | null) => Boolean(imageUrl?.startsWith("data:video/"));

const socialVideoPublicUrl = (publicId: string) =>
  `${publicContentBaseUrl()}/api/public/content/social/${publicId}/video.mp4`;

/**
 * Persists a video data URI as a file asset + public id. New generations
 * call this inline; legacy posts (stored as raw base64 before Reels existed)
 * are converted lazily on first publish, so every video post becomes
 * publishable without a migration.
 */
async function ensureSocialVideoAsset(post: {
  id: string;
  imageUrl: string | null;
  publicId: string | null;
  videoPath: string | null;
}): Promise<{ publicId: string; videoPath: string; videoUrl: string }> {
  let publicId = post.publicId;
  let videoPath = post.videoPath;
  const dataUri = post.imageUrl ?? "";
  if ((!videoPath || !publicId) && isVideoDataUri(dataUri)) {
    const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
    publicId = publicId ?? randomBytes(16).toString("hex");
    videoPath = path.join(socialVideosDir(), `${publicId}.mp4`);
    await mkdir(socialVideosDir(), { recursive: true });
    await writeFile(videoPath, Buffer.from(base64, "base64"));
    await db
      .update(socialPosts)
      .set({ publicId, videoPath, updatedAt: new Date() })
      .where(eq(socialPosts.id, post.id));
  }
  if (!videoPath || !publicId) {
    throw new Error(`Social post ${post.id} has no video asset to publish`);
  }
  return { publicId, videoPath, videoUrl: socialVideoPublicUrl(publicId) };
}

export interface CreateSocialPostInput {
  platform: SocialPlatform;
  topic: string;
  caption: string;
  hashtags?: string[];
  imagePrompt?: string;
  imageUrl?: string;
  /** Content-pipeline brand — resolves per-brand Meta credentials on publish. */
  brand?: string;
  actor: string;
}

export async function createSocialPost(input: CreateSocialPostInput) {
  // Video posts get their on-disk asset + public id right away (the same
  // data URI still feeds the Telegram preview).
  let publicId: string | undefined;
  let videoPath: string | undefined;
  if (isVideoDataUri(input.imageUrl)) {
    try {
      const id = randomBytes(16).toString("hex");
      videoPath = path.join(socialVideosDir(), `${id}.mp4`);
      await mkdir(socialVideosDir(), { recursive: true });
      await writeFile(
        videoPath,
        Buffer.from(input.imageUrl!.slice(input.imageUrl!.indexOf(",") + 1), "base64")
      );
      publicId = id;
    } catch (err) {
      console.error("Failed to persist social video asset:", err);
    }
  }

  const [post] = await db
    .insert(socialPosts)
    .values({
      platform: input.platform,
      topic: input.topic,
      caption: input.caption,
      hashtags: input.hashtags || [],
      imagePrompt: input.imagePrompt,
      imageUrl: input.imageUrl,
      brand: input.brand,
      publicId,
      videoPath,
      status: "pending_approval",
      createdBy: input.actor,
    })
    .returning();

  if (!post) {
    throw new Error("Failed to insert social post");
  }

  await logEvent({
    entity: "social_post",
    entityId: post.id,
    action: "post_created",
    actor: input.actor,
    after: {
      status: "pending_approval",
      platform: input.platform,
      topic: input.topic,
    },
    reason: `Generated post for ${input.platform}: ${input.topic}`,
  });

  // Notify on Telegram for 1-click HITL approval
  notifySocialPostCreated(post.id).catch((err) =>
    console.error("Failed to notify social post on Telegram:", err)
  );

  return {
    success: true,
    post,
  };
}

export interface ReviewSocialPostInput {
  postId: string;
  decision: "approved" | "rejected";
  rejectedReason?: string;
  actor: string;
}

export async function reviewSocialPost(input: ReviewSocialPostInput) {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, input.postId))
    .limit(1);

  if (!post) {
    throw new Error(`Social post ${input.postId} not found`);
  }

  const newStatus: SocialPostStatus = input.decision === "approved" ? "approved" : "rejected";

  const [updated] = await db
    .update(socialPosts)
    .set({
      status: newStatus,
      rejectedReason: input.decision === "rejected" ? input.rejectedReason : null,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, input.postId))
    .returning();

  await logEvent({
    entity: "social_post",
    entityId: input.postId,
    action: `post_${input.decision}`,
    actor: input.actor,
    before: { status: post.status },
    after: { status: newStatus },
    reason: input.rejectedReason || "Owner review decision",
  });

  return {
    success: true,
    post: updated,
  };
}

export async function publishSocialPost(postId: string, actor: string) {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);

  if (!post) throw new Error(`Social post ${postId} not found`);
  if (post.status !== "approved") {
    throw new Error(`Cannot publish post in status '${post.status}'. Post must be approved first.`);
  }

  // Import Meta Graph service
  const { publishToFacebook, publishToInstagram, publishInstagramVideo, publishFacebookVideo } =
    await import("../services/meta-graph");

  let publishResult;
  let fbUrl: string | undefined;

  // Video posts publish as an IG Reel + best-effort FB page video (same
  // contract as content packs: a FB failure never un-publishes the IG side).
  if (isVideoDataUri(post.imageUrl) || post.videoPath) {
    const asset = await ensureSocialVideoAsset(post);
    if (!post.brand) {
      throw new Error(
        `El post ${postId} no tiene marca registrada — no se puede resolver la cuenta de IG/FB. Genera de nuevo con brand (creapolis|pepinillo|solennix).`
      );
    }
    const brand = post.brand as "creapolis" | "pepinillo" | "solennix";
    publishResult = await publishInstagramVideo({
      brand,
      videoUrl: asset.videoUrl,
      caption: post.caption,
      hashtags: post.hashtags,
      mediaType: "REELS",
    });
    try {
      const fb = await publishFacebookVideo({
        brand,
        videoUrl: asset.videoUrl,
        description: post.caption,
        hashtags: post.hashtags,
      });
      fbUrl = fb.externalPostUrl;
    } catch (fbErr) {
      console.error(`FB video publish failed for ${postId}:`, fbErr);
      await logEvent({
        entity: "social_post",
        entityId: postId,
        action: "post_fb_failed",
        actor,
        reason: fbErr instanceof Error ? fbErr.message : String(fbErr),
      });
    }

    const [published] = await db
      .update(socialPosts)
      .set({
        status: "published",
        publishedAt: new Date(),
        externalPostId: publishResult.externalPostId,
        externalPostUrl: publishResult.externalPostUrl,
        fbPostUrl: fbUrl ?? null,
        fbPublishedAt: fbUrl ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(socialPosts.id, postId))
      .returning();

    await logEvent({
      entity: "social_post",
      entityId: postId,
      action: "post_published",
      actor,
      before: { status: "approved" },
      after: {
        status: "published",
        reel: publishResult.externalPostUrl,
        fb: fbUrl,
      },
      reason: `IG Reel + ${fbUrl ? "FB video" : "FB failed (best-effort)"}`,
    });

    return { success: true, publishResult, post: published, fbUrl };
  }

  if (post.platform === "facebook") {
    publishResult = await publishToFacebook({
      caption: post.caption,
      hashtags: post.hashtags,
      imageUrl: post.imageUrl || undefined,
    });
  } else if (post.platform === "instagram") {
    publishResult = await publishToInstagram({
      caption: post.caption,
      hashtags: post.hashtags,
      imageUrl: post.imageUrl || undefined,
    });
  } else {
    throw new Error(`Automated publishing for platform '${post.platform}' is not yet supported.`);
  }

  const [published] = await db
    .update(socialPosts)
    .set({
      status: "published",
      publishedAt: new Date(),
      externalPostId: publishResult.externalPostId,
      externalPostUrl: publishResult.externalPostUrl,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, postId))
    .returning();

  await logEvent({
    entity: "social_post",
    entityId: postId,
    action: "post_published",
    actor,
    before: { status: post.status },
    after: {
      status: "published",
      externalPostId: publishResult.externalPostId,
      externalPostUrl: publishResult.externalPostUrl,
    },
    reason: `Published to ${post.platform} via Meta Graph API`,
  });

  return {
    success: true,
    post: published,
    publishResult,
  };
}

export async function listSocialPosts() {
  return await db
    .select()
    .from(socialPosts)
    .orderBy(desc(socialPosts.createdAt))
    .limit(50);
}

/**
 * Shares an approved video post to the Instagram Story surface (24h, no
 * public permalink). Requires the Reel publish to have happened first —
 * stories reference the same on-disk asset via its public URL.
 */
export async function publishSocialStory(postId: string, actor: string) {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);

  if (!post) throw new Error(`Social post ${postId} not found`);
  if (post.status !== "approved" && post.status !== "published") {
    throw new Error(`Cannot share a story from a post in status '${post.status}'. Approve it first.`);
  }
  if (!post.brand) {
    throw new Error(`El post ${postId} no tiene marca registrada — no se puede resolver la cuenta de IG.`);
  }

  const asset = await ensureSocialVideoAsset(post);
  const { publishInstagramVideo } = await import("../services/meta-graph");
  const story = await publishInstagramVideo({
    brand: post.brand as "creapolis" | "pepinillo" | "solennix",
    videoUrl: asset.videoUrl,
    caption: "",
    mediaType: "STORIES",
  });

  await logEvent({
    entity: "social_post",
    entityId: postId,
    action: "post_story_published",
    actor,
    after: { storyId: story.externalPostId },
    reason: "Shared the approved video to Instagram Stories",
  });

  return { success: true, story };
}
