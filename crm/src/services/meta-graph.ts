/**
 * Meta Graph API Service for Creapolis Social Publishing
 * Supports Facebook Page Posts & Instagram Business Media Publishing
 * (single image + carousel), with per-brand credentials for the three
 * content-pipeline brands: creapolis, pepinillo, solennix.
 *
 * PUBLISH_DRY_RUN=true short-circuits every publish into a fake success —
 * used to rehearse the approve+publish flow without touching real accounts.
 */

export type PublishBrand = "creapolis" | "pepinillo" | "solennix";

export interface PublishResult {
  success: boolean;
  externalPostId: string;
  externalPostUrl?: string;
  platform: "facebook" | "instagram";
  error?: string;
}

export interface PublishContent {
  caption: string;
  hashtags?: string[];
  imageUrl?: string; // Can be data:image/...;base64,... or http(s)://...
}

export interface PublishConfig {
  version: string;
  pageId?: string;
  pageAccessToken?: string;
  instagramAccountId?: string;
}

/** Env suffix per brand — variables are PUBLISH_<SUFFIX>_ACCESS_TOKEN etc. */
const BRAND_ENV_SUFFIX: Record<PublishBrand, string> = {
  creapolis: "CREAPOLIS",
  pepinillo: "PEPINILLO",
  solennix: "SOLENNIX",
};

function legacyEnvConfig(): PublishConfig {
  return {
    version: process.env.META_GRAPH_API_VERSION || "v20.0",
    pageId: process.env.META_FACEBOOK_PAGE_ID,
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN,
    instagramAccountId: process.env.META_INSTAGRAM_ACCOUNT_ID,
  };
}

/**
 * Per-brand publish credentials: PUBLISH_<BRAND>_IG_ACCOUNT_ID /
 * PUBLISH_<BRAND>_FB_PAGE_ID / PUBLISH_<BRAND>_ACCESS_TOKEN. The creapolis
 * brand falls back to the legacy META_* variables so existing setups keep
 * working without renames. Returns whatever is configured; the platform
 * publishers throw a brand-specific error when their part is missing.
 */
export function resolveBrandConfig(brand: PublishBrand): PublishConfig {
  const suffix = BRAND_ENV_SUFFIX[brand];
  const version = process.env.META_GRAPH_API_VERSION || "v20.0";
  const brandToken = process.env[`PUBLISH_${suffix}_ACCESS_TOKEN`];
  const brandIg = process.env[`PUBLISH_${suffix}_IG_ACCOUNT_ID`];
  const brandPage = process.env[`PUBLISH_${suffix}_FB_PAGE_ID`];
  const legacy =
    brand === "creapolis"
      ? legacyEnvConfig()
      : { pageId: undefined, pageAccessToken: undefined, instagramAccountId: undefined };
  return {
    version,
    pageAccessToken: brandToken ?? legacy.pageAccessToken,
    instagramAccountId: brandIg ?? legacy.instagramAccountId,
    pageId: brandPage ?? legacy.pageId,
  };
}

const brandMissingMessage = (brand: PublishBrand) => {
  const suffix = BRAND_ENV_SUFFIX[brand];
  return `Faltan credenciales de publicación para la marca "${brand}". Configura PUBLISH_${suffix}_ACCESS_TOKEN y PUBLISH_${suffix}_IG_ACCOUNT_ID (ver docs/OPERATIONS_RUNBOOK.md, sección Publicación por marca).`;
};

const withHashtags = (content: PublishContent["caption"], hashtags?: string[]) =>
  [
    content,
    hashtags && hashtags.length > 0
      ? "\n\n" + hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
      : "",
  ]
    .join("")
    .trim();

/** POST with params form-encoded in the body (long captions break URL length). */
async function graphPost(endpoint: string, params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return { res, data: (await res.json()) as Record<string, unknown> };
}

async function graphError(data: Record<string, unknown>, res: { ok: boolean; status: number }, what: string): Promise<never> {
  const err = data.error as { message?: string } | undefined;
  throw new Error(`${what}: ${err?.message || `HTTP ${res.status}`}`);
}

export async function publishToFacebook(content: PublishContent, config?: PublishConfig): Promise<PublishResult> {
  const cfg = config ?? legacyEnvConfig();
  const { version, pageId, pageAccessToken } = cfg;

  if (!pageId || !pageAccessToken) {
    throw new Error(
      "Meta Facebook credentials missing. Please set META_FACEBOOK_PAGE_ID and META_PAGE_ACCESS_TOKEN."
    );
  }

  if (process.env.PUBLISH_DRY_RUN === "true") {
    console.warn("[MetaGraph] PUBLISH_DRY_RUN: skipping Facebook publish for", content.caption.slice(0, 40));
    return {
      success: true,
      externalPostId: `dryrun_fb_${Date.now()}`,
      externalPostUrl: "https://facebook.com/dryrun",
      platform: "facebook",
    };
  }

  const message = withHashtags(content.caption, content.hashtags);

  // If we have an image
  if (content.imageUrl) {
    const isBase64 = content.imageUrl.startsWith("data:image/");
    const endpoint = `https://graph.facebook.com/${version}/${pageId}/photos`;

    const formData = new FormData();
    formData.append("access_token", pageAccessToken);
    formData.append("message", message);

    if (isBase64) {
      // Extract binary data from base64 data URI
      const commaIdx = content.imageUrl.indexOf(",");
      const mimeMatch = content.imageUrl.match(/data:([^;]+);base64/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/webp";
      const base64Data = content.imageUrl.slice(commaIdx + 1);
      const binaryBuf = Buffer.from(base64Data, "base64");
      const blob = new Blob([binaryBuf], { type: mimeType });
      formData.append("source", blob, "creapolis_post.webp");
    } else {
      formData.append("url", content.imageUrl);
    }

    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });

    const data = (await res.json()) as { id?: string; post_id?: string; error?: { message: string } };

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || `Facebook API error HTTP ${res.status}`;
      throw new Error(`Facebook photo publish failed: ${errMsg}`);
    }

    const postId = data.post_id || data.id || "";
    return {
      success: true,
      externalPostId: postId,
      externalPostUrl: `https://facebook.com/${postId}`,
      platform: "facebook",
    };
  }

  // Text-only feed post
  const endpoint = `https://graph.facebook.com/${version}/${pageId}/feed`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      access_token: pageAccessToken,
    }),
  });

  const data = (await res.json()) as { id?: string; error?: { message: string } };
  if (!res.ok || data.error) {
    const errMsg = data.error?.message || `Facebook API error HTTP ${res.status}`;
    throw new Error(`Facebook feed publish failed: ${errMsg}`);
  }

  return {
    success: true,
    externalPostId: data.id || "",
    externalPostUrl: `https://facebook.com/${data.id}`,
    platform: "facebook",
  };
}

export async function publishToInstagram(content: PublishContent, config?: PublishConfig): Promise<PublishResult> {
  const cfg = config ?? legacyEnvConfig();
  const { version, pageAccessToken, instagramAccountId } = cfg;

  if (!instagramAccountId || !pageAccessToken) {
    throw new Error(
      "Instagram Account ID missing. Link your Instagram Professional account to the Facebook Page and set META_INSTAGRAM_ACCOUNT_ID."
    );
  }

  if (!content.imageUrl || content.imageUrl.startsWith("data:")) {
    throw new Error(
      "Instagram Content Publishing requires a publicly accessible HTTPS image URL. Direct base64 uploads are only supported on Facebook."
    );
  }

  const caption = withHashtags(content.caption, content.hashtags);

  // Step 1: Create media container
  const { res: containerRes, data: containerData } = await graphPost(
    `https://graph.facebook.com/${version}/${instagramAccountId}/media`,
    { image_url: content.imageUrl, caption, access_token: pageAccessToken }
  );
  if (!containerRes.ok || containerData.error || typeof containerData.id !== "string") {
    await graphError(containerData, containerRes, "Instagram container creation failed");
  }
  const containerId = containerData.id as string;

  // Step 2: Publish media container
  const { res: publishRes, data: publishData } = await graphPost(
    `https://graph.facebook.com/${version}/${instagramAccountId}/media_publish`,
    { creation_id: containerId, access_token: pageAccessToken }
  );
  if (!publishRes.ok || publishData.error || typeof publishData.id !== "string") {
    await graphError(publishData, publishRes, "Instagram media publish failed");
  }

  return {
    success: true,
    externalPostId: publishData.id as string,
    externalPostUrl: `https://instagram.com/p/${publishData.id}`,
    platform: "instagram",
  };
}

/* ------------------------------------------------------------------ */
/* Instagram pack publishing (single image + carousel, per brand)      */
/* ------------------------------------------------------------------ */

/** Waits until a container finishes processing (Meta processes async). */
async function waitForContainer(
  version: string,
  containerId: string,
  accessToken: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = `https://graph.facebook.com/${version}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = (await res.json()) as { status_code?: string; error?: { message: string } };
    if (!res.ok || data.error) {
      throw new Error(`Instagram container status check failed: ${data.error?.message ?? `HTTP ${res.status}`}`);
    }
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Instagram container ${data.status_code.toLowerCase()} before publish`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Instagram container did not finish processing in time");
}

/**
 * Publishes one image or a carousel (2–10 images) to the brand's Instagram
 * account. `imageUrls` must be publicly accessible HTTPS URLs (the pack's
 * public slide URLs). Single-image packs reuse the plain container flow.
 */
export async function publishInstagramMedia(args: {
  brand: PublishBrand;
  imageUrls: string[];
  caption: string;
  hashtags?: string[];
}): Promise<PublishResult> {
  const cfg = resolveBrandConfig(args.brand);
  const { version, pageAccessToken, instagramAccountId } = cfg;

  if (process.env.PUBLISH_DRY_RUN === "true") {
    console.warn(
      `[MetaGraph] PUBLISH_DRY_RUN: skipping Instagram ${args.imageUrls.length > 1 ? "carousel" : "image"} publish (${args.brand})`
    );
    return {
      success: true,
      externalPostId: `dryrun_ig_${Date.now()}`,
      externalPostUrl: "https://instagram.com/p/dryrun",
      platform: "instagram",
    };
  }

  if (!instagramAccountId || !pageAccessToken) {
    throw new Error(brandMissingMessage(args.brand));
  }
  if (args.imageUrls.length < 1) {
    throw new Error("Instagram publish needs at least 1 image URL");
  }
  if (args.imageUrls.length > 10) {
    throw new Error("Instagram carousels support at most 10 images");
  }

  const caption = withHashtags(args.caption, args.hashtags);

  // Single image: plain container + publish.
  if (args.imageUrls.length === 1) {
    const { res, data } = await graphPost(
      `https://graph.facebook.com/${version}/${instagramAccountId}/media`,
      { image_url: args.imageUrls[0]!, caption, access_token: pageAccessToken }
    );
    if (!res.ok || data.error || typeof data.id !== "string") {
      await graphError(data, res, "Instagram container creation failed");
    }
    await waitForContainer(version, data.id as string, pageAccessToken);
    const { res: pubRes, data: pubData } = await graphPost(
      `https://graph.facebook.com/${version}/${instagramAccountId}/media_publish`,
      { creation_id: data.id as string, access_token: pageAccessToken }
    );
    if (!pubRes.ok || pubData.error || typeof pubData.id !== "string") {
      await graphError(pubData, pubRes, "Instagram media publish failed");
    }
    return {
      success: true,
      externalPostId: pubData.id as string,
      externalPostUrl: `https://instagram.com/p/${pubData.id}`,
      platform: "instagram",
    };
  }

  // Carousel: child containers → carousel container → publish.
  const children: string[] = [];
  for (const imageUrl of args.imageUrls) {
    const { res, data } = await graphPost(
      `https://graph.facebook.com/${version}/${instagramAccountId}/media`,
      { image_url: imageUrl, is_carousel_item: "true", access_token: pageAccessToken }
    );
    if (!res.ok || data.error || typeof data.id !== "string") {
      await graphError(data, res, "Instagram carousel child creation failed");
    }
    children.push(data.id as string);
  }

  const { res: carRes, data: carData } = await graphPost(
    `https://graph.facebook.com/${version}/${instagramAccountId}/media`,
    {
      media_type: "CAROUSEL",
      caption,
      children: children.join(","),
      access_token: pageAccessToken,
    }
  );
  if (!carRes.ok || carData.error || typeof carData.id !== "string") {
    await graphError(carData, carRes, "Instagram carousel container creation failed");
  }
  await waitForContainer(version, carData.id as string, pageAccessToken);

  const { res: pubRes, data: pubData } = await graphPost(
    `https://graph.facebook.com/${version}/${instagramAccountId}/media_publish`,
    { creation_id: carData.id as string, access_token: pageAccessToken }
  );
  if (!pubRes.ok || pubData.error || typeof pubData.id !== "string") {
    await graphError(pubData, pubRes, "Instagram carousel publish failed");
  }
  return {
    success: true,
    externalPostId: pubData.id as string,
    externalPostUrl: `https://instagram.com/p/${pubData.id}`,
    platform: "instagram",
  };
}
