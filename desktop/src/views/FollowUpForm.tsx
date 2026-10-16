import React, { useState } from "react";
import { crmApi } from "../api";
import { BellRing } from "lucide-react";

interface Props {
  kind: "lead" | "ticket" | "organization";
  entityId: string;
  currentAt?: string | null;
  currentNote?: string | null;
  onSaved?: () => void;
}

/** Compacto: programa o limpia el próximo seguimiento de un lead, ticket o cliente. */
export const FollowUpForm: React.FC<Props> = ({ kind, entityId, currentAt, currentNote, onSaved }) => {
  const [date, setDate] = useState(currentAt ? currentAt.slice(0, 16) : "");
  const [note, setNote] = useState(currentNote || "");
  const [saving, setSaving] = useState(false);

  const snooze = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    setDate(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  };

  const save = async (clear: boolean) => {
    try {
      setSaving(true);
      const iso = clear || !date ? null : new Date(date).toISOString();
      const payload = { nextFollowUpAt: iso, followUpNote: note.trim() || undefined };
      if (kind === "lead") await crmApi.setLeadFollowUp(entityId, payload.nextFollowUpAt, payload.followUpNote);
      else if (kind === "ticket") await crmApi.setTicketFollowUp(entityId, payload.nextFollowUpAt, payload.followUpNote);
      else await crmApi.setOrganizationFollowUp(entityId, payload.nextFollowUpAt, payload.followUpNote);
      if (!clear) {
        setDate(iso ? iso.slice(0, 16) : "");
      } else {
        setDate("");
        setNote("");
      }
      onSaved?.();
    } catch (err: any) {
      alert(`No se pudo guardar el seguimiento: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
      <h4 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider flex items-center gap-1.5">
        <BellRing className="w-3.5 h-3.5 text-amber-400" /> Próximo seguimiento
        {currentAt && (
          <span className="ml-1 font-mono normal-case text-amber-300">
            {new Date(currentAt).toLocaleString()}
          </span>
        )}
      </h4>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="datetime-local"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-500"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Nota: ej. llamar para cerrar..."
          maxLength={500}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-amber-500"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => save(false)}
          disabled={saving || !date}
          className="px-3 py-1.5 text-xs font-medium bg-amber-950/80 hover:bg-amber-900 text-amber-300 border border-amber-700/60 rounded-md transition disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Programar"}
        </button>
        <button onClick={() => snooze(1)} className="px-2.5 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition">+1 día</button>
        <button onClick={() => snooze(3)} className="px-2.5 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition">+3 días</button>
        <button onClick={() => snooze(7)} className="px-2.5 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition">+1 sem</button>
        {currentAt && (
          <button
            onClick={() => save(true)}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-md transition"
          >
            Hecho / limpiar
          </button>
        )}
      </div>
    </div>
  );
};
