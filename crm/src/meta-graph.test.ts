import { describe, expect, it, vi, afterEach } from "vitest";
import {
  publishInstagramMedia,
  resolveBrandConfig,
  type PublishBrand,
} from "./services/meta-graph";

/**
 * Instagram pack publishing: brand credential resolution (per-brand vars +
 * creapolis legacy fallback) and the carousel container sequence
 * (children → carousel → status poll → media_publish).
 */

const ORIGINAL_FETCH = globalThis.fetch;

interface Call {
  url: string;
  body?: string;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Responds to graph POSTs/GETs in order; records calls for assertions. */
function mockGraph(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(next.json), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const BRAND_ENV: Record<PublishBrand, string> = {
  creapolis: "CREAPOLIS",
  pepinillo: "PEPINILLO",
  solennix: "SOLENNIX",
};

describe("resolveBrandConfig", () => {
  it("usa las variables de la marca y cae a META_* legacy solo en creapolis", () => {
    vi.stubEnv("PUBLISH_PEPINILLO_IG_ACCOUNT_ID", "ig-pepinillo");
    vi.stubEnv("PUBLISH_PEPINILLO_ACCESS_TOKEN", "tok-pepinillo");
    vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", "ig-legacy");
    vi.stubEnv("META_PAGE_ACCESS_TOKEN", "tok-legacy");

    const pepinillo = resolveBrandConfig("pepinillo");
    expect(pepinillo.instagramAccountId).toBe("ig-pepinillo");
    expect(pepinillo.pageAccessToken).toBe("tok-pepinillo");

    // No legacy fallback for other brands.
    expect(resolveBrandConfig("solennix").instagramAccountId).toBeUndefined();

    const creapolis = resolveBrandConfig("creapolis");
    expect(creapolis.instagramAccountId).toBe("ig-legacy");
    expect(creapolis.pageAccessToken).toBe("tok-legacy");

    // Brand vars win over legacy for creapolis.
    vi.stubEnv("PUBLISH_CREAPOLIS_IG_ACCOUNT_ID", "ig-creapolis");
    expect(resolveBrandConfig("creapolis").instagramAccountId).toBe("ig-creapolis");
  });
});

describe("publishInstagramMedia", () => {
  it("carrusel: hijos → contenedor CAROUSEL → poll FINISHED → media_publish", async () => {
    vi.stubEnv("PUBLISH_SOLENNIX_IG_ACCOUNT_ID", "ig-solennix");
    vi.stubEnv("PUBLISH_SOLENNIX_ACCESS_TOKEN", "tok-solennix");
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { id: "child-1" } },
      { json: { id: "child-2" } },
      { json: { id: "carousel-1" } },
      { json: { status_code: "FINISHED" } },
      { json: { id: "pub-123" } },
    ]);

    const result = await publishInstagramMedia({
      brand: "solennix",
      imageUrls: ["https://x.example/s/0", "https://x.example/s/1"],
      caption: "Dos slides",
      hashtags: ["Solennix"],
    });

    expect(result.success).toBe(true);
    expect(result.externalPostId).toBe("pub-123");
    expect(result.externalPostUrl).toContain("instagram.com/p/pub-123");

    const posts = calls.filter((c) => !c.url.includes("?fields="));
    expect(posts).toHaveLength(4);
    expect(posts[0]!.body).toContain("is_carousel_item=true");
    expect(posts[1]!.body).toContain("is_carousel_item=true");
    expect(posts[2]!.body).toContain("media_type=CAROUSEL");
    expect(posts[2]!.body).toContain("children=child-1%2Cchild-2");
    expect(posts[3]!.url).toContain("/media_publish");
    // The poll hit the carousel container's status endpoint.
    expect(calls[3]!.url).toContain("carousel-1");
    expect(calls[3]!.url).toContain("status_code");
  });

  it("imagen única: contenedor directo con caption + publish", async () => {
    vi.stubEnv("PUBLISH_CREAPOLIS_IG_ACCOUNT_ID", "ig-creapolis");
    vi.stubEnv("PUBLISH_CREAPOLIS_ACCESS_TOKEN", "tok-creapolis");
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { id: "single-1" } },
      { json: { status_code: "FINISHED" } },
      { json: { id: "pub-single" } },
    ]);

    const result = await publishInstagramMedia({
      brand: "creapolis",
      imageUrls: ["https://x.example/s/0"],
      caption: "Una slide",
    });
    expect(result.externalPostId).toBe("pub-single");
    const posts = calls.filter((c) => !c.url.includes("?fields="));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toContain("image_url=");
    expect(posts[0]!.body).not.toContain("is_carousel_item");
  });

  it("sin credenciales de la marca: error que nombra la marca y sus variables", async () => {
    delete process.env.PUBLISH_DRY_RUN;
    delete process.env.PUBLISH_SOLENNIX_IG_ACCOUNT_ID;
    delete process.env.PUBLISH_SOLENNIX_ACCESS_TOKEN;

    await expect(
      publishInstagramMedia({ brand: "solennix", imageUrls: ["https://x/0"], caption: "x" })
    ).rejects.toThrow(/solennix.*PUBLISH_SOLENNIX_IG_ACCOUNT_ID/s);
  });

  it("contenedor en ERROR aborta con mensaje claro", async () => {
    vi.stubEnv("PUBLISH_CREAPOLIS_IG_ACCOUNT_ID", "ig-c");
    vi.stubEnv("PUBLISH_CREAPOLIS_ACCESS_TOKEN", "tok");
    delete process.env.PUBLISH_DRY_RUN;

    mockGraph([
      { json: { id: "single-1" } },
      { json: { status_code: "ERROR" } },
    ]);

    await expect(
      publishInstagramMedia({ brand: "creapolis", imageUrls: ["https://x/0"], caption: "x" })
    ).rejects.toThrow(/container error/i);
  });
});
