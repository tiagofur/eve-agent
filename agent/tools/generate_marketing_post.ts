import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGenerateMarketingPost } from "../lib/crm";

export default defineTool({
  description:
    "Generate a complete social media marketing post (Instagram, Facebook, LinkedIn) with technical copy, hashtags, and Muse Image visual prompt, automatically sending it to Telegram for executive approval.",
  inputSchema: z.object({
    platform: z
      .enum(["instagram", "facebook", "linkedin", "twitter"])
      .describe("Target social media platform"),
    topic: z
      .string()
      .min(5)
      .describe(
        "Subject or case study to promote (e.g. 'Creapolis Dev AI WhatsApp Receptionist saves 15 hours/week for clinics')"
      ),
    tone: z
      .string()
      .optional()
      .describe("Voice tone: modern, authoritative, technical, or case-study"),
    targetAudience: z
      .string()
      .optional()
      .describe("Target reader persona"),
  }),
  async execute(input) {
    try {
      const result = await crmGenerateMarketingPost(input);
      return {
        status: "post_created_pending_approval",
        postId: result.post.id,
        platform: result.post.platform,
        topic: result.post.topic,
        captionPreview: result.post.caption.slice(0, 150) + "...",
        imagePrompt: result.post.imagePrompt,
        message: `Post created for ${result.post.platform.toUpperCase()} and queued in CRM in 'pending_approval' status. Telegram notification dispatched for 1-click owner approval.`,
      };
    } catch (err) {
      return {
        status: "generation_failed",
        error: err instanceof Error ? err.message : "Marketing generation error",
      };
    }
  },
});
