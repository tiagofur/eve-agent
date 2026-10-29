import React, { useEffect, useMemo, useState } from "react";
import { crmApi, type OrganizationItem } from "../api";
import { Modal } from "../components/ui";

/**
 * Formularios del override manual (agent-first: si Eve puede hacerlo, el owner
 * también). Todos siguen el vocabulario de ContactModal: Modal centrado,
 * inputs sobre zinc-950, botón primario esmeralda, error inline del API.
 */

const inputClass =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500";
const labelClass = "block text-xs font-medium text-zinc-300 mb-1";

const FormError: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <p className="text-xs text-rose-300 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
      {message}
    </p>
  ) : null;

const FormButtons: React.FC<{
  onClose: () => void;
  busy: boolean;
  disabled?: boolean;
  label: string;
}> = ({ onClose, busy, disabled, label }) => (
  <div className="flex justify-end gap-2 pt-1">
    <button
      type="button"
      onClick={onClose}
      className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white rounded-lg bg-zinc-800 hover:bg-zinc-700 transition"
    >
      Cancelar
    </button>
    <button
      type="submit"
      disabled={busy || disabled}
      title={disabled ? "Faltan campos obligatorios" : undefined}
      className="px-4 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg transition disabled:opacity-50"
    >
      {busy ? "Guardando..." : label}
    </button>
  </div>
);

export const SERVICE_TYPES = [
  { value: "software_development", label: "Desarrollo de software" },
  { value: "automation", label: "Automatización" },
  { value: "ai_implementation", label: "Implementación de IA" },
  { value: "consulting", label: "Consultoría" },
] as const;

/* ------------------------------------------------------------------ */
/* Leads: alta y edición manual                                        */
/* ------------------------------------------------------------------ */

const LEAD_SOURCES = [
  { value: "manual_desktop", label: "Manual (yo lo capturé)" },
  { value: "referral", label: "Referido" },
  { value: "web", label: "Web / formulario" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "google_maps", label: "Google Maps" },
  { value: "other", label: "Otro" },
] as const;

/** Alta manual de un lead: cliente, servicio, resumen y presupuesto. */
export const NewLeadModal: React.FC<{
  onCreated: (leadId: string) => void;
  onClose: () => void;
}> = ({ onCreated, onClose }) => {
  const [clientName, setClientName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [contact, setContact] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [summary, setSummary] = useState("");
  const [estimatedBudget, setEstimatedBudget] = useState("");
  const [source, setSource] = useState("manual_desktop");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !clientName.trim() || !summary.trim()) return;
    try {
      setSaving(true);
      setError(null);
      const res = await crmApi.createLead({
        clientName: clientName.trim(),
        companyName: companyName.trim() || undefined,
        contact: contact.trim() || undefined,
        serviceType: (serviceType || undefined) as any,
        projectSummary: summary.trim(),
        estimatedBudget: estimatedBudget.trim() || undefined,
        source: source || "manual_desktop",
      });
      onCreated(res.leadId);
    } catch (err: any) {
      setError(err.message || "No se pudo crear el lead.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Nuevo lead"
      description="Alta manual: si ya existe la empresa, el lead se vincula a su ficha; si no, se crea."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="lead-client">Nombre del contacto *</label>
          <input
            id="lead-client"
            type="text"
            required
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Ej: María Gómez"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="lead-company">Empresa</label>
          <input
            id="lead-company"
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Ej: Muebles Nahu"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="lead-contact">Email o teléfono del contacto</label>
          <input
            id="lead-contact"
            type="text"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder="maria@empresa.com o +52 33 1234 5678"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="lead-service">Tipo de servicio</label>
            <select
              id="lead-service"
              value={serviceType}
              onChange={(e) => setServiceType(e.target.value)}
              className={inputClass}
            >
              <option value="">—</option>
              {SERVICE_TYPES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="lead-source">Origen</label>
            <select
              id="lead-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={inputClass}
            >
              {LEAD_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="lead-summary">Resumen del proyecto *</label>
          <textarea
            id="lead-summary"
            required
            rows={3}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Qué necesita el cliente, contexto y qué le prometiste..."
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="lead-budget">Presupuesto estimado</label>
          <input
            id="lead-budget"
            type="text"
            value={estimatedBudget}
            onChange={(e) => setEstimatedBudget(e.target.value)}
            placeholder="Ej: USD 5,000"
            className={inputClass}
          />
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} label="Crear lead" />
      </form>
    </Modal>
  );
};

/** Edición de los campos del lead. La etapa se cambia por transición, no aquí. */
export const LeadEditModal: React.FC<{
  initial: {
    id: string;
    serviceType: string | null;
    summary: string | null;
    estimatedValueCents: number | null;
  };
  onSaved: () => void;
  onClose: () => void;
}> = ({ initial, onSaved, onClose }) => {
  const [serviceType, setServiceType] = useState(initial.serviceType ?? "");
  const [summary, setSummary] = useState(initial.summary ?? "");
  // El presupuesto se muestra en unidades (USD); el API lo guarda en centavos.
  const [budget, setBudget] = useState(
    initial.estimatedValueCents != null ? String(Math.round(initial.estimatedValueCents / 100)) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    (serviceType || null) !== (initial.serviceType ?? null) ||
    summary !== (initial.summary ?? "") ||
    (budget.trim() ? Math.round(Number(budget) * 100) : null) !== (initial.estimatedValueCents ?? null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    const cents = Math.round(Number(budget) * 100);
    try {
      setSaving(true);
      setError(null);
      await crmApi.updateLead(initial.id, {
        serviceType: serviceType || null,
        summary: summary.trim() || undefined,
        estimatedValueCents: budget.trim() && !Number.isNaN(cents) && cents >= 0 ? cents : null,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || "No se pudo guardar el lead.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Editar lead"
      description="Corrige o completa lo capturado. La etapa y el seguimiento se cambian desde sus controles propios; toda edición queda auditada."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="lead-edit-service">Tipo de servicio</label>
          <select
            id="lead-edit-service"
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {SERVICE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="lead-edit-summary">Resumen del proyecto</label>
          <textarea
            id="lead-edit-summary"
            rows={4}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="lead-edit-budget">Presupuesto estimado (USD)</label>
          <input
            id="lead-edit-budget"
            type="number"
            min={0}
            step="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="Ej: 5000 (vacío limpia el campo)"
            className={inputClass}
          />
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} disabled={!dirty} label="Guardar cambios" />
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* Organizaciones: alta manual                                         */
/* ------------------------------------------------------------------ */

/** Alta manual de una organización. 409 si ya existe (dedup normalizado). */
export const NewOrgModal: React.FC<{
  onCreated: (orgId: string) => void;
  onClose: () => void;
}> = ({ onCreated, onClose }) => {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [website, setWebsite] = useState("");
  const [industry, setIndustry] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !name.trim()) return;
    try {
      setSaving(true);
      setError(null);
      const res = await crmApi.createOrganization({
        name: name.trim(),
        domain: domain.trim() || null,
        website: website.trim() || null,
        industry: industry.trim() || null,
        city: city.trim() || null,
        country: country.trim() || null,
      });
      onCreated(res.organization.id);
    } catch (err: any) {
      setError(err.message || "No se pudo crear la organización.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Nueva organización"
      description="Cliente o prospecto creado a mano. El dominio se usa para deduplicar: si ya existe otra organización con el mismo nombre, el API te lo dirá."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="new-org-name">Nombre *</label>
          <input
            id="new-org-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Muebles Nahu"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="new-org-domain">Dominio</label>
            <input
              id="new-org-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="empresa.com"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="new-org-website">Sitio web</label>
            <input
              id="new-org-website"
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://empresa.com"
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="new-org-industry">Industria</label>
          <input
            id="new-org-industry"
            type="text"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="Ej: Manufactura de mobiliario"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="new-org-city">Ciudad</label>
            <input
              id="new-org-city"
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="new-org-country">País</label>
            <input
              id="new-org-country"
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} label="Crear organización" />
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* Proyectos: alta y edición manual                                    */
/* ------------------------------------------------------------------ */

/** Alta manual de un proyecto. Si no llega la lista, la carga sola. */
export const NewProjectModal: React.FC<{
  organizations?: OrganizationItem[];
  preselectedOrgId?: string | null;
  onCreated: (projectId: string) => void;
  onClose: () => void;
}> = ({ organizations: orgsProp, preselectedOrgId, onCreated, onClose }) => {
  const [orgs, setOrgs] = useState<OrganizationItem[]>(orgsProp ?? []);
  const [loadingOrgs, setLoadingOrgs] = useState(!orgsProp);
  const [organizationId, setOrganizationId] = useState(preselectedOrgId ?? "");
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orgsProp || !preselectedOrgId) return;
    let alive = true;
    crmApi
      .getOrganizationSummary(preselectedOrgId)
      .then((res) => {
        if (alive) setOrgs([res.organization]);
      })
      .catch(() => {
        if (alive) setOrgs([]);
      })
      .finally(() => {
        if (alive) setLoadingOrgs(false);
      });
    return () => {
      alive = false;
    };
  }, [orgsProp, preselectedOrgId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !organizationId || !name.trim()) return;
    try {
      setSaving(true);
      setError(null);
      const res = await crmApi.createProject({
        organizationId,
        name: name.trim(),
        repoUrl: repoUrl.trim() || undefined,
      });
      onCreated(res.project.id);
    } catch (err: any) {
      setError(err.message || "No se pudo crear el proyecto.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Nuevo proyecto"
      description="Registra la entrega aunque no venga de un lead ganado. Los hitos se agregan después; el proyecto arranca en onboarding."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="proj-org">Cliente *</label>
          {loadingOrgs ? (
            <p className="text-xs text-zinc-500 py-2">Cargando organizaciones…</p>
          ) : orgs.length === 0 ? (
            <p className="text-xs text-amber-300 py-2">
              No hay organizaciones: crea primero una en Clientes 360.
            </p>
          ) : (
            <select
              id="proj-org"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              className={inputClass}
              required
            >
              <option value="">—</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={labelClass} htmlFor="proj-name">Nombre del proyecto *</label>
          <input
            id="proj-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Muebles Nahu — Sistema de cotizaciones"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="proj-repo">Repositorio (URL)</label>
          <input
            id="proj-repo"
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            className={inputClass}
          />
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} disabled={!organizationId || !name.trim()} label="Crear proyecto" />
      </form>
    </Modal>
  );
};

const PROJECT_STATUSES = [
  { value: "onboarding", label: "Onboarding" },
  { value: "active", label: "Activo" },
  { value: "paused", label: "En pausa" },
  { value: "delivered", label: "Entregado" },
  { value: "cancelled", label: "Cancelado" },
] as const;

/** Edición de proyecto: nombre, repo y estado. No hay borrado: se cierra o cancela. */
export const ProjectEditModal: React.FC<{
  initial: { id: string; name: string; repoUrl: string | null; status: string };
  onSaved: () => void;
  onClose: () => void;
}> = ({ initial, onSaved, onClose }) => {
  const [name, setName] = useState(initial.name);
  const [repoUrl, setRepoUrl] = useState(initial.repoUrl ?? "");
  const [status, setStatus] = useState(initial.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== initial.name || (repoUrl.trim() || null) !== initial.repoUrl || status !== initial.status;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    try {
      setSaving(true);
      setError(null);
      await crmApi.updateProject(initial.id, {
        name: name.trim(),
        repoUrl: repoUrl.trim() || null,
        status: status as any,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || "No se pudo guardar el proyecto.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Editar proyecto"
      description="Los proyectos no se borran: muévelos a Entregado o Cancelado para cerrarlos conservando tareas e histórico."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="proj-edit-name">Nombre *</label>
          <input
            id="proj-edit-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="proj-edit-repo">Repositorio (URL)</label>
          <input
            id="proj-edit-repo"
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="proj-edit-status">Estado</label>
          <select
            id="proj-edit-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={inputClass}
          >
            {PROJECT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} disabled={!dirty} label="Guardar proyecto" />
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* Interacciones: registro manual en el timeline                       */
/* ------------------------------------------------------------------ */

const CHANNELS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "Email" },
  { value: "telegram", label: "Telegram" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "phone", label: "Llamada" },
  { value: "web", label: "Web" },
  { value: "other", label: "Otro" },
] as const;

/** Registrar a mano una llamada/reunión/nota en el timeline (el API la estampa "ahora"). */
export const LogInteractionModal: React.FC<{
  links: { organizationId?: string; leadId?: string; contactId?: string };
  entityName: string;
  onSaved: () => void;
  onClose: () => void;
}> = ({ links, entityName, onSaved, onClose }) => {
  const [channel, setChannel] = useState("whatsapp");
  const [direction, setDirection] = useState<"inbound" | "outbound">("outbound");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !content.trim()) return;
    try {
      setSaving(true);
      setError(null);
      await crmApi.logInteraction({
        ...links,
        channel,
        direction,
        content: content.trim(),
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || "No se pudo registrar la interacción.");
      setSaving(false);
    }
  };

  const submitDisabled = useMemo(() => !content.trim(), [content]);

  return (
    <Modal
      onClose={onClose}
      title="Registrar interacción"
      description={`Queda en el timeline de ${entityName} con fecha de ahora: úsalo para llamadas, reuniones o notas que no pasaron por el agente.`}
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="inter-channel">Canal</label>
            <select
              id="inter-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className={inputClass}
            >
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="inter-direction">Dirección</label>
            <select
              id="inter-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "inbound" | "outbound")}
              className={inputClass}
            >
              <option value="outbound">Saliente (yo contacté)</option>
              <option value="inbound">Entrante (contactaron)</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="inter-content">Qué pasó *</label>
          <textarea
            id="inter-content"
            rows={4}
            required
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Ej: Llamada de seguimiento: pidió propuesta formal con hitos para el 15/11."
            className={inputClass}
          />
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} disabled={submitDisabled} label="Registrar interacción" />
      </form>
    </Modal>
  );
};
