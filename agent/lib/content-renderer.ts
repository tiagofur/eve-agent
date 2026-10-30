/**
 * Branded slide renderer: satori (JSX-like objects → SVG) + resvg (SVG → PNG).
 * 1080x1350 portrait, dark zinc + cyan/emerald Creapolis brand. Deterministic:
 * text is layout, never AI-generated pixels, so Spanish copy is always crisp.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

const C = {
  bg: "#09090b",
  panel: "#141417",
  panelBorder: "#27272a",
  text: "#fafafa",
  muted: "#a1a1aa",
  faint: "#52525b",
  cyan: "#22d3ee",
  emerald: "#10b981",
  amber: "#f59e0b",
  red: "#f87171",
} as const;

export type SlideVariant = "cover" | "news" | "problema_solucion" | "lista" | "cta";

export interface SlideSpec {
  variant: SlideVariant;
  kicker?: string;
  title: string;
  subtitle?: string;
  bullets?: string[];
  blocks?: Array<{ heading: string; body: string }>;
  takeaway?: string;
  cta?: string;
}

export interface PackRenderSpec {
  topic: string;
  slides: SlideSpec[];
}

export const MAX_SLIDES = 10;

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

interface FontEntry {
  name: string;
  data: Buffer;
  weight: 400 | 700 | 900;
}

let fontsCache: FontEntry[] | null = null;

function resolveFontsDir(): string {
  const candidates = [
    ...(process.env.FONTS_DIR ? [process.env.FONTS_DIR] : []),
    "/app/agent/assets/fonts",
    path.resolve(process.cwd(), "agent/assets/fonts"),
    path.resolve(process.cwd(), "assets/fonts"),
  ];
  for (const candidate of candidates) {
    // Presence of the regular weight is enough to trust the directory.
    if (existsSync(path.join(candidate, "Inter-Regular.ttf"))) return candidate;
  }
  throw new Error(
    `Fonts directory not found (set FONTS_DIR; looked in: ${candidates.join(", ")})`
  );
}

async function loadFonts(): Promise<FontEntry[]> {
  if (fontsCache) return fontsCache;
  const dir = resolveFontsDir();
  const [regular, bold, black] = await Promise.all([
    readFile(path.join(dir, "Inter-Regular.ttf")),
    readFile(path.join(dir, "Inter-Bold.ttf")),
    readFile(path.join(dir, "Inter-Black.ttf")),
  ]);
  fontsCache = [
    { name: "Inter", data: regular, weight: 400 },
    { name: "Inter", data: bold, weight: 700 },
    { name: "Inter", data: black, weight: 900 },
  ];
  return fontsCache;
}

/* ------------------------------------------------------------------ */
/* Element helpers (satori object format)                              */
/* ------------------------------------------------------------------ */

type Style = Record<string, string | number>;
type El = { type: string; props: { style?: Style; children?: El | El[] | string | (El | string)[] } };

const el = (type: string, style?: Style, children?: El | El[] | string | (El | string)[]): El => ({
  type,
  props: { ...(style ? { style } : {}), ...(children !== undefined ? { children } : {}) },
});

const text = (content: string, style?: Style): El => el("div", style, content);

/* ------------------------------------------------------------------ */
/* Slide layouts                                                       */
/* ------------------------------------------------------------------ */

function slideFrame(inner: El, pageIndex: number, pageCount: number): El {
  return el(
    "div",
    {
      width: `${SLIDE_WIDTH}px`,
      height: `${SLIDE_HEIGHT}px`,
      boxSizing: "border-box", // satori defaults to content-box: padding would overflow the canvas
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      backgroundColor: C.bg,
      padding: "72px 64px 56px",
    },
    [
      inner,
      el(
        "div",
        { display: "flex", justifyContent: "space-between", alignItems: "center" },
        [
          el("div", { display: "flex", alignItems: "center", gap: "14px" }, [
            el("div", {
              width: "14px",
              height: "14px",
              borderRadius: "4px",
              background: `linear-gradient(135deg, ${C.emerald}, ${C.cyan})`,
            }),
            text("Creapolis.Dev", { fontSize: "26px", fontWeight: 700, color: C.muted, letterSpacing: "1px" }),
          ]),
          text(`${pageIndex} / ${pageCount}`, { fontSize: "26px", fontWeight: 700, color: C.faint }),
        ]
      ),
    ]
  );
}

const kicker = (label: string, color: string): El =>
  text(label.toUpperCase(), {
    fontSize: "28px",
    fontWeight: 700,
    color,
    letterSpacing: "4px",
    marginBottom: "28px",
  });

const bullets = (items: string[]): El[] =>
  items.slice(0, 5).map((b, i) =>
    el(
      "div",
      {
        display: "flex",
        gap: "20px",
        alignItems: "flex-start",
        backgroundColor: C.panel,
        border: `1px solid ${C.panelBorder}`,
        borderRadius: "20px",
        padding: "26px 30px",
        marginBottom: "18px",
      },
      [
        text(`${i + 1}`, {
          fontSize: "34px",
          fontWeight: 900,
          color: C.cyan,
          marginRight: "4px",
        }),
        text(b, { fontSize: "34px", fontWeight: 400, color: C.text, lineHeight: 1.4, flexGrow: 1 }),
      ]
    )
  );

function slideBody(spec: SlideSpec): El {
  switch (spec.variant) {
    case "cover":
      return el("div", { display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1 }, [
        spec.kicker ? kicker(spec.kicker, C.cyan) : null,
        text(spec.title, { fontSize: "88px", fontWeight: 900, color: C.text, lineHeight: 1.08 }),
        spec.subtitle
          ? text(spec.subtitle, { fontSize: "40px", fontWeight: 400, color: C.muted, lineHeight: 1.4, marginTop: "36px" })
          : null,
      ].filter(Boolean) as El[]);

    case "news":
      return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        kicker(spec.kicker ?? "IA hoy", C.amber),
        text(spec.title, { fontSize: "64px", fontWeight: 900, color: C.text, lineHeight: 1.12 }),
        ...(spec.bullets?.length
          ? [el("div", { display: "flex", flexDirection: "column", marginTop: "44px" }, bullets(spec.bullets))]
          : []),
        ...(spec.takeaway
          ? [
              el(
                "div",
                {
                  marginTop: "auto",
                  backgroundColor: "rgba(34,211,238,0.08)",
                  border: `1px solid rgba(34,211,238,0.35)`,
                  borderRadius: "20px",
                  padding: "28px 32px",
                },
                [text(spec.takeaway, { fontSize: "32px", fontWeight: 700, color: C.cyan, lineHeight: 1.35 })]
              ),
            ]
          : []),
      ]);

    case "problema_solucion": {
      const [problema, solucion] = spec.blocks ?? [];
      const block = (heading: string, body: string, color: string, border: string): El =>
        el(
          "div",
          {
            display: "flex",
            flexDirection: "column",
            backgroundColor: C.panel,
            border: `1px solid ${border}`,
            borderRadius: "24px",
            padding: "40px",
            marginBottom: "26px",
            flexGrow: 1,
          },
          [
            text(heading.toUpperCase(), { fontSize: "28px", fontWeight: 700, color, letterSpacing: "3px", marginBottom: "18px" }),
            text(body, { fontSize: "38px", fontWeight: 400, color: C.text, lineHeight: 1.4 }),
          ]
        );
      return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        kicker(spec.kicker ?? "Problema → Solución", C.emerald),
        text(spec.title, { fontSize: "54px", fontWeight: 900, color: C.text, lineHeight: 1.15, marginBottom: "40px" }),
        problema ? block("Problema", problema.body, C.red, "rgba(248,113,113,0.35)") : null,
        solucion ? block("Solución — Creapolis", solucion.body, C.emerald, "rgba(16,185,129,0.35)") : null,
      ].filter(Boolean) as El[]);
    }

    case "lista":
      return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        kicker(spec.kicker ?? "Para tu operación", C.cyan),
        text(spec.title, { fontSize: "60px", fontWeight: 900, color: C.text, lineHeight: 1.12, marginBottom: "44px" }),
        el("div", { display: "flex", flexDirection: "column" }, bullets(spec.bullets ?? [])),
        ...(spec.takeaway ? [text(spec.takeaway, { fontSize: "30px", fontWeight: 700, color: C.emerald, marginTop: "auto", lineHeight: 1.35 })] : []),
      ]);

    case "cta": {
      const kids: El[] = [
        kicker(spec.kicker ?? "Creapolis.Dev", C.emerald),
        text(spec.title, { fontSize: "76px", fontWeight: 900, color: C.text, lineHeight: 1.1 }),
      ];
      if (spec.subtitle) {
        kids.push(text(spec.subtitle, { fontSize: "38px", fontWeight: 400, color: C.muted, lineHeight: 1.45, marginTop: "36px" }));
      }
      if (spec.cta) {
        kids.push(
          el(
            "div",
            {
              marginTop: "56px",
              backgroundColor: `linear-gradient(135deg, ${C.emerald}, ${C.cyan})`,
              borderRadius: "999px",
              padding: "30px 48px",
              display: "flex",
              justifyContent: "center",
            },
            [text(spec.cta, { fontSize: "36px", fontWeight: 900, color: "#052e2b", letterSpacing: "0.5px" })]
          )
        );
      }
      return el("div", { display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1 }, kids);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function renderSlidePng(spec: SlideSpec, pageIndex: number, pageCount: number): Promise<Buffer> {
  const fonts = await loadFonts();
  const svg = await satori(slideFrame(slideBody(spec), pageIndex, pageCount), {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    fonts,
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: SLIDE_WIDTH } });
  return Buffer.from(resvg.render().asPng());
}

export async function renderPackPngs(spec: PackRenderSpec): Promise<Buffer[]> {
  if (!spec.slides?.length) throw new Error("Pack needs at least 1 slide");
  if (spec.slides.length > MAX_SLIDES) throw new Error(`Pack exceeds ${MAX_SLIDES} slides`);
  const pngs: Buffer[] = [];
  for (let i = 0; i < spec.slides.length; i++) {
    const slide = spec.slides[i];
    if (!slide?.variant || !slide.title) {
      throw new Error(`Slide ${i + 1} invalid: needs variant and title`);
    }
    pngs.push(await renderSlidePng(slide, i + 1, spec.slides.length));
  }
  return pngs;
}
