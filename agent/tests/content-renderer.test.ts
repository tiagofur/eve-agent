import { describe, expect, it } from "vitest";
import {
  countWords,
  renderPackPngs,
  renderSlidePng,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type PackRenderSpec,
} from "../lib/content-renderer";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads the IHDR to assert real pixel dimensions of the rendered PNG. */
const pngDimensions = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

const carouselSpec: PackRenderSpec = {
  topic: "Test carousel",
  brand: "creapolis",
  slides: [
    { variant: "cover", kicker: "IA aplicada", title: "Portada de prueba", subtitle: "Subtítulo con acentos: páginas, solución" },
    {
      variant: "news",
      kicker: "IA hoy",
      title: "Titular de noticia razonablemente largo para probar el wrap",
      bullets: ["Primera viñeta de prueba.", "Segunda viñeta, un poco más larga para forzar dos líneas."],
      takeaway: "Conclusión destacada.",
    },
    {
      variant: "problema_solucion",
      title: "Problema → Solución",
      blocks: [
        { heading: "Problema", body: "Algo que duele y se puede medir." },
        { heading: "Solución — Creapolis", body: "Lo que hacemos por el cliente." },
      ],
    },
    { variant: "lista", title: "Lista", bullets: ["Uno", "Dos", "Tres"] },
    { variant: "cta", title: "CTA final", subtitle: "Invitación directa", cta: "Escríbenos → creapolis.dev" },
  ],
};

describe("content-renderer (posts de imagen y carrusel)", () => {
  it("renderiza una slide 1080x1350 PNG válida", async () => {
    const png = await renderSlidePng({ variant: "cover", kicker: "test", title: "Hola" }, 1, 5);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
    expect(png.length).toBeGreaterThan(10_000); // un canvas vacío comprimiría a ~2KB
  });

  it("renderiza las 5 variantes con contenido distinto por variante", async () => {
    const pngs = await renderPackPngs(carouselSpec);
    expect(pngs).toHaveLength(5);
    for (const png of pngs) {
      expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(pngDimensions(png).width).toBe(SLIDE_WIDTH);
    }
    // Cada variante produce bytes distintos (layouts diferentes)
    const sizes = pngs.map((p) => p.length);
    expect(new Set(sizes).size).toBeGreaterThan(2);
  });

  it("imprime texto español con acentos y emoji-free (no TTF tofu): slide CTA pesa más que portada vacía", async () => {
    const withText = await renderSlidePng({ variant: "cta", title: "Automatiza el 80%, firma el 20%" }, 1, 1);
    const minimal = await renderSlidePng({ variant: "cover", title: "." }, 1, 1);
    expect(withText.length).toBeGreaterThan(minimal.length);
  });

  it("cada marca produce una identidad visual distinta (paletas + footer)", async () => {
    const spec = { variant: "cover" as const, kicker: "marca", title: "Identidad de prueba" };
    const pngs = await Promise.all(
      (["creapolis", "pepinillo", "solennix"] as const).map((brand) => renderSlidePng(spec, 1, 1, brand))
    );
    for (const png of pngs) {
      expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    }
    // Distinct palettes/footer text → distinct bytes.
    expect(new Set(pngs.map((p) => p.length)).size).toBe(3);
    expect(new Set(pngs.map((p) => p.toString("hex"))).size).toBe(3);
  });

  it("marca desconocida cae al tema de creapolis", async () => {
    const spec = { variant: "cover" as const, title: "Fallback" };
    const fallback = await renderSlidePng(spec, 1, 1, "desconocida" as "creapolis");
    const creapolis = await renderSlidePng(spec, 1, 1, "creapolis");
    expect(fallback.equals(creapolis)).toBe(true);
  });

  it("rechaza packs vacíos, >10 slides y slides inválidas", async () => {
    await expect(renderPackPngs({ topic: "x", brand: "creapolis", slides: [] })).rejects.toThrow(/at least 1/);
    await expect(
      renderPackPngs({
        topic: "x",
        brand: "creapolis",
        slides: Array.from({ length: 11 }, () => ({ variant: "cover" as const, title: "t" })),
      })
    ).rejects.toThrow(/10 slides/);
    await expect(
      // @ts-expect-error provocar slide sin title
      renderPackPngs({ topic: "x", brand: "creapolis", slides: [{ variant: "cover" }] })
    ).rejects.toThrow(/invalid/);
  });

  it("countWords mide palabras reales (el cap de portada lo usa el tool)", () => {
    expect(countWords("El 80% de los equipos pierde tiempo")).toBe(7);
    expect(countWords("  hola   mundo  ")).toBe(2);
    expect(countWords("")).toBe(0);
  });

  it("la portada híbrida compone el arte IA (4:5 → 1080x1350) y difiere de la tipográfica", async () => {
    // 864x1080 solid-ish PNG built via resvg (no network in tests).
    const { Resvg } = await import("@resvg/resvg-js");
    const art = Buffer.from(
      new Resvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="864" height="1080"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#164e63"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs><rect width="864" height="1080" fill="url(#g)"/><circle cx="700" cy="260" r="140" fill="#22d3ee" opacity="0.7"/></svg>'
      ).render().asPng()
    );
    const typographic = await renderSlidePng(carouselSpec.slides[0]!, 1, 5);
    const hybrid = await renderSlidePng(carouselSpec.slides[0]!, 1, 5, "creapolis", { coverImage: art });
    expect(hybrid.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(pngDimensions(hybrid)).toEqual({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
    expect(hybrid.equals(typographic)).toBe(false);

    // image_only: sin texto de titular; aún PNG válido y distinto al híbrido.
    const imageOnly = await renderSlidePng(carouselSpec.slides[0]!, 1, 5, "creapolis", {
      coverImage: art,
      textOnCover: false,
    });
    expect(imageOnly.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(imageOnly.equals(hybrid)).toBe(false);

    // Solo el slide 1 lleva arte: renderPackPngs lo aplica y las interiores no.
    const pack = await renderPackPngs(carouselSpec, { coverImage: art, showLogo: true });
    expect(pack).toHaveLength(5);
    expect(pack[0]!.equals(typographic)).toBe(false);
  });
});
