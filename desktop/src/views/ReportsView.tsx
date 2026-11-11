import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, FileText, Inbox, Newspaper, RefreshCw } from "lucide-react";
import { crmApi, type AnalystReportItem } from "../api";
import { Badge, EmptyState, SectionList, Skeleton, SlideOver } from "../components/ui";
import { Markdown } from "../components/Markdown";

/**
 * Inbox de reportes del agente (briefs de IA, planes editoriales, reportes
 * de operación, y cualquier fuente futura): triage con leído/no leído,
 * filtros por estado y por tipo, y render markdown completo en el drawer.
 * Abrir un reporte lo marca leído automáticamente (reversible).
 */

type ReadFilter = "unread" | "read" | "all";

interface ReportType {
  key: string;
  label: string;
  badgeClass: string;
}

/**
 * El tipo se deriva del prefijo de createdBy (p.ej. "intel:scheduled") —
 * una fuente nueva de reportes aparece sola bajo su prefijo o como "Otro".
 */
const REPORT_TYPES: ReportType[] = [
  { key: "intel", label: "Brief IA", badgeClass: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30" },
  { key: "strategist", label: "Plan editorial", badgeClass: "bg-violet-500/10 text-violet-300 border-violet-500/30" },
  { key: "analyst", label: "Operación", badgeClass: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
  { key: "other", label: "Otro", badgeClass: "bg-zinc-800 text-zinc-300 border-zinc-700" },
];

const reportType = (createdBy: string): ReportType =>
  REPORT_TYPES.find((t) => createdBy.startsWith(t.key)) ?? REPORT_TYPES[REPORT_TYPES.length - 1]!;

/** Primer heading `#` del markdown; si no hay, la primera línea no vacía. */
const reportTitle = (summary: string): string => {
  const heading = /^#\s+(.+)$/m.exec(summary);
  const line = (heading?.[1] ?? summary.split("\n").find((l) => l.trim()) ?? "Reporte").trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

const dtf = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmt = (iso: string) => dtf.format(new Date(iso));

export const ReportsView: React.FC = () => {
  const [reports, setReports] = useState<AnalystReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [readFilter, setReadFilter] = useState<ReadFilter>("unread");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = reports.find((r) => r.id === selectedId) ?? null;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await crmApi.getAnalystReports();
      setReports(res.reports);
    } catch (err) {
      setBanner({ ok: false, text: `No se pudieron cargar los reportes: ${(err as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setRead = useCallback(
    async (id: string, read: boolean) => {
      // Optimista: el badge del sidebar se refresca con su poll de 15s.
      setReports((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, readAt: read ? new Date().toISOString() : null } : r
        )
      );
      try {
        await crmApi.markReportRead(id, read);
      } catch (err) {
        setBanner({ ok: false, text: `No se pudo marcar: ${(err as Error).message}` });
        void load();
      }
    },
    [load]
  );

  const openDetail = (report: AnalystReportItem) => {
    setSelectedId(report.id);
    if (!report.readAt) void setRead(report.id, true);
  };

  const visible = useMemo(
    () =>
      reports.filter((r) => {
        if (typeFilter !== "all" && reportType(r.createdBy).key !== typeFilter) return false;
        if (readFilter === "unread" && r.readAt) return false;
        if (readFilter === "read" && !r.readAt) return false;
        return true;
      }),
    [reports, readFilter, typeFilter]
  );

  const unreadCount = reports.filter((r) => !r.readAt).length;

  const typeChips: Array<{ key: string; label: string }> = [
    { key: "all", label: "Todos" },
    ...REPORT_TYPES.map((t) => ({ key: t.key, label: t.label })),
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
            <Newspaper className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Reportes</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Briefs de IA, planes y reportes del agente — {unreadCount} sin leer
            </p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition shrink-0"
          title="Refrescar"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-lg px-3.5 py-2 text-xs flex items-start justify-between gap-3 border ${
            banner.ok
              ? "bg-emerald-950/50 border-emerald-800 text-emerald-300"
              : "bg-rose-950/50 border-rose-800 text-rose-300"
          }`}
        >
          <span className="flex items-center gap-2">
            <CircleAlert className="w-4 h-4 shrink-0" /> {banner.text}
          </span>
          <button onClick={() => setBanner(null)} className="text-zinc-400 hover:text-white shrink-0">
            ✕
          </button>
        </div>
      )}

      {/* Filtros: estado + tipo */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border border-zinc-800 overflow-hidden">
          {(
            [
              { key: "unread", label: `Sin leer${unreadCount ? ` (${unreadCount})` : ""}` },
              { key: "read", label: "Leídos" },
              { key: "all", label: "Todos" },
            ] as Array<{ key: ReadFilter; label: string }>
          ).map((f) => (
            <button
              key={f.key}
              onClick={() => setReadFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-semibold transition ${
                readFilter === f.key ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="text-zinc-700">·</span>
        <div className="flex rounded-lg border border-zinc-800 overflow-hidden">
          {typeChips.map((t) => (
            <button
              key={t.key}
              onClick={() => setTypeFilter(t.key)}
              className={`px-3 py-1.5 text-xs font-semibold transition ${
                typeFilter === t.key ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Lista */}
      {loading && reports.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nada por aquí"
          hint={
            readFilter === "unread"
              ? "Todo leído. Los reportes nuevos del agente aparecen aquí automáticamente."
              : "Sin reportes para este filtro."
          }
        />
      ) : (
        <SectionList>
          {visible.map((r) => {
            const type = reportType(r.createdBy);
            return (
              <div
                key={r.id}
                className="py-3 flex items-center gap-3 cursor-pointer hover:bg-zinc-900/40 transition -mx-4 px-4 rounded-lg"
                onClick={() => openDetail(r)}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    r.readAt ? "bg-transparent" : "bg-sky-400 shadow-sm shadow-sky-400/80"
                  }`}
                  title={r.readAt ? "Leído" : "Sin leer"}
                />
                <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 text-[11px] font-semibold rounded-md border ${type.badgeClass}`}>
                      {type.label}
                    </span>
                    <span className={`text-sm truncate ${r.readAt ? "text-zinc-400" : "text-white font-medium"}`}>
                      {reportTitle(r.summary)}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    {fmt(r.createdAt)} · <span className="font-mono">{r.createdBy}</span>
                    {r.periodEnd && ` · periodo hasta ${fmt(r.periodEnd)}`}
                  </div>
                </div>
              </div>
            );
          })}
        </SectionList>
      )}

      {/* Detalle */}
      {selected && (
        <SlideOver
          onClose={() => setSelectedId(null)}
          width="max-w-3xl"
          title={reportTitle(selected.summary)}
          badge={
            selected.readAt ? <Badge tone="zinc">Leído</Badge> : <Badge tone="sky">Sin leer</Badge>
          }
          meta={
            <>
              <span>{fmt(selected.createdAt)}</span>
              <span>·</span>
              <span className="font-mono">{selected.createdBy}</span>
              {selected.periodEnd && (
                <>
                  <span>·</span>
                  <span>periodo hasta {fmt(selected.periodEnd)}</span>
                </>
              )}
            </>
          }
          actions={
            <button
              onClick={() => void setRead(selected.id, !selected.readAt)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
            >
              {selected.readAt ? "Marcar sin leer" : "Marcar leída"}
            </button>
          }
        >
          <div className="p-6">
            <Markdown>{selected.summary}</Markdown>
          </div>
        </SlideOver>
      )}
    </div>
  );
};
