import React, { useEffect, useState } from "react";
import { crmApi, OrganizationItem, OrganizationSummary, type ContactPayload } from "../api";
import { FollowUpForm } from "./FollowUpForm";
import { Building2, RefreshCw, Search, FolderKanban, LifeBuoy, FileText, History, Globe, MapPin, BookUser, ArrowUpRight, AlertCircle, Plus, Pencil } from "lucide-react";

import { ThreadDrawer } from "./ThreadDrawer";
import { ContactModal, OrgDataModal, type ContactInitial, type OrgDataInitial } from "./Client360Modals";
import {
  SlideOver,
  Badge,
  EmptyState,
  SectionHeading,
  SectionList,
  InfoGrid,
  ContactActions,
  Skeleton,
} from "../components/ui";

const PROJECT_STATUS_TONES: Record<string, "emerald" | "teal" | "cyan" | "amber" | "zinc"> = {
  active: "emerald",
  onboarding: "teal",
  support: "cyan",
  paused: "amber",
};

export const ClientesView: React.FC<{ onAskOrchestrator: (prompt: string) => void }> = ({ onAskOrchestrator }) => {
  const [orgs, setOrgs] = useState<OrganizationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "client" | "prospect">("all");
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [summary, setSummary] = useState<OrganizationSummary | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [threadContact, setThreadContact] = useState<{ id: string; name: string } | null>(null);
  // Edición manual (agent-first también significa poder corregir a mano)
  const [contactModal, setContactModal] = useState<
    { mode: "create" } | { mode: "edit"; contact: ContactInitial & { id: string } } | null
  >(null);
  const [orgModalOpen, setOrgModalOpen] = useState(false);

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
    setDrawerError(null);
    setSummary(null);
    try {
      const res = await crmApi.getOrganizationSummary(orgId);
      setSummary(res);
    } catch (err: any) {
      setDrawerError(err.message || "No se pudo cargar la ficha 360.");
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    setActiveOrgId(null);
    setSummary(null);
    setDrawerError(null);
  };

  const handleSaveContact = async (payload: ContactPayload) => {
    if (!activeOrgId) return;
    if (contactModal?.mode === "edit") {
      await crmApi.updateContact(contactModal.contact.id, payload);
    } else {
      await crmApi.createOrgContact(activeOrgId, payload);
    }
    await openSummary(activeOrgId);
  };

  const handleSaveOrg = async (patch: Partial<OrgDataInitial>) => {
    if (!activeOrgId) return;
    await crmApi.updateOrganization(activeOrgId, patch);
    await openSummary(activeOrgId);
    fetchOrgs();
  };

  const filtered = orgs.filter((o) => {
    const isClient = (o.projectCount ?? 0) > 0;
    if (typeFilter === "client" && !isClient) return false;
    if (typeFilter === "prospect" && isClient) return false;
    return `${o.name} ${o.domain ?? ""} ${o.city ?? ""}`.toLowerCase().includes(search.toLowerCase());
  });

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;
  const activeIsClient = (activeOrg?.projectCount ?? 0) > 0;
  const closeThread = () => setThreadContact(null);

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
        <SlideOver
          onClose={closeDrawer}
          title={activeOrg?.name ?? "Ficha 360°"}
          badge={
            activeOrg && (
              <Badge tone={activeIsClient ? "emerald" : "sky"}>
                {activeIsClient
                  ? `Cliente · ${activeOrg.projectCount} proy.`
                  : `Prospecto · ${activeOrg.leadCount ?? 0} leads`}
              </Badge>
            )
          }
          meta={
            <>
              {(activeOrg?.domain || activeOrg?.website) && (
                <a
                  href={
                    activeOrg.website
                      ? activeOrg.website.startsWith("http")
                        ? activeOrg.website
                        : `https://${activeOrg.website}`
                      : `https://${activeOrg.domain}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-cyan-400 hover:underline"
                >
                  <Globe className="w-3 h-3" />
                  {activeOrg.domain || activeOrg.website}
                </a>
              )}
              {(activeOrg?.city || activeOrg?.country) && (
                <span className="flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-zinc-500" />
                  {[activeOrg.city, activeOrg.country].filter(Boolean).join(", ")}
                </span>
              )}
              {activeOrg?.industry && <span>{activeOrg.industry}</span>}
            </>
          }
        >
          <div className="p-6 space-y-6">
            {drawerLoading && (
              <div className="space-y-4" aria-label="Cargando ficha 360°">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {drawerError && (
              <div className="p-4 bg-rose-950/50 border border-rose-800 text-rose-300 rounded-xl flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {drawerError}
                </span>
                <button
                  onClick={() => openSummary(activeOrgId)}
                  className="px-3 py-1.5 text-xs font-semibold bg-rose-900/60 hover:bg-rose-900 border border-rose-700 rounded-lg transition shrink-0"
                >
                  Reintentar
                </button>
              </div>
            )}

            {summary && (
              <>
                {/* Carátula: empresa + personas con datos para contactar a la vista */}
                <section className="space-y-3">
                  <SectionHeading
                    icon={Building2}
                    title="Datos de la empresa"
                    action={
                      <button
                        onClick={() => setOrgModalOpen(true)}
                        title="Editar datos de la empresa"
                        className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    }
                  />
                  <SectionList>
                    <div className="py-3.5">
                      <InfoGrid
                        items={[
                          {
                            label: "Sitio web",
                            value:
                              summary.organization.domain || summary.organization.website ? (
                                <a
                                  href={
                                    summary.organization.website
                                      ? summary.organization.website.startsWith("http")
                                        ? summary.organization.website
                                        : `https://${summary.organization.website}`
                                      : `https://${summary.organization.domain}`
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-cyan-400 hover:underline inline-flex items-center gap-1"
                                >
                                  {summary.organization.domain || summary.organization.website}
                                  <ArrowUpRight className="w-3 h-3" />
                                </a>
                              ) : null,
                          },
                          {
                            label: "Ubicación",
                            value:
                              [summary.organization.city, summary.organization.country]
                                .filter(Boolean)
                                .join(", ") || null,
                          },
                          { label: "Industria", value: summary.organization.industry },
                          {
                            label: activeIsClient ? "Cliente desde" : "Registrado",
                            value: new Date(summary.organization.createdAt).toLocaleDateString(),
                          },
                        ]}
                      />
                    </div>
                  </SectionList>
                </section>

                <section className="space-y-3">
                  <SectionHeading
                    icon={BookUser}
                    title="Contactos"
                    count={summary.contacts.length}
                    action={
                      <button
                        onClick={() => setContactModal({ mode: "create" })}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/60 rounded-md transition"
                      >
                        <Plus className="w-3.5 h-3.5" /> Añadir
                      </button>
                    }
                  />
                  <SectionList>
                    {summary.contacts.map((c) => (
                      <div key={c.id} className="py-3 flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="text-sm font-semibold text-white">
                            {c.name}
                            {c.role && (
                              <span className="ml-2 text-xs font-normal text-zinc-500">{c.role}</span>
                            )}
                          </div>
                          {c.email && (
                            <a
                              href={`mailto:${c.email}`}
                              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-emerald-400 transition w-fit"
                            >
                              {c.email}
                            </a>
                          )}
                          {c.phone && (
                            <a
                              href={`tel:${c.phone.replace(/[\s()-]/g, "")}`}
                              className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-emerald-400 transition w-fit"
                            >
                              {c.phone}
                            </a>
                          )}
                          {!c.email && !c.phone && (
                            <div className="text-xs text-zinc-600">Sin email ni teléfono registrados</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                          <ContactActions email={c.email} phone={c.phone} />
                          <button
                            onClick={() =>
                              setContactModal({
                                mode: "edit",
                                contact: {
                                  id: c.id,
                                  name: c.name,
                                  role: c.role,
                                  email: c.email,
                                  phone: c.phone,
                                  preferredChannel: c.preferredChannel,
                                },
                              })
                            }
                            title={`Editar contacto de ${c.name}`}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setThreadContact({ id: c.id, name: c.name })}
                            title={`Ver hilo de conversación con ${c.name}`}
                            className="px-2.5 py-1 text-xs font-medium bg-teal-950/80 hover:bg-teal-900 text-teal-300 border border-teal-700/60 rounded-md transition"
                          >
                            Hilo
                          </button>
                        </div>
                      </div>
                    ))}
                    {summary.contacts.length === 0 && (
                      <div className="py-3">
                        <EmptyState
                          icon={BookUser}
                          title="Sin contactos registrados."
                          hint="Añade a quien implementa el sistema, contabilidad, dirección… con su email o teléfono."
                        />
                      </div>
                    )}
                  </SectionList>
                </section>

                <FollowUpForm
                  kind="organization"
                  entityId={summary.organization.id}
                  currentAt={summary.organization.nextFollowUpAt}
                  currentNote={summary.organization.followUpNote}
                  onSaved={() => openSummary(summary.organization.id)}
                />

                <section className="space-y-3">
                  <SectionHeading icon={FolderKanban} title="Proyectos" count={summary.projects.length} />
                  {summary.projects.length === 0 ? (
                    <EmptyState
                      icon={FolderKanban}
                      title="Sin proyectos todavía."
                      hint={
                        activeIsClient
                          ? "Cuando se convierta un lead o se cree un proyecto, aparecerá aquí."
                          : "Aún es un prospecto: los proyectos aparecen al convertir un lead en cliente."
                      }
                    />
                  ) : (
                    <SectionList>
                      {summary.projects.map((p) => (
                        <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-white truncate">{p.name}</div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              Desde {new Date(p.createdAt).toLocaleDateString()}
                              {p.repoUrl && (
                                <a
                                  href={p.repoUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="ml-2 text-cyan-400 hover:underline inline-flex items-center gap-0.5"
                                >
                                  repositorio <ArrowUpRight className="w-3 h-3" />
                                </a>
                              )}
                            </div>
                          </div>
                          <Badge tone={PROJECT_STATUS_TONES[p.status] ?? "zinc"}>{p.status}</Badge>
                        </div>
                      ))}
                    </SectionList>
                  )}
                </section>

                <section className="space-y-3">
                  <SectionHeading icon={FileText} title="Leads" count={summary.leads.length} />
                  {summary.leads.length === 0 ? (
                    <EmptyState icon={FileText} title="Sin leads asociados." />
                  ) : (
                    <SectionList>
                      {summary.leads.map((l) => (
                        <div key={l.id} className="py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm text-zinc-200 truncate">
                              {l.summary || l.source || "Sin notas"}
                            </div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              Creado {new Date(l.createdAt).toLocaleDateString()}
                            </div>
                          </div>
                          <Badge tone="sky">{l.stage}</Badge>
                        </div>
                      ))}
                    </SectionList>
                  )}
                </section>

                <section className="space-y-3">
                  <SectionHeading icon={LifeBuoy} title="Tickets" count={summary.tickets.length} />
                  {summary.tickets.length === 0 ? (
                    <EmptyState icon={LifeBuoy} title="Sin tickets de soporte." />
                  ) : (
                    <SectionList>
                      {summary.tickets.map((t) => (
                        <div key={t.id} className="py-3 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm text-zinc-200">{t.description}</div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              {t.system} · {new Date(t.createdAt).toLocaleDateString()}
                            </div>
                          </div>
                          <Badge tone={t.severity === "critical" ? "rose" : t.severity === "major" ? "amber" : "zinc"}>
                            {t.status}
                          </Badge>
                        </div>
                      ))}
                    </SectionList>
                  )}
                </section>

                <section className="space-y-3">
                  <SectionHeading icon={History} title="Historial" />
                  {summary.timeline.length === 0 ? (
                    <EmptyState icon={History} title="Sin eventos registrados." />
                  ) : (
                    <div className="rounded-xl border border-zinc-800 px-4 py-2 divide-y divide-zinc-800/50">
                      {summary.timeline.slice(0, 20).map((e) => (
                        <div key={e.id} className="py-2 text-xs font-mono flex items-center gap-2 min-w-0">
                          <span className="text-zinc-500 shrink-0">
                            {new Date(e.createdAt).toLocaleDateString()}
                          </span>
                          <span className="text-emerald-400 shrink-0">{e.action}</span>
                          <span className="text-zinc-500 shrink-0">{e.entity}</span>
                          <span className="text-zinc-600 truncate">{e.actor}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </SlideOver>
      )}
      {contactModal && (
        <ContactModal
          title={contactModal.mode === "edit" ? "Editar contacto" : "Añadir contacto"}
          description={
            summary ? `Se guarda en la ficha de ${summary.organization.name}.` : undefined
          }
          initial={contactModal.mode === "edit" ? contactModal.contact : null}
          onSubmit={handleSaveContact}
          onClose={() => setContactModal(null)}
        />
      )}
      {orgModalOpen && summary && (
        <OrgDataModal
          initial={{
            name: summary.organization.name,
            domain: summary.organization.domain,
            website: summary.organization.website,
            industry: summary.organization.industry,
            city: summary.organization.city,
            country: summary.organization.country,
          }}
          onSubmit={handleSaveOrg}
          onClose={() => setOrgModalOpen(false)}
        />
      )}
      {threadContact && summary && (
        <ThreadDrawer
          contactId={threadContact.id}
          contactName={threadContact.name}
          organizationId={summary.organization.id}
          organizationName={summary.organization.name}
          onClose={closeThread}
          onAskOrchestrator={(prompt) => {
            closeThread();
            onAskOrchestrator(prompt);
          }}
        />
      )}
    </div>
  );
};
