import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contentPacks, events } from "./db/schema";
import { eq, inArray } from "drizzle-orm";

process.env.CONTENT_DIR = path.join(os.tmpdir(), `content-packs-test-${Date.now()}`);

describe("Content packs (pipeline de contenido)", () => {
  const opsKey = "cp_ops_contentpacktestkey123456789";
  const ownerKey = "cp_owner_contentpacktestkey1234567";
  const authOps = { Authorization: `Bearer ${opsKey}` };
  const authOwner = { Authorization: `Bearer ${ownerKey}` };
  let packId = "";
  let packWithCoverId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Content Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Content Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
    ]);
  });

  afterAll(async () => {
    const ids = [packId, packWithCoverId].filter(Boolean);
    if (ids.length) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(contentPacks).where(inArray(contentPacks.id, ids));
    }
    await db.delete(apiKeys).where(inArray(apiKeys.keyHash, [hashApiKey(opsKey), hashApiKey(ownerKey)]));
    rmSync(process.env.CONTENT_DIR!, { recursive: true, force: true });
    await pool.end();
  });

  it("rechaza sin key", async () => {
    const res = await app.request("/api/content-packs");
    expect(res.status).toBe(401);
  });

  it("sube un pack (zip + meta) y queda pending_approval", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    const form = new FormData();
    form.append("file", new File([zipBytes], "pack.zip", { type: "application/zip" }));
    form.append(
      "meta",
      JSON.stringify({
        kind: "video",
        topic: "Cómo un agente opera nuestro CRM",
        hook: "El agente investiga, nosotros aprobamos",
        caption: "Caption de prueba para TikTok #ia",
        hashtags: ["ia", "agentes"],
        platforms: ["tiktok", "instagram", "youtube"],
        notes: "Pack de test",
        scheduledFor: "2026-10-31",
      })
    );

    const res = await app.request("/api/content-packs/upload", { method: "POST", headers: authOps, body: form });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pack: { id: string; status: string; hasCover: boolean; topic: string } };
    packId = body.pack.id;
    expect(body.pack.status).toBe("pending_approval");
    expect(body.pack.hasCover).toBe(false);

    // ZIP quedó en disco bajo CONTENT_DIR/<id>/pack.zip
    expect(existsSync(path.join(process.env.CONTENT_DIR!, packId, "pack.zip"))).toBe(true);
  });

  it("rechaza meta inválida", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "pack.zip", { type: "application/zip" }));
    form.append("meta", JSON.stringify({ kind: "noexiste", topic: "x", caption: "" }));
    const res = await app.request("/api/content-packs/upload", { method: "POST", headers: authOps, body: form });
    expect(res.status).toBe(400);
  });

  it("lista packs y acepta cover opcional", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x50, 0x4b, 0x01])], "pack.zip", { type: "application/zip" }));
    form.append("cover", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "cover.jpg", { type: "image/jpeg" }));
    form.append("meta", JSON.stringify({ kind: "carousel", topic: "5 automatizaciones para pymes", caption: "Carrusel" }));
    const res = await app.request("/api/content-packs/upload", { method: "POST", headers: authOps, body: form });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pack: { id: string } };
    packWithCoverId = body.pack.id;

    const listRes = await app.request("/api/content-packs?status=pending_approval", { headers: authOps });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { packs: Array<{ id: string; hasCover: boolean }> };
    const ids = list.packs.map((p) => p.id);
    expect(ids).toContain(packId);
    expect(ids).toContain(packWithCoverId);
    expect(list.packs.find((p) => p.id === packWithCoverId)?.hasCover).toBe(true);

    const coverRes = await app.request(`/api/content-packs/${packWithCoverId}/cover`, { headers: authOps });
    expect(coverRes.status).toBe(200);
    expect(coverRes.headers.get("content-type")).toBe("image/jpeg");

    const noCoverRes = await app.request(`/api/content-packs/${packId}/cover`, { headers: authOps });
    expect(noCoverRes.status).toBe(404);
  });

  it("review: ops no puede, owner aprueba, doble review falla", async () => {
    const opsRes = await app.request(`/api/content-packs/${packId}/review`, {
      method: "POST",
      headers: { ...authOps, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(opsRes.status).toBe(403);

    const okRes = await app.request(`/api/content-packs/${packId}/review`, {
      method: "POST",
      headers: { ...authOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(okRes.status).toBe(200);

    const twiceRes = await app.request(`/api/content-packs/${packId}/review`, {
      method: "POST",
      headers: { ...authOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected", rejectedReason: "cambio de opinión" }),
    });
    expect(twiceRes.status).toBe(400);
  });

  it("rechazar exige motivo", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x50])], "pack.zip", { type: "application/zip" }));
    form.append("meta", JSON.stringify({ kind: "image", topic: "Imagen de servicio", caption: "x" }));
    const res = await app.request("/api/content-packs/upload", { method: "POST", headers: authOps, body: form });
    const { pack } = (await res.json()) as { pack: { id: string } };

    const noReason = await app.request(`/api/content-packs/${pack.id}/review`, {
      method: "POST",
      headers: { ...authOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected" }),
    });
    expect(noReason.status).toBe(400);

    const withReason = await app.request(`/api/content-packs/${pack.id}/review`, {
      method: "POST",
      headers: { ...authOwner, "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "rejected", rejectedReason: "hook débil" }),
    });
    expect(withReason.status).toBe(200);

    await db.delete(events).where(eq(events.entityId, pack.id));
    await db.delete(contentPacks).where(eq(contentPacks.id, pack.id));
  });

  it("descarga el ZIP y marca downloadedAt", async () => {
    const res = await app.request(`/api/content-packs/${packId}/download`, { headers: authOwner });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain(".zip");

    const list = (await (await app.request("/api/content-packs", { headers: authOps })).json()) as {
      packs: Array<{ id: string; downloadedAt: string | null }>;
    };
    expect(list.packs.find((p) => p.id === packId)?.downloadedAt).not.toBeNull();
  });
});
