import { describe, expect, it } from "vitest";
import { renderPackPngs, renderSlidePng, SLIDE_HEIGHT, SLIDE_WIDTH, type PackRenderSpec } from "../lib/content-renderer";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Reads the IHDR to assert real pixel dimensions of the rendered PNG. */
const pngDimensions = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
});

const carouselSpec: PackRenderSpec = {
  topic: "Test carousel",
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

  it("rechaza packs vacíos, >10 slides y slides inválidas", async () => {
    await expect(renderPackPngs({ topic: "x", slides: [] })).rejects.toThrow(/at least 1/);
    await expect(
      renderPackPngs({ topic: "x", slides: Array.from({ length: 11 }, () => ({ variant: "cover" as const, title: "t" })) })
    ).rejects.toThrow(/10 slides/);
    await expect(
      // @ts-expect-error provocar slide sin title
      renderPackPngs({ topic: "x", slides: [{ variant: "cover" }] })
    ).rejects.toThrow(/invalid/);
  });
});
