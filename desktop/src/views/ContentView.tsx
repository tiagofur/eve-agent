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
} from "../api";

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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
        <div>
          <h2 className="text-lg font-bold text-white">Contenido</h2>
          <p className="text-xs text-zinc-500 mt-1">
            Packs diarios de las 3 marcas (carrusel / imagen / video): llegan a Telegram con botón
            «Aprobar y publicar» en Instagram; aquí revisas el detalle, apruebas y descargas el ZIP.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-zinc-800 overflow-hidden">
            {BRAND_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setBrandFilter(f.key)}
                className={`px-3 py-1.5 text-xs font-semibold transition ${
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
                className={`px-3 py-1.5 text-xs font-semibold transition ${
                  filter === f.key ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            onClick={loadPacks}
            className="p-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-700"
            title="Recargar"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

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
