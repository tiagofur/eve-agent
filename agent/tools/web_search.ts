import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireStaff } from "../lib/guard";

const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_COUNT = 8;
const MAX_COUNT = 10;

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

type SearchOutcome =
  | { ok: true; provider: "brave" | "tavily"; results: SearchResultItem[] }
  | { ok: false; reason: "not_configured" | "request_failed"; message: string };

function resolveProvider(): { provider: "brave" | "tavily"; apiKey: string } | null {
  const raw = (process.env.SEARCH_PROVIDER ?? "brave").trim().toLowerCase();
  const genericKey = process.env.SEARCH_API_KEY?.trim();
  if (raw !== "brave" && raw !== "tavily") return null;
  const key =
    genericKey ??
    (raw === "brave" ? process.env.BRAVE_API_KEY?.trim() : process.env.TAVILY_API_KEY?.trim());
  return key ? { provider: raw, apiKey: key } : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapBraveResults(body: unknown): SearchResultItem[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const web = (root.web ?? {}) as Record<string, unknown>;
  const results = Array.isArray(web.results) ? web.results : [];
  return results
    .map((item): SearchResultItem | null => {
      const record = (item ?? {}) as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      const title = cleanString(record.title);
      if (!url || !title) return null;
      return { title, url, snippet: cleanString(record.description) };
    })
    .filter((item): item is SearchResultItem => item !== null)
    .slice(0, MAX_COUNT);
}

function mapTavilyResults(body: unknown): SearchResultItem[] {
  const root = (body ?? {}) as Record<string, unknown>;
  const results = Array.isArray(root.results) ? root.results : [];
  return results
    .map((item): SearchResultItem | null => {
      const record = (item ?? {}) as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      const title = cleanString(record.title);
      if (!url || !title) return null;
      return { title, url, snippet: cleanString(record.content) };
    })
    .filter((item): item is SearchResultItem => item !== null)
    .slice(0, MAX_COUNT);
}

async function searchWeb(query: string, count: number): Promise<SearchOutcome> {
  const resolved = resolveProvider();
  if (!resolved) {
    const provider = (process.env.SEARCH_PROVIDER ?? "brave").trim();
    return {
      ok: false,
      reason: "not_configured",
      message:
        `Búsqueda web no configurada (proveedor: ${provider}). ` +
        "El dueño debe crear una API key gratuita (Brave: brave.com/search/api o Tavily: tavily.com) " +
        "y configurarla como SEARCH_API_KEY en el .env del servicio. " +
        "Mientras tanto, investiga solo negocios nombrados explícitamente.",
    };
  }

  const safeCount = Math.min(Math.max(count, 1), MAX_COUNT);
  try {
    let response: Response;
    if (resolved.provider === "brave") {
      const url =
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}` +
        `&count=${safeCount}`;
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": resolved.apiKey,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } else {
      response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolved.apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: safeCount,
          search_depth: "basic",
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    }

    if (!response.ok) {
      return {
        ok: false,
        reason: "request_failed",
        message: `El proveedor de búsqueda respondió con error (HTTP ${response.status}). Reintenta más tarde.`,
      };
    }

    const body: unknown = await response.json();
    const results =
      resolved.provider === "brave" ? mapBraveResults(body) : mapTavilyResults(body);
    if (results.length === 0) {
      return {
        ok: false,
        reason: "request_failed",
        message: "El proveedor de búsqueda no devolvió resultados utilizables.",
      };
    }
    return { ok: true, provider: resolved.provider, results };
  } catch (err) {
    return {
      ok: false,
      reason: "request_failed",
      message: `La búsqueda web falló: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export default defineTool({
  description:
    "Search the real web (Brave/Tavily) for local businesses and public information. " +
    "Use this FIRST when asked to FIND a prospect by criteria (industry, city, niche) " +
    "instead of guessing from memory. Returns {title, url, snippet} per result: pick the " +
    "best candidate, then verify it on its website before saving any dossier. " +
    "If it reports search_not_configured, tell the owner to set SEARCH_API_KEY.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe("Search query in natural language, e.g. 'clinica dental Puerto Vallarta'"),
    count: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Number of results (default 8, max 10)"),
  }),
  async execute({ query, count }, ctx) {
    requireStaff(ctx, "web_search");
    try {
      const outcome = await searchWeb(query.trim(), count ?? DEFAULT_COUNT);
      if (!outcome.ok) {
        return {
          status: "search_not_configured" in outcome || outcome.reason === "not_configured"
            ? "search_not_configured"
            : "search_failed",
          message: outcome.message,
        };
      }
      return {
        status: "search_ok",
        provider: outcome.provider,
        results: outcome.results,
      };
    } catch (err) {
      return {
        status: "search_failed",
        message: err instanceof Error ? err.message : "Web search unavailable",
      };
    }
  },
});
