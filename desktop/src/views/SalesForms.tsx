import React, { useState } from "react";
import { crmApi, type LeadItem, type MilestoneItem, type OrganizationItem, type ProjectItem } from "../api";
import { Modal } from "../components/ui";
import { FormButtons, FormError, inputClass, labelClass } from "./CrmForms";

/**
 * Formularios de la vista Ventas (override manual del ciclo comercial que el
 * agente hace con save_service_estimate / save_contract_draft / hitos).
 * Mismo vocabulario que CrmForms: Modal centrado, inputs zinc-950, primario
 * esmeralda, error inline del API.
 */

export const ESTIMATE_CATEGORIES = [
  { value: "web_mobile_app", label: "Web / Móvil" },
  { value: "workflow_automation", label: "Automatización" },
  { value: "enterprise_ai_agent", label: "Agente de IA" },
  { value: "full_system_integration", label: "Integración de sistemas" },
] as const;

export const ESTIMATE_COMPLEXITIES = [
  { value: "mvp", label: "MVP" },
  { value: "standard", label: "Estándar" },
  { value: "enterprise", label: "Enterprise" },
] as const;

/** Una fase por línea: "Título | 2-3 semanas" (el timeframe es opcional). */
const parsePhases = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, timeframe] = line.split("|").map((s) => s.trim());
      return { title, ...(timeframe ? { timeframe } : {}) };
    });

/** "1500" → 150000 centavos; vacío → null (sin monto, nunca adivinar). */
const parseCents = (value: string): number | null | "invalid" => {
  if (!value.trim()) return null;
  const cents = Math.round(Number(value) * 100);
  if (Number.isNaN(cents) || cents < 0) return "invalid";
  return cents;
};

/* ------------------------------------------------------------------ */
/* Propuestas                                                          */
/* ------------------------------------------------------------------ */

export const NewEstimateModal: React.FC<{
  organizations: OrganizationItem[];
  onSaved: () => void;
  onClose: () => void;
}> = ({ organizations, onSaved, onClose }) => {
  const [organizationId, setOrganizationId] = useState("");
  const [category, setCategory] = useState<string>(ESTIMATE_CATEGORIES[0].value);
  const [complexity, setComplexity] = useState<string>(ESTIMATE_COMPLEXITIES[0].value);
  const [scopeSummary, setScopeSummary] = useState("");
  const [phasesText, setPhasesText] = useState("");
  const [timelineText, setTimelineText] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseCents(value);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !organizationId || !scopeSummary.trim() || cents === "invalid") return;
    try {
      setSaving(true);
      setError(null);
      await crmApi.createEstimate({
        organizationId,
        category,
        complexity,
        scopeSummary: scopeSummary.trim(),
        phases: parsePhases(phasesText),
        timelineText: timelineText.trim() || undefined,
        valueCents: cents,
        currency: currency.trim() || "USD",
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || "No se pudo guardar la propuesta.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Nueva propuesta"
      description="La misma ficha que guarda Eve (solutions): categoría, complejidad, alcance y fases. El monto queda en null si aún no se cotiza."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="est-org">Cliente o prospecto *</label>
          {organizations.length === 0 ? (
            <p className="text-xs text-amber-300 py-2">
              No hay organizaciones: crea primero una en Clientes 360.
            </p>
          ) : (
            <select
              id="est-org"
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
              className={inputClass}
              required
            >
              <option value="">—</option>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="est-category">Categoría</label>
            <select id="est-category" value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
              {ESTIMATE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="est-complexity">Complejidad</label>
            <select id="est-complexity" value={complexity} onChange={(e) => setComplexity(e.target.value)} className={inputClass}>
              {ESTIMATE_COMPLEXITIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="est-scope">Alcance propuesto *</label>
          <textarea
            id="est-scope"
            rows={4}
            required
            value={scopeSummary}
            onChange={(e) => setScopeSummary(e.target.value)}
            placeholder="Qué incluye la propuesta, qué no, y supuestos..."
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="est-phases">Fases (una por línea: Título | 2-3 semanas)</label>
          <textarea
            id="est-phases"
            rows={3}
            value={phasesText}
            onChange={(e) => setPhasesText(e.target.value)}
            placeholder={"MVP | 2-4 semanas\nIntegraciones | 1-2 semanas"}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="est-timeline">Timeline (texto libre)</label>
          <input
            id="est-timeline"
            type="text"
            value={timelineText}
            onChange={(e) => setTimelineText(e.target.value)}
            placeholder="Ej: 3 - 5 semanas"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="est-value">Monto cotizado (unidades)</label>
            <input
              id="est-value"
              type="number"
              min={0}
              step="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Vacío = sin cotizar"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="est-currency">Moneda</label>
            <input
              id="est-currency"
              type="text"
              maxLength={8}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <FormError message={error} />
        <FormButtons
          onClose={onClose}
          busy={saving}
          disabled={!organizationId || !scopeSummary.trim() || cents === "invalid"}
          label="Guardar propuesta"
        />
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* Contratos                                                           */
/* ------------------------------------------------------------------ */

export const NewContractModal: React.FC<{
  projects: ProjectItem[];
  leads: LeadItem[];
  onSaved: () => void;
  onClose: () => void;
}> = ({ projects, leads, onSaved, onClose }) => {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [leadId, setLeadId] = useState("");
  const [body, setBody] = useState("");
  const [reviewerNote, setReviewerNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !title.trim() || !body.trim() || (!projectId && !leadId)) return;
    try {
      setSaving(true);
      setError(null);
      await crmApi.createContract({
        projectId: projectId || undefined,
        leadId: leadId || undefined,
        title: title.trim(),
        body: body.trim(),
        reviewerNote: reviewerNote.trim() || undefined,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || "No se pudo crear el contrato.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Nuevo contrato"
      description="Borrador en estado draft. Nace vinculado a un lead o a un proyecto; la firma (y anular un firmado) es siempre del owner."
      width="max-w-lg"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="ct-title">Título *</label>
          <input
            id="ct-title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ej: Contrato Muebles Nahu — Sistema de cotizaciones"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="ct-project">Proyecto</label>
            <select id="ct-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
              <option value="">—</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="ct-lead">Lead</label>
            <select id="ct-lead" value={leadId} onChange={(e) => setLeadId(e.target.value)} className={inputClass}>
              <option value="">—</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.organizationName ?? "Sin empresa"} — {(l.summary ?? "").slice(0, 40) || l.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="ct-body">Cuerpo del contrato *</label>
          <textarea
            id="ct-body"
            rows={8}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Objeto, alcance, pagos, IP, confidencialidad, terminación..."
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="ct-note">Nota para revisión</label>
          <input
            id="ct-note"
            type="text"
            value={reviewerNote}
            onChange={(e) => setReviewerNote(e.target.value)}
            placeholder="Ej: Confirmar razón social y jurisdicción"
            className={inputClass}
          />
        </div>

        <FormError message={error} />
        <FormButtons
          onClose={onClose}
          busy={saving}
          disabled={!title.trim() || !body.trim() || (!projectId && !leadId)}
          label="Crear borrador"
        />
      </form>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* Hitos                                                               */
/* ------------------------------------------------------------------ */

export type MilestoneModalTarget =
  | { mode: "new"; projectId: string; projectName: string }
  | { mode: "edit"; milestone: MilestoneItem; projectName: string };

/** Alta y edición de un hito de cobro: título, fecha, monto y moneda. */
export const MilestoneModal: React.FC<{
  target: MilestoneModalTarget;
  onSaved: () => void;
  onClose: () => void;
}> = ({ target, onSaved, onClose }) => {
  const initial = target.mode === "edit" ? target.milestone : null;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [dueDate, setDueDate] = useState(initial?.dueDate ?? "");
  const [value, setValue] = useState(
    initial?.amountCents != null ? String(Math.round(initial.amountCents / 100)) : ""
  );
  const [currency, setCurrency] = useState(initial?.currency ?? "USD");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseCents(value);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !title.trim() || cents === "invalid") return;
    try {
      setSaving(true);
      setError(null);
      if (target.mode === "new") {
        await crmApi.createMilestone(target.projectId, {
          title: title.trim(),
          dueDate: dueDate || undefined,
          amountCents: cents ?? undefined,
          currency: currency.trim() || "USD",
        });
      } else {
        await crmApi.updateMilestone(target.milestone.id, {
          title: title.trim(),
          dueDate: dueDate || null,
          amountCents: cents,
          currency: currency.trim() || "USD",
        });
      }
      onSaved();
    } catch (err: any) {
      setError(err.message || "No se pudo guardar el hito.");
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={target.mode === "new" ? `Agregar hito — ${target.projectName}` : `Editar hito — ${target.projectName}`}
      description="El biller y los recordatorios leen estos montos: vacío significa que el monto no está acordado."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="ms-title">Título *</label>
          <input
            id="ms-title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ej: Anticipo 50%"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="ms-date">Fecha comprometida</label>
          <input
            id="ms-date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="ms-value">Monto (unidades)</label>
            <input
              id="ms-value"
              type="number"
              min={0}
              step="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Vacío = sin monto acordado"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="ms-currency">Moneda</label>
            <input
              id="ms-currency"
              type="text"
              maxLength={8}
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <FormError message={error} />
        <FormButtons onClose={onClose} busy={saving} disabled={!title.trim() || cents === "invalid"} label="Guardar hito" />
      </form>
    </Modal>
  );
};
