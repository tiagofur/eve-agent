import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { apiKeys, brandVisualConfigs } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";

/**
 * Per-brand visual profile: the three brands come seeded in editorial mode,
 * the owner can flip one to hybrid, and every write is validated (mode enum,
 * word-cap bounds, unknown brand → 404).
 */
describe("Visual configs API", () => {
  const opsKey = "cp_ops_visualkey1234567890abcdef";
  const frontKey = "cp_front_visualkey1234567890abcd";
  const opsHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Visual Test Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Visual Test Front", scope: "front", keyHash: hashApiKey(frontKey) },
    ]);
  });

  afterAll(async () => {
    await db.delete(brandVisualConfigs).where(eq(brandVisualConfigs.brand, "creapolis"));
    await db.delete(apiKeys).where(like(apiKeys.name, "Visual Test %"));
    await pool.end();
  });

  it("requires auth and rejects non-ops keys", async () => {
    const noKey = await app.request("/api/visual-configs");
    expect(noKey.status).toBe(401);
    const front = await app.request("/api/visual-configs", {
      headers: { Authorization: `Bearer ${frontKey}` },
    });
    expect(front.status).toBe(403);
  });

  it("lists the three brands with editorial defaults", async () => {
    const res = await app.request("/api/visual-configs", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configs: Array<{ brand: string; mode: string; configured: boolean; coverTitleMaxWords: number }>;
    };
    expect(body.configs.map((cfg) => cfg.brand)).toEqual(["creapolis", "pepinillo", "solennix"]);
    for (const cfg of body.configs) {
      expect(cfg.mode).toBe("editorial");
      expect(cfg.coverTitleMaxWords).toBe(8);
    }
  });

  it("PUT flips a brand to hybrid and the change persists", async () => {
    const res = await app.request("/api/visual-configs/creapolis", {
      method: "PUT",
      headers: opsHeaders,
      body: JSON.stringify({
        mode: "hybrid",
        artDirection: "escenas 3D minimalistas, fondo oscuro, sin texto en la imagen",
        coverTitleMaxWords: 6,
        showLogo: true,
        imageModel: "gemini-nano-banana-2.1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { mode: string; coverTitleMaxWords: number } };
    expect(body.config.mode).toBe("hybrid");
    expect(body.config.coverTitleMaxWords).toBe(6);

    const list = await app.request("/api/visual-configs", { headers: opsHeaders });
    const configs = (await list.json()) as { configs: Array<{ brand: string; mode: string; configured: boolean }> };
    const creapolis = configs.configs.find((cfg) => cfg.brand === "creapolis");
    expect(creapolis?.mode).toBe("hybrid");
    expect(creapolis?.configured).toBe(true);
    // The other two brands stay editorial.
    expect(configs.configs.find((cfg) => cfg.brand === "pepinillo")?.mode).toBe("editorial");
  });

  it("rejects an unknown brand, an invalid mode and an out-of-range word cap", async () => {
    const badBrand = await app.request("/api/visual-configs/devdeck", {
      method: "PUT",
      headers: opsHeaders,
      body: JSON.stringify({ mode: "hybrid" }),
    });
    expect(badBrand.status).toBe(404);

    const badMode = await app.request("/api/visual-configs/creapolis", {
      method: "PUT",
      headers: opsHeaders,
      body: JSON.stringify({ mode: "cinematic" }),
    });
    expect(badMode.status).toBe(400);

    const badCap = await app.request("/api/visual-configs/creapolis", {
      method: "PUT",
      headers: opsHeaders,
      body: JSON.stringify({ mode: "editorial", coverTitleMaxWords: 40 }),
    });
    expect(badCap.status).toBe(400);
  });
});
