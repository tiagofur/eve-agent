import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { requireScope, type AuthContextVariables } from "../auth-middleware";

/**
 * Serves docs/products/*.md (the canonical product/service documentation)
 * over the API so the eve agent tools and the desktop read the same source.
 * Resolution: DOCS_PRODUCTS_DIR > /app/docs/products (Docker) > ./docs/products
 * > ../docs/products (dev, cwd=crm).
 */
function resolveDocsDir(): string | null {
  const candidates = [
    process.env.DOCS_PRODUCTS_DIR,
    "/app/docs/products",
    path.resolve(process.cwd(), "docs/products"),
    path.resolve(process.cwd(), "..", "docs", "products"),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface ProductMeta {
  slug: string;
  nombre?: string;
  tipo?: string;
  resumen?: string;
  audiencia?: string;
  palabras_clave?: string;
}

function parseFrontmatter(slug: string, markdown: string): ProductMeta {
  const meta: ProductMeta = { slug };
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return meta;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) {
      (meta as unknown as Record<string, string | undefined>)[match[1]] = match[2].trim();
    }
  }
  return meta;
}

async function listDocs(): Promise<ProductMeta[]> {
  const dir = resolveDocsDir();
  if (!dir) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const metas: ProductMeta[] = [];
  for (const file of files) {
    const markdown = await readFile(path.join(dir, file), "utf8");
    metas.push(parseFrontmatter(file.replace(/\.md$/, ""), markdown));
  }
  return metas;
}

async function readDoc(slug: string): Promise<{ meta: ProductMeta; markdown: string } | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const dir = resolveDocsDir();
  if (!dir) return null;
  const filePath = path.join(dir, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const markdown = await readFile(filePath, "utf8");
  return { meta: parseFrontmatter(slug, markdown), markdown };
}

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
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  const results: Array<{ slug: string; nombre?: string; score: number; excerpts: string[] }> = [];
  for (const doc of await listDocs()) {
    const full = await readDoc(doc.slug);
    if (!full) continue;
    const lines = full.markdown.split("\n");
    const lowerLines = lines.map((l) => l.toLowerCase());

    let score = 0;
    const excerpts: string[] = [];
    let heading = doc.nombre || doc.slug;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith("# ")) heading = line.slice(2).trim();
      const lowerLine = lowerLines[i] ?? "";
      const hits = terms.reduce((acc, t) => acc + (lowerLine.split(t).length - 1), 0);
      if (hits > 0 && !line.trim().startsWith("---")) {
        score += hits;
        const excerpt = `[${heading}] ${line.replace(/^#+\s*/, "").trim()}`.slice(0, 240);
        if (excerpts.length < 3 && !excerpts.includes(excerpt)) excerpts.push(excerpt);
      }
      // Frontmatter keywords weigh 3x: they are curated for discovery.
      if (i < 8) score += hits * 2;
    }
    if (score > 0) results.push({ slug: doc.slug, nombre: doc.nombre, score, excerpts });
  }

  results.sort((a, b) => b.score - a.score);
  return c.json({ query: q, results: results.slice(0, 5) });
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
