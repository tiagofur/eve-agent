import { useState, useEffect } from "react";
import { crmApi, type DailyMetrics, type FunnelReport, type FollowUpItem } from "../api";
import { Users, AlertTriangle, Send, CheckCircle2, TrendingUp, RefreshCw, BellRing } from "lucide-react";

export function DashboardView() {
  const [metrics, setMetrics] = useState<DailyMetrics | null>(null);
  const [funnel, setFunnel] = useState<FunnelReport | null>(null);
  const [followups, setFollowups] = useState<{ overdue: FollowUpItem[]; upcoming: FollowUpItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [metricsRes, funnelRes, followupsRes] = await Promise.all([
        crmApi.getDailyMetrics(),
        crmApi.getFunnelReport(),
        crmApi.getFollowups(),
      ]);
      setMetrics(metricsRes.metrics);
      setFunnel(funnelRes);
      setFollowups(followupsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error connecting to CRM API");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000); // 15s polling
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Dashboard Ejecutivo</h2>
          <p className="text-sm text-slate-400">
            Monitoreo en tiempo real de leads, agentes, tickets y conversiones.
          </p>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
          ⚠️ {error} — Asegúrate de que el backend esté corriendo en <code className="font-mono text-xs">localhost:8787</code>.
        </div>
      )}

      {/* Top Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Total Leads
            </span>
            <Users className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-white">
              {metrics ? metrics.totalLeads : "--"}
            </span>
            <span className="text-xs text-slate-400">captados</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Por Aprobar (Outbox)
            </span>
            <Send className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-amber-300">
              {metrics ? metrics.pendingDraftsApproval : "--"}
            </span>
            <span className="text-xs text-slate-400">esperando tu OK</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Tickets Abiertos
            </span>
            <AlertTriangle className="h-4 w-4 text-rose-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-rose-400">
              {metrics ? metrics.openTickets : "--"}
            </span>
            <span className="text-xs text-slate-400">soporte activo</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Contratos Ganados
            </span>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-extrabold text-emerald-400">
              {funnel ? funnel.wonCount : "--"}
            </span>
            <span className="text-xs text-slate-400">en onboarding</span>
          </div>
        </div>
      </div>

      {/* Follow-ups vencidos */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-amber-400" />
            <h3 className="font-semibold text-white">Seguimientos vencidos</h3>
          </div>
          <span className="text-xs text-slate-400">
            {metrics?.followUpsOverdue ?? 0} vencidos · {followups?.upcoming.length ?? 0} próximos
          </span>
        </div>
        {!followups || followups.overdue.length === 0 ? (
          <p className="text-sm text-slate-500">Al día — ningún seguimiento vencido. 🎉</p>
        ) : (
          <div className="space-y-2">
            {followups.overdue.slice(0, 10).map((f) => (
              <div key={`${f.kind}-${f.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="mr-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-300">
                    {f.kind === "lead" ? "Lead" : f.kind === "ticket" ? "Ticket" : f.kind === "contact" ? "Contacto" : "Cliente"}
                  </span>
                  <span className="font-medium text-white">{f.organizationName || f.name || f.id.slice(0, 8)}</span>
                  {f.followUpNote && <span className="ml-2 text-slate-400">— {f.followUpNote}</span>}
                </div>
                <span className="shrink-0 font-mono text-xs text-amber-300">
                  {new Date(f.nextFollowUpAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Funnel Conversion Breakdown */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-indigo-400" />
            <h3 className="font-semibold text-white">Embudo de Conversión de Clientes</h3>
          </div>
          <span className="text-xs text-slate-400">Total en proceso: {funnel?.totalInFunnel ?? 0}</span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {funnel?.funnel.map((item, idx) => {
            const pct =
              funnel.totalInFunnel > 0
                ? Math.round((item.count / funnel.totalInFunnel) * 100)
                : 0;

            return (
              <div
                key={item.stage}
                className="relative rounded-lg border border-slate-800/80 bg-slate-950/60 p-3 text-center"
              >
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {idx + 1}. {item.stage}
                </div>
                <div className="mt-2 text-2xl font-bold text-white">{item.count}</div>
                <div className="mt-1 text-[11px] font-medium text-indigo-400">{pct}%</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
