import React, { useEffect, useState } from "react";
import {
  crmApi,
  LeadItem,
  LeadDetailsResponse,
} from "../api";
import { FollowUpForm } from "./FollowUpForm";
import {
  SlideOver,
  Modal,
  Badge,
  InfoGrid,
  ContactActions,
  Skeleton,
} from "../components/ui";
import {
  Users,
  Search,
  RefreshCw,
  ArrowRight,
  Building2,
  Mail,
  Phone,
  AlertCircle,
  CheckCircle2,
  SlidersHorizontal,
  ExternalLink,
  Sparkles,
  History,
  Send,
  X,
  Check,
  Globe,
  FileText,
  Copy,
} from "lucide-react";

const STAGE_LABELS: Record<string, { label: string; color: string }> = {
  new: { label: "Nuevo", color: "bg-slate-700 text-slate-200" },
  researched: { label: "Investigado", color: "bg-sky-900/60 text-sky-300 border border-sky-700" },
  contacted: { label: "Contactado", color: "bg-blue-900/60 text-blue-300 border border-blue-700" },
  qualified: { label: "Calificado", color: "bg-indigo-900/60 text-indigo-300 border border-indigo-700" },
  discovery: { label: "Discovery", color: "bg-purple-900/60 text-purple-300 border border-purple-700" },
  proposal: { label: "Propuesta", color: "bg-amber-900/60 text-amber-300 border border-amber-700" },
  contract: { label: "Contrato", color: "bg-orange-900/60 text-orange-300 border border-orange-700" },
  won: { label: "Ganado 🎉", color: "bg-emerald-900/60 text-emerald-300 border border-emerald-700" },
  lost: { label: "Perdido", color: "bg-rose-900/60 text-rose-300 border border-rose-700" },
  onboarding: { label: "Onboarding", color: "bg-teal-900/60 text-teal-300 border border-teal-700" },
  active: { label: "Activo", color: "bg-emerald-800/60 text-emerald-200 border border-emerald-600" },
  support: { label: "Soporte", color: "bg-cyan-900/60 text-cyan-300 border border-cyan-700" },
};

// Tonos del Badge compartido por etapa (mismos matices que STAGE_LABELS).
const STAGE_TONES: Record<string, "slate" | "sky" | "blue" | "indigo" | "purple" | "amber" | "orange" | "emerald" | "rose" | "teal" | "cyan"> = {
  new: "slate",
  researched: "sky",
  contacted: "blue",
  qualified: "indigo",
  discovery: "purple",
  proposal: "amber",
  contract: "orange",
  won: "emerald",
  lost: "rose",
  onboarding: "teal",
  active: "emerald",
  support: "cyan",
};

// Espejo exacto de crm/src/domain/lead-stages.ts (TRANSITIONS).
const NEXT_STAGES: Record<string, string[]> = {
  new: ["researched", "contacted", "qualified", "lost"],
  researched: ["contacted", "lost"],
  contacted: ["qualified", "lost"],
  qualified: ["discovery", "lost"],
  discovery: ["proposal", "lost"],
  proposal: ["contract", "discovery", "lost"],
  contract: ["won", "lost"],
  won: ["onboarding"],
  lost: ["new"],
  onboarding: ["active"],
  active: ["support"],
  support: ["active"],
};

export const LeadsView: React.FC = () => {
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");

  // Lead Detail Drawer State
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const [leadDetails, setLeadDetails] = useState<LeadDetailsResponse | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<"intelligence" | "outreach" | "timeline">("intelligence");

  // Advance Stage Modal State
  const [selectedLead, setSelectedLead] = useState<LeadItem | null>(null);
  const [targetStage, setTargetStage] = useState<string>("");
  const [transitionReason, setTransitionReason] = useState<string>("");
  const [lostReason, setLostReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const fetchLeads = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await crmApi.getLeads();
      setLeads(res.leads);
    } catch (err: any) {
      setError(err.message || "Failed to load leads from CRM");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeads();
  }, []);

  const openLeadDrawer = async (leadId: string) => {
    setActiveLeadId(leadId);
    setDrawerLoading(true);
    setDrawerError(null);
    setLeadDetails(null);
    try {
      const details = await crmApi.getLeadDetails(leadId);
      setLeadDetails(details);
      setDrawerTab("intelligence");
    } catch (err: any) {
      setDrawerError(err.message || "No se pudo cargar la ficha del lead.");
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    setActiveLeadId(null);
    setLeadDetails(null);
    setDrawerError(null);
  };

  const openTransitionModal = (lead: LeadItem, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedLead(lead);
    const available = NEXT_STAGES[lead.stage] || [];
    setTargetStage(available[0] || "");
    setTransitionReason("");
    setLostReason("");
  };

  const handleStageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLead || !targetStage) return;

    try {
      setSubmitting(true);
      await crmApi.updateLeadStage(
        selectedLead.id,
        targetStage,
        transitionReason || `Manual transition to ${targetStage} via Desktop App`,
        targetStage === "lost" ? lostReason || "Unspecified loss" : undefined
      );
      setActionSuccess(`Lead moved to ${targetStage.replace("_", " ")}`);
      setSelectedLead(null);
      if (activeLeadId === selectedLead.id) {
        openLeadDrawer(selectedLead.id);
      }
      fetchLeads();
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error updating stage: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const [convertingId, setConvertingId] = useState<string | null>(null);

  const handleConvert = async (lead: LeadItem, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const projectName = window.prompt(
      `Convertir lead en cliente/proyecto - nombre del proyecto:`,
      lead.organizationName ? `${lead.organizationName} - Proyecto` : undefined
    );
    if (projectName === null) return;
    try {
      setConvertingId(lead.id);
      const res = await crmApi.convertLead(lead.id, projectName.trim() || undefined);
      setActionSuccess(`Cliente creado: proyecto "${res.project.name}" en onboarding.`);
      if (activeLeadId === lead.id) openLeadDrawer(lead.id);
      fetchLeads();
      setTimeout(() => setActionSuccess(null), 5000);
    } catch (err: any) {
      alert(`No se pudo convertir: ${err.message}`);
    } finally {
      setConvertingId(null);
    }
  };

  const handleCopyDraft = async (body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setActionSuccess("Mensaje copiado al portapapeles.");
      setTimeout(() => setActionSuccess(null), 3000);
    } catch {
      alert("No se pudo copiar el mensaje.");
    }
  };

  const handleReviewDraft = async (draftId: string, decision: "approved" | "rejected") => {
    try {
      await crmApi.reviewDraft(draftId, decision);
      setActionSuccess(
        decision === "approved"
          ? "Outreach message approved. Sending is manual: copy it and send it yourself."
          : "Draft rejected. Marketing agent notified to revise."
      );
      if (activeLeadId) {
        openLeadDrawer(activeLeadId);
      }
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err: any) {
      alert(`Error reviewing draft: ${err.message}`);
    }
  };

  const filtered = leads.filter((l) => {
    const matchesStage = stageFilter === "all" || l.stage === stageFilter;
    const q = search.toLowerCase();
    const matchesSearch =
      !search ||
      l.contactName?.toLowerCase().includes(q) ||
      l.organizationName?.toLowerCase().includes(q) ||
      l.contactEmail?.toLowerCase().includes(q) ||
      l.serviceType?.toLowerCase().includes(q) ||
      l.summary?.toLowerCase().includes(q);
    return matchesStage && matchesSearch;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <Users className="w-7 h-7 text-emerald-400" />
            CRM Leads & Pipeline
          </h2>
          <p className="text-sm text-zinc-400">
            AI-driven pipeline with verified dossiers, contact history, and 1-click stage actions.
          </p>
        </div>
        <button
          onClick={fetchLeads}
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

      {error && (
        <div className="p-4 bg-rose-950/50 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-3 text-sm">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-3 text-zinc-400" />
          <input
            type="text"
            placeholder="Search leads by contact, company, email, service..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-zinc-400" />
          <select
            value={stageFilter}
            onChange={(e) => setStageFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500"
          >
            <option value="all">All Stages ({leads.length})</option>
            {Object.keys(STAGE_LABELS).map((st) => (
              <option key={st} value={st}>
                {STAGE_LABELS[st].label} ({leads.filter((l) => l.stage === st).length})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900/60 backdrop-blur">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-950 text-zinc-400 text-xs uppercase tracking-wider border-b border-zinc-800">
              <tr>
                <th className="px-4 py-3">Contact & Org</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Source & Service</th>
                <th className="px-4 py-3">Summary / AI Notes</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {loading && leads.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                    Loading CRM leads...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">
                    No leads found matching your search.
                  </td>
                </tr>
              ) : (
                filtered.map((lead) => {
                  const stageMeta = STAGE_LABELS[lead.stage] || {
                    label: lead.stage,
                    color: "bg-zinc-800 text-zinc-400",
                  };
                  return (
                    <tr
                      key={lead.id}
                      onClick={() => openLeadDrawer(lead.id)}
                      className="hover:bg-zinc-800/60 cursor-pointer transition group"
                    >
                      <td className="px-4 py-3">
                        <div className="font-semibold text-white group-hover:text-emerald-400 transition flex items-center gap-1.5">
                          {lead.contactName || "Anonymous Lead"}
                        </div>
                        {lead.organizationName && (
                          <div className="flex items-center gap-1 text-xs text-zinc-400 mt-0.5">
                            <Building2 className="w-3 h-3 text-zinc-500" />
                            {lead.organizationName}
                          </div>
                        )}
                        <div className="flex items-center gap-3 text-xs text-zinc-400 mt-1">
                          {lead.contactEmail && (
                            <span className="flex items-center gap-1">
                              <Mail className="w-3 h-3 text-zinc-500" />
                              {lead.contactEmail}
                            </span>
                          )}
                          {lead.contactPhone && (
                            <span className="flex items-center gap-1">
                              <Phone className="w-3 h-3 text-zinc-500" />
                              {lead.contactPhone}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2.5 py-0.5 text-xs font-semibold rounded-full ${stageMeta.color}`}
                        >
                          {stageMeta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs font-mono text-zinc-300 uppercase">
                          {lead.source}
                        </div>
                        {lead.serviceType && (
                          <div className="text-xs text-zinc-400 mt-0.5">{lead.serviceType}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 max-w-xs truncate text-xs text-zinc-300">
                        {lead.summary || "No notes"}
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-500 whitespace-nowrap">
                        {new Date(lead.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {lead.stage === "won" && (
                          <button
                            onClick={(e) => handleConvert(lead, e)}
                            disabled={convertingId === lead.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-teal-950/80 hover:bg-teal-900 text-teal-300 border border-teal-700/60 rounded-md transition mr-2"
                          >
                            {convertingId === lead.id ? "Convirtiendo..." : "Convertir en cliente"}
                          </button>
                        )}
                        <button
                          onClick={(e) => openTransitionModal(lead, e)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/60 rounded-md transition mr-2"
                        >
                          Advance <ArrowRight className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slide-over Drawer for Lead / Prospect AI Details */}
      {activeLeadId && (
        <SlideOver
          onClose={closeDrawer}
          title={leadDetails?.lead.contactName || leadDetails?.lead.organizationName || "Lead details"}
          badge={
            leadDetails && (
              <Badge tone={STAGE_TONES[leadDetails.lead.stage] ?? "zinc"}>
                {STAGE_LABELS[leadDetails.lead.stage]?.label || leadDetails.lead.stage}
              </Badge>
            )
          }
          meta={
            leadDetails && (
              <>
                {leadDetails.lead.organizationName && (
                  <span className="flex items-center gap-1">
                    <Building2 className="w-3 h-3 text-zinc-500" />
                    {leadDetails.lead.organizationName}
                  </span>
                )}
                {leadDetails.lead.organizationDomain && (
                  <a
                    href={`https://${leadDetails.lead.organizationDomain}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-cyan-400 hover:underline"
                  >
                    <Globe className="w-3 h-3" />
                    {leadDetails.lead.organizationDomain}
                  </a>
                )}
                <span className="font-mono uppercase">{leadDetails.lead.source}</span>
                <span>Desde {new Date(leadDetails.lead.createdAt).toLocaleDateString()}</span>
              </>
            )
          }
          footer={
            leadDetails && !drawerLoading && !drawerError ? (
              <>
                <div className="text-xs text-zinc-400">
                  Lead ID:{" "}
                  <span className="font-mono text-zinc-300">{leadDetails.lead.id.slice(0, 8)}...</span>
                </div>
                <button
                  onClick={() => openTransitionModal(leadDetails.lead)}
                  className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold rounded-lg transition shadow-md"
                >
                  Advance Pipeline Stage <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </>
            ) : undefined
          }
          footerClassName="flex items-center justify-between gap-3"
        >
            {leadDetails?.lead.stage === "won" && (
              <div className="px-6 py-3 border-b border-zinc-800/80 bg-teal-950/30">
                <button
                  onClick={() =>
                    handleConvert({
                      id: leadDetails.lead.id,
                      stage: leadDetails.lead.stage,
                      source: leadDetails.lead.source,
                      serviceType: leadDetails.lead.serviceType,
                      summary: leadDetails.lead.summary,
                      createdAt: leadDetails.lead.createdAt,
                      organizationName: leadDetails.lead.organizationName,
                      contactName: leadDetails.lead.contactName,
                      contactEmail: leadDetails.lead.contactEmail,
                      contactPhone: leadDetails.lead.contactPhone ?? null,
                    })
                  }
                  disabled={convertingId === leadDetails.lead.id}
                  className="w-full px-3 py-2 text-sm font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition disabled:opacity-50"
                >
                  {convertingId === leadDetails.lead.id ? "Convirtiendo..." : "Convertir en cliente / crear proyecto"}
                </button>
              </div>
            )}

            {drawerLoading ? (
              <div className="p-6 space-y-4" aria-label="Cargando ficha del lead">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : drawerError ? (
              <div className="p-6">
                <div className="p-4 bg-rose-950/50 border border-rose-800 text-rose-300 rounded-xl flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {drawerError}
                  </span>
                  <button
                    onClick={() => openLeadDrawer(activeLeadId)}
                    className="px-3 py-1.5 text-xs font-semibold bg-rose-900/60 hover:bg-rose-900 border border-rose-700 rounded-lg transition shrink-0"
                  >
                    Reintentar
                  </button>
                </div>
              </div>
            ) : leadDetails ? (
              <>
                {/* Drawer Nav Tabs (pegajosas bajo el header mientras se scrollea) */}
                <div className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-6 gap-6 flex">
                  <button
                    onClick={() => setDrawerTab("intelligence")}
                    className={`py-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition ${
                      drawerTab === "intelligence"
                        ? "border-emerald-400 text-emerald-400"
                        : "border-transparent text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    AI Dossier ({leadDetails.dossiers.length})
                  </button>
                  <button
                    onClick={() => setDrawerTab("outreach")}
                    className={`py-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition ${
                      drawerTab === "outreach"
                        ? "border-emerald-400 text-emerald-400"
                        : "border-transparent text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <Send className="w-3.5 h-3.5" />
                    Suggested Outreach ({leadDetails.drafts.length})
                  </button>
                  <button
                    onClick={() => setDrawerTab("timeline")}
                    className={`py-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition ${
                      drawerTab === "timeline"
                        ? "border-emerald-400 text-emerald-400"
                        : "border-transparent text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <History className="w-3.5 h-3.5" />
                    History & Events ({leadDetails.timeline.length})
                  </button>
                </div>

                {/* Drawer Content */}
                <div className="p-6 space-y-5">
                  {/* Carátula de contacto: quién es y cómo llegarle, siempre a la vista */}
                  <section className="rounded-xl border border-zinc-800 divide-y divide-zinc-800/70">
                    <div className="px-4 py-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white">
                          {leadDetails.lead.contactName || "Contacto sin registrar"}
                        </div>
                        {leadDetails.lead.organizationName && (
                          <div className="text-xs text-zinc-500 mt-0.5">
                            {leadDetails.lead.organizationName}
                          </div>
                        )}
                      </div>
                      <ContactActions
                        email={leadDetails.lead.contactEmail}
                        phone={leadDetails.lead.contactPhone}
                      />
                    </div>
                    <div className="px-4 py-3">
                      <InfoGrid
                        items={[
                          {
                            label: "Email",
                            value: leadDetails.lead.contactEmail ? (
                              <a
                                href={`mailto:${leadDetails.lead.contactEmail}`}
                                className="text-cyan-400 hover:underline"
                              >
                                {leadDetails.lead.contactEmail}
                              </a>
                            ) : null,
                          },
                          {
                            label: "Teléfono",
                            value: leadDetails.lead.contactPhone ? (
                              <a
                                href={`tel:${leadDetails.lead.contactPhone.replace(/[\s()-]/g, "")}`}
                                className="text-cyan-400 hover:underline"
                              >
                                {leadDetails.lead.contactPhone}
                              </a>
                            ) : null,
                          },
                          {
                            label: "Origen",
                            value: (
                              <span className="font-mono text-xs uppercase">
                                {leadDetails.lead.source}
                              </span>
                            ),
                          },
                          { label: "Servicio", value: leadDetails.lead.serviceType },
                          {
                            label: "Registrado",
                            value: new Date(leadDetails.lead.createdAt).toLocaleDateString(),
                          },
                          {
                            label: "Etapa actual desde",
                            value: leadDetails.lead.stageChangedAt
                              ? new Date(leadDetails.lead.stageChangedAt).toLocaleDateString()
                              : null,
                          },
                        ]}
                      />
                      {leadDetails.lead.summary && (
                        <p className="text-sm text-zinc-300 leading-relaxed mt-3">
                          {leadDetails.lead.summary}
                        </p>
                      )}
                    </div>
                    {!leadDetails.lead.contactEmail && !leadDetails.lead.contactPhone && (
                      <div className="px-4 py-2.5 bg-amber-950/20 text-xs text-amber-300 flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        Sin email ni teléfono: completá el contacto del lead antes de aprobar y enviar
                        outreach.
                      </div>
                    )}
                  </section>
                  <FollowUpForm
                      kind="lead"
                      entityId={leadDetails.lead.id}
                      currentAt={leadDetails.lead.nextFollowUpAt}
                      currentNote={leadDetails.lead.followUpNote}
                      onSaved={() => openLeadDrawer(leadDetails.lead.id)}
                  />
                  {/* TAB 1: AI INTELLIGENCE & DOSSIER */}
                  {drawerTab === "intelligence" && (
                    <div className="space-y-4">
                      {leadDetails.dossiers.length === 0 ? (
                        <div className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl text-center text-sm text-zinc-400">
                          <FileText className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                          No verified research dossier has been created yet for this prospect.
                          <div className="text-xs text-zinc-500 mt-1">
                            The Eve Prospector subagent researches prospects and adds verified
                            sources.
                          </div>
                        </div>
                      ) : (
                        leadDetails.dossiers.map((dos) => (
                          <div
                            key={dos.id}
                            className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 space-y-4"
                          >
                            <div className="flex justify-between items-center text-xs">
                              <span className="font-mono text-emerald-400 font-semibold">
                                Researched by: {dos.createdBy}
                              </span>
                              <span className="text-zinc-500">
                                {new Date(dos.createdAt).toLocaleString()}
                              </span>
                            </div>

                            <div>
                              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                                Executive Opportunity Diagnosis
                              </h4>
                              <p className="text-sm text-zinc-200 leading-relaxed bg-zinc-950 p-3 rounded-lg border border-zinc-800/80">
                                {dos.summary}
                              </p>
                            </div>

                            {/* Pains / Findings */}
                            {dos.findings && Object.keys(dos.findings).length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                                  Structured Findings
                                </h4>
                                <div className="grid grid-cols-1 gap-2">
                                  {Object.entries(dos.findings).map(([k, v]) => (
                                    <div
                                      key={k}
                                      className="p-2.5 rounded-lg bg-zinc-950/70 border border-zinc-800/60 text-xs"
                                    >
                                      <span className="text-cyan-400 font-semibold capitalize">
                                        {k.replace(/([A-Z])/g, " $1")}:
                                      </span>{" "}
                                      <span className="text-zinc-300">
                                        {typeof v === "object"
                                          ? JSON.stringify(v)
                                          : String(v)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Verified Source URLs */}
                            {dos.sources && dos.sources.length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                                  Verified Evidence Sources
                                </h4>
                                <div className="space-y-1.5">
                                  {dos.sources.map((src, i) => (
                                    <a
                                      key={i}
                                      href={src.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="flex items-center justify-between p-2 rounded-lg bg-zinc-950 border border-zinc-800/60 text-xs text-zinc-300 hover:border-emerald-600 transition"
                                    >
                                      <span className="flex items-center gap-2 truncate">
                                        <ExternalLink className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                                        <span className="truncate">{src.url}</span>
                                      </span>
                                      <span className="text-[11px] text-zinc-500 whitespace-nowrap ml-2">
                                        {src.note || "Verified source"}
                                      </span>
                                    </a>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {/* TAB 2: SUGGESTED OUTREACH & DRAFTS */}
                  {drawerTab === "outreach" && (
                    <div className="space-y-4">
                      {leadDetails.drafts.length === 0 ? (
                        <div className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl text-center text-sm text-zinc-400">
                          <Send className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                          No outreach drafts in outbox for this lead.
                          <div className="text-xs text-zinc-500 mt-1">
                            Cada prospecto nuevo recibe su primer mensaje automáticamente:
                            el orquestador delega al agente Marketing, que redacta desde el dossier
                            y lo deja acá para tu aprobación.
                          </div>
                        </div>
                      ) : (
                        leadDetails.drafts.map((draft) => (
                          <div
                            key={draft.id}
                            className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 space-y-3"
                          >
                            <div className="flex justify-between items-start">
                              <div>
                                <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase bg-zinc-800 text-zinc-300">
                                  {draft.channel}
                                </span>
                                {draft.subject && (
                                  <h4 className="text-sm font-semibold text-white mt-1">
                                    Subject: {draft.subject}
                                  </h4>
                                )}
                              </div>
                              <span
                                className={`text-xs px-2 py-0.5 rounded font-semibold ${
                                  draft.status === "approved"
                                    ? "bg-emerald-950 text-emerald-300 border border-emerald-800"
                                    : draft.status === "rejected"
                                    ? "bg-rose-950 text-rose-300 border border-rose-800"
                                    : "bg-amber-950 text-amber-300 border border-amber-800"
                                }`}
                              >
                                {draft.status.toUpperCase()}
                              </span>
                            </div>

                            {/* Rationale */}
                            {draft.rationale && (
                              <div className="p-2.5 bg-amber-950/20 border border-amber-900/40 rounded-lg text-xs text-amber-300 flex items-start gap-2">
                                <Sparkles className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                                <div>
                                  <span className="font-semibold">AI Strategy / Angle:</span>{" "}
                                  {draft.rationale}
                                </div>
                              </div>
                            )}

                            {/* Missing-contact warning (lead-only draft) */}
                            {draft.status === "pending_approval" && !draft.contactId && (
                              <div className="p-2.5 bg-amber-950/20 border border-amber-900/40 rounded-lg text-xs text-amber-300 flex items-start gap-2">
                                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                                <div>
                                  <span className="font-semibold">Sin contacto verificado:</span>{" "}
                                  el mensaje está listo, pero hace falta completar el contacto del lead
                                  antes de aprobar y enviar. Podés copiarlo y enviarlo manualmente.
                                </div>
                              </div>
                            )}

                            {/* Message Body */}
                            <div className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                              {draft.body}
                            </div>

                            {/* Approved drafts: manual send helper */}
                            {draft.status === "approved" && (
                              <div className="flex gap-2 pt-2 border-t border-zinc-800/80 items-center">
                                <button
                                  onClick={() => handleCopyDraft(draft.body)}
                                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold rounded-lg transition"
                                  title="Copiar el mensaje aprobado para enviarlo manualmente"
                                >
                                  <Copy className="w-4 h-4" /> Copiar para enviar
                                </button>
                                <span className="text-[11px] text-zinc-500">El envío es manual.</span>
                              </div>
                            )}

                            {/* 1-Click Action Buttons if pending */}
                            {draft.status === "pending_approval" && (
                              <div className="flex gap-2 pt-2 border-t border-zinc-800/80">
                                <button
                                  onClick={() => handleReviewDraft(draft.id, "approved")}
                                  disabled={!draft.contactId}
                                  title={
                                    draft.contactId
                                      ? undefined
                                      : "Falta contacto verificado: completá el contacto del lead antes de aprobar"
                                  }
                                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-black text-xs font-semibold rounded-lg transition ${
                                    draft.contactId
                                      ? "bg-emerald-500 hover:bg-emerald-400"
                                      : "bg-zinc-700 cursor-not-allowed opacity-50"
                                  }`}
                                >
                                  <Check className="w-4 h-4" /> Approve
                                </button>
                                <button
                                  onClick={() => handleCopyDraft(draft.body)}
                                  className="flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold rounded-lg transition"
                                  title="Copiar el mensaje para enviarlo manualmente (WhatsApp, email...)"
                                >
                                  <Copy className="w-4 h-4" /> Copiar
                                </button>
                                <button
                                  onClick={() => handleReviewDraft(draft.id, "rejected")}
                                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-rose-950 hover:text-rose-300 text-zinc-300 text-xs font-semibold rounded-lg transition"
                                >
                                  <X className="w-4 h-4" /> Reject / Revise
                                </button>
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {/* TAB 3: AUDIT TIMELINE & HISTORY */}
                  {drawerTab === "timeline" && (
                    <div className="space-y-3">
                      {leadDetails.timeline.length === 0 ? (
                        <div className="p-6 bg-zinc-900/50 border border-zinc-800 rounded-xl text-center text-sm text-zinc-400">
                          No audit events recorded yet for this entity.
                        </div>
                      ) : (
                        leadDetails.timeline.map((ev) => (
                          <div
                            key={ev.id}
                            className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl text-xs space-y-1"
                          >
                            <div className="flex justify-between items-center">
                              <span className="font-semibold text-emerald-400 font-mono">
                                {ev.action}
                              </span>
                              <span className="text-zinc-500">
                                {new Date(ev.createdAt).toLocaleString()}
                              </span>
                            </div>
                            <div className="text-zinc-400 flex items-center gap-1">
                              <span>Actor:</span>
                              <span className="text-zinc-200 font-medium">{ev.actor}</span>
                            </div>
                            {ev.reason && (
                              <div className="text-zinc-300 bg-zinc-950 p-2 rounded border border-zinc-800/60">
                                Reason: {ev.reason}
                              </div>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : null}
        </SlideOver>
      )}

      {/* Advance Stage Modal */}
      {selectedLead && (
        <Modal
          onClose={() => setSelectedLead(null)}
          title="Advance Lead Stage"
          description={
            <>
              Moving lead for{" "}
              <span className="text-emerald-400 font-medium">
                {selectedLead.contactName || selectedLead.organizationName || selectedLead.id}
              </span>{" "}
              (current: {selectedLead.stage})
            </>
          }
        >
            <form onSubmit={handleStageSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Target Stage
                </label>
                <select
                  value={targetStage}
                  onChange={(e) => setTargetStage(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                >
                  {(NEXT_STAGES[selectedLead.stage] || []).map((st) => (
                    <option key={st} value={st}>
                      {STAGE_LABELS[st]?.label || st}
                    </option>
                  ))}
                  {(NEXT_STAGES[selectedLead.stage] || []).length === 0 && (
                    <option value="disqualified">Disqualified</option>
                  )}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Transition Reason
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Solution accepted by client, moving to contract..."
                  value={transitionReason}
                  onChange={(e) => setTransitionReason(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              {targetStage === "lost" && (
                <div>
                  <label className="block text-xs font-medium text-rose-300 mb-1">
                    Lost Reason (Required for Lost)
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Budget constraints, opted for in-house..."
                    value={lostReason}
                    onChange={(e) => setLostReason(e.target.value)}
                    className="w-full bg-zinc-950 border border-rose-900 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-rose-500"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedLead(null)}
                  className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white rounded-lg bg-zinc-800 hover:bg-zinc-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg transition disabled:opacity-50"
                >
                  {submitting ? "Updating..." : "Confirm Transition"}
                </button>
              </div>
            </form>
        </Modal>
      )}
    </div>
  );
};
