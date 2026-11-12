import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Banknote,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CreditCard,
  FileSignature,
  FileText,
  HandCoins,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  Repeat,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  crmApi,
  type BillingProject,
  type CollectionsData,
  type ContractItem,
  type EstimateItem,
  type InvoiceItem,
  type LeadItem,
  type MilestoneItem,
  type OrganizationItem,
  type ProjectItem,
  type SubscriptionItem,
} from "../api";
import { Badge, EmptyState, Skeleton } from "../components/ui";
import {
  InvoiceModal,
  MilestoneModal,
  NewContractModal,
  NewEstimateModal,
  PaymentModal,
  SubscriptionModal,
  ESTIMATE_CATEGORIES,
  type InvoiceModalTarget,
  type MilestoneModalTarget,
  type SubscriptionModalTarget,
} from "./SalesForms";

/**
 * Ventas: el ciclo comercial completo que antes solo existía vía agente
 * (solutions → save_service_estimate, legal → save_contract_draft, biller →
 * hitos). Tres pestañas: Cobros (hitos por proyecto), Propuestas y Contratos.
 */

type SalesTab = "cobros" | "propuestas" | "contratos";

const fmtMoney = (cents: number, currency: string) =>
  (cents / 100).toLocaleString("es-MX", { style: "currency", currency, maximumFractionDigits: 0 });

const fmtMoneyExact = (cents: number, currency: string) =>
  (cents / 100).toLocaleString("es-MX", { style: "currency", currency, maximumFractionDigits: 2 });

const moneyByCurrency = (totals: Record<string, number>) =>
  Object.entries(totals)
    .map(([cur, cents]) => fmtMoneyExact(cents, cur))
    .join(" · ") || "—";

const fmtDate = (value: string) =>
  new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const fmtDateTime = (value: string) => new Date(value).toLocaleString();

const CATEGORY_LABEL = new Map<string, string>(ESTIMATE_CATEGORIES.map((c) => [c.value, c.label]));
const COMPLEXITY_LABEL: Record<string, string> = { mvp: "MVP", standard: "Estándar", enterprise: "Enterprise" };

const CONTRACT_STATUS: Record<
  ContractItem["status"],
  { label: string; tone: "zinc" | "amber" | "sky" | "emerald" | "rose" }
> = {
  draft: { label: "Borrador", tone: "zinc" },
  in_review: { label: "En revisión", tone: "amber" },
  sent: { label: "Enviado", tone: "sky" },
  signed: { label: "Firmado", tone: "emerald" },
  void: { label: "Anulado", tone: "rose" },
};

/** Siguiente paso de la máquina contractual por estado (void desde cualquier vivo). */
const CONTRACT_NEXT: Partial<
  Record<ContractItem["status"], Array<{ target: ContractItem["status"]; label: string; primary?: boolean }>>
> = {
  draft: [
    { target: "in_review", label: "A revisión", primary: true },
    { target: "void", label: "Anular" },
  ],
  in_review: [
    { target: "sent", label: "Marcar enviado", primary: true },
    { target: "void", label: "Anular" },
  ],
  sent: [
    { target: "signed", label: "Firmar", primary: true },
    { target: "void", label: "Anular" },
  ],
};

function contractActions(status: ContractItem["status"]) {
  return CONTRACT_NEXT[status] ?? [];
}

const INVOICE_STATUS: Record<InvoiceItem["status"], { label: string; tone: "zinc" | "amber" | "sky" | "emerald" | "rose" }> = {
  draft: { label: "Borrador", tone: "zinc" },
  sent: { label: "Enviada", tone: "sky" },
  overdue: { label: "Vencida", tone: "rose" },
  paid: { label: "Pagada", tone: "emerald" },
  cancelled: { label: "Cancelada", tone: "zinc" },
};

const CADENCE_LABEL: Record<SubscriptionItem["cadence"], string> = {
  monthly: "mes",
  quarterly: "trimestre",
  yearly: "año",
};

function renewalState(s: SubscriptionItem): { label: string; tone: "zinc" | "amber" | "emerald" | "rose" } {
  if (s.status !== "active") return { label: s.status === "paused" ? "Pausada" : "Cancelada", tone: "zinc" };
  if (s.dueInDays == null) return { label: "Sin fecha", tone: "zinc" };
  if (s.dueInDays < 0) return { label: `Vencida ${-s.dueInDays}d`, tone: "rose" };
  if (s.dueInDays <= 14) return { label: `En ${s.dueInDays}d`, tone: "amber" };
  return { label: fmtDate(s.nextRenewalAt!), tone: "zinc" };
}

const btnAction =
  "px-2.5 py-1 text-[11px] font-semibold rounded-md border transition disabled:opacity-50";
const btnPrimary = `${btnAction} bg-emerald-400 text-black border-emerald-400 hover:bg-emerald-300`;
const btnGhost = `${btnAction} bg-transparent text-zinc-300 border-zinc-700 hover:bg-zinc-800`;
const btnIcon =
  "p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 border border-transparent hover:border-zinc-700 transition disabled:opacity-50";

/* ------------------------------------------------------------------ */
/* Hitos                                                                */
/* ------------------------------------------------------------------ */

type MilestoneState = { label: string; tone: "zinc" | "amber" | "emerald" | "rose" };

function milestoneState(m: MilestoneItem): MilestoneState {
  if (m.doneAt) return { label: "Hecho", tone: "emerald" };
  if (!m.dueDate) return { label: "Sin fecha", tone: "zinc" };
  const due = new Date(`${m.dueDate.slice(0, 10)}T12:00:00`);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const in7days = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (due < startOfToday) return { label: "Vencido", tone: "rose" };
  if (due <= in7days) return { label: "Vence pronto", tone: "amber" };
  return { label: "Agendado", tone: "zinc" };
}

const MilestoneRow: React.FC<{
  milestone: MilestoneItem;
  onToggleDone: (m: MilestoneItem) => void;
  onEdit: (m: MilestoneItem) => void;
  onDelete: (m: MilestoneItem) => void;
  busy: boolean;
}> = ({ milestone: m, onToggleDone, onEdit, onDelete, busy }) => {
  const state = milestoneState(m);
  return (
    <div className="flex items-center gap-3 py-2.5">
      <button
        type="button"
        onClick={() => onToggleDone(m)}
        disabled={busy}
        title={m.doneAt ? "Marcar como pendiente" : "Marcar como hecho"}
        className={btnIcon}
      >
        {m.doneAt ? <CheckCircle2 className="w-[18px] h-[18px] text-emerald-400" /> : <CircleDashed className="w-[18px] h-[18px]" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-200 flex items-center gap-2 flex-wrap">
          <span className={m.doneAt ? "line-through text-zinc-500" : ""}>{m.title}</span>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">
          {m.dueDate ? `Vence ${fmtDate(m.dueDate)}` : "Sin fecha comprometida"}
        </div>
      </div>
      <div className="text-sm font-mono text-zinc-200 shrink-0">
        {m.amountCents != null ? fmtMoney(m.amountCents, m.currency) : <span className="text-zinc-600">Sin monto</span>}
      </div>
      <button type="button" onClick={() => onEdit(m)} disabled={busy} title="Editar hito" className={btnIcon}>
        <Pencil className="w-4 h-4" />
      </button>
      <button type="button" onClick={() => onDelete(m)} disabled={busy} title="Eliminar hito" className={btnIcon}>
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Vista                                                                */
/* ------------------------------------------------------------------ */

export const SalesView: React.FC = () => {
  const [tab, setTab] = useState<SalesTab>("cobros");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [billing, setBilling] = useState<BillingProject[]>([]);
  const [collections, setCollections] = useState<CollectionsData | null>(null);
  const [estimates, setEstimates] = useState<EstimateItem[]>([]);
  const [contracts, setContracts] = useState<ContractItem[]>([]);
  const [orgs, setOrgs] = useState<OrganizationItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [leads, setLeads] = useState<LeadItem[]>([]);

  const [showEstimateForm, setShowEstimateForm] = useState(false);
  const [showContractForm, setShowContractForm] = useState(false);
  const [showInvoiceForm, setShowInvoiceForm] = useState<InvoiceModalTarget | null>(null);
  const [showSubscriptionForm, setShowSubscriptionForm] = useState<SubscriptionModalTarget | null>(null);
  const [paymentInvoice, setPaymentInvoice] = useState<InvoiceItem | null>(null);
  const [milestoneTarget, setMilestoneTarget] = useState<MilestoneModalTarget | null>(null);
  const [expandedContract, setExpandedContract] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [b, co, e, ct, o, p, l] = await Promise.all([
        crmApi.getBilling(),
        crmApi.getCollections(),
        crmApi.getEstimates(),
        crmApi.getContracts(),
        crmApi.getOrganizations(),
        crmApi.getProjects(),
        crmApi.getLeads(),
      ]);
      setBilling(b.projects);
      setCollections(co);
      setEstimates(e.estimates);
      setContracts(ct.contracts);
      setOrgs(o.organizations);
      setProjects(p.projects);
      setLeads(l.leads);
    } catch (err: any) {
      setLoadError(err.message || "No se pudo cargar Ventas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Acción sobre un contrato/hito: ejecuta, refresca y muestra error inline. */
  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (err: any) {
      setActionError(err.message || "La operación falló.");
    } finally {
      setBusy(false);
    }
  };

  const kpis = useMemo(() => {
    const openProjects = billing;
    const overdueMilestones = openProjects.reduce((n, p) => n + p.overdueMilestones.length, 0);
    const overdueInvoices = collections?.invoices.filter((i) => i.status === "overdue").length ?? 0;
    const overdueRenewals = collections?.subscriptions.filter((s) => s.status === "active" && s.dueInDays != null && s.dueInDays < 0).length ?? 0;
    const dueSoon = openProjects.reduce((n, p) => n + p.dueSoonMilestones.length, 0);
    const unsigned = new Set(
      openProjects.flatMap((p) => p.unsignedContracts.map((ct) => ct.id))
    );
    // Contratos ligados a leads (aún sin proyecto) también cuentan como sin firmar.
    const leadUnsigned = contracts.filter(
      (ct) => !ct.projectId && (ct.status === "draft" || ct.status === "in_review" || ct.status === "sent")
    );
    leadUnsigned.forEach((ct) => unsigned.add(ct.id));
    return {
      overdueMilestones,
      overdueInvoices,
      overdueRenewals,
      overdue: overdueMilestones + overdueInvoices + overdueRenewals,
      dueSoon,
      unsigned: unsigned.size,
    };
  }, [billing, contracts, collections]);

  const unquoted = estimates.filter((e) => e.valueCents == null).length;

  const tabs: Array<{ id: SalesTab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }> = [
    {
      id: "cobros",
      label: "Cobros",
      icon: HandCoins,
      badge: kpis.overdue > 0 ? kpis.overdue : undefined,
    },
    { id: "propuestas", label: "Propuestas", icon: FileText, badge: unquoted > 0 ? unquoted : undefined },
    {
      id: "contratos",
      label: "Contratos",
      icon: FileSignature,
      badge: kpis.unsigned > 0 ? kpis.unsigned : undefined,
    },
  ];

  const toggleDone = (m: MilestoneItem) => runAction(() => crmApi.updateMilestone(m.id, { done: !m.doneAt }));
  const editMilestone = (m: MilestoneItem, projectName: string) =>
    setMilestoneTarget({ mode: "edit", milestone: m, projectName });
  const deleteMilestone = (m: MilestoneItem) => {
    if (!window.confirm(`¿Eliminar el hito "${m.title}"? Las tareas ligadas conservan su historial.`)) return;
    runAction(() => crmApi.deleteMilestone(m.id));
  };
  const moveContract = (ct: ContractItem, target: ContractItem["status"]) => {
    if (target === "void") {
      const reason = window.prompt(`Motivo de anular "${ct.title}":`);
      if (!reason || !reason.trim()) return;
      runAction(() => crmApi.moveContractStatus(ct.id, "void", reason.trim()));
      return;
    }
    runAction(() => crmApi.moveContractStatus(ct.id, target));
  };

  return (
    <div className="space-y-5">
      {/* Encabezado + pestañas */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <HandCoins className="w-5 h-5 text-emerald-400" /> Ventas
          </h2>
          <p className="text-xs text-zinc-500 mt-1">
            Propuestas, contratos y cobros: lo mismo que guardan los agentes, a mano.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load()}
            title="Recargar"
            className={btnGhost}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          {tab === "cobros" && (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowSubscriptionForm({ mode: "new" })} className={btnGhost}>
                <Repeat className="w-3.5 h-3.5 inline mr-1" /> Suscripción
              </button>
              <button onClick={() => setShowInvoiceForm({ mode: "new" })} className={btnPrimary}>
                <Plus className="w-3.5 h-3.5 inline mr-1" /> Nueva factura
              </button>
            </div>
          )}
          {tab === "propuestas" && (
            <button onClick={() => setShowEstimateForm(true)} className={btnPrimary}>
              <Plus className="w-3.5 h-3.5 inline mr-1" /> Nueva propuesta
            </button>
          )}
          {tab === "contratos" && (
            <button onClick={() => setShowContractForm(true)} className={btnPrimary}>
              <Plus className="w-3.5 h-3.5 inline mr-1" /> Nuevo contrato
            </button>
          )}
        </div>
      </div>

      {/* Pestañas */}
      <div className="flex gap-1 border-b border-zinc-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition flex items-center gap-2 border-b-2 -mb-px ${
              tab === t.id
                ? "border-emerald-400 text-white"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.badge != null && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-amber-500 text-black">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {actionError && (
        <p className="text-xs text-rose-300 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
          {actionError}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : loadError ? (
        <EmptyState icon={TriangleAlert} title="No se pudo cargar Ventas" hint={loadError} />
      ) : (
        <>
          {/* COBROS */}
          {tab === "cobros" && (
            <div className="space-y-4">
              {/* Dinero real: facturas y suscripciones (el biller y sus recordatorios leen esto) */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KpiCard label="Por cobrar" value={collections ? moneyByCurrency(collections.outstandingCents) : "—"} tone={collections && Object.keys(collections.outstandingCents).length > 0 ? "amber" : "zinc"} />
                <KpiCard label="Vencido" value={collections ? moneyByCurrency(collections.overdueCents) : "—"} tone={collections && Object.keys(collections.overdueCents).length > 0 ? "rose" : "zinc"} />
                <KpiCard label="MRR (suscripciones)" value={collections ? moneyByCurrency(collections.mrrCents) : "—"} tone={collections && Object.keys(collections.mrrCents).length > 0 ? "emerald" : "zinc"} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KpiCard label="Hitos vencidos" value={kpis.overdueMilestones} tone={kpis.overdueMilestones > 0 ? "rose" : "zinc"} />
                <KpiCard label="Vencen en 7 días" value={kpis.dueSoon} tone={kpis.dueSoon > 0 ? "amber" : "zinc"} />
                <KpiCard label="Contratos sin firmar" value={kpis.unsigned} tone={kpis.unsigned > 0 ? "sky" : "zinc"} />
              </div>

              {/* FACTURAS */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/70">
                  <div className="text-sm font-semibold text-white flex items-center gap-2">
                    <Receipt className="w-4 h-4 text-emerald-400" /> Facturas
                  </div>
                  <span className="text-xs text-zinc-500">Pagada solo pagando; el saldo recalcula solo.</span>
                </div>

                {(collections?.invoices.length ?? 0) === 0 ? (
                  <p className="px-4 py-3 text-xs text-zinc-500">
                    Sin facturas todavía: crea la primera o deja que la factura nazca de un hito acordado.
                  </p>
                ) : (
                  <div className="divide-y divide-zinc-800/70 px-4">
                    {[...(collections?.invoices ?? [])]
                      .sort((a, b) => {
                        const rank = (i: InvoiceItem) =>
                          i.status === "overdue" ? 0 : i.status === "sent" ? 1 : i.status === "draft" ? 2 : 3;
                        return rank(a) - rank(b) || (a.dueAt ?? "").localeCompare(b.dueAt ?? "");
                      })
                      .slice(0, 30)
                      .map((inv) => (
                        <div key={inv.id} className="flex items-center gap-3 py-2.5">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-zinc-200 flex items-center gap-2 flex-wrap">
                              <span className="font-mono">{inv.number}</span>
                              <Badge tone={INVOICE_STATUS[inv.status].tone}>{INVOICE_STATUS[inv.status].label}</Badge>
                              {inv.pendingReminder && <Badge tone="amber">Recordatorio en revisión</Badge>}
                            </div>
                            <div className="text-xs text-zinc-500 mt-0.5 truncate">
                              {inv.organizationName ?? "Sin organización"}
                              {inv.projectName ? ` · ${inv.projectName}` : ""}
                              {inv.dueAt ? ` · Vence ${fmtDate(inv.dueAt)}` : ""}
                              {inv.paidCents > 0 ? ` · Pagado ${fmtMoneyExact(inv.paidCents, inv.currency)}` : ""}
                            </div>
                          </div>
                          <div className="text-sm font-mono text-zinc-200 shrink-0">
                            {fmtMoneyExact(inv.amountCents, inv.currency)}
                          </div>
                          {inv.status === "draft" && (
                            <button
                              type="button"
                              onClick={() => runAction(() => crmApi.updateInvoice(inv.id, { status: "sent" }))}
                              disabled={busy}
                              title="Marcar como enviada"
                              className={btnIcon}
                            >
                              <FileText className="w-4 h-4" />
                            </button>
                          )}
                          {(inv.status === "sent" || inv.status === "overdue") && (
                            <button
                              type="button"
                              onClick={() => setPaymentInvoice(inv)}
                              disabled={busy}
                              title="Registrar pago"
                              className={btnIcon}
                            >
                              <CreditCard className="w-4 h-4 text-emerald-400" />
                            </button>
                          )}
                          {inv.status !== "paid" && inv.status !== "cancelled" && (
                            <>
                              <button
                                type="button"
                                onClick={() => setShowInvoiceForm({ mode: "edit", invoice: inv })}
                                disabled={busy}
                                title="Editar factura"
                                className={btnIcon}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!window.confirm(`¿Cancelar la factura ${inv.number}? No se puede pagar una cancelada.`)) return;
                                  runAction(() => crmApi.updateInvoice(inv.id, { status: "cancelled" }));
                                }}
                                disabled={busy}
                                title="Cancelar factura"
                                className={btnIcon}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* SUSCRIPCIONES */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/70">
                  <div className="text-sm font-semibold text-white flex items-center gap-2">
                    <Repeat className="w-4 h-4 text-emerald-400" /> Suscripciones
                  </div>
                  <button onClick={() => setShowSubscriptionForm({ mode: "new" })} className={btnGhost}>
                    <Plus className="w-3.5 h-3.5 inline mr-1" /> Nueva
                  </button>
                </div>

                {(collections?.subscriptions.length ?? 0) === 0 ? (
                  <p className="px-4 py-3 text-xs text-zinc-500">
                    Sin suscripciones: hosting, mantenimiento o SaaS recurrente se registran aquí para que el biller avise la renovación.
                  </p>
                ) : (
                  <div className="divide-y divide-zinc-800/70 px-4">
                    {[...(collections?.subscriptions ?? [])]
                      .sort((a, b) => {
                        const rank = (s: SubscriptionItem) =>
                          s.status === "active" ? (s.dueInDays != null && s.dueInDays < 0 ? 0 : 1) : 2;
                        return rank(a) - rank(b) || (a.nextRenewalAt ?? "").localeCompare(b.nextRenewalAt ?? "");
                      })
                      .map((sub) => {
                        const state = renewalState(sub);
                        return (
                          <div key={sub.id} className="flex items-center gap-3 py-2.5">
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-zinc-200 flex items-center gap-2 flex-wrap">
                                {sub.name}
                                <Badge tone={state.tone}>{state.label}</Badge>
                                {sub.pendingReminder && <Badge tone="amber">Aviso en revisión</Badge>}
                              </div>
                              <div className="text-xs text-zinc-500 mt-0.5 truncate">
                                {sub.organizationName ?? "Sin organización"} · cada {CADENCE_LABEL[sub.cadence]}
                              </div>
                            </div>
                            <div className="text-sm font-mono text-zinc-200 shrink-0">
                              {fmtMoneyExact(sub.amountCents, sub.currency)}
                            </div>
                            {sub.status === "active" && (
                              <button
                                type="button"
                                onClick={() => runAction(() => crmApi.renewSubscription(sub.id))}
                                disabled={busy}
                                title="Renovar: avanza una cadencia completa"
                                className={btnIcon}
                              >
                                <RefreshCw className="w-4 h-4 text-emerald-400" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setShowSubscriptionForm({ mode: "edit", subscription: sub })}
                              disabled={busy}
                              title="Editar suscripción"
                              className={btnIcon}
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* HITOS POR PROYECTO */}
              <div className="text-sm font-semibold text-white flex items-center gap-2 pt-1">
                <Banknote className="w-4 h-4 text-emerald-400" /> Hitos por proyecto
              </div>

              {billing.length === 0 ? (
                <EmptyState
                  icon={HandCoins}
                  title="Sin proyectos abiertos"
                  hint="Los hitos de cobro aparecen aquí por proyecto (onboarding, activo o en pausa)."
                />
              ) : (
                billing.map((p) => (
                  <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40">
                    <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800/70">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white flex items-center gap-2 flex-wrap">
                          {p.name}
                          <Badge tone="slate">{p.status}</Badge>
                        </div>
                        <div className="text-xs text-zinc-500 mt-0.5">{p.organizationName ?? "Sin organización"}</div>
                      </div>
                      <button
                        onClick={() => setMilestoneTarget({ mode: "new", projectId: p.id, projectName: p.name })}
                        className={btnGhost}
                      >
                        <Plus className="w-3.5 h-3.5 inline mr-1" /> Agregar hito
                      </button>
                    </div>

                    {p.milestones.length === 0 ? (
                      <p className="px-4 py-3 text-xs text-zinc-500">
                        Sin hitos todavía: agrega los acuerdos de cobro para que el biller los siga.
                      </p>
                    ) : (
                      <div className="divide-y divide-zinc-800/70 px-4">
                        {[...p.milestones]
                          .sort((a, b) => {
                            // Vencidos y pendientes primero, hechos al final.
                            const rank = (m: MilestoneItem) => (m.doneAt ? 2 : milestoneState(m).tone === "rose" ? 0 : 1);
                            return rank(a) - rank(b) || (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
                          })
                          .map((m) => (
                            <MilestoneRow
                              key={m.id}
                              milestone={m}
                              onToggleDone={toggleDone}
                              onEdit={(mm) => editMilestone(mm, p.name)}
                              onDelete={deleteMilestone}
                              busy={busy}
                            />
                          ))}
                      </div>
                    )}

                    {p.unsignedContracts.length > 0 && (
                      <div className="px-4 py-2.5 border-t border-zinc-800/70 text-xs text-zinc-400 flex items-center gap-2 flex-wrap">
                        <FileSignature className="w-3.5 h-3.5 text-sky-400" />
                        {p.unsignedContracts.map((ct) => (
                          <span key={ct.id} className="inline-flex items-center gap-1.5">
                            “{ct.title}” · {CONTRACT_STATUS[ct.status].label.toLowerCase()}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* PROPUESTAS */}
          {tab === "propuestas" && (
            <div className="space-y-3">
              {estimates.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title="Sin propuestas guardadas"
                  hint="Las que redacta Eve (solutions) y las que captures a mano viven aquí."
                />
              ) : (
                estimates.map((e) => (
                  <div key={e.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white">{e.organizationName ?? "Sin organización"}</div>
                        <div className="text-xs text-zinc-500 mt-0.5">
                          {CATEGORY_LABEL.get(e.category) ?? e.category} ·{" "}
                          {COMPLEXITY_LABEL[e.complexity] ?? e.complexity} · {fmtDateTime(e.createdAt)} · {e.createdBy}
                        </div>
                      </div>
                      {e.valueCents != null ? (
                        <span className="text-sm font-semibold font-mono text-emerald-300">
                          {fmtMoney(e.valueCents, e.currency)}
                        </span>
                      ) : (
                        <Badge tone="amber">Sin cotizar</Badge>
                      )}
                    </div>
                    <p className="text-sm text-zinc-300 mt-2 whitespace-pre-wrap">{e.scopeSummary}</p>
                    {e.phases.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {e.phases.map((ph, i) => (
                          <Badge key={i} tone="cyan">
                            {ph.title}
                            {ph.timeframe ? ` · ${ph.timeframe}` : ""}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {e.timelineText && (
                      <div className="text-xs text-zinc-500 mt-2">Timeline: {e.timelineText}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* CONTRATOS */}
          {tab === "contratos" && (
            <div className="space-y-3">
              {contracts.length === 0 ? (
                <EmptyState
                  icon={FileSignature}
                  title="Sin contratos"
                  hint="Los borradores de Eve (legal) y los tuyos aparecen aquí con su máquina de estados."
                />
              ) : (
                contracts.map((ct) => {
                  const actions = contractActions(ct.status);
                  const st = CONTRACT_STATUS[ct.status];
                  const expanded = expandedContract === ct.id;
                  return (
                    <div key={ct.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-white flex items-center gap-2 flex-wrap">
                            {ct.title}
                            <Badge tone={st.tone}>{st.label}</Badge>
                          </div>
                          <div className="text-xs text-zinc-500 mt-0.5">
                            {[
                              ct.organizationName ?? "Sin organización",
                              ct.projectName ? `Proyecto: ${ct.projectName}` : "Vía lead",
                              `Creado ${fmtDateTime(ct.createdAt)}`,
                            ].join(" · ")}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {actions.map((a) => (
                            <button
                              key={a.target}
                              onClick={() => moveContract(ct, a.target)}
                              disabled={busy}
                              className={a.primary ? btnPrimary : btnGhost}
                            >
                              {a.target === "signed" && "✅ "}
                              {a.label}
                            </button>
                          ))}
                          <button
                            onClick={() => setExpandedContract(expanded ? null : ct.id)}
                            title={expanded ? "Ocultar cuerpo" : "Ver cuerpo"}
                            className={btnIcon}
                          >
                            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {ct.reviewerNote && (
                        <p className="text-xs text-amber-300/90 mt-2">Nota de revisión: {ct.reviewerNote}</p>
                      )}
                      {ct.status === "void" && ct.voidReason && (
                        <p className="text-xs text-rose-300/90 mt-2">Anulado: {ct.voidReason}</p>
                      )}

                      {expanded && (
                        <pre className="mt-3 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 whitespace-pre-wrap font-sans">
                          {ct.body}
                        </pre>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      {/* Formularios */}
      {showEstimateForm && (
        <NewEstimateModal
          organizations={orgs}
          onSaved={() => {
            setShowEstimateForm(false);
            setTab("propuestas");
            load();
          }}
          onClose={() => setShowEstimateForm(false)}
        />
      )}
      {showContractForm && (
        <NewContractModal
          projects={projects}
          leads={leads}
          onSaved={() => {
            setShowContractForm(false);
            setTab("contratos");
            load();
          }}
          onClose={() => setShowContractForm(false)}
        />
      )}
      {milestoneTarget && (
        <MilestoneModal
          target={milestoneTarget}
          onSaved={() => {
            setMilestoneTarget(null);
            load();
          }}
          onClose={() => setMilestoneTarget(null)}
        />
      )}
      {showInvoiceForm && (
        <InvoiceModal
          target={showInvoiceForm}
          orgs={orgs}
          projects={projects}
          onSaved={() => {
            setShowInvoiceForm(null);
            load();
          }}
          onClose={() => setShowInvoiceForm(null)}
        />
      )}
      {paymentInvoice && (
        <PaymentModal
          invoice={paymentInvoice}
          onSaved={() => {
            setPaymentInvoice(null);
            load();
          }}
          onClose={() => setPaymentInvoice(null)}
        />
      )}
      {showSubscriptionForm && (
        <SubscriptionModal
          target={showSubscriptionForm}
          orgs={orgs}
          onSaved={() => {
            setShowSubscriptionForm(null);
            load();
          }}
          onClose={() => setShowSubscriptionForm(null)}
        />
      )}
    </div>
  );
};

const KpiCard: React.FC<{ label: string; value: number | string; tone: "zinc" | "rose" | "amber" | "sky" | "emerald" }> = ({
  label,
  value,
  tone,
}) => {
  const valueTone =
    tone === "rose"
      ? "text-rose-300"
      : tone === "amber"
      ? "text-amber-300"
      : tone === "sky"
      ? "text-sky-300"
      : tone === "emerald"
      ? "text-emerald-300"
      : "text-zinc-200";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <div className={`text-2xl font-bold ${valueTone}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
};
