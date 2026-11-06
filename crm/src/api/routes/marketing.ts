import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createSubscriptionFetch } from "../../../../agent/lib/meta-subscription";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import {
  createSocialPost,
  listSocialPosts,
  reviewSocialPost,
  publishSocialPost,
} from "../../domain/marketing";
import { pickMarketingContext, readDoc } from "../../domain/products";

export const marketingRouter = new Hono<{ Variables: AuthContextVariables }>();

function getModel() {
  // Gemini first when the key exists (same precedence as agent/lib/models.ts);
  // removing GEMINI_API_KEY falls back to Meta with no code change.
  if (process.env.GEMINI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
    return google(process.env.GEMINI_MODEL_ID || "gemini-flash-latest");
  }

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

// Product grounding block injected into the generation prompt. The docs are
// the single source of truth for product claims (docs/products/README).
function buildProductContext(nombre: string, slug: string, markdown: string): string {
  return `PRODUCT CONTEXT — ${nombre} (canonical doc docs/products/${slug}.md):
${markdown}

GROUNDING RULES (hard):
- Only claim features, platforms, and prices that appear in this doc. If a detail is not in the doc, do not invent it.
- Use the "Ángulos de marketing" section as the angle starting point for the caption.
- If the TOPIC conflicts with the doc, the doc wins.`;
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
      format: z.enum(["image", "video"]).optional().default("image"),
      productSlug: z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .optional(),
    })
  ),
  async (c) => {
    const { platform, topic, tone, targetAudience, format, productSlug } = c.req.valid("json");
    const actor = c.get("actor");
    const model = getModel();

    try {
      const isVideo = format === "video";

      // Ground the post in the canonical product docs (docs/products/*.md):
      // explicit slug when provided, otherwise auto-detect from the topic.
      // Pendiente docs are off-limits for marketing content (docs README rule).
      let productContext = "";
      if (productSlug) {
        const doc = await readDoc(productSlug);
        if (!doc) {
          return c.json({ error: `Unknown product doc '${productSlug}'` }, 400);
        }
        if (doc.meta.tipo === "pendiente") {
          return c.json(
            { error: `Product doc '${productSlug}' is tipo:pendiente — marketing content is blocked until the owner completes it.` },
            400
          );
        }
        productContext = buildProductContext(doc.meta.nombre || doc.meta.slug, doc.meta.slug, doc.markdown);
      } else {
        const detected = await pickMarketingContext(topic);
        if (detected) {
          productContext = buildProductContext(detected.nombre || detected.slug, detected.slug, detected.markdown);
        }
      }

      const prompt = `You are the Lead Marketing Specialist for Creapolis.Dev (a high-performance software agency specializing in autonomous AI agents, enterprise automation, and custom web/desktop apps).
Generate a high-converting, professional, and technical marketing post for ${platform.toUpperCase()}.

TOPIC: ${topic}
TARGET AUDIENCE: ${targetAudience || "Tech founders, business owners, operations managers"}
TONE: ${tone || "Modern, authoritative, builder-oriented, clear ROI, no generic corporate buzzwords"}
FORMAT: ${isVideo ? "Short-form video (Reel / TikTok / Short)" : "Static post with high-impact visual"}
${productContext ? `\n${productContext}\n` : ""}

Respond ONLY with valid JSON following this schema:
{
  "caption": "The complete post caption with emojis, hook, problem, solution, ROI, and call to action (in natural Spanish)",
  "hashtags": ["CreapolisDev", "AIAgents", "Automation", ...],
  ${isVideo ? `"videoPrompt": "Detailed English prompt for generative video model (Google Veo / Gemini Omni Flash). Describe high-tech camera movement, dynamic motion, dark tech zinc background, cyan/emerald glowing neon accents, 3D volumetric interfaces or agent workflows, cinematic 60fps."` : `"imagePrompt": "Detailed English prompt for generative image models (Nano Banana, Imagen). Style: sleek dark tech aesthetic, dark gray/zinc background, glowing emerald/cyan neon accents, clean geometric 3D shapes or futuristic agent dashboard, high resolution, 8k render, no blurry text."`}
}`;

      const { text } = await generateText({
        model,
        messages: [{ role: "user", content: prompt }],
      });

      // Parse JSON from model output (handling code fence if present)
      const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      // Generate Media: Video (Google Veo / Omni Flash) or Image (Nano Banana 2.1)
      let imageUrl: string | undefined = undefined;
      const visualPrompt = parsed.videoPrompt || parsed.imagePrompt;
      const geminiKey = process.env.GEMINI_API_KEY;
      const nanoBananaModel = process.env.NANO_BANANA_MODEL_ID || "gemini-nano-banana-2.1";
      const omniFlashModel = process.env.OMNI_FLASH_MODEL_ID || "gemini-omni-1.2-flash";
      const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
      const baseUrl = process.env.META_API_BASE_URL || "https://api.meta.ai/v1";

      if (isVideo && geminiKey && visualPrompt) {
        try {
          const vidRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/interactions?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: omniFlashModel,
                input: [{ type: "text", text: visualPrompt }],
                response_format: {
                  type: "video",
                  delivery: "uri",
                  aspect_ratio: platform === "instagram" ? "9:16" : "16:9",
                  duration: "5s",
                  resolution: "720p",
                },
              }),
            }
          );
          if (vidRes.ok) {
            const vidData = (await vidRes.json()) as any;
            const outputStep = vidData.steps?.find((s: any) => s.type === "model_output" || s.content?.[0]?.uri);
            const videoPart = outputStep?.content?.[0];
            if (videoPart?.uri) {
              const downloadRes = await fetch(`${videoPart.uri}&key=${geminiKey}`);
              if (downloadRes.ok) {
                const buf = Buffer.from(await downloadRes.arrayBuffer());
                imageUrl = `data:video/mp4;base64,${buf.toString("base64")}`;
              }
            }
          } else {
            const errText = await vidRes.text();
            console.error(`Failed to generate video with ${omniFlashModel} (${vidRes.status}):`, errText);
          }
        } catch (vidErr) {
          console.error("Failed to generate video with Omni Flash:", vidErr);
        }
      } else if (geminiKey && visualPrompt) {
        try {
          const imgRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${nanoBananaModel}:generateContent?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: visualPrompt }] }],
                generationConfig: {
                  responseModalities: ["IMAGE"],
                },
              }),
            }
          );
          if (imgRes.ok) {
            const imgData = (await imgRes.json()) as any;
            const part = imgData.candidates?.[0]?.content?.parts?.[0];
            if (part?.inlineData?.data) {
              const mime = part.inlineData.mimeType || "image/jpeg";
              imageUrl = `data:${mime};base64,${part.inlineData.data}`;
            }
          } else {
            const errText = await imgRes.text();
            console.error(`Failed to generate image with Nano Banana (${imgRes.status}):`, errText);
          }
        } catch (imgErr) {
          console.error("Failed to generate image with Nano Banana:", imgErr);
        }
      } else if (metaKey && visualPrompt) {
        try {
          const imgRes = await fetch(`${baseUrl}/images/generations`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${metaKey}`,
            },
            body: JSON.stringify({
              model: "muse-image-1.0",
              prompt: visualPrompt,
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
        imagePrompt: visualPrompt,
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
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing post id" }, 400);
    const actor = c.get("actor");

    try {
      const result = await publishSocialPost(id, actor);
      return c.json(result);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  }
);
