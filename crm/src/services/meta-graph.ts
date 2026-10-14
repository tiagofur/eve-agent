/**
 * Meta Graph API Service for Creapolis Social Publishing
 * Supports Facebook Page Posts & Instagram Business Media Publishing
 */

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

function getEnvConfig() {
  const version = process.env.META_GRAPH_API_VERSION || "v20.0";
  const pageId = process.env.META_FACEBOOK_PAGE_ID;
  const pageAccessToken = process.env.META_PAGE_ACCESS_TOKEN;
  const instagramAccountId = process.env.META_INSTAGRAM_ACCOUNT_ID;

  return {
    version,
    pageId,
    pageAccessToken,
    instagramAccountId,
  };
}

export async function publishToFacebook(content: PublishContent): Promise<PublishResult> {
  const { version, pageId, pageAccessToken } = getEnvConfig();

  if (!pageId || !pageAccessToken) {
    throw new Error(
      "Meta Facebook credentials missing. Please set META_FACEBOOK_PAGE_ID and META_PAGE_ACCESS_TOKEN."
    );
  }

  const message = [
    content.caption,
    content.hashtags && content.hashtags.length > 0
      ? "\n\n" + content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
      : "",
  ]
    .join("")
    .trim();

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

export async function publishToInstagram(content: PublishContent): Promise<PublishResult> {
  const { version, pageAccessToken, instagramAccountId } = getEnvConfig();

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

  const caption = [
    content.caption,
    content.hashtags && content.hashtags.length > 0
      ? "\n\n" + content.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
      : "",
  ]
    .join("")
    .trim();

  // Step 1: Create media container
  const containerUrl = new URL(`https://graph.facebook.com/${version}/${instagramAccountId}/media`);
  containerUrl.searchParams.set("image_url", content.imageUrl);
  containerUrl.searchParams.set("caption", caption);
  containerUrl.searchParams.set("access_token", pageAccessToken);

  const containerRes = await fetch(containerUrl.toString(), { method: "POST" });
  const containerData = (await containerRes.json()) as { id?: string; error?: { message: string } };

  if (!containerRes.ok || containerData.error || !containerData.id) {
    const errMsg = containerData.error?.message || `Instagram container creation failed HTTP ${containerRes.status}`;
    throw new Error(errMsg);
  }

  const containerId = containerData.id;

  // Step 2: Publish media container
  const publishUrl = new URL(`https://graph.facebook.com/${version}/${instagramAccountId}/media_publish`);
  publishUrl.searchParams.set("creation_id", containerId);
  publishUrl.searchParams.set("access_token", pageAccessToken);

  const publishRes = await fetch(publishUrl.toString(), { method: "POST" });
  const publishData = (await publishRes.json()) as { id?: string; error?: { message: string } };

  if (!publishRes.ok || publishData.error || !publishData.id) {
    const errMsg = publishData.error?.message || `Instagram media publish failed HTTP ${publishRes.status}`;
    throw new Error(errMsg);
  }

  return {
    success: true,
    externalPostId: publishData.id,
    externalPostUrl: `https://instagram.com/p/${publishData.id}`,
    platform: "instagram",
  };
}
