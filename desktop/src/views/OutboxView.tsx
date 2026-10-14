import { useState, useEffect } from "react";
import { crmApi, type OutboxDraft } from "../api";
import { Check, X, Send, Clock, User } from "lucide-react";

export function OutboxView() {
  const [drafts, setDrafts] = useState<OutboxDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);

  const loadDrafts = async () => {
    try {
      setLoading(true);
      const res = await crmApi.getPendingDrafts();
      setDrafts(res.drafts);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDrafts();
  }, []);

  const handleDecision = async (draftId: string, decision: "approved" | "rejected") => {
    try {
      setActioningId(draftId);
      await crmApi.reviewDraft(draftId, decision);
      // Remove reviewed draft from pending list
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error al revisar borrador");
    } finally {
      setActioningId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">
            Bandeja de Aprobación Humana (Outbox)
          </h2>
          <p className="text-sm text-slate-400">
            Revisa y autoriza los mensajes de prospección redactados por los agentes antes de su envío.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-400">
          <Clock className="h-3.5 w-3.5" />
          {drafts.length} pendientes
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">Cargando borradores...</div>
      ) : drafts.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 py-16 text-center">
          <Send className="mx-auto h-10 w-10 text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-white">No hay mensajes pendientes</h3>
          <p className="mt-1 text-sm text-slate-400">
            Cuando el subagente de prospección redacte un nuevo contacto, aparecerá aquí para tu revisión.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {drafts.map((draft) => (
            <div
              key={draft.id}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-sm transition hover:border-slate-700"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                    <User className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="font-semibold text-white">
                      {draft.contactName ?? "Contacto sin nombre"}
                    </div>
                    <div className="text-xs text-slate-400">
                      {draft.contactEmail || draft.contactPhone || "Sin datos de contacto"}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="rounded-md bg-indigo-950 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase text-indigo-300">
                    {draft.channel}
                  </span>
                  <span className="text-xs text-slate-400">
                    Por: <span className="font-mono text-slate-300">{draft.createdBy}</span>
                  </span>
                </div>
              </div>

              {/* Rationale / Explanation */}
              {draft.rationale && (
                <div className="mt-3 rounded-lg border border-indigo-500/10 bg-indigo-500/5 p-3 text-xs text-indigo-300">
                  <span className="font-bold">Estrategia del agente:</span> {draft.rationale}
                </div>
              )}

              {/* Draft Body */}
              <div className="mt-3 space-y-1">
                {draft.subject && (
                  <div className="text-xs font-semibold text-slate-300">
                    Asunto: <span className="text-white">{draft.subject}</span>
                  </div>
                )}
                <div className="rounded-lg bg-slate-950/70 p-4 font-mono text-xs leading-relaxed text-slate-200">
                  <pre className="whitespace-pre-wrap font-sans">{draft.body}</pre>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-4 flex items-center justify-end gap-3">
                <button
                  onClick={() => handleDecision(draft.id, "rejected")}
                  disabled={actioningId === draft.id}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-950 hover:text-rose-200 disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                  Rechazar
                </button>
                <button
                  onClick={() => handleDecision(draft.id, "approved")}
                  disabled={actioningId === draft.id}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-500 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  Aprobar y Enviar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
