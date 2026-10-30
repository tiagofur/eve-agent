/**
 * Renders two sample packs (1 news carousel + 1 service carousel) and uploads
 * them to the CRM as pending_approval. Used for local QA of the render stack:
 *   npx tsx agent/scripts/render-sample-pack.ts
 * Requires CRM_API_URL + CRM_OPS_KEY (loaded from .env.local) and the local CRM running.
 */
import { ZipArchive } from "archiver";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crmUploadContentPack } from "../lib/crm";
import { renderPackPngs, type PackRenderSpec } from "../lib/content-renderer";

// Minimal .env.local loader (dotenv is not a root dependency).
for (const line of readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

async function buildZip(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of entries) archive.append(entry.data, { name: entry.name });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

const newsPack: PackRenderSpec = {
  topic: "Agentes de IA que operan negocios reales (muestra QA)",
  slides: [
    {
      variant: "cover",
      kicker: "IA aplicada",
      title: "Un agente de IA opera nuestro CRM todos los días",
      subtitle: "Investiga, redacta y deja todo listo para aprobación humana.",
    },
    {
      variant: "news",
      kicker: "Lo que cambió esta semana",
      title: "Los agentes pasaron de conversar a ejecutar trabajo",
      bullets: [
        "Orquestadores que delegan a subagentes especializados.",
        "Gates de aprobación humana antes de cualquier acción externa.",
        "Trazabilidad completa: cada acción queda auditada.",
      ],
      takeaway: "¿Qué significa para tu negocio? Un equipo que no duerme, con humano al mando.",
    },
    {
      variant: "problema_solucion",
      kicker: "Problema → Solución",
      title: "Follow-up comercial que nadie alcanza a hacer",
      blocks: [
        {
          heading: "Problema",
          body: "Los leads se enfrían porque el seguimiento depende de que alguien recuerde escribir.",
        },
        {
          heading: "Solución — Creapolis",
          body: "Un agente agenda y redacta cada seguimiento; tú solo apruebas con un toque.",
        },
      ],
    },
    {
      variant: "lista",
      kicker: "Cómo empieza",
      title: "3 pasos para tu primer agente",
      bullets: [
        "Diagnosticamos qué proceso conviene automatizar primero.",
        "Conectamos el agente a tus sistemas reales con gates.",
        "Midemos horas ahorradas desde la semana 1.",
      ],
      takeaway: "El primer quick win cabe en dos semanas.",
    },
    {
      variant: "cta",
      kicker: "Creapolis.Dev",
      title: "Tu operación, operada por agentes",
      subtitle: "Software a medida, automatización y agentes de IA para pymes.",
      cta: "Escríbenos → creapolis.dev",
    },
  ],
};

const servicePack: PackRenderSpec = {
  topic: "Automatización con aprobación humana (muestra QA)",
  slides: [
    {
      variant: "cover",
      kicker: "Automatización",
      title: "Automatiza el 80%, firma el 20%",
      subtitle: "Flujos que trabajan solos y te avisan solo cuando importa.",
    },
    {
      variant: "lista",
      kicker: "Para tu operación",
      title: "Lo que puedes dejar de hacer a mano",
      bullets: [
        "Copiar datos entre tu CRM, hojas de cálculo y WhatsApp.",
        "Armar reportes semanales en Excel.",
        "Persuadir seguimientos vencidos uno por uno.",
      ],
      takeaway: "Primero medimos cuántas horas recuperas; después automatizamos.",
    },
    {
      variant: "problema_solucion",
      kicker: "Problema → Solución",
      title: "Cotizaciones que mueren en el copy-paste",
      blocks: [
        { heading: "Problema", body: "Cotización → orden → factura: tres sistemas, tres capturas, errores garantizados." },
        { heading: "Solución — Creapolis", body: "Un flujo con webhooks conecta todo y deja la firma final a un humano." },
      ],
    },
    {
      variant: "cta",
      kicker: "Creapolis.Dev",
      title: "Te decimos cuánto puedes ahorrar",
      subtitle: "Assessment de automatización sin costo y sin compromiso.",
      cta: "Agenda tu diagnóstico → creapolis.dev",
    },
  ],
};

const PREVIEW_DIR = path.resolve(process.cwd(), "data/pack-preview");

async function produce(name: string, spec: PackRenderSpec, extra: Record<string, unknown>) {
  console.log(`→ rendering ${name} (${spec.slides.length} slides)...`);
  const pngs = await renderPackPngs(spec);
  mkdirSync(path.join(PREVIEW_DIR, name), { recursive: true });
  pngs.forEach((png, i) => writeFileSync(path.join(PREVIEW_DIR, name, `slide-${i + 1}.png`), png));

  const zip = await buildZip(
    pngs.map((png, i) => ({ name: `slides/slide-${String(i + 1).padStart(2, "0")}.png`, data: png }))
  );
  const result = await crmUploadContentPack({
    meta: {
      kind: "carousel",
      topic: spec.topic,
      hook: spec.slides[0]?.title,
      caption:
        "Pack de muestra para QA del pipeline de contenido. Revisa las slides, aprueba o rechaza, y descarga el ZIP. #CreapolisDev #IA",
      captionsByPlatform: {
        linkedin: "Variante LinkedIn del pack de muestra: tono profesional, 3 líneas y CTA.",
        tiktok: "Versión corta para TikTok (muestra QA).",
      },
      hashtags: ["CreapolisDev", "IA", "Automatizacion"],
      platforms: ["instagram", "linkedin", "tiktok", "x"],
      notes: "Generado por agent/scripts/render-sample-pack.ts (QA local).",
      ...extra,
    },
    zip,
    cover: pngs[0],
  });
  console.log(`✓ ${name}: pack ${result.pack.id} (${result.pack.status})`);
}

const today = new Date().toISOString().slice(0, 10);
await produce("news", newsPack, { scheduledFor: today });
await produce("service", servicePack, { scheduledFor: today });
console.log(`PNG previews in ${PREVIEW_DIR}`);
