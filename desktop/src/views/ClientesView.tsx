import React, { useEffect, useState } from "react";
import { crmApi, OrganizationItem, OrganizationSummary } from "../api";
import { FollowUpForm } from "./FollowUpForm";
import { Building2, RefreshCw, Search, Users, FolderKanban, LifeBuoy, FileText, History } from "lucide-react";

import { ThreadDrawer } from "./ThreadDrawer";

export const ClientesView: React.FC<{ onAskOrchestrator: (prompt: string) => void }> = ({ onAskOrchestrator }) => {
  const [orgs, setOrgs] = useState<OrganizationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "client" | "prospect">("all");
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [summary, setSummary] = useState<OrganizationSummary | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [threadContact, setThreadContact] = useState<{ id: string; name: string } | null>(null);

  const fetchOrgs = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await crmApi.getOrganizations();
      setOrgs(res.organizations);
    } catch (err: any) {
      setError(err.message || "No se pudieron cargar los clientes");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrgs();
  }, []);

  const openSummary = async (orgId: string) => {
    setActiveOrgId(orgId);
    setDrawerLoading(true);
    try {
      const res = await crmApi.getOrganizationSummary(orgId);
      setSummary(res);
    } catch (err: any) {
      alert(`No se pudo cargar la ficha 360: ${err.message}`);
      setActiveOrgId(null);
    } finally {
      setDrawerLoading(false);
    }
  };

  const filtered = orgs.filter((o) => {
    const isClient = (o.projectCount ?? 0) > 0;
    if (typeFilter === "client" && !isClient) return false;
    if (typeFilter === "prospect" && isClient) return false;
    return `${o.name} ${o.domain ?? ""} ${o.city ?? ""}`.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Building2 className="w-5 h-5 text-emerald-400" /> Clientes 360°
          </h2>
          <p className="text-sm text-zinc-400">Ficha unificada: contactos, leads, proyectos, tickets e historial.</p>
        </div>
        <button
          onClick={fetchOrgs}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm"
        >
          <RefreshCw className="w-4 h-4" /> Actualizar
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
      <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 flex-1">
        <Search className="w-4 h-4 text-zinc-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, dominio o ciudad..."
          className="bg-transparent outline-none text-sm w-full placeholder:text-zinc-600"
        />
      </div>
      <select
        value={typeFilter}
        onChange={(e) => setTypeFilter(e.target.value as "all" | "client" | "prospect")}
        className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200"
      >
        <option value="all">Todos ({orgs.length})</option>
        <option value="client">Clientes ({orgs.filter((o) => (o.projectCount ?? 0) > 0).length})</option>
        <option value="prospect">Prospectos ({orgs.filter((o) => (o.projectCount ?? 0) === 0).length})</option>
      </select>
      </div>

      {loading && <p className="text-sm text-zinc-500">Cargando clientes...</p>}
      {error && <p className="text-sm text-rose-400">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((org) => {
          const isClient = (org.projectCount ?? 0) > 0;
          return (
          <button
            key={org.id}
            onClick={() => openSummary(org.id)}
            className="text-left p-4 rounded-xl border border-zinc-800 bg-zinc-900/60 hover:border-emerald-600 transition"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold text-white truncate">{org.name}</div>
              <span
                className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                  isClient
                    ? "bg-emerald-900/60 text-emerald-300 border border-emerald-700"
                    : "bg-sky-900/60 text-sky-300 border border-sky-700"
                }`}
              >
                {isClient ? `Cliente · ${org.projectCount} proy.` : `Prospecto · ${org.leadCount ?? 0} leads`}
              </span>
            </div>
            <div className="text-xs text-zinc-500 font-mono">
              {[org.city, org.country].filter(Boolean).join(", ") || "Sin ubicación"}
            </div>
            <div className="text-xs text-zinc-500 font-mono truncate">{org.domain || org.website || "Sin dominio"}</div>
          </button>
          );
        })}
      </div>

      {activeOrgId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => { setActiveOrgId(null); setSummary(null); }}>
          <div
            className="w-full max-w-2xl h-full overflow-y-auto bg-zinc-950 border-l border-zinc-800 p-6 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            {drawerLoading || !summary ? (
              <p className="text-sm text-zinc-500">Cargando ficha 360°...</p>
            ) : (
              <>
                <div>
                  <h3 className="text-lg font-bold text-white">{summary.organization.name}</h3>
                  <p className="text-xs text-zinc-500 font-mono">
                    {summary.organization.domain || "Sin dominio"} · {summary.contacts.length} contactos ·{" "}
                    {summary.leads.length} leads · {summary.projects.length} proyectos · {summary.tickets.length} tickets
                  </p>
                </div>

                <FollowUpForm
                  kind="organization"
                  entityId={summary.organization.id}
                  currentAt={summary.organization.nextFollowUpAt}
                  currentNote={summary.organization.followUpNote}
                  onSaved={() => openSummary(summary.organization.id)}
                />

                <section>
                  <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><Users className="w-4 h-4" /> Contactos</h4>
                  {summary.contacts.length === 0 && <p className="text-xs text-zinc-600">Sin contactos.</p>}
                  {summary.contacts.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2 py-1">
                      <div className="text-sm text-zinc-300">{c.name} <span className="text-zinc-500 font-mono text-xs">{c.email || c.phone || ""}</span></div>
                      <button
                        onClick={() => setThreadContact({ id: c.id, name: c.name })}
                        className="px-2.5 py-1 text-xs font-medium bg-teal-950/80 hover:bg-teal-900 text-teal-300 border border-teal-700/60 rounded-md transition"
                      >
                        Hilo
                      </button>
                    </div>
                  ))}
                </section>

                <section>
                  <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><FileText className="w-4 h-4" /> Leads</h4>
                  {summary.leads.map((l) => (
                    <div key={l.id} className="text-sm text-zinc-300">{l.stage} · {l.summary || l.source}</div>
                  ))}
                </section>

                <section>
                  <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><FolderKanban className="w-4 h-4" /> Proyectos</h4>
                  {summary.projects.map((p) => (
                    <div key={p.id} className="text-sm text-zinc-300">{p.name} <span className="text-zinc-500">({p.status})</span></div>
                  ))}
                </section>

                <section>
                  <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><LifeBuoy className="w-4 h-4" /> Tickets</h4>
                  {summary.tickets.map((t) => (
                    <div key={t.id} className="text-sm text-zinc-300">{t.status} · {t.system} · {t.description.slice(0, 80)}</div>
                  ))}
                </section>

                <section>
                  <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><History className="w-4 h-4" /> Historial</h4>
                  {summary.timeline.slice(0, 20).map((e) => (
                    <div key={e.id} className="text-xs text-zinc-500 font-mono">{e.createdAt} · {e.entity}/{e.action} · {e.actor}</div>
                  ))}
                </section>
              </>
            )}
          </div>
        </div>
      )}
      {threadContact && summary && (
        <ThreadDrawer
          contactId={threadContact.id}
          contactName={threadContact.name}
          organizationId={summary.organization.id}
          organizationName={summary.organization.name}
          onClose={() => setThreadContact(null)}
          onAskOrchestrator={(prompt) => {
            setThreadContact(null);
            onAskOrchestrator(prompt);
          }}
        />
      )}
    </div>
  );
};
