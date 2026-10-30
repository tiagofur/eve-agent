import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchAiNews } from "../lib/ai-news";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Fetch today's curated AI news (last 48h) from vetted sources (TLDR AI, The Rundown, Simon Willison, DeepMind, OpenAI, Hugging Face, Latent Space, Hacker News). Deterministic fetch + dedupe; the caller selects and interprets. Use for the daily intel brief and for news-based content.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(30).optional().describe("Max items to return (default 20)"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "fetch_ai_news");
    try {
      const result = await fetchAiNews();
      return {
        status: result.items.length > 0 ? "ok" : "empty",
        fetchedAt: result.fetchedAt,
        windowHours: result.windowHours,
        itemCount: result.items.length,
        items: result.items.slice(0, input.limit ?? 20),
        failedSources: result.failedSources,
        hint: "Pick the 5-8 items most relevant for LATAM pyme owners; ground every claim in a specific item title/source.",
      };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : "News fetch failed" };
    }
  },
});
