import { Hono } from "hono";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { listDocs, readDoc, searchDocs } from "../../domain/products";

export const productsRouter = new Hono<{ Variables: AuthContextVariables }>();

// 1. List documented products/services
productsRouter.get("/", requireScope(["ops"]), async (c) => {
  const docs = await listDocs();
  return c.json({ products: docs, docsAvailable: docs.length > 0 });
});

// 2. Search across docs by terms (excerpt + heading context per match)
productsRouter.get("/search", requireScope(["ops"]), async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 3) {
    return c.json({ error: "Query too short (min 3 chars)" }, 400);
  }

  const results = await searchDocs(q);
  return c.json({
    query: q,
    results: results.map((r) => ({ slug: r.meta.slug, nombre: r.meta.nombre, score: r.score, excerpts: r.excerpts })),
  });
});

// 3. Full markdown for one product
productsRouter.get("/:slug", requireScope(["ops"]), async (c) => {
  const slug = c.req.param("slug") ?? "";
  const doc = await readDoc(slug);
  if (!doc) {
    return c.json({ error: `Unknown product doc '${slug}'` }, 404);
  }
  return c.json(doc);
});
