/**
 * Web search for the orchestrator chat, without coupling to a single vendor.
 *
 * Providers (selected via SEARCH_PROVIDER, default "brave"):
 *   - brave:  Brave Search API (free tier: https://brave.com/search/api)
 *   - tavily: Tavily API (free tier: https://tavily.com)
 *
 * The key is read from SEARCH_API_KEY (BRAVE_API_KEY / TAVILY_API_KEY are
 * accepted as provider-specific fallbacks). Without a key the search degrades
 * HONESTLY: it reports `not_configured` with setup instructions instead of
 * inventing results, so the model tells the owner what is missing.
 */
const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_COUNT = 8;
const MAX_COUNT = 10;

export type SearchProvider = "brave" | "tavily";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchInput {
  query: string;
  count?: number;
}

export type SearchOutcome =
  | {
      ok: true;
      provider: SearchProvider;
      results: SearchResultItem[];
    }
  | {
      ok: false;
      reason: "not_configured" | "request_failed";
      message: string;
    };

export interface SearchIO {
  fetchJson(
    url: string,
    init?: RequestInit
  ): Promise<{ status: number; body: unknown } | null>;
}

const defaultIO: SearchIO = {
  async fetchJson(url, init) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = (await response.json()) as unknown;
      return { status: response.status, body };
    } catch {
      return null;
    }
  },
};

function resolveProvider(): { provider: SearchProvider; apiKey: string } | null {
  const raw = (process.env.SEARCH_PROVIDER ?? "brave").trim().toLowerCase();
  const genericKey = process.env.SEARCH_API_KEY?.trim();

  if (raw === "brave") {
    const key = genericKey ?? process.env.BRAVE_API_KEY?.trim();
    return key ? { provider: "brave", apiKey: key } : null;
  }
  if (raw === "tavily") {
    const key = genericKey ?? process.env.TAVILY_API_KEY?.trim();
    return key ? { provider: "tavily", apiKey: key } : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function mapBrave(body: unknown): SearchResultItem[] {
  const root = asRecord(body);
  const web = asRecord(root?.web);
  const results = Array.isArray(web?.results) ? web.results : [];
  return results
    .map((item): SearchResultItem | null => {
      const record = asRecord(item);
      const url = typeof record?.url === "string" ? record.url : "";
      const title = toStringOrEmpty(record?.title);
      if (!url || !title) return null;
      return { title, url, snippet: toStringOrEmpty(record?.description) };
    })
    .filter((item): item is SearchResultItem => item !== null)
    .slice(0, MAX_COUNT);
}

function mapTavily(body: unknown): SearchResultItem[] {
  const root = asRecord(body);
  const results = Array.isArray(root?.results) ? root.results : [];
  return results
    .map((item): SearchResultItem | null => {
      const record = asRecord(item);
      const url = typeof record?.url === "string" ? record.url : "";
      const title = toStringOrEmpty(record?.title);
      if (!url || !title) return null;
      return { title, url, snippet: toStringOrEmpty(record?.content) };
    })
    .filter((item): item is SearchResultItem => item !== null)
    .slice(0, MAX_COUNT);
}

export async function searchWeb(
  input: SearchInput,
  io: SearchIO = defaultIO
): Promise<SearchOutcome> {
  const query = input.query.trim();
  if (!query) {
    return {
      ok: false,
      reason: "request_failed",
      message: "La búsqueda no puede estar vacía.",
    };
  }

  const resolved = resolveProvider();
  if (!resolved) {
    const provider = (process.env.SEARCH_PROVIDER ?? "brave").trim();
    return {
      ok: false,
      reason: "not_configured",
      message:
        `Búsqueda web no configurada (proveedor: ${provider}). ` +
        "Crea una API key gratuita (Brave: brave.com/search/api o Tavily: tavily.com) " +
        "y configúrala en crm/.env como SEARCH_API_KEY (opcional SEARCH_PROVIDER=brave|tavily). " +
        "Mientras tanto, investiga solo negocios que el dueño nombre explícitamente.",
    };
  }

  const count = Math.min(Math.max(input.count ?? DEFAULT_COUNT, 1), MAX_COUNT);

  let response: Awaited<ReturnType<SearchIO["fetchJson"]>>;
  if (resolved.provider === "brave") {
    const url =
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}` +
      `&count=${count}`;
    response = await io.fetchJson(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": resolved.apiKey,
      },
    });
  } else {
    response = await io.fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: count,
        search_depth: "basic",
      }),
    });
  }

  if (!response || response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      reason: "request_failed",
      message: `El proveedor de búsqueda respondió con error (HTTP ${response?.status ?? "sin respuesta"}). Reintenta más tarde.`,
    };
  }

  const results =
    resolved.provider === "brave" ? mapBrave(response.body) : mapTavily(response.body);
  if (results.length === 0) {
    return {
      ok: false,
      reason: "request_failed",
      message: "El proveedor de búsqueda no devolvió resultados utilizables.",
    };
  }

  return { ok: true, provider: resolved.provider, results };
}
