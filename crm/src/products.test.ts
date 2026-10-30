import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys } from "./db/schema";
import { inArray } from "drizzle-orm";

describe("Docs de productos servidas por la API", () => {
  const opsKey = "cp_ops_productstestkey1234567890abc";
  const authOps = { Authorization: `Bearer ${opsKey}` };

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Products Ops", scope: "ops", keyHash: hashApiKey(opsKey) }]);
  });

  afterAll(async () => {
    await db.delete(apiKeys).where(inArray(apiKeys.keyHash, [hashApiKey(opsKey)]));
    await pool.end();
  });

  it("rechaza sin key", async () => {
    const res = await app.request("/api/products");
    expect(res.status).toBe(401);
  });

  it("lista las fichas de docs/products", async () => {
    const res = await app.request("/api/products", { headers: authOps });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      products: Array<{ slug: string; nombre?: string; tipo?: string; resumen?: string }>;
      docsAvailable: boolean;
    };
    expect(body.docsAvailable).toBe(true);
    const slugs = body.products.map((p) => p.slug);
    expect(slugs).toContain("creapolis-crm");
    expect(slugs).toContain("servicio-agentes-ia");
    const crm = body.products.find((p) => p.slug === "creapolis-crm");
    expect(crm?.nombre).toBe("Creapolis CRM");
    expect(crm?.resumen).toBeTruthy();
  });

  it("busca por términos y devuelve excerpts con contexto", async () => {
    const res = await app.request("/api/products/search?q=crm%20agente%20aprobaci%C3%B3n", { headers: authOps });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ slug: string; score: number; excerpts: string[] }> };
    const top = body.results[0];
    expect(body.results.length).toBeGreaterThan(0);
    expect(top?.excerpts.length).toBeGreaterThan(0);
    expect(top?.score).toBeGreaterThan(0);
  });

  it("query corta devuelve 400 y slug inválido 404", async () => {
    expect((await app.request("/api/products/search?q=ia", { headers: authOps })).status).toBe(400);
    expect((await app.request("/api/products/no-existe-esto", { headers: authOps })).status).toBe(404);
  });

  it("devuelve el markdown completo de una ficha", async () => {
    const res = await app.request("/api/products/pepinillo", { headers: authOps });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toContain("Pepinillo");
    expect(body.markdown).toContain("## Ángulos de marketing");
  });
});
