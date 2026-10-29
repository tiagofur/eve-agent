import React, { useMemo, useState } from "react";
import { Modal } from "../components/ui";
import { CONTACT_CHANNELS, ContactChannel, ContactPayload } from "../api";

export interface ContactInitial {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  preferredChannel?: string | null;
}

const inputClass =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500";
const labelClass = "block text-xs font-medium text-zinc-300 mb-1";

/** Formulario compartido para crear/editar el contacto de un cliente o lead. */
export const ContactModal: React.FC<{
  title: string;
  description?: string;
  initial?: ContactInitial | null;
  onSubmit: (payload: ContactPayload) => Promise<void>;
  onClose: () => void;
}> = ({ title, description, initial, onSubmit, onClose }) => {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [channel, setChannel] = useState(initial?.preferredChannel ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload: ContactPayload = useMemo(
    () => ({
      name: name.trim(),
      role: role.trim() || null,
      email: email.trim() || null,
      phone: phone.trim() || null,
      preferredChannel: (channel || null) as ContactChannel | null,
    }),
    [name, role, email, phone, channel]
  );

  const dirty = useMemo(() => {
    if (!initial) return payload.name.length > 0;
    return (
      payload.name !== initial.name ||
      payload.role !== initial.role ||
      payload.email !== initial.email ||
      payload.phone !== initial.phone ||
      payload.preferredChannel !== (initial.preferredChannel ?? null)
    );
  }, [initial, payload]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    try {
      setSaving(true);
      setError(null);
      await onSubmit(payload);
      onClose();
    } catch (err: any) {
      setError(err.message || "No se pudo guardar el contacto.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={title} description={description} width="max-w-md">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="contact-name">Nombre *</label>
          <input
            id="contact-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: María Gómez"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="contact-role">Rol / Área</label>
          <input
            id="contact-role"
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Ej: Implementación, Contabilidad, Dirección"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="contact-email">Email</label>
            <input
              id="contact-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="maria@empresa.com"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="contact-phone">Teléfono / WhatsApp</label>
            <input
              id="contact-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+52 33 1234 5678"
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="contact-channel">Canal preferido</label>
          <select
            id="contact-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className={inputClass}
          >
            <option value="">—</option>
            {CONTACT_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-xs text-rose-300 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

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
            disabled={!dirty || saving}
            title={dirty ? undefined : "Sin cambios por guardar"}
            className="px-4 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg transition disabled:opacity-50"
          >
            {saving ? "Guardando..." : "Guardar contacto"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export interface OrgDataInitial {
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
}

/** Corrección manual de los datos de la empresa en la ficha 360. */
export const OrgDataModal: React.FC<{
  initial: OrgDataInitial;
  onSubmit: (patch: Partial<OrgDataInitial>) => Promise<void>;
  onClose: () => void;
}> = ({ initial, onSubmit, onClose }) => {
  const [name, setName] = useState(initial.name);
  const [domain, setDomain] = useState(initial.domain ?? "");
  const [website, setWebsite] = useState(initial.website ?? "");
  const [industry, setIndustry] = useState(initial.industry ?? "");
  const [city, setCity] = useState(initial.city ?? "");
  const [country, setCountry] = useState(initial.country ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch: Partial<OrgDataInitial> = {
    name: name.trim(),
    domain: domain.trim() || null,
    website: website.trim() || null,
    industry: industry.trim() || null,
    city: city.trim() || null,
    country: country.trim() || null,
  };

  const dirty =
    patch.name !== initial.name ||
    patch.domain !== initial.domain ||
    patch.website !== initial.website ||
    patch.industry !== initial.industry ||
    patch.city !== initial.city ||
    patch.country !== initial.country;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty || saving) return;
    try {
      setSaving(true);
      setError(null);
      await onSubmit(patch);
      onClose();
    } catch (err: any) {
      setError(err.message || "No se pudieron guardar los datos.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title="Datos de la empresa"
      description="Se aplica a la ficha 360 y al histórico del pipeline. El dominio se usa para deduplicar organizaciones."
      width="max-w-md"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="org-name">Nombre *</label>
          <input
            id="org-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="org-domain">Dominio</label>
            <input
              id="org-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="empresa.com"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="org-website">Sitio web</label>
            <input
              id="org-website"
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://empresa.com"
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="org-industry">Industria</label>
          <input
            id="org-industry"
            type="text"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            placeholder="Ej: Manufactura de mobiliario"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="org-city">Ciudad</label>
            <input
              id="org-city"
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="org-country">País</label>
            <input
              id="org-country"
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {error && (
          <p className="text-xs text-rose-300 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

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
            disabled={!dirty || saving}
            title={dirty ? undefined : "Sin cambios por guardar"}
            className="px-4 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg transition disabled:opacity-50"
          >
            {saving ? "Guardando..." : "Guardar datos"}
          </button>
        </div>
      </form>
    </Modal>
  );
};
