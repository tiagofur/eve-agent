import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmGetProductDoc, crmListProductDocs, crmSearchProductDocs } from "../lib/crm";
import { requireStaff } from "../lib/guard";

/**
 * Grounding rule for marketing/content work: claims about Creapolis products
 * or services must come from docs/products/ (served by the CRM). This tool is
 * the only sanctioned way to read that catalog.
 */
export default defineTool({
  description:
    "Search and read the canonical Creapolis product/service documentation (docs/products). Use before creating any marketing content, estimate, or client-facing claim about what Creapolis offers, so content is grounded in documented features instead of invented ones.",
  inputSchema: z.object({
    action: z
      .enum(["search", "list", "read"])
      .describe("'search' finds docs by terms, 'list' returns the catalog index, 'read' returns one full doc"),
    query: z
      .string()
      .min(3)
      .max(200)
      .optional()
      .describe("Search terms (required for action=search), e.g. 'agente ia soporte'"),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe("Doc slug (required for action=read), e.g. 'servicio-agentes-ia'"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "search_product_docs");

    if (input.action === "search") {
      if (!input.query) {
        return { status: "error", error: "action=search requires 'query'" };
      }
      try {
        const { results } = await crmSearchProductDocs(input.query);
        if (results.length === 0) {
          return {
            status: "no_results",
            hint: "Nothing matched. Try 'list' to see the catalog and broader terms.",
          };
        }
        return {
          status: "ok",
          results: results.map((r) => ({
            slug: r.slug,
            nombre: r.nombre ?? r.slug,
            relevancia: r.score,
            extractos: r.excerpts,
          })),
          hint: "Call again with action=read and a slug for the full doc before writing content about it.",
        };
      } catch (err) {
        return { status: "error", error: err instanceof Error ? err.message : "Search failed" };
      }
    }

    if (input.action === "list") {
      try {
        const { products, docsAvailable } = await crmListProductDocs();
        return {
          status: docsAvailable ? "ok" : "empty",
          products: products.map((p) => ({
            slug: p.slug,
            nombre: p.nombre ?? p.slug,
            tipo: p.tipo ?? "?",
            resumen: p.resumen ?? "",
          })),
          note: docsAvailable
            ? "Docs with tipo 'pendiente' must not be used for marketing content."
            : "docs/products is not available on the CRM (check deployment).",
        };
      } catch (err) {
        return { status: "error", error: err instanceof Error ? err.message : "List failed" };
      }
    }

    // action === "read"
    if (!input.slug) {
      return { status: "error", error: "action=read requires 'slug'" };
    }
    try {
      const { meta, markdown } = await crmGetProductDoc(input.slug);
      return { status: "ok", meta, markdown };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : "Read failed" };
    }
  },
});
