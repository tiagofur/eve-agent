import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Canonical product/service docs (docs/products/*.md) shared by the products
 * API, the marketing generation grounding, and the desktop. Resolution:
 * DOCS_PRODUCTS_DIR > /app/docs/products (Docker) > ./docs/products
 * > ../docs/products (dev, cwd=crm).
 */
export function resolveDocsDir(): string | null {
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

export interface ProductMeta {
  slug: string;
  nombre?: string;
  tipo?: string;
  resumen?: string;
  audiencia?: string;
  palabras_clave?: string;
}

export function parseFrontmatter(slug: string, markdown: string): ProductMeta {
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

export async function listDocs(): Promise<ProductMeta[]> {
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

export async function readDoc(slug: string): Promise<{ meta: ProductMeta; markdown: string } | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const dir = resolveDocsDir();
  if (!dir) return null;
  const filePath = path.join(dir, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const markdown = await readFile(filePath, "utf8");
  return { meta: parseFrontmatter(slug, markdown), markdown };
}

export interface ProductSearchResult {
  meta: ProductMeta;
  score: number;
  excerpts: string[];
}

// Search across docs by terms (excerpt + heading context per match).
export async function searchDocs(q: string): Promise<ProductSearchResult[]> {
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  const results: ProductSearchResult[] = [];
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
    if (score > 0) results.push({ meta: doc, score, excerpts });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

/**
 * Auto-detect the product doc that grounds a marketing topic. Docs marked
 * `tipo: pendiente` are off-limits for marketing content (docs/products/README).
 * Returns null when no doc matches — the caller proceeds ungrounded.
 */
export async function pickMarketingContext(
  topic: string
): Promise<{ slug: string; nombre?: string; markdown: string } | null> {
  const results = await searchDocs(topic);
  for (const result of results) {
    if (result.meta.tipo === "pendiente") continue;
    const doc = await readDoc(result.meta.slug);
    if (doc) return { slug: doc.meta.slug, nombre: doc.meta.nombre, markdown: doc.markdown };
  }
  return null;
}
