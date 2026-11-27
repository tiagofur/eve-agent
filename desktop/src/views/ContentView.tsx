import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Download,
  Loader2,
  RefreshCw,
  Video,
  Layers,
  Image as ImageIcon,
  Copy,
  Check,
  FileArchive,
} from "lucide-react";
import {
  crmApi,
  fetchContentPackCoverUrl,
  fetchContentPackZip,
  type ContentPackItem,
  type VisualConfigItem,
} from "../api";
import { Modal } from "../components/ui";
import { inputClass, labelClass } from "./CrmForms";

type StatusFilter = "pending_approval" | "approved" | "rejected" | "published" | "all";
type BrandFilter = "all" | ContentPackItem["brand"];

const STATUS_LABEL: Record<ContentPackItem["status"], string> = {
  pending_approval: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
  published: "Publicado",
};

const STATUS_STYLE: Record<ContentPackItem["status"], string> = {
  pending_approval: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/15 text-red-400 border-red-500/30",
  published: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
};

const KIND_LABEL: Record<ContentPackItem["kind"], string> = {
  video: "Video",
  carousel: "Carrusel",
  image: "Imagen",
};

const BRAND_LABEL: Record<ContentPackItem["brand"], string> = {
  creapolis: "Creapolis",
  pepinillo: "Pepinillo",
  solennix: "Solennix",
};

const BRAND_STYLE: Record<ContentPackItem["brand"], string> = {
  creapolis: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  pepinillo: "bg-lime-500/10 text-lime-300 border-lime-500/30",
  solennix: "bg-violet-500/10 text-violet-300 border-violet-500/30",
};

const KindIcon: React.FC<{ kind: ContentPackItem["kind"] }> = ({ kind }) => {
  const cls = "w-4 h-4";
  if (kind === "video") return <Video className={cls} />;
  if (kind === "carousel") return <Layers className={cls} />;
  return <ImageIcon className={cls} />;
};

const PackCard: React.FC<{
  pack: ContentPackItem;
  coverUrl: string | null;
  actionLoading: boolean;
  onReview: (id: string, decision: "approved" | "rejected") => void;
  onDownload: (id: string) => void;
}> = ({ pack, coverUrl, actionLoading, onReview, onDownload }) => {
  const [copied, setCopied] = useState(false);

  const copyCaption = () => {
    navigator.clipboard.writeText(pack.caption);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden flex flex-col">
      {coverUrl ? (
        <img src={coverUrl} alt={pack.topic} className="w-full aspect-video object-cover" />
      ) : (
        <div className="w-full aspect-video bg-zinc-800/60 flex items-center justify-center">
          <FileArchive className="w-10 h-10 text-zinc-600" />
        </div>
      )}

      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 text-xs font-semibold rounded-md border ${BRAND_STYLE[pack.brand]}`}>
            {BRAND_LABEL[pack.brand]}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold rounded-md bg-zinc-800 text-zinc-300">
            <KindIcon kind={pack.kind} />
            {KIND_LABEL[pack.kind]}
          </span>
          <span className={`px-2 py-0.5 text-xs font-semibold rounded-md border ${STATUS_STYLE[pack.status]}`}>
            {STATUS_LABEL[pack.status]}
          </span>
          {pack.scheduledFor && (
            <span className="text-[11px] text-zinc-500" title="Fecha para la que se planificó el post">
              📅 {pack.scheduledFor}
            </span>
          )}
          {pack.downloadedAt && (
            <span className="text-[11px] text-zinc-500">descargado</span>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold text-white leading-snug">{pack.topic}</h3>
          {pack.hook && <p className="text-xs text-cyan-400 mt-0.5">{pack.hook}</p>}
          {pack.status === "published" && pack.externalPostUrl && (
            <a
              href={pack.externalPostUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block mt-1 text-xs text-cyan-300 hover:underline"
            >
              Ver publicación en Instagram ↗
            </a>
          )}
          {pack.status === "published" && pack.fbPostUrl && (
            <a
              href={pack.fbPostUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block mt-1 ml-3 text-xs text-blue-300 hover:underline"
            >
              Ver publicación en Facebook ↗
            </a>
          )}
          {pack.status === "published" && pack.externalPostUrl && !pack.fbPostUrl && (
            <span className="inline-block mt-1 ml-3 text-[11px] text-zinc-600">Facebook no publicado</span>
          )}
        </div>

        <p className="text-xs text-zinc-400 leading-relaxed line-clamp-4 whitespace-pre-line">{pack.caption}</p>

        {pack.hashtags.length > 0 && (
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            {pack.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}
          </p>
        )}

        {pack.status === "rejected" && pack.rejectedReason && (
          <p className="text-[11px] text-red-400 border-l-2 border-red-500/40 pl-2">{pack.rejectedReason}</p>
        )}

        {pack.captionsByPlatform && Object.keys(pack.captionsByPlatform).length > 0 && (
          <details className="text-[11px] text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Captions por plataforma</summary>
            {Object.entries(pack.captionsByPlatform).map(([platform, caption]) => (
              <div key={platform} className="mt-1.5">
                <span className="font-semibold text-zinc-400 uppercase">{platform}</span>
                <p className="whitespace-pre-line">{caption}</p>
              </div>
            ))}
          </details>
        )}

        <div className="mt-auto pt-2 flex items-center gap-2 flex-wrap">
          {pack.status === "pending_approval" && (
            <>
              <button
                onClick={() => onReview(pack.id, "approved")}
                disabled={actionLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
              >
                {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Aprobar
              </button>
              <button
                onClick={() => onReview(pack.id, "rejected")}
                disabled={actionLoading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-800 hover:bg-zinc-700 text-red-400 disabled:opacity-50"
              >
                <XCircle className="w-3.5 h-3.5" />
                Rechazar
              </button>
            </>
          )}
          <button
            onClick={() => onDownload(pack.id)}
            disabled={actionLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            ZIP
          </button>
          <button
            onClick={copyCaption}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
            title="Copiar caption"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
};

export const ContentView: React.FC = () => {
  const [packs, setPacks] = useState<ContentPackItem[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("pending_approval");
  const [brandFilter, setBrandFilter] = useState<BrandFilter>("all");
  const [showVisualConfig, setShowVisualConfig] = useState(false);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);

  const loadPacks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await crmApi.getContentPacks(filter === "all" ? undefined : filter);
      setPacks(res.packs);

      // Load covers only for packs that have one; revoke old object URLs.
      setCovers((prev) => {
        Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
        return {};
      });
      const withCover = res.packs.filter((p) => p.hasCover);
      const entries = await Promise.all(
        withCover.map(async (p) => {
          try {
            const url = await fetchContentPackCoverUrl(p.id);
            return url ? [p.id, url] as const : null;
          } catch {
            return null;
          }
        })
      );
      setCovers(Object.fromEntries(entries.filter((e): e is readonly [string, string] => e !== null)));
    } catch (err) {
      console.error("Failed to load content packs:", err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadPacks();
  }, [loadPacks]);

  useEffect(() => {
    return () => {
      Object.values(covers).forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReview = async (id: string, decision: "approved" | "rejected") => {
    let rejectedReason: string | undefined;
    if (decision === "rejected") {
      rejectedReason = window.prompt("Motivo del rechazo (queda auditado):") ?? undefined;
      if (!rejectedReason?.trim()) return;
    }
    try {
      setActionLoading(id);
      await crmApi.reviewContentPack(id, decision, rejectedReason);
      await loadPacks();
    } catch (err: any) {
      alert(`Error en revisión: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownload = async (id: string) => {
    try {
      setActionLoading(id);
      const { blob, filename } = await fetchContentPackZip(id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      await loadPacks();
    } catch (err: any) {
      alert(`Error al descargar: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const FILTERS: Array<{ key: StatusFilter; label: string }> = [
    { key: "pending_approval", label: "Pendientes" },
    { key: "approved", label: "Aprobados" },
    { key: "published", label: "Publicados" },
    { key: "rejected", label: "Rechazados" },
    { key: "all", label: "Todos" },
  ];

  const BRAND_FILTERS: Array<{ key: BrandFilter; label: string }> = [
    { key: "all", label: "Todas" },
    { key: "creapolis", label: "Creapolis" },
    { key: "pepinillo", label: "Pepinillo" },
    { key: "solennix", label: "Solennix" },
  ];

  const visiblePacks = brandFilter === "all" ? packs : packs.filter((p) => p.brand === brandFilter);

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 lg:gap-6 flex-wrap border-b border-zinc-800 pb-5">
        <div className="flex-1 min-w-[280px]">
          <h2 className="text-lg font-bold text-white">Contenido</h2>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl">
            Packs diarios de las 3 marcas (carrusel / imagen / video): llegan a Telegram con botón
            «Aprobar y publicar» en Instagram; aquí revisas el detalle, apruebas y descargas el ZIP.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="flex rounded-lg border border-zinc-800 overflow-hidden">
            {BRAND_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setBrandFilter(f.key)}
                className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition ${
                  brandFilter === f.key ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-zinc-800 overflow-hidden">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition ${
                  filter === f.key ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowVisualConfig(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700 text-xs font-semibold whitespace-nowrap"
            title="Configuración visual por marca (portadas IA)"
          >
            <ImageIcon className="w-4 h-4 shrink-0" /> <span className="whitespace-nowrap">Configuración visual</span>
          </button>
          <button
            onClick={loadPacks}
            className="p-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700"
            title="Recargar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {showVisualConfig && (
        <VisualConfigModal
          onClose={() => setShowVisualConfig(false)}
          onSaved={() => {
            setBanner({ ok: true, text: "Configuración visual guardada — aplica en el próximo pack" });
          }}
          onError={(text) => setBanner({ ok: false, text })}
        />
      )}
      {banner && (
        <div
          className={`rounded-lg px-3.5 py-2 text-xs flex items-start justify-between gap-3 border ${
            banner.ok
              ? "bg-emerald-950/50 border-emerald-800 text-emerald-300"
              : "bg-rose-950/50 border-rose-800 text-rose-300"
          }`}
        >
          <span>{banner.text}</span>
          <button onClick={() => setBanner(null)} className="text-zinc-400 hover:text-white shrink-0">
            ✕
          </button>
        </div>
      )}

      {loading && packs.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-zinc-500">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : visiblePacks.length === 0 ? (
        <div className="text-center py-16 text-zinc-500 text-sm border border-dashed border-zinc-800 rounded-xl">
          Sin packs {filter !== "all" ? "en este estado" : ""}
          {brandFilter !== "all" ? ` de ${BRAND_LABEL[brandFilter]}` : ""}. El pipeline los irá dejando aquí cada día.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visiblePacks.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              coverUrl={covers[pack.id] ?? null}
              actionLoading={actionLoading === pack.id}
              onReview={handleReview}
              onDownload={handleDownload}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Configuración visual por marca (portadas del pipeline)              */
/* ------------------------------------------------------------------ */

const VISUAL_MODES: Array<{ value: VisualConfigItem["mode"]; label: string; hint: string }> = [
  { value: "editorial", label: "Editorial tipográfico", hint: "Sin costo de imagen — portada de tipografía como siempre" },
  { value: "hybrid", label: "Híbrido (IA + titular)", hint: "Arte IA de Gemini + titular corto compuesto; ~US$0.03 por portada" },
  { value: "image_only", label: "Solo imagen IA", hint: "Arte a sangre completa sin texto; el mensaje vive en el caption" },
];

const BRAND_META: Record<string, { label: string; tone: string }> = {
  creapolis: { label: "Creapolis.Dev", tone: "text-cyan-300" },
  pepinillo: { label: "Pepinillo", tone: "text-lime-300" },
  solennix: { label: "Solennix", tone: "text-violet-300" },
};

const VisualConfigModal: React.FC<{
  onClose: () => void;
  onSaved: () => void;
  onError: (text: string) => void;
}> = ({ onClose, onSaved, onError }) => {
  const [configs, setConfigs] = useState<VisualConfigItem[] | null>(null);
  const [savingBrand, setSavingBrand] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await crmApi.getVisualConfigs();
      setConfigs(res.configs);
    } catch (err) {
      onError(`No se pudo cargar la configuración: ${(err as Error).message}`);
      onClose();
    }
  };

  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (brand: string, changes: Partial<VisualConfigItem>) => {
    setConfigs((prev) => (prev ?? []).map((cfg) => (cfg.brand === brand ? { ...cfg, ...changes } : cfg)));
  };

  const save = async (brand: string) => {
    const cfg = (configs ?? []).find((c) => c.brand === brand);
    if (!cfg) return;
    try {
      setSavingBrand(brand);
      await crmApi.updateVisualConfig(brand, {
        mode: cfg.mode,
        artDirection: cfg.artDirection,
        coverTitleMaxWords: cfg.coverTitleMaxWords,
        showLogo: cfg.showLogo,
        imageModel: cfg.imageModel,
      });
      onSaved();
      await load();
    } catch (err) {
      onError(`No se pudo guardar ${brand}: ${(err as Error).message}`);
    } finally {
      setSavingBrand(null);
    }
  };

  return (
    <Modal onClose={onClose} title="Configuración visual por marca" width="max-w-3xl">
      {!configs ? (
        <div className="flex items-center justify-center py-10 text-zinc-500">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-zinc-500">
            Decide cómo nace la portada de cada marca. Los cambios aplican en el próximo pack — el
            pipeline lee esta configuración en cada corrida. Modo editorial no gasta imagen; los otros
            dos generan arte con el modelo configurado.
          </p>
          {configs.map((cfg) => {
            const meta = BRAND_META[cfg.brand] ?? { label: cfg.brand, tone: "text-zinc-300" };
            return (
              <div key={cfg.brand} className="border border-zinc-800 rounded-xl p-4 space-y-3 bg-zinc-900/40">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-bold ${meta.tone}`}>{meta.label}</span>
                  <span className="font-mono text-[10px] text-zinc-600">{cfg.brand}</span>
                  {!cfg.configured && <span className="text-[10px] text-zinc-600">sin perfil guardado</span>}
                </div>
                <div>
                  <label className={labelClass}>Modo de portada</label>
                  <div className="space-y-1.5">
                    {VISUAL_MODES.map((mode) => (
                      <label
                        key={mode.value}
                        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition ${
                          cfg.mode === mode.value
                            ? "border-violet-500/50 bg-violet-500/10"
                            : "border-zinc-800 hover:border-zinc-700"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`mode-${cfg.brand}`}
                          checked={cfg.mode === mode.value}
                          onChange={() => patch(cfg.brand, { mode: mode.value })}
                          className="mt-0.5 accent-violet-400"
                        />
                        <span>
                          <span className="text-xs font-semibold text-zinc-200">{mode.label}</span>
                          <span className="block text-[11px] text-zinc-500">{mode.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                {cfg.mode !== "editorial" && (
                  <>
                    <div>
                      <label className={labelClass}>
                        Dirección de arte (estilo, paleta, qué evitar — el designer aporta la escena)
                      </label>
                      <textarea
                        value={cfg.artDirection}
                        onChange={(e) => patch(cfg.brand, { artDirection: e.target.value })}
                        rows={2}
                        maxLength={2000}
                        placeholder="Ej.: 3D minimalista editorial, fondo azul petróleo, un solo objeto hero, sin texto"
                        className={`${inputClass} resize-y`}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelClass}>Máx. palabras del titular</label>
                        <input
                          type="number"
                          min={2}
                          max={15}
                          value={cfg.coverTitleMaxWords}
                          onChange={(e) =>
                            patch(cfg.brand, { coverTitleMaxWords: Number(e.target.value) || 8 })
                          }
                          className={inputClass}
                        />
                      </div>
                      <div>
                        <label className={labelClass}>Modelo de imagen</label>
                        <input
                          value={cfg.imageModel}
                          onChange={(e) => patch(cfg.brand, { imageModel: e.target.value })}
                          className={`${inputClass} font-mono text-xs`}
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-zinc-400">
                      <input
                        type="checkbox"
                        checked={cfg.showLogo}
                        onChange={(e) => patch(cfg.brand, { showLogo: e.target.checked })}
                        className="accent-emerald-400"
                      />
                      Mostrar el badge de la marca sobre el arte
                    </label>
                    <label className="flex items-start gap-2 text-xs text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfg.generationMode === "batch"}
                        onChange={(e) => patch(cfg.brand, { generationMode: e.target.checked ? "batch" : "standard" })}
                        className="accent-amber-400 mt-0.5"
                      />
                      <span>
                        <span className="font-semibold text-zinc-300">Generar en modo Batch (mitad de precio)</span>
                        <span className="block text-[11px] text-zinc-500">
                          La portada tarda ~2-5 minutos en vez de ~15 segundos; si el job falla, cae a generación estándar
                          automáticamente. Ideal para el pipeline nocturno.
                        </span>
                      </span>
                    </label>
                  </>
                )}
                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => void save(cfg.brand)}
                    disabled={savingBrand === cfg.brand}
                    className="px-4 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg transition disabled:opacity-50"
                  >
                    {savingBrand === cfg.brand ? "Guardando…" : `Guardar ${meta.label}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
};
