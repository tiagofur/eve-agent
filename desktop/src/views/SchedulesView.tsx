import React, { useCallback, useEffect, useState } from "react";
// Default import: v4 is CJS; vite tolerates the named import but keep the
// same interop shape as the CRM so both runtimes behave identically.
import cronParser from "cron-parser";

const parseExpression = cronParser.parseExpression;
import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import {
  crmApi,
  type ChatThreadDetails,
  type ScheduleItem,
  type ScheduleRunItem,
} from "../api";
import { Badge, EmptyState, InfoGrid, Modal, SectionList, Skeleton, SlideOver } from "../components/ui";
import { FormButtons, FormError, inputClass, labelClass } from "./CrmForms";

/**
 * Tareas programadas del agente (cronjobs): listado, CRUD manual (override
 * agent-first), ejecución inmediata e historial con la conversación de cada
 * ejecución. La creación/mejora "con el agente" se deriva al Orquestador Chat
 * con el plumbing externalPrompt.
 */

const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const dtf = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const fmtDateTime = (iso: string | null) => (iso ? dtf.format(new Date(iso)) : "—");

function fmtDuration(run: ScheduleRunItem): string {
  if (!run.finishedAt) return "en curso";
  const secs = Math.max(1, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Traducción pragmática de crons comunes; cualquier otra cosa se muestra cruda. */
export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const at = (h: string, m: string) => `${Number(h)}:${m.padStart(2, "0")}`;
  if (dom === "*" && mon === "*") {
    if (dow === "*" && hour !== "*" && !hour.includes("*/") && !min.includes("*/")) {
      return `Cada día a las ${at(hour, min)}`;
    }
    if (dow !== "*" && hour !== "*" && !hour.includes("*/") && !min.includes("*/")) {
      const days = dow
        .split(",")
        .map((d) => (d in DAY_NAMES || /^\d$/.test(d) ? DAY_NAMES[Number(d)] : d))
        .join(" y ");
      return `Cada ${days} a las ${at(hour, min)}`;
    }
    if (dow === "*" && min.startsWith("*/") && hour === "*") {
      return `Cada ${min.slice(2)} minutos`;
    }
    if (dow === "*" && hour.startsWith("*/") && hour !== "*" && min !== "*") {
      return `Cada ${hour.slice(2)} horas`;
    }
  }
  return cron;
}

function validateCron(expr: string): string | null {
  try {
    parseExpression(expr);
    return null;
  } catch {
    return "Expresión cron inválida (5 campos: minuto hora día-mes mes día-semana)";
  }
}

function nextRunPreview(expr: string): string | null {
  try {
    return dtf.format(parseExpression(expr).next().toDate());
  } catch {
    return null;
  }
}

const statusTone: Record<ScheduleRunItem["status"], "emerald" | "rose" | "amber"> = {
  succeeded: "emerald",
  failed: "rose",
  running: "amber",
};
const statusLabel: Record<ScheduleRunItem["status"], string> = {
  succeeded: "OK",
  failed: "Falló",
  running: "Corriendo",
};

export const SchedulesView: React.FC<{ onAskOrchestrator: (text: string) => void }> = ({
  onAskOrchestrator,
}) => {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [serverTimezone, setServerTimezone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRunItem[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runMessages, setRunMessages] = useState<Record<string, ChatThreadDetails["messages"]>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzDiffers = serverTimezone !== null && serverTimezone !== localTz;

  const selected = schedules.find((s) => s.id === selectedId) ?? null;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await crmApi.getSchedules();
      setSchedules(res.schedules);
      setServerTimezone(res.timezone);
    } catch (err) {
      setBanner({ ok: false, text: `No se pudieron cargar las tareas: ${(err as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(async (scheduleId: string) => {
    try {
      setRunsLoading(true);
      const res = await crmApi.getScheduleRuns(scheduleId);
      setRuns(res.runs);
    } catch {
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const openDetail = (id: string) => {
    setSelectedId(id);
    setExpandedRunId(null);
    setConfirmDelete(false);
    void loadRuns(id);
  };

  const closeDetail = () => {
    setSelectedId(null);
    setRuns([]);
    setRunMessages({});
  };

  const toggleEnabled = async (s: ScheduleItem) => {
    try {
      setTogglingId(s.id);
      await crmApi.updateSchedule(s.id, { enabled: !s.enabled });
      await load();
      if (selectedId === s.id) await loadRuns(s.id);
      setBanner({ ok: true, text: s.enabled ? `«${s.title}» pausada` : `«${s.title}» reactivada` });
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    } finally {
      setTogglingId(null);
    }
  };

  const runNow = async (s: ScheduleItem) => {
    try {
      await crmApi.runScheduleNow(s.id);
      setBanner({ ok: true, text: `Ejecución de «${s.title}» iniciada (puede tardar; mira el historial)` });
      await loadRuns(s.id);
    } catch (err) {
      setBanner({ ok: false, text: `No se pudo ejecutar: ${(err as Error).message}` });
    }
  };

  const removeSchedule = async (s: ScheduleItem) => {
    try {
      await crmApi.deleteSchedule(s.id);
      setBanner({ ok: true, text: `«${s.title}» eliminada` });
      closeDetail();
      await load();
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    }
  };

  const improveWithAgent = (s: ScheduleItem) => {
    onAskOrchestrator(
      [
        `Quiero que revises y mejores esta tarea programada del agente: "${s.title}" (name: ${s.name}, cron: ${s.cron}).`,
        `Su prompt actual es:\n"""\n${s.prompt}\n"""`,
        "Lee la definición completa con list_schedules, detecta debilidades (prompt poco autosuficiente, pasos faltantes, delegación o tools equivocadas, cadencia) y aplica las mejoras con update_schedule. Al final resume exactamente qué cambiaste.",
      ].join("\n\n")
    );
  };

  const toggleRunMessages = async (run: ScheduleRunItem) => {
    if (expandedRunId === run.id) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(run.id);
    if (run.threadId && !runMessages[run.id]) {
      try {
        const details = await crmApi.getChatThread(run.threadId);
        setRunMessages((prev) => ({ ...prev, [run.id]: details.messages }));
      } catch {
        setRunMessages((prev) => ({ ...prev, [run.id]: [] }));
      }
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/30 flex items-center justify-center shrink-0">
            <CalendarClock className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Tareas Programadas</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Los cronjobs del agente: cadencia, prompt e historial de ejecuciones
              {serverTimezone && (
                <> · hora del servidor <span className="font-mono">{serverTimezone}</span></>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void load()}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
            title="Refrescar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg transition"
          >
            <Plus className="w-4 h-4" /> Nueva
          </button>
        </div>
      </div>

      {tzDiffers && (
        <div className="bg-amber-950/50 border border-amber-800 text-amber-300 rounded-lg px-3.5 py-2 text-xs flex items-center gap-2">
          <CircleAlert className="w-4 h-4 shrink-0" />
          El cron se evalúa en la zona del servidor ({serverTimezone}); tu equipo está en {localTz},
          así que las horas pueden verse distintas a lo que escribes.
        </div>
      )}
      {banner && (
        <div
          className={`rounded-lg px-3.5 py-2 text-xs flex items-start justify-between gap-3 border ${
            banner.ok
              ? "bg-emerald-950/50 border-emerald-800 text-emerald-300"
              : "bg-rose-950/50 border-rose-800 text-rose-300"
          }`}
        >
          <span className="flex items-center gap-2">
            {banner.ok ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <CircleAlert className="w-4 h-4 shrink-0" />
            )}
            {banner.text}
          </span>
          <button onClick={() => setBanner(null)} className="text-zinc-400 hover:text-white shrink-0">
            ✕
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No hay tareas programadas"
          hint="Crea una con el botón Nueva — manualmente o describiéndole al agente qué quieres."
        />
      ) : (
        <SectionList>
          {schedules.map((s) => (
            <div
              key={s.id}
              className="py-3.5 flex items-center gap-4 cursor-pointer hover:bg-zinc-900/40 transition -mx-4 px-4 rounded-lg"
              onClick={() => openDetail(s.id)}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  s.enabled ? "bg-emerald-400 shadow-sm shadow-emerald-400/80" : "bg-zinc-600"
                }`}
                title={s.enabled ? "Activa" : "Pausada"}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-white truncate">{s.title}</span>
                  <Badge tone={s.source === "system" ? "indigo" : "zinc"}>
                    {s.source === "system" ? "Sistema" : "Custom"}
                  </Badge>
                  {s.lastRun && (
                    <Badge tone={statusTone[s.lastRun.status]}>{statusLabel[s.lastRun.status]}</Badge>
                  )}
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  <span className="font-mono">{s.name}</span>
                  <span>·</span>
                  <span>{humanizeCron(s.cron)}</span>
                  {s.cron !== humanizeCron(s.cron) && (
                    <span className="font-mono text-zinc-600">({s.cron})</span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0 hidden sm:block">
                <div className="text-[11px] text-zinc-400">
                  {s.enabled ? (
                    <span className="flex items-center gap-1.5 justify-end">
                      <Clock3 className="w-3.5 h-3.5 text-zinc-500" /> {fmtDateTime(s.nextRunAt)}
                    </span>
                  ) : (
                    <span className="text-zinc-600">pausada</span>
                  )}
                </div>
                <div className="text-[10px] text-zinc-600">
                  {s.lastRun ? `última: ${fmtDateTime(s.lastRun.startedAt)}` : "sin ejecuciones"}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleEnabled(s);
                }}
                disabled={togglingId === s.id}
                title={s.enabled ? "Pausar" : "Reactivar"}
                className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition shrink-0 disabled:opacity-50"
              >
                {togglingId === s.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : s.enabled ? (
                  <Pause className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </button>
            </div>
          ))}
        </SectionList>
      )}

      {/* Detail drawer */}
      {selected && (
        <SlideOver
          onClose={closeDetail}
          title={selected.title}
          badge={
            selected.enabled ? <Badge tone="emerald">Activa</Badge> : <Badge tone="zinc">Pausada</Badge>
          }
          meta={
            <>
              <span className="font-mono">{selected.name}</span>
              <span>·</span>
              <span>{humanizeCron(selected.cron)}</span>
              <span className="font-mono text-zinc-600">{selected.cron}</span>
            </>
          }
          actions={
            <>
              <button
                onClick={() => void toggleEnabled(selected)}
                disabled={togglingId === selected.id}
                title={selected.enabled ? "Pausar" : "Reactivar"}
                className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition disabled:opacity-50"
              >
                {togglingId === selected.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : selected.enabled ? (
                  <Pause className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => void runNow(selected)}
                title="Ejecutar ahora"
                className="p-2 rounded-lg text-amber-300 hover:text-amber-200 hover:bg-zinc-800 transition"
              >
                <Zap className="w-4 h-4" />
              </button>
              <button
                onClick={() => improveWithAgent(selected)}
                title="Mejorar con el agente"
                className="p-2 rounded-lg text-violet-300 hover:text-violet-200 hover:bg-zinc-800 transition"
              >
                <Sparkles className="w-4 h-4" />
              </button>
              <button
                onClick={() => setShowEdit(true)}
                title="Editar"
                className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                <Pencil className="w-4 h-4" />
              </button>
              {confirmDelete ? (
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => void removeSchedule(selected)}
                    className="px-2 py-1 text-[11px] font-semibold rounded-md bg-rose-500 text-white hover:bg-rose-400 transition"
                  >
                    Sí, eliminar
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-1 text-[11px] rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  title="Eliminar"
                  className="p-2 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-zinc-800 transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </>
          }
        >
          <div className="p-6 space-y-6">
            <InfoGrid
              items={[
                { label: "Próxima ejecución", value: selected.enabled ? fmtDateTime(selected.nextRunAt) : "pausada" },
                {
                  label: "Última ejecución",
                  value: selected.lastRun
                    ? `${fmtDateTime(selected.lastRun.startedAt)} · ${statusLabel[selected.lastRun.status]}`
                    : "sin ejecuciones",
                },
                { label: "Origen", value: selected.source === "system" ? "Sistema (semilla)" : "Creada por ti / el agente" },
                { label: "Cadencia", value: <span className="font-mono">{selected.cron}</span> },
              ]}
            />

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Prompt (se ejecuta en sesión nueva, sin contexto del chat)
              </h4>
              <pre className="text-xs text-zinc-200 whitespace-pre-wrap font-mono bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 leading-relaxed">
                {selected.prompt}
              </pre>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">
                Ejecuciones (últimas {runs.length || 20})
              </h4>
              {runsLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : runs.length === 0 ? (
                <EmptyState icon={Clock3} title="Todavía no se ejecutó" />
              ) : (
                <SectionList>
                  {runs.map((run) => (
                    <div key={run.id} className="py-3">
                      <button
                        className="w-full text-left flex items-center gap-3"
                        onClick={() => void toggleRunMessages(run)}
                      >
                        <Badge tone={statusTone[run.status]}>{statusLabel[run.status]}</Badge>
                        <span className="text-xs text-zinc-300">
                          {fmtDateTime(run.startedAt)}
                          <span className="text-zinc-500">
                            {" "}
                            · {run.trigger === "manual" ? "manual" : "cron"} · {fmtDuration(run)}
                          </span>
                        </span>
                        <span className="ml-auto text-zinc-500 text-xs shrink-0">
                          {expandedRunId === run.id ? "▲" : "▼"}
                        </span>
                      </button>
                      {(run.resultSummary || run.error) && expandedRunId !== run.id && (
                        <p className="text-[11px] text-zinc-500 mt-1.5 line-clamp-2">
                          {run.error ?? run.resultSummary}
                        </p>
                      )}
                      {expandedRunId === run.id && (
                        <div className="mt-3 space-y-2">
                          {(run.error || run.resultSummary) && (
                            <p
                              className={`text-[11px] rounded-lg px-3 py-2 border ${
                                run.error
                                  ? "bg-rose-950/50 border-rose-800 text-rose-300"
                                  : "bg-zinc-900/60 border-zinc-800 text-zinc-300"
                              }`}
                            >
                              {run.error ?? run.resultSummary}
                            </p>
                          )}
                          {!run.threadId && (
                            <p className="text-[11px] text-zinc-500">Esta ejecución no dejó conversación.</p>
                          )}
                          {run.threadId &&
                            (runMessages[run.id] ? (
                              runMessages[run.id].length === 0 ? (
                                <p className="text-[11px] text-zinc-500">Sin mensajes registrados.</p>
                              ) : (
                                runMessages[run.id].map((m) => (
                                  <div
                                    key={m.id}
                                    className={`text-xs rounded-lg px-3 py-2 border ${
                                      m.role === "user"
                                        ? "bg-zinc-900/60 border-zinc-800 text-zinc-300"
                                        : "bg-emerald-950/30 border-emerald-900/50 text-emerald-100"
                                    }`}
                                  >
                                    <span className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
                                      {m.role === "user" ? "tarea" : "orquestador"}
                                    </span>
                                    <span className="whitespace-pre-wrap leading-relaxed">{m.content}</span>
                                  </div>
                                ))
                              )
                            ) : (
                              <Skeleton className="h-12 w-full" />
                            ))}
                        </div>
                      )}
                    </div>
                  ))}
                </SectionList>
              )}
            </div>
          </div>
        </SlideOver>
      )}

      {showNew && (
        <NewScheduleModal
          onClose={() => setShowNew(false)}
          onCreated={async () => {
            setShowNew(false);
            await load();
            setBanner({ ok: true, text: "Tarea programada creada" });
          }}
          onAskAgent={(description) => {
            setShowNew(false);
            onAskOrchestrator(
              [
                "Quiero una nueva tarea programada del agente. Esto es lo que tiene que hacer y cada cuánto:",
                `«${description}»`,
                "Primero revisa con list_schedules que no exista ya algo equivalente. Luego créala con create_schedule: título claro, cron de 5 campos (confírmame la cadencia si hay ambigüedad de hora o zona) y un prompt autosuficiente para una sesión headless del orquestador (delega en el subagente adecuado y usa las tools correctas). Crea la tarea y resúmeme la definición final.",
              ].join("\n\n")
            );
          }}
          onError={(text) => setBanner({ ok: false, text })}
        />
      )}

      {showEdit && selected && (
        <EditScheduleModal
          schedule={selected}
          onClose={() => setShowEdit(false)}
          onSaved={async () => {
            setShowEdit(false);
            await load();
            setBanner({ ok: true, text: "Tarea actualizada" });
          }}
          onError={(text) => setBanner({ ok: false, text })}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Modales: alta manual / alta con el agente / edición                 */
/* ------------------------------------------------------------------ */

const NewScheduleModal: React.FC<{
  onClose: () => void;
  onCreated: () => Promise<void>;
  onAskAgent: (description: string) => void;
  onError: (text: string) => void;
}> = ({ onClose, onCreated, onAskAgent, onError }) => {
  const [mode, setMode] = useState<"manual" | "agent">("agent");
  const [title, setTitle] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const cronError = mode === "manual" && cron ? validateCron(cron) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cronError) return;
    try {
      setSaving(true);
      await crmApi.createSchedule({ title, cron, prompt });
      await onCreated();
    } catch (err) {
      onError(`No se pudo crear: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Nueva tarea programada" width="max-w-2xl">
      <div className="flex gap-1 p-1 bg-zinc-950 border border-zinc-800 rounded-lg mb-4" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "agent"}
          onClick={() => setMode("agent")}
          className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition ${
            mode === "agent" ? "bg-violet-500/20 text-violet-200" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          ✨ Con el agente
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "manual"}
          onClick={() => setMode("manual")}
          className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition ${
            mode === "manual" ? "bg-emerald-500/20 text-emerald-200" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Manual
        </button>
      </div>

      {mode === "agent" ? (
        <div className="space-y-3">
          <div>
            <label className={labelClass}>
              Describe qué debe hacer el agente y cada cuánto (él propone el resto)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="Ej.: cada lunes a las 10, revisar los tickets abiertos de la semana y proponer un plan de cierre por prioridad…"
              className={`${inputClass} resize-y`}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white rounded-lg bg-zinc-800 hover:bg-zinc-700 transition"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!description.trim()}
              onClick={() => onAskAgent(description.trim())}
              className="px-4 py-2 text-xs font-semibold text-black bg-violet-400 hover:bg-violet-300 rounded-lg transition disabled:opacity-50"
            >
              Pedir al orquestador
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className={labelClass}>Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={120}
              placeholder="Ej.: Resumen semanal de soporte"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Cron (5 campos, hora del servidor)</label>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              required
              placeholder="0 9 * * 1"
              className={`${inputClass} font-mono`}
            />
            {cron && !cronError && nextRunPreview(cron) && (
              <p className="text-[11px] text-zinc-500 mt-1">
                Próxima ejecución en tu zona: {nextRunPreview(cron)}
              </p>
            )}
            <FormError message={cronError} />
          </div>
          <div>
            <label className={labelClass}>
              Prompt (autosuficiente: corre en sesión nueva, sin contexto del chat)
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
              rows={6}
              placeholder="Ej.: Delega en el subagente `closer`: revisa los drafts pendientes de aprobación y…"
              className={`${inputClass} resize-y font-mono text-xs`}
            />
          </div>
          <FormButtons onClose={onClose} busy={saving} disabled={!title || !prompt || !!cronError} label="Crear tarea" />
        </form>
      )}
    </Modal>
  );
};

const EditScheduleModal: React.FC<{
  schedule: ScheduleItem;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onError: (text: string) => void;
}> = ({ schedule, onClose, onSaved, onError }) => {
  const [title, setTitle] = useState(schedule.title);
  const [cron, setCron] = useState(schedule.cron);
  const [prompt, setPrompt] = useState(schedule.prompt);
  const [saving, setSaving] = useState(false);

  const cronChanged = cron !== schedule.cron;
  const cronError = cron ? validateCron(cron) : null;
  const dirty = title !== schedule.title || cronChanged || prompt !== schedule.prompt;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cronError) return;
    try {
      setSaving(true);
      await crmApi.updateSchedule(schedule.id, { title, cron, prompt });
      await onSaved();
    } catch (err) {
      onError(`No se pudo guardar: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={`Editar «${schedule.title}»`} width="max-w-2xl">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className={labelClass}>Título</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>
            Cron (5 campos, hora del servidor) — cambiarlo re-arma la próxima ejecución
          </label>
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            required
            className={`${inputClass} font-mono`}
          />
          {cron && !cronError && nextRunPreview(cron) && (
            <p className="text-[11px] text-zinc-500 mt-1">
              Próxima ejecución en tu zona: {nextRunPreview(cron)}
            </p>
          )}
          <FormError message={cronError} />
        </div>
        <div>
          <label className={labelClass}>Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            rows={8}
            className={`${inputClass} resize-y font-mono text-xs`}
          />
        </div>
        <FormButtons onClose={onClose} busy={saving} disabled={!dirty || !!cronError} label="Guardar cambios" />
      </form>
    </Modal>
  );
};
