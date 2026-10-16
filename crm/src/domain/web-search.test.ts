import { describe, expect, it, afterAll } from "vitest";
import { searchWeb, type SearchIO } from "./web-search";

/**
 * Web search for the orchestrator chat: real search-provider results when a
 * key is configured, honest not-configured degradation otherwise. Network is
 * fully mocked via the injectable IO.
 */

const braveResults = {
  web: {
    results: [
      {
        title: "Clínica Dental Vallarta",
        url: "https://clinicadentalvallarta.com",
        description: "Odontología integral en Puerto Vallarta",
      },
      {
        title: "Dentista Vallarta Centro",
        url: "https://dentistavallartacentro.mx",
        description: "Consultas y limpiezas",
      },
    ],
  },
};

const tavilyResults = {
  results: [
    {
      title: "Clínica Dental Vallarta",
      url: "https://clinicadentalvallarta.com",
      content: "Odontología integral en Puerto Vallarta",
    },
  ],
};

const fakeIO = (
  respond: (url: string, init?: RequestInit) => { status: number; body: unknown }
): SearchIO & { calls: Array<{ url: string; init?: RequestInit }> } => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    async fetchJson(url: string, init?: RequestInit) {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
};

const originalEnv = { ...process.env };

describe("searchWeb", () => {
  it("degrades honestly when no API key is configured", async () => {
    delete process.env.SEARCH_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.TAVILY_API_KEY;

    const result = await searchWeb({ query: "dentista puerto vallarta" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_configured");
      expect(result.message).toContain("SEARCH_API_KEY");
    }
  });

  it("searches Brave by default and maps results", async () => {
    process.env.SEARCH_API_KEY = "test-brave-key";
    delete process.env.SEARCH_PROVIDER;

    const io = fakeIO(() => ({ status: 200, body: braveResults }));
    const result = await searchWeb({ query: "dentista puerto vallarta" }, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("brave");
      expect(result.results).toEqual([
        {
          title: "Clínica Dental Vallarta",
          url: "https://clinicadentalvallarta.com",
          snippet: "Odontología integral en Puerto Vallarta",
        },
        {
          title: "Dentista Vallarta Centro",
          url: "https://dentistavallartacentro.mx",
          snippet: "Consultas y limpiezas",
        },
      ]);
    }
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0]?.url).toContain("api.search.brave.com");
    expect(io.calls[0]?.init?.headers).toMatchObject({
      "X-Subscription-Token": "test-brave-key",
    });
  });

  it("searches Tavily when selected via SEARCH_PROVIDER", async () => {
    process.env.SEARCH_API_KEY = "test-tavily-key";
    process.env.SEARCH_PROVIDER = "tavily";

    const io = fakeIO(() => ({ status: 200, body: tavilyResults }));
    const result = await searchWeb({ query: "dentista puerto vallarta" }, io);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("tavily");
      expect(result.results[0]?.url).toBe("https://clinicadentalvallarta.com");
      expect(result.results[0]?.snippet).toBe("Odontología integral en Puerto Vallarta");
    }
    expect(io.calls[0]?.url).toContain("api.tavily.com");
    expect(String(io.calls[0]?.init?.method)).toBe("POST");
  });

  it("degrades honestly when the provider call fails", async () => {
    process.env.SEARCH_API_KEY = "test-brave-key";
    delete process.env.SEARCH_PROVIDER;

    const io = fakeIO(() => ({ status: 429, body: { error: "rate limited" } }));
    const result = await searchWeb({ query: "dentista" }, io);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("request_failed");
    }
  });

  it("degrades honestly when the provider returns malformed data", async () => {
    process.env.SEARCH_API_KEY = "test-brave-key";

    const io = fakeIO(() => ({ status: 200, body: { unexpected: true } }));
    const result = await searchWeb({ query: "dentista" }, io);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("request_failed");
    }
  });

  it("rejects an unknown provider explicitly", async () => {
    process.env.SEARCH_API_KEY = "some-key";
    process.env.SEARCH_PROVIDER = "altavista";

    const result = await searchWeb({ query: "dentista" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_configured");
      expect(result.message).toContain("altavista");
    }
  });
});
