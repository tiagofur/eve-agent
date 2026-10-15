import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createSubscriptionFetch } from "../../../../agent/lib/meta-subscription";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  createSocialPost,
  listSocialPosts,
  reviewSocialPost,
  publishSocialPost,
} from "../../domain/marketing";

export const marketingRouter = new Hono<{ Variables: AuthContextVariables }>();

function getModel() {
  const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  if (metaKey) {
    const meta = createOpenAI({
      name: "meta",
      baseURL: process.env.META_API_BASE_URL || "https://api.meta.ai/v1",
      apiKey: metaKey,
    });
    return meta(process.env.META_MODEL_ID || "muse-spark-1.3-contributor");
  }

  // Explicit OpenAI key always wins when set.
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai("gpt-4o-mini");
  }

  if (process.env.META_USE_SUBSCRIPTION === "0") {
    // Escape hatch back to the previous OpenAI default.
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY || "dummy",
    });
    return openai("gpt-4o-mini");
  }

  // Local-only Muse Code subscription (one-time login via
  // `node scripts/meta-login.mjs`). No API billing.
  const metaSubscription = createOpenAI({
    name: "meta-subscription",
    baseURL: process.env.META_API_BASE_URL || "https://api.meta.ai/v1",
    apiKey: "subscription",
    fetch: createSubscriptionFetch(),
  });
  return metaSubscription(process.env.META_MODEL_ID || "muse-spark-1.3-contributor");
}

// 1. List social posts
marketingRouter.get("/", requireScope(["ops"]), async (c) => {
  const posts = await listSocialPosts();
  return c.json({ posts });
});

// 2. Generate a new AI marketing post (Copy + Image Prompt + Auto Telegram Notification)
marketingRouter.post(
  "/generate",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      platform: z.enum(["instagram", "facebook", "linkedin", "twitter"]),
      topic: z.string().min(5),
      tone: z.string().optional(),
      targetAudience: z.string().optional(),
    })
  ),
  async (c) => {
    const { platform, topic, tone, targetAudience } = c.req.valid("json");
    const actor = c.get("actor");
    const model = getModel();

    try {
      const prompt = `You are the Lead Marketing Specialist for Creapolis.Dev (a high-performance software agency specializing in autonomous AI agents, enterprise automation, and custom web/desktop apps).
Generate a high-converting, professional, and technical marketing post for ${platform.toUpperCase()}.

TOPIC: ${topic}
TARGET AUDIENCE: ${targetAudience || "Tech founders, business owners, operations managers"}
TONE: ${tone || "Modern, authoritative, builder-oriented, clear ROI, no generic corporate buzzwords"}

Respond ONLY with valid JSON following this schema:
{
  "caption": "The complete post caption with emojis, hook, problem, solution, ROI, and call to action (in natural Spanish)",
  "hashtags": ["CreapolisDev", "AIAgents", "Automation", ...],
  "imagePrompt": "Detailed English prompt for generative image models (Muse Image, Midjourney). Style: sleek dark tech aesthetic, dark gray/zinc background, glowing emerald/cyan neon accents, clean geometric 3D shapes or futuristic agent dashboard, high resolution, 8k render, no blurry text."
}`;

      const { text } = await generateText({
        model,
        messages: [{ role: "user", content: prompt }],
      });

      // Parse JSON from model output (handling code fence if present)
      const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      // Generate Image using muse-image-1.0 with the same META_API_KEY
      let imageUrl: string | undefined = undefined;
      const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
      const baseUrl = process.env.META_API_BASE_URL || "https://api.meta.ai/v1";

      if (metaKey && parsed.imagePrompt) {
        try {
          const imgRes = await fetch(`${baseUrl}/images/generations`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${metaKey}`,
            },
            body: JSON.stringify({
              model: "muse-image-1.0",
              prompt: parsed.imagePrompt,
              n: 1,
              size: "1024x1024",
            }),
          });
          const imgData = (await imgRes.json()) as any;
          const b64 = imgData.data?.[0]?.b64_json;
          if (b64) {
            imageUrl = `data:image/webp;base64,${b64}`;
          }
        } catch (imgErr) {
          console.error("Failed to generate image with muse-image-1.0:", imgErr);
        }
      }

      const result = await createSocialPost({
        platform,
        topic,
        caption: parsed.caption,
        hashtags: parsed.hashtags || [],
        imagePrompt: parsed.imagePrompt,
        imageUrl,
        actor,
      });

      return c.json({
        success: true,
        post: result.post,
      });
    } catch (err: any) {
      console.error("Marketing generation error:", err);
      return c.json({ error: err.message || "Failed to generate marketing post" }, 500);
    }
  }
);

// 3. Review post (approve / reject)
marketingRouter.post(
  "/:id/review",
  requireScope(["owner"]),
  zValidator(
    "json",
    z.object({
      decision: z.enum(["approved", "rejected"]),
      rejectedReason: z.string().optional(),
    })
  ),
  async (c) => {
    const { id } = c.req.param();
    const { decision, rejectedReason } = c.req.valid("json");
    const actor = c.get("actor");

    try {
      const result = await reviewSocialPost({
        postId: id,
        decision,
        rejectedReason,
        actor,
      });
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  }
);

// 4. Publish post (Meta Graph API)
marketingRouter.post(
  "/:id/publish",
  requireScope(["owner"]),
  async (c) => {
    const { id } = c.req.param();
    const actor = c.get("actor");

    try {
      const result = await publishSocialPost(id, actor);
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  }
);
