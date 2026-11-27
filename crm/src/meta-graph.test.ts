import { describe, expect, it, vi, afterEach } from "vitest";
import {
  publishToFacebook,
  publishFacebookVideo,
  publishInstagramMedia,
  publishInstagramVideo,
  resolveBrandConfig,
  type PublishBrand,
} from "./services/meta-graph";

/**
 * Instagram pack publishing: brand credential resolution (per-brand vars +
 * creapolis legacy fallback) and the carousel container sequence
 * (children → carousel → status poll → media_publish). Facebook publishing
 * through a system-user token must first exchange it for a page token.
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

describe("publishToFacebook con token de usuario de sistema", () => {
  it("intercambia el token de sistema por un token de página antes de publicar la foto", async () => {
    vi.stubEnv("PUBLISH_PEPINILLO_FB_PAGE_ID", "page-pep");
    vi.stubEnv("PUBLISH_PEPINILLO_ACCESS_TOKEN", "tok-sistema");
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { access_token: "tok-pagina" } }, // GET page?fields=access_token
      { json: { id: "photo-1", post_id: "post-1" } }, // POST /photos
    ]);

    const result = await publishToFacebook(
      {
        caption: "Hola",
        imageUrl: "https://x.example/cover.jpg",
      },
      {
        version: "v23.0",
        pageId: "page-pep",
        pageAccessToken: "tok-sistema",
        tokenIsSystemUser: true,
      }
    );

    expect(result.success).toBe(true);
    expect(result.externalPostUrl).toContain("facebook.com/post-1");
    // La primera llamada deriva el token de página (GET), la segunda publica.
    expect(calls[0]!.url).toContain("page-pep?fields=access_token");
    expect(calls[0]!.url).toContain("tok-sistema");
    expect(calls[1]!.url).toContain("/photos");
  });

  it("un token de página ya derivado (legacy META_*) se usa tal cual", async () => {
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { id: "photo-2", post_id: "post-2" } }, // solo POST /photos
    ]);

    const result = await publishToFacebook(
      { caption: "Hola", imageUrl: "https://x.example/cover.jpg" },
      { version: "v23.0", pageId: "page-legacy", pageAccessToken: "tok-pagina" }
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/photos");
  });
});

describe("publishInstagramVideo (Reel / Historia)", () => {
  it("reel: contenedor REELS con video_url + caption → poll FINISHED → media_publish", async () => {
    vi.stubEnv("PUBLISH_PEPINILLO_IG_ACCOUNT_ID", "ig-pep");
    vi.stubEnv("PUBLISH_PEPINILLO_ACCESS_TOKEN", "tok-pep");
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { id: "video-container" } },
      { json: { status_code: "FINISHED" } },
      { json: { id: "reel-123" } },
    ]);

    const result = await publishInstagramVideo({
      brand: "pepinillo",
      videoUrl: "https://crm.example/api/public/content/social/abc/video.mp4",
      caption: "Clip vertical",
      hashtags: ["Pepinillo"],
      mediaType: "REELS",
    });

    expect(result.success).toBe(true);
    expect(result.externalPostId).toBe("reel-123");
    expect(result.externalPostUrl).toContain("instagram.com/reel/reel-123");

    const posts = calls.filter((c) => !c.url.includes("?fields="));
    expect(posts).toHaveLength(2);
    const params = new URLSearchParams(posts[0]!.body);
    expect(posts[0]!.url).toContain("/media");
    expect(params.get("media_type")).toBe("REELS");
    expect(params.get("video_url")).toContain("/video.mp4");
    expect(params.get("share_to_feed")).toBe("true");
    expect(params.get("caption")).toContain("Clip vertical");
    expect(calls[1]!.url).toContain("video-container");
    expect(posts[1]!.url).toContain("/media_publish");
  });

  it("historia: media_type STORIES sin caption ni share_to_feed", async () => {
    vi.stubEnv("PUBLISH_SOLENNIX_IG_ACCOUNT_ID", "ig-sol");
    vi.stubEnv("PUBLISH_SOLENNIX_ACCESS_TOKEN", "tok-sol");
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { id: "story-container" } },
      { json: { status_code: "FINISHED" } },
      { json: { id: "story-77" } },
    ]);

    const result = await publishInstagramVideo({
      brand: "solennix",
      videoUrl: "https://crm.example/v.mp4",
      caption: "",
      mediaType: "STORIES",
    });

    expect(result.success).toBe(true);
    const params = new URLSearchParams(calls.filter((c) => !c.url.includes("?fields="))[0]!.body);
    expect(params.get("media_type")).toBe("STORIES");
    expect(params.has("caption")).toBe(false);
    expect(params.has("share_to_feed")).toBe(false);
  });

  it("sin credenciales de la marca: error que nombra la marca", async () => {
    delete process.env.PUBLISH_DRY_RUN;
    delete process.env.PUBLISH_PEPINILLO_IG_ACCOUNT_ID;
    delete process.env.PUBLISH_PEPINILLO_ACCESS_TOKEN;

    await expect(
      publishInstagramVideo({
        brand: "pepinillo",
        videoUrl: "https://x/v.mp4",
        caption: "x",
        mediaType: "REELS",
      })
    ).rejects.toThrow(/pepinillo.*PUBLISH_PEPINILLO/s);
  });
});

describe("publishFacebookVideo", () => {
  it("intercambia el token de sistema por token de página antes de /videos", async () => {
    vi.stubEnv("PUBLISH_SOLENNIX_FB_PAGE_ID", "page-sol");
    vi.stubEnv("PUBLISH_SOLENNIX_ACCESS_TOKEN", "tok-sistema");
    delete process.env.PUBLISH_DRY_RUN;

    const calls = mockGraph([
      { json: { access_token: "tok-pagina" } }, // GET page?fields=access_token
      { json: { id: "video-9" } }, // POST /videos
    ]);

    const result = await publishFacebookVideo({
      brand: "solennix",
      videoUrl: "https://crm.example/v.mp4",
      description: "Clip",
      hashtags: ["Solennix"],
    });

    expect(result.success).toBe(true);
    expect(result.externalPostUrl).toContain("facebook.com/");

    const params = new URLSearchParams(calls[1]!.body);
    expect(calls[1]!.url).toContain("/videos");
    expect(params.get("file_url")).toContain("/v.mp4");
    expect(params.get("description")).toContain("Clip");
    // The page token exchange ran with the system-user token.
    expect(calls[0]!.url).toContain("page-sol?fields=access_token");
  });
});
