/**
 * AI news intelligence: fetches curated sources (RSS/Atom + Hacker News),
 * filters to the last 48h, dedupes and returns a compact item list for the
 * intel subagent to summarize. No LLM here — deterministic curation only.
 */

export interface AiNewsItem {
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  summary?: string;
}

interface FeedDef {
  name: string;
  url: string;
  kind: "rss" | "atom";
}

const FEEDS: FeedDef[] = [
  { name: "TLDR AI", url: "https://tldr.tech/rss/ai", kind: "rss" },
  { name: "The Rundown", url: "https://www.therundown.ai/feed", kind: "rss" },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", kind: "atom" },
  { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", kind: "rss" },
  { name: "OpenAI", url: "https://openai.com/news/rss.xml", kind: "rss" },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", kind: "atom" },
  { name: "Latent Space", url: "https://www.latent.space/feed", kind: "rss" },
];

const HN_ALGOLIA =
  "https://hn.algolia.com/api/v1/search_by_date?tags=story&query=AI&numericFilters=points%3E100";

const WINDOW_MS = 48 * 60 * 60 * 1000;
const PER_FEED_CAP = 4;
const HN_CAP = 6;
const MAX_ITEMS = 30;

const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const decodeCdata = (raw: string) => {
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  return stripTags(cdata ? cdata[1] : raw);
};

const tagContent = (block: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match?.[1];
};

const parseFeed = (xml: string, kind: FeedDef["kind"]): Array<{ title: string; url: string; date?: string; summary?: string }> => {
  const itemTag = kind === "atom" ? "entry" : "item";
  const blocks = xml.match(new RegExp(`<${itemTag}[^>]*>[\\s\\S]*?</${itemTag}>`, "gi")) ?? [];
  const items: Array<{ title: string; url: string; date?: string; summary?: string }> = [];
  for (const block of blocks) {
    const title = tagContent(block, "title");
    if (!title) continue;
    let url = "";
    if (kind === "atom") {
      const link = /<link[^>]*href="([^"]+)"/i.exec(block);
      url = link?.[1] ?? "";
    } else {
      url = decodeCdata(tagContent(block, "link") ?? "");
    }
    const date = tagContent(block, "pubDate") ?? tagContent(block, "published") ?? tagContent(block, "updated");
    const summaryRaw = tagContent(block, "description") ?? tagContent(block, "summary") ?? tagContent(block, "content");
    items.push({
      title: decodeCdata(title),
      url,
      date,
      summary: summaryRaw ? stripTags(decodeCdata(summaryRaw)).slice(0, 280) : undefined,
    });
  }
  return items;
};

async function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { "User-Agent": "creapolis-intel/1.0" } });
  } finally {
    clearTimeout(timer);
  }
}

const normalizeKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ");

export interface AiNewsResult {
  items: AiNewsItem[];
  fetchedAt: string;
  windowHours: number;
  failedSources: string[];
}

export async function fetchAiNews(): Promise<AiNewsResult> {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const failedSources: string[] = [];
  const collected: AiNewsItem[] = [];
  const seen = new Set<string>();

  const push = (item: AiNewsItem) => {
    const key = normalizeKey(item.title);
    if (!key || seen.has(key)) return;
    seen.add(key);
    collected.push(item);
  };

  await Promise.allSettled([
    ...FEEDS.map(async (feed) => {
      try {
        const res = await fetchWithTimeout(feed.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseFeed(await res.text(), feed.kind);
        let count = 0;
        for (const entry of parsed) {
          if (count >= PER_FEED_CAP) break;
          const ts = entry.date ? new Date(entry.date).getTime() : NaN;
          if (Number.isFinite(ts) && ts < cutoff) continue;
          push({
            source: feed.name,
            title: entry.title,
            url: entry.url,
            publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString(),
            summary: entry.summary,
          });
          count++;
        }
      } catch (err) {
        failedSources.push(`${feed.name}: ${err instanceof Error ? err.message : "fetch failed"}`);
      }
    }),
    (async () => {
      try {
        const res = await fetchWithTimeout(HN_ALGOLIA);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          hits: Array<{ title: string; url: string | null; objectID: string; created_at: string; points: number }>;
        };
        let count = 0;
        for (const hit of data.hits ?? []) {
          if (count >= HN_CAP) break;
          const ts = new Date(hit.created_at).getTime();
          if (ts < cutoff) continue;
          push({
            source: `Hacker News (${hit.points}★)`,
            title: hit.title,
            url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
            publishedAt: hit.created_at,
          });
          count++;
        }
      } catch (err) {
        failedSources.push(`Hacker News: ${err instanceof Error ? err.message : "fetch failed"}`);
      }
    })(),
  ]);

  // Freshest first, hard cap.
  collected.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return {
    items: collected.slice(0, MAX_ITEMS),
    fetchedAt: new Date().toISOString(),
    windowHours: WINDOW_MS / 3_600_000,
    failedSources,
  };
}
