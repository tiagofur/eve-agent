import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { zipSync } from "fflate";
import { pool, db } from "./db/client";
import { apiKeys, contentPacks } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";
import { contentDirAbsolute } from "./domain/content-packs";

// The pack notification phones Telegram on upload; dev-mode senders skip, but
// mocking keeps the test hermetic and quiet.
vi.mock("./services/telegram", async (importOriginal) => {
  const original = await importOriginal<typeof import("./services/telegram")>();
  return {
    ...original,
    sendTelegramMessage: vi.fn(async () => ({ ok: true })),
    sendTelegramPhoto: vi.fn(async () => ({ ok: true, result: { message_id: 1 } })),
  };
});

/** Minimal 1x1 PNG (real magic bytes: the extractor only matches names). */
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
]);

function packZip(slideCount: number): Buffer {
  const entries: Record<string, Uint8Array> = { "caption.txt": new TextEncoder().encode("caption") };
  for (let i = 1; i <= slideCount; i++) {
    entries[`slides/slide-${String(i).padStart(2, "0")}.png`] = new Uint8Array(TINY_PNG);
  }
  return Buffer.from(zipSync(entries));
}

async function uploadPack(brand: "pepinillo" | "solennix", slides = 2) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(packZip(slides))], { type: "application/zip" }), "pack.zip");
  form.append(
    "meta",
    JSON.stringify({
      kind: slides === 1 ? "image" : "carousel",
      brand,
      topic: `TEST Pack ${brand}`,
      caption: "Caption de prueba con gancho",
      hashtags: ["TEST"],
      platforms: ["instagram"],
    })
  );
  const res = await app.request("/api/content-packs/upload", { method: "POST", headers: opsHeaders, body: form });
  if (res.status !== 201) throw new Error(`upload failed: ${await res.text()}`);
  return (await res.json()) as {
    pack: { id: string; publicId: string; brand: string; status: string };
    slides: string[];
  };
}

const ownerKey = "cp_owner_packpub1234567890abcdef";
const opsKey = "cp_ops_packpub1234567890abcdef0";
const ownerHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` };
const opsHeaders = { Authorization: `Bearer ${opsKey}` };

/**
 * Multi-brand content packs: upload extracts slides (for the public URLs
 * Instagram downloads), the public slide route serves them by unguessable
 * publicId, and approve→publish lands the pack as published (dry-run).
 */
describe("Content packs: slides públicas y publish 1-click", () => {
  const createdIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "PackPub Test Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
      { name: "PackPub Test Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
    ]);
    process.env.PUBLISH_DRY_RUN = "true";
  });

  afterAll(async () => {
    delete process.env.PUBLISH_DRY_RUN;
    for (const id of createdIds) {
      await rm(path.join(contentDirAbsolute(), id), { recursive: true, force: true });
    }
    await db.delete(contentPacks).where(like(contentPacks.topic, "TEST Pack %"));
    await db.delete(apiKeys).where(like(apiKeys.name, "PackPub Test %"));
    await pool.end();
  });

  it("upload extrae las slides, guarda marca y publicId", async () => {
    const created = await uploadPack("pepinillo", 3);
    createdIds.push(created.pack.id);
    expect(created.pack.brand).toBe("pepinillo");
    expect(created.pack.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(created.slides).toHaveLength(3);
  });

  it("la ruta pública sirve slides por publicId y rechaza índices inválidos", async () => {
    const created = await uploadPack("solennix", 2);
    createdIds.push(created.pack.id);

    const ok = await app.request(`/api/public/content/${created.pack.publicId}/slides/1`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 8)).toEqual(TINY_PNG.subarray(0, 8));

    const outOfRange = await app.request(`/api/public/content/${created.pack.publicId}/slides/9`);
    expect(outOfRange.status).toBe(404);
    const traversal = await app.request(`/api/public/content/${created.pack.publicId}/slides/..%2Fpack`);
    expect(traversal.status).toBe(404);
    const badId = await app.request(`/api/public/content/nothex/slides/0`);
    expect(badId.status).toBe(404);
  });

  it("publish exige aprobación previa y luego publica (dry-run) con guard de doble publish", async () => {
    const created = await uploadPack("pepinillo", 2);
    createdIds.push(created.pack.id);
    const base = `/api/content-packs/${created.pack.id}`;

    const tooEarly = await app.request(`${base}/publish`, { method: "POST", headers: ownerHeaders });
    expect(tooEarly.status).toBe(400);
    expect(((await tooEarly.json()) as { error: string }).error).toContain("approve");

    const review = await app.request(`${base}/review`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(review.status).toBe(200);

    const publish = await app.request(`${base}/publish`, { method: "POST", headers: ownerHeaders });
    expect(publish.status).toBe(200);
    const body = (await publish.json()) as { pack: { status: string; externalPostUrl: string | null } };
    expect(body.pack.status).toBe("published");
    expect(body.pack.externalPostUrl).toContain("instagram.com");

    const again = await app.request(`${base}/publish`, { method: "POST", headers: ownerHeaders });
    expect(again.status).toBe(409);
  });

  it("review rechaza doble revisión (el botón de Telegram la tolera)", async () => {
    const created = await uploadPack("solennix", 1);
    createdIds.push(created.pack.id);
    const base = `/api/content-packs/${created.pack.id}`;
    const review = await app.request(`${base}/review`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(review.status).toBe(200);
    const twice = await app.request(`${base}/review`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(twice.status).toBe(400);
    expect(((await twice.json()) as { error: string }).error).toContain("already reviewed");
  });

  it("el listado incluye marca y estado published", async () => {
    const res = await app.request("/api/content-packs?status=published", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packs: Array<{ brand: string; status: string }> };
    expect(body.packs.length).toBeGreaterThan(0);
    expect(body.packs.every((p) => p.status === "published")).toBe(true);
    expect(body.packs.some((p) => p.brand === "pepinillo")).toBe(true);
  });

  it("packs de video no son auto-publicables", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(packZip(1))], { type: "application/zip" }), "pack.zip");
    form.append(
      "meta",
      JSON.stringify({ kind: "video", brand: "creapolis", topic: "TEST Pack video", caption: "x" })
    );
    const res = await app.request("/api/content-packs/upload", { method: "POST", headers: opsHeaders, body: form });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { pack: { id: string } };
    createdIds.push(created.pack.id);

    await app.request(`/api/content-packs/${created.pack.id}/review`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });
    const publish = await app.request(`/api/content-packs/${created.pack.id}/publish`, {
      method: "POST",
      headers: ownerHeaders,
    });
    expect(publish.status).toBe(400);
    expect(((await publish.json()) as { error: string }).error).toContain("Video packs");
  });
});
