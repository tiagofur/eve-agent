/**
 * Branded slide renderer: satori (JSX-like objects → SVG) + resvg (SVG → PNG).
 * 1080x1350 portrait, dark themes per brand (Creapolis / Pepinillo / Solennix).
 * Deterministic: text is layout, never AI-generated pixels, so Spanish copy is
 * always crisp.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

export type Brand = "creapolis" | "pepinillo" | "solennix";

export interface BrandTheme {
  /** Footer + default kicker label (e.g. "Creapolis.Dev"). */
  name: string;
  bg: string;
  panel: string;
  panelBorder: string;
  text: string;
  muted: string;
  faint: string;
  /** Primary accent (kickers, numbers, highlights). */
  accent: string;
  /** Secondary accent (gradients, positive blocks). */
  accent2: string;
  amber: string;
  red: string;
  /** Soft fills/borders derived from the accents (takeaway box, blocks). */
  accentSoftBg: string;
  accentSoftBorder: string;
  okSoftBorder: string;
  failSoftBorder: string;
  /** Dark text painted over the accent gradient CTA pill. */
  ctaText: string;
}

/**
 * One palette per brand, in one place. Dark bases keep the crisp-text rule;
 * accents carry the identity: cyan/emerald (Creapolis), lime/green
 * (Pepinillo), violet/indigo (Solennix).
 */
const BRANDS: Record<Brand, BrandTheme> = {
  creapolis: {
    name: "Creapolis.Dev",
    bg: "#09090b",
    panel: "#141417",
    panelBorder: "#27272a",
    text: "#fafafa",
    muted: "#a1a1aa",
    faint: "#52525b",
    accent: "#22d3ee",
    accent2: "#10b981",
    amber: "#f59e0b",
    red: "#f87171",
    accentSoftBg: "rgba(34,211,238,0.08)",
    accentSoftBorder: "rgba(34,211,238,0.35)",
    okSoftBorder: "rgba(16,185,129,0.35)",
    failSoftBorder: "rgba(248,113,113,0.35)",
    ctaText: "#052e2b",
  },
  pepinillo: {
    name: "Pepinillo",
    bg: "#07120c",
    panel: "#0f1f16",
    panelBorder: "#1e3a29",
    text: "#f0fdf4",
    muted: "#9fbfaa",
    faint: "#4d6b58",
    accent: "#a3e635",
    accent2: "#4ade80",
    amber: "#fbbf24",
    red: "#f87171",
    accentSoftBg: "rgba(163,230,53,0.08)",
    accentSoftBorder: "rgba(163,230,53,0.35)",
    okSoftBorder: "rgba(74,222,128,0.35)",
    failSoftBorder: "rgba(248,113,113,0.35)",
    ctaText: "#052e16",
  },
  solennix: {
    name: "Solennix",
    bg: "#0c0a14",
    panel: "#16121f",
    panelBorder: "#2a2340",
    text: "#f5f3ff",
    muted: "#b0a9cf",
    faint: "#5c5480",
    accent: "#a78bfa",
    accent2: "#818cf8",
    amber: "#fbbf24",
    red: "#f87171",
    accentSoftBg: "rgba(167,139,250,0.08)",
    accentSoftBorder: "rgba(167,139,250,0.35)",
    okSoftBorder: "rgba(129,140,248,0.35)",
    failSoftBorder: "rgba(248,113,113,0.35)",
    ctaText: "#1e1b4b",
  },
};

export const getBrandTheme = (brand: Brand): BrandTheme => BRANDS[brand] ?? BRANDS.creapolis;

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
  brand: Brand;
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

function slideFrame(inner: El, pageIndex: number, pageCount: number, theme: BrandTheme): El {
  return el(
    "div",
    {
      width: `${SLIDE_WIDTH}px`,
      height: `${SLIDE_HEIGHT}px`,
      boxSizing: "border-box", // satori defaults to content-box: padding would overflow the canvas
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      backgroundColor: theme.bg,
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
              background: `linear-gradient(135deg, ${theme.accent2}, ${theme.accent})`,
            }),
            text(theme.name, { fontSize: "26px", fontWeight: 700, color: theme.muted, letterSpacing: "1px" }),
          ]),
          text(`${pageIndex} / ${pageCount}`, { fontSize: "26px", fontWeight: 700, color: theme.faint }),
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

const bullets = (items: string[], theme: BrandTheme): El[] =>
  items.slice(0, 5).map((b, i) =>
    el(
      "div",
      {
        display: "flex",
        gap: "20px",
        alignItems: "flex-start",
        backgroundColor: theme.panel,
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: "20px",
        padding: "26px 30px",
        marginBottom: "18px",
      },
      [
        text(`${i + 1}`, {
          fontSize: "34px",
          fontWeight: 900,
          color: theme.accent,
          marginRight: "4px",
        }),
        text(b, { fontSize: "34px", fontWeight: 400, color: theme.text, lineHeight: 1.4, flexGrow: 1 }),
      ]
    )
  );

function slideBody(spec: SlideSpec, theme: BrandTheme): El {
  switch (spec.variant) {
    case "cover":
      return el("div", { display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1 }, [
        spec.kicker ? kicker(spec.kicker, theme.accent) : null,
        text(spec.title, { fontSize: "88px", fontWeight: 900, color: theme.text, lineHeight: 1.08 }),
        spec.subtitle
          ? text(spec.subtitle, { fontSize: "40px", fontWeight: 400, color: theme.muted, lineHeight: 1.4, marginTop: "36px" })
          : null,
      ].filter(Boolean) as El[]);

    case "news":
      return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        kicker(spec.kicker ?? "IA hoy", theme.amber),
        text(spec.title, { fontSize: "64px", fontWeight: 900, color: theme.text, lineHeight: 1.12 }),
        ...(spec.bullets?.length
          ? [el("div", { display: "flex", flexDirection: "column", marginTop: "44px" }, bullets(spec.bullets, theme))]
          : []),
        ...(spec.takeaway
          ? [
              el(
                "div",
                {
                  marginTop: "auto",
                  backgroundColor: theme.accentSoftBg,
                  border: `1px solid ${theme.accentSoftBorder}`,
                  borderRadius: "20px",
                  padding: "28px 32px",
                },
                [text(spec.takeaway, { fontSize: "32px", fontWeight: 700, color: theme.accent, lineHeight: 1.35 })]
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
            backgroundColor: theme.panel,
            border: `1px solid ${border}`,
            borderRadius: "24px",
            padding: "40px",
            marginBottom: "26px",
            flexGrow: 1,
          },
          [
            text(heading.toUpperCase(), { fontSize: "28px", fontWeight: 700, color, letterSpacing: "3px", marginBottom: "18px" }),
            text(body, { fontSize: "38px", fontWeight: 400, color: theme.text, lineHeight: 1.4 }),
          ]
        );
      return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        kicker(spec.kicker ?? "Problema → Solución", theme.accent2),
        text(spec.title, { fontSize: "54px", fontWeight: 900, color: theme.text, lineHeight: 1.15, marginBottom: "40px" }),
        problema ? block("Problema", problema.body, theme.red, theme.failSoftBorder) : null,
        solucion ? block(`Solución — ${theme.name}`, solucion.body, theme.accent2, theme.okSoftBorder) : null,
      ].filter(Boolean) as El[]);
    }

    case "lista":
      return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
        kicker(spec.kicker ?? "Para tu operación", theme.accent),
        text(spec.title, { fontSize: "60px", fontWeight: 900, color: theme.text, lineHeight: 1.12, marginBottom: "44px" }),
        el("div", { display: "flex", flexDirection: "column" }, bullets(spec.bullets ?? [], theme)),
        ...(spec.takeaway ? [text(spec.takeaway, { fontSize: "30px", fontWeight: 700, color: theme.accent2, marginTop: "auto", lineHeight: 1.35 })] : []),
      ]);

    case "cta": {
      const kids: El[] = [
        kicker(spec.kicker ?? theme.name, theme.accent2),
        text(spec.title, { fontSize: "76px", fontWeight: 900, color: theme.text, lineHeight: 1.1 }),
      ];
      if (spec.subtitle) {
        kids.push(text(spec.subtitle, { fontSize: "38px", fontWeight: 400, color: theme.muted, lineHeight: 1.45, marginTop: "36px" }));
      }
      if (spec.cta) {
        kids.push(
          el(
            "div",
            {
              marginTop: "56px",
              backgroundColor: `linear-gradient(135deg, ${theme.accent2}, ${theme.accent})`,
              borderRadius: "999px",
              padding: "30px 48px",
              display: "flex",
              justifyContent: "center",
            },
            [text(spec.cta, { fontSize: "36px", fontWeight: 900, color: theme.ctaText, letterSpacing: "0.5px" })]
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

export async function renderSlidePng(
  spec: SlideSpec,
  pageIndex: number,
  pageCount: number,
  brand: Brand = "creapolis"
): Promise<Buffer> {
  const theme = getBrandTheme(brand);
  const fonts = await loadFonts();
  const svg = await satori(slideFrame(slideBody(spec, theme), pageIndex, pageCount, theme), {
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
    pngs.push(await renderSlidePng(slide, i + 1, spec.slides.length, spec.brand));
  }
  return pngs;
}
