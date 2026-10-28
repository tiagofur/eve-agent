import React, { useEffect, useState } from "react";
import { crmApi, TicketItem, TicketDetailsResponse } from "../api";
import { FollowUpForm } from "./FollowUpForm";
import {
  LifeBuoy,
  AlertTriangle,
  Clock,
  CheckCircle2,
  RefreshCw,
  Search,
  Mail,
  Flame,
  ShieldAlert,
  X,
  Check,
  Ban,
  History,
  FileText,
  Terminal,
} from "lucide-react";

const SEVERITY_CONFIG: Record<
  "critical" | "major" | "minor",
  { label: string; badge: string; icon: React.ReactNode }
> = {
  critical: {
    label: "Critical (1h SLA)",
    badge: "bg-rose-950/80 text-rose-300 border border-rose-700",
    icon: <Flame className="w-3.5 h-3.5 text-rose-400" />,
  },
  major: {
    label: "Major (4h SLA)",
    badge: "bg-amber-950/80 text-amber-300 border border-amber-700",
    icon: <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />,
  },
  minor: {
    label: "Minor (24h SLA)",
    badge: "bg-blue-950/80 text-blue-300 border border-blue-700",
    icon: <Clock className="w-3.5 h-3.5 text-blue-400" />,
  },
};

const STATUS_LABELS: Record<string, { label: string; badge: string }> = {
  open: { label: "Pending Review", badge: "bg-amber-950 text-amber-300 border border-amber-800" },
  in_progress: {
    label: "In Progress / Approved",
    badge: "bg-cyan-950 text-cyan-300 border border-cyan-800",
  },
  waiting_client: {
    label: "Waiting Client",
    badge: "bg-purple-950 text-purple-300 border border-purple-800",
  },
  resolved: {
    label: "Resolved",
    badge: "bg-emerald-950 text-emerald-300 border border-emerald-800",
  },
  closed: {
    label: "Rejected / Closed",
    badge: "bg-zinc-850 text-zinc-400 border border-zinc-700",
  },
};

export const TicketsView: React.FC = () => {
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");

  // Drawer details state
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [ticketDetails, setTicketDetails] = useState<TicketDetailsResponse | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Rejection modal state
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [clientExplanation, setClientExplanation] = useState("");

  // Resolve modal state (internal note + client-facing explanation)
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [resolveNote, setResolveNote] = useState("");
  const [resolveClientMsg, setResolveClientMsg] = useState("");
  const [submittingAction, setSubmittingAction] = useState(false);

  const fetchTickets = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await crmApi.getTickets();
      setTickets(res.tickets);
    } catch (err: any) {
      setError(err.message || "Failed to load support tickets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTickets();
  }, []);

  const openTicketDrawer = async (ticketId: string) => {
    setActiveTicketId(ticketId);
    setDrawerLoading(true);
    try {
      const details = await crmApi.getTicketDetails(ticketId);
      setTicketDetails(details);
    } catch (err: any) {
      alert(`Could not load ticket details: ${err.message}`);
      setActiveTicketId(null);
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    setActiveTicketId(null);
    setTicketDetails(null);
    setShowRejectModal(false);
    setShowResolveModal(false);
  };

  const handleApproveTicket = async (ticketId: string) => {
    try {
      setSubmittingAction(true);
      await crmApi.updateTicketStatus(
        ticketId,
        "in_progress",
        "Owner approved ticket: agent initiated incident triage and resolution flow"
      );
      setActionSuccess("Ticket aprobado. Agente de soporte notificado para iniciar la resolución.");
      openTicketDrawer(ticketId);
      fetchTickets();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error approving ticket: ${err.message}`);
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleRejectTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTicketId) return;

    try {
      setSubmittingAction(true);
      await crmApi.updateTicketStatus(
        activeTicketId,
        "closed",
        rejectReason || "Ticket desestimado por el propietario",
        clientExplanation
      );
      setActionSuccess("Ticket rechazado y respuesta al cliente registrada.");
      setShowRejectModal(false);
      setRejectReason("");
      setClientExplanation("");
      openTicketDrawer(activeTicketId);
      fetchTickets();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error rejecting ticket: ${err.message}`);
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleResolveTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTicketId) return;

    try {
      setSubmittingAction(true);
      await crmApi.updateTicketStatus(
        activeTicketId,
        "resolved",
        resolveNote || "Incidente resuelto satisfactoriamente por el equipo",
        resolveClientMsg || undefined
      );
      setActionSuccess("Ticket marcado como Resuelto con éxito.");
      setShowResolveModal(false);
      setResolveNote("");
      setResolveClientMsg("");
      openTicketDrawer(activeTicketId);
      fetchTickets();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error resolving ticket: ${err.message}`);
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleEditDescription = async (ticketId: string, current: string) => {
    const next = window.prompt(
      "Corrige la descripción del problema (qué pasa, esperado, impacto, pasos):",
      current
    );
    if (next === null || next.trim() === current.trim()) return;
    try {
      setSubmittingAction(true);
      await crmApi.updateTicketContent(ticketId, {
        description: next.trim(),
        reason: "Descripción corregida desde el drawer del ticket",
      });
      setActionSuccess("Descripción del ticket corregida.");
      openTicketDrawer(ticketId);
      fetchTickets();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error editando el ticket: ${err.message}`);
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleReopenTicket = async (ticketId: string) => {
    try {
      setSubmittingAction(true);
      await crmApi.updateTicketStatus(ticketId, "open", "Reabierto por el owner");
      setActionSuccess("Ticket reabierto (pendiente de triage).");
      openTicketDrawer(ticketId);
      fetchTickets();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error reabriendo el ticket: ${err.message}`);
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleCloseConfirmed = async (ticketId: string) => {
    try {
      setSubmittingAction(true);
      await crmApi.updateTicketStatus(ticketId, "closed", "Cliente confirmó la solución");
      setActionSuccess("Ticket cerrado tras confirmación del cliente.");
      openTicketDrawer(ticketId);
      fetchTickets();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error cerrando el ticket: ${err.message}`);
    } finally {
      setSubmittingAction(false);
    }
  };

  const openTickets = tickets.filter((t) => t.status === "open" || t.status === "in_progress");
  const criticalCount = openTickets.filter((t) => t.severity === "critical").length;
  const majorCount = openTickets.filter((t) => t.severity === "major").length;
  const resolvedCount = tickets.filter((t) => t.status === "resolved").length;

  const filtered = tickets.filter((t) => {
    const matchesSev = severityFilter === "all" || t.severity === severityFilter;
    const matchesStat = statusFilter === "all" || t.status === statusFilter;
    const matchesKind = kindFilter === "all" || (t.kind || "support") === kindFilter;
    const q = search.toLowerCase();
    const matchesSearch =
      !search ||
      t.system.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.contactName?.toLowerCase().includes(q) ||
      t.contactEmail?.toLowerCase().includes(q);
    return matchesSev && matchesStat && matchesKind && matchesSearch;
  });

  const isBreached = (slaDueAt: string, status: string) => {
    if (status === "resolved" || status === "closed") return false;
    return new Date(slaDueAt).getTime() < Date.now();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <LifeBuoy className="w-7 h-7 text-indigo-400" />
            Support Incidents & SLA Desk
          </h2>
          <p className="text-sm text-zinc-400">
            Triaged client tickets with contractual SLA timers and Human-in-the-Loop review.
          </p>
        </div>
        <button
          onClick={fetchTickets}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {actionSuccess && (
        <div className="p-3 bg-emerald-950/60 border border-emerald-800 text-emerald-300 rounded-lg flex items-center gap-2 text-sm shadow-md">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {actionSuccess}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <div className="text-xs text-zinc-400 font-medium">Active Incidents</div>
          <div className="text-2xl font-bold text-white mt-1">{openTickets.length}</div>
        </div>
        <div className="bg-rose-950/20 border border-rose-900/40 rounded-xl p-4">
          <div className="text-xs text-rose-300 font-medium flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-rose-400" /> Critical (1h)
          </div>
          <div className="text-2xl font-bold text-rose-300 mt-1">{criticalCount}</div>
        </div>
        <div className="bg-amber-950/20 border border-amber-900/40 rounded-xl p-4">
          <div className="text-xs text-amber-300 font-medium flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> Major (4h)
          </div>
          <div className="text-2xl font-bold text-amber-300 mt-1">{majorCount}</div>
        </div>
        <div className="bg-emerald-950/20 border border-emerald-900/40 rounded-xl p-4">
          <div className="text-xs text-emerald-300 font-medium flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Resolved
          </div>
          <div className="text-2xl font-bold text-emerald-300 mt-1">{resolvedCount}</div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-950/50 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-3 text-sm">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-3 text-zinc-400" />
          <input
            type="text"
            placeholder="Search tickets by system, issue description, client email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">Soporte + Info</option>
            <option value="support">Soporte</option>
            <option value="info">Info/Ventas</option>
          </select>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">All Statuses</option>
            <option value="open">Pending Review</option>
            <option value="in_progress">In Progress</option>
            <option value="waiting_client">Waiting Client</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed / Rejected</option>
          </select>
        </div>
      </div>

      {/* Ticket List */}
      <div className="space-y-3">
        {loading && tickets.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">Loading support tickets...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/40 border border-zinc-800 rounded-xl">
            No support tickets found matching criteria.
          </div>
        ) : (
          filtered.map((ticket) => {
            const sev = SEVERITY_CONFIG[ticket.severity] || SEVERITY_CONFIG.minor;
            const breached = isBreached(ticket.slaDueAt, ticket.status);
            const statusConfig = STATUS_LABELS[ticket.status] || {
              label: ticket.status,
              badge: "bg-zinc-800 text-zinc-300",
            };
            return (
              <div
                key={ticket.id}
                onClick={() => openTicketDrawer(ticket.id)}
                className={`p-4 rounded-xl border transition cursor-pointer group ${
                  breached
                    ? "bg-rose-950/20 border-rose-800/80 hover:border-rose-600 shadow-md shadow-rose-950/20"
                    : "bg-zinc-900/60 border-zinc-800 hover:border-indigo-500/60"
                }`}
              >
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        (ticket.kind || "support") === "info"
                          ? "bg-teal-950 text-teal-300 border border-teal-800"
                          : "bg-indigo-950 text-indigo-300 border border-indigo-800"
                      }`}
                    >
                      {(ticket.kind || "support") === "info" ? "Info/Ventas" : "Soporte"}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${sev.badge}`}
                    >
                      {sev.icon}
                      {sev.label}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono font-medium">
                      System: {ticket.system}
                    </span>
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-semibold ${statusConfig.badge}`}
                    >
                      {statusConfig.label}
                    </span>
                  </div>

                  {/* SLA due time */}
                  <div
                    className={`flex items-center gap-1.5 text-xs font-medium ${
                      breached
                        ? "text-rose-400 font-bold animate-pulse"
                        : ticket.status === "resolved"
                        ? "text-emerald-400"
                        : "text-zinc-400"
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    {ticket.status === "resolved" ? (
                      <span>Resolved</span>
                    ) : breached ? (
                      <span>SLA BREACHED: {new Date(ticket.slaDueAt).toLocaleTimeString()}</span>
                    ) : (
                      <span>SLA Due: {new Date(ticket.slaDueAt).toLocaleTimeString()}</span>
                    )}
                  </div>
                </div>

                <p className="text-sm text-zinc-200 mt-2 leading-relaxed group-hover:text-white transition">
                  {ticket.description}
                </p>

                <div className="flex items-center justify-between text-xs text-zinc-500 mt-3 pt-3 border-t border-zinc-800/60">
                  <div className="flex items-center gap-4">
                    {ticket.contactName && (
                      <span className="text-zinc-400 font-medium">{ticket.contactName}</span>
                    )}
                    {ticket.contactEmail && (
                      <span className="flex items-center gap-1 text-zinc-500">
                        <Mail className="w-3 h-3" />
                        {ticket.contactEmail}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span>Reported {new Date(ticket.createdAt).toLocaleString()}</span>
                    <span className="text-indigo-400 font-medium ml-2">Click to review →</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Slide-over Drawer for Ticket Incident Review */}
      {activeTicketId && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-2xl bg-zinc-950 border-l border-zinc-800 h-full flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
            {/* Drawer Header */}
            <div className="p-6 border-b border-zinc-800/80 flex items-start justify-between bg-zinc-900/40">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-indigo-400 uppercase font-semibold">
                    Support Incident Desk
                  </span>
                  {ticketDetails && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                        STATUS_LABELS[ticketDetails.ticket.status]?.badge || "bg-zinc-800"
                      }`}
                    >
                      {STATUS_LABELS[ticketDetails.ticket.status]?.label ||
                        ticketDetails.ticket.status}
                    </span>
                  )}
                </div>
                <h3 className="text-xl font-bold text-white mt-1">
                  System: {ticketDetails?.ticket.system || "Loading..."}
                </h3>
                {ticketDetails && (
                  <div className="flex items-center gap-3 text-xs text-zinc-400 mt-1">
                    <span>ID: {ticketDetails.ticket.id}</span>
                    <span className="text-zinc-600">•</span>
                    <span>Created: {new Date(ticketDetails.ticket.createdAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
              <button
                onClick={closeDrawer}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {drawerLoading ? (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                <RefreshCw className="w-5 h-5 animate-spin mr-2" />
                Loading incident history and SLA status...
              </div>
            ) : ticketDetails ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  <FollowUpForm
                    kind="ticket"
                    entityId={ticketDetails.ticket.id}
                    currentAt={ticketDetails.ticket.nextFollowUpAt}
                    currentNote={ticketDetails.ticket.followUpNote}
                    onSaved={() => openTicketDrawer(ticketDetails.ticket.id)}
                  />
                  {/* SLA Status Banner */}
                  <div
                    className={`p-4 rounded-xl border flex items-center justify-between ${
                      isBreached(ticketDetails.ticket.slaDueAt, ticketDetails.ticket.status)
                        ? "bg-rose-950/30 border-rose-800 text-rose-300"
                        : ticketDetails.ticket.status === "resolved"
                        ? "bg-emerald-950/30 border-emerald-800 text-emerald-300"
                        : "bg-indigo-950/30 border-indigo-800 text-indigo-300"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Clock className="w-5 h-5" />
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wider">
                          SLA Guarantee
                        </div>
                        <div className="text-sm font-medium mt-0.5">
                          {ticketDetails.ticket.status === "resolved" ? (
                            <span>
                              Resolved at{" "}
                              {ticketDetails.ticket.resolvedAt
                                ? new Date(ticketDetails.ticket.resolvedAt).toLocaleString()
                                : "N/A"}
                            </span>
                          ) : isBreached(
                              ticketDetails.ticket.slaDueAt,
                              ticketDetails.ticket.status
                            ) ? (
                            <span className="font-bold text-rose-400">
                              BREACHED at{" "}
                              {new Date(ticketDetails.ticket.slaDueAt).toLocaleString()}
                            </span>
                          ) : (
                            <span>
                              Contractual Due:{" "}
                              {new Date(ticketDetails.ticket.slaDueAt).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-xs px-2.5 py-1 rounded-full font-semibold uppercase ${
                        SEVERITY_CONFIG[ticketDetails.ticket.severity]?.badge
                      }`}
                    >
                      {ticketDetails.ticket.severity}
                    </span>
                  </div>

                  {/* Client Information */}
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-2">
                    <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                      Client & Reporter Details
                    </h4>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-zinc-500">Contact Name:</span>
                        <div className="font-medium text-white mt-0.5">
                          {ticketDetails.ticket.contactName || "Direct Web Inbound"}
                        </div>
                      </div>
                      <div>
                        <span className="text-zinc-500">Email:</span>
                        <div className="font-medium text-white mt-0.5 flex items-center gap-1">
                          <Mail className="w-3 h-3 text-zinc-400" />
                          {ticketDetails.ticket.contactEmail || "N/A"}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Problem Description */}
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-2">
                    <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-indigo-400" /> Issue Description
                      <button
                        onClick={() =>
                          handleEditDescription(
                            ticketDetails.ticket.id,
                            ticketDetails.ticket.description
                          )
                        }
                        disabled={submittingAction}
                        className="ml-auto text-[11px] font-medium text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                      >
                        Editar
                      </button>
                    </h4>
                    <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800/80 text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">
                      {ticketDetails.ticket.description}
                    </div>
                  </div>

                  {/* Linked correction tasks */}
                  {ticketDetails.tasks && ticketDetails.tasks.length > 0 && (
                    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-2">
                      <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-indigo-400" /> Correcciones vinculadas
                      </h4>
                      {ticketDetails.tasks.map((t) => (
                        <div
                          key={t.id}
                          className="bg-zinc-950 border border-zinc-800/80 rounded-lg p-3 space-y-1"
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800">
                              {t.status}
                            </span>
                            <span className="text-xs text-zinc-200 font-medium flex-1 min-w-0 truncate">
                              {t.title}
                            </span>
                            {t.prUrl && (
                              <a
                                href={t.prUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-cyan-400 hover:underline"
                              >
                                PR
                              </a>
                            )}
                          </div>
                          {t.resultSummary && (
                            <details>
                              <summary className="text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300">
                                Reporte del agente
                              </summary>
                              <pre className="mt-1 text-[10px] text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
                                {t.resultSummary}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Audit Timeline */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5 text-indigo-400" /> Incident Timeline & Audit Log
                    </h4>
                    {ticketDetails.timeline.length === 0 ? (
                      <div className="text-xs text-zinc-500 p-3 bg-zinc-900/40 rounded-lg">
                        No state transitions recorded yet.
                      </div>
                    ) : (
                      ticketDetails.timeline.map((ev) => (
                        <div
                          key={ev.id}
                          className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl text-xs space-y-1"
                        >
                          <div className="flex justify-between items-center">
                            <span className="font-semibold text-indigo-400 font-mono">
                              {ev.action}
                            </span>
                            <span className="text-zinc-500">
                              {new Date(ev.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-zinc-400">
                            Actor: <span className="text-zinc-200">{ev.actor}</span>
                          </div>
                          {ev.reason && (
                            <div className="text-zinc-300 bg-zinc-950 p-2 rounded border border-zinc-800/60 mt-1">
                              {ev.reason}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Human-in-the-Loop Action Bar */}
                <div className="p-4 border-t border-zinc-800 bg-zinc-900/80 flex items-center gap-3">
                  {ticketDetails.ticket.status === "open" && (
                    <>
                      <button
                        onClick={() => handleApproveTicket(ticketDetails.ticket.id)}
                        disabled={submittingAction}
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold rounded-lg transition shadow-md disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" /> Aprobar Ticket (Iniciar Atención)
                      </button>
                      <button
                        onClick={() => setShowRejectModal(true)}
                        disabled={submittingAction}
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-800 text-xs font-semibold rounded-lg transition disabled:opacity-50"
                      >
                        <Ban className="w-4 h-4" /> Rechazar / Fuera de Alcance
                      </button>
                    </>
                  )}

                  {ticketDetails.ticket.status === "in_progress" && (
                    <button
                      onClick={() => setShowResolveModal(true)}
                      disabled={submittingAction}
                      className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold rounded-lg transition shadow-md disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Marcar como Resuelto
                    </button>
                  )}

                  {ticketDetails.ticket.status === "waiting_client" && (
                    <>
                      <button
                        onClick={() => handleCloseConfirmed(ticketDetails.ticket.id)}
                        disabled={submittingAction}
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold rounded-lg transition shadow-md disabled:opacity-50"
                      >
                        <Check className="w-4 h-4" /> Cliente confirmó: Cerrar
                      </button>
                      <button
                        onClick={() => handleReopenTicket(ticketDetails.ticket.id)}
                        disabled={submittingAction}
                        className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg transition disabled:opacity-50"
                      >
                        <RefreshCw className="w-4 h-4" /> Persiste: Reabrir atención
                      </button>
                    </>
                  )}

                  {(ticketDetails.ticket.status === "resolved" ||
                    ticketDetails.ticket.status === "closed") && (
                    <div className="w-full flex items-center gap-2">
                      <span className="flex-1 text-center text-xs text-zinc-500 py-1">
                        Finalizado ({ticketDetails.ticket.status}).
                      </span>
                      <button
                        onClick={() => handleReopenTicket(ticketDetails.ticket.id)}
                        disabled={submittingAction}
                        className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg transition disabled:opacity-50"
                      >
                        <RefreshCw className="w-3.5 h-3.5" /> Reabrir
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Reject Ticket Modal with Client Response */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-lg w-full shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-1">
              Rechazar / Desestimar Incidente
            </h3>
            <p className="text-xs text-zinc-400 mb-4">
              Indica el motivo técnico interno y la explicación que se enviará al cliente.
            </p>

            <form onSubmit={handleRejectTicket} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Motivo Interno de Rechazo
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Incidencia corresponde a caída externa de API de Meta, fuera del SLA de soporte"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-rose-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Explicación para el Cliente (Contestación formal)
                </label>
                <textarea
                  rows={4}
                  required
                  placeholder="Estimado cliente, revisamos el reporte de su sistema y determinamos que..."
                  value={clientExplanation}
                  onChange={(e) => setClientExplanation(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRejectModal(false)}
                  className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white rounded-lg bg-zinc-800 hover:bg-zinc-700 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submittingAction}
                  className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition disabled:opacity-50"
                >
                  {submittingAction ? "Guardando..." : "Confirmar Rechazo y Notificar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Resolve Ticket Modal: internal note + client-facing explanation */}
      {showResolveModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-lg w-full shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-1">Marcar como Resuelto</h3>
            <p className="text-xs text-zinc-400 mb-4">
              Nota interna para el historial y explicación que verá el cliente. Si este ticket tiene
              una corrección vinculada, al marcarla «done» el CRM ya genera el borrador de
              notificación (Outbox) — este modal es para resoluciones manuales.
            </p>

            <form onSubmit={handleResolveTicket} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Nota interna de resolución
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sesión expirada no invalidaba el token: parche aplicado y verificado"
                  value={resolveNote}
                  onChange={(e) => setResolveNote(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Explicación para el cliente (opcional)
                </label>
                <textarea
                  rows={3}
                  placeholder="Se corrigió el fallo de login al expirar la sesión. Ya puedes volver a ingresar con normalidad."
                  value={resolveClientMsg}
                  onChange={(e) => setResolveClientMsg(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowResolveModal(false)}
                  disabled={submittingAction}
                  className="flex-1 px-4 py-2 text-xs font-semibold text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submittingAction}
                  className="flex-1 px-4 py-2 text-xs font-semibold text-black bg-emerald-500 hover:bg-emerald-400 rounded-lg transition disabled:opacity-50"
                >
                  {submittingAction ? "Guardando..." : "Confirmar Resolución"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
