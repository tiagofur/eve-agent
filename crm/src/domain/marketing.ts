import { eq, desc } from "drizzle-orm";
import { db } from "../db/client";
import {
  socialPosts,
  type SocialPlatform,
  type SocialPostStatus,
} from "../db/schema";
import { logEvent } from "./events";
import { notifySocialPostCreated } from "../services/telegram";

export interface CreateSocialPostInput {
  platform: SocialPlatform;
  topic: string;
  caption: string;
  hashtags?: string[];
  imagePrompt?: string;
  imageUrl?: string;
  actor: string;
}

export async function createSocialPost(input: CreateSocialPostInput) {
  const [post] = await db
    .insert(socialPosts)
    .values({
      platform: input.platform,
      topic: input.topic,
      caption: input.caption,
      hashtags: input.hashtags || [],
      imagePrompt: input.imagePrompt,
      imageUrl: input.imageUrl,
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
  const { publishToFacebook, publishToInstagram } = await import("../services/meta-graph");

  let publishResult;
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
