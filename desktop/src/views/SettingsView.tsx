import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Clock, Plug, Plus, Save, Trash2 } from "lucide-react";
import {
  crmApi,
  type CatalogModel,
  type ModelModality,
  type ModelProvider,
  type ModelRouting,
  type ModelTestResult,
  type ResolvedModelInfo,
  type SettingHistoryEntry,
  type SettingsPayload,
} from "../api";

/**
 * Configuración → Modelos: catálogo y ruteo editables sin tocar código.
 * Todo se guarda como documento completo (el API valida y audita); lo que el
 * owner guarda aplica en el próximo turno del orquestador. Sin nada guardado
 * cada uso corre su variable de entorno o default, y el bloque "En vivo" lo
 * dice explícitamente.
 */

const inputClass =
  "bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 w-full";
const labelClass = "block text-xs font-medium text-zinc-400 mb-1";
const cardClass = "bg-zinc-900/60 border border-zinc-800 rounded-xl p-5";

const REASONING_LEVELS = [
  { value: "provider-default", label: "Default del proveedor" },
  { value: "none", label: "Sin razonamiento" },
  { value: "minimal", label: "Mínimo" },
  { value: "low", label: "Bajo" },
  { value: "medium", label: "Medio" },
  { value: "high", label: "Alto" },
  { value: "xhigh", label: "Máximo" },
];

const ROW_LABELS: Record<string, string> = {
  orchestrator: "Orquestador",
  marketingCopy: "Copy Marketing Studio",
  post: "Imagen de post",
  model: "Video",
};

const SOURCE_LABELS: Record<string, string> = {
  saved: "ajuste guardado",
  env: "variable de entorno",
  default: "default de código",
};

const emptyRouting: ModelRouting = {
  text: { orchestrator: null, marketingCopy: null, reasoning: "high" },
  image: { post: null },
  video: { model: null },
};

const newModel = (): CatalogModel => ({
  id: "",
  modality: "text",
  provider: "google",
  label: "",
  contextWindow: null,
  priceInPerM: null,
  priceOutPerM: null,
  pricePerUnit: null,
});

interface Props {
  onOpenConnection: () => void;
}

interface TestState {
  loading: boolean;
  result: ModelTestResult | null;
  error: string | null;
}

const compact = (value: unknown) => JSON.stringify(value) ?? "—";

export const SettingsView: React.FC<Props> = ({ onOpenConnection }) => {
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [routing, setRouting] = useState<ModelRouting>(emptyRouting);
  const [savedRevisions, setSavedRevisions] = useState<{ catalog: number; routing: number }>({ catalog: 0, routing: 0 });
  const [runtime, setRuntime] = useState<SettingsPayload["runtime"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [historyKey, setHistoryKey] = useState<"models.catalog" | "models.routing" | null>(null);
  const [history, setHistory] = useState<SettingHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** The routing as the server has it — the baseline for "this selection changed". */
  const savedRoutingRef = useRef<ModelRouting>(emptyRouting);
  const [confirm, setConfirm] = useState<{ failures: Array<{ id: string; reason: string }> } | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await crmApi.getSettings();
      const catalogSetting = payload.settings.find((setting) => setting.key === "models.catalog");
      const routingSetting = payload.settings.find((setting) => setting.key === "models.routing");
      const catalogValue = (catalogSetting?.value as { models?: CatalogModel[] } | undefined)?.models ?? [];
      const routingValue = routingSetting?.saved
        ? ((routingSetting.value as ModelRouting) ?? emptyRouting)
        : emptyRouting;
      setCatalog(catalogValue.map((model) => ({ ...model })));
      setRouting(routingValue);
      savedRoutingRef.current = routingValue;
      setConfirm(null);
      setSavedRevisions({ catalog: catalogSetting?.revision ?? 0, routing: routingSetting?.revision ?? 0 });
      setRuntime(payload.runtime);
    } catch (err) {
      setBanner({ ok: false, text: `No se pudo cargar la configuración: ${(err as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const routingDirty = useMemo(
    () => JSON.stringify(routing) !== JSON.stringify(emptyRouting),
    [routing]
  );

  const modelsOf = (modality: ModelModality) => catalog.filter((model) => model.modality === modality && model.id);

  const patchModel = (index: number, changes: Partial<CatalogModel>) => {
    setCatalog((prev) => prev.map((model, i) => (i === index ? { ...model, ...changes } : model)));
  };

  const routeTo = (use: keyof Pick<ModelRouting["text"], "orchestrator" | "marketingCopy"> | "post" | "model", id: string | null) => {
    setRouting((prev) => {
      if (use === "orchestrator" || use === "marketingCopy") {
        return { ...prev, text: { ...prev.text, [use]: id } };
      }
      if (use === "post") return { ...prev, image: { ...prev.image, post: id } };
      return { ...prev, video: { ...prev.video, model: id } };
    });
  };

  const routeValue = (use: "orchestrator" | "marketingCopy" | "post" | "model"): string | null => {
    if (use === "orchestrator" || use === "marketingCopy") return routing.text[use];
    if (use === "post") return routing.image.post;
    return routing.video.model;
  };

  /** Text uses whose model changed since the last load — the ones worth probing. */
  const changedTextSelections = useCallback(() => {
    const changed = (use: "orchestrator" | "marketingCopy") => {
      const id = routing.text[use];
      const savedId = savedRoutingRef.current?.text[use] ?? null;
      return id && id !== savedId ? id : null;
    };
    return (["orchestrator", "marketingCopy"] as const)
      .map((use) => {
        const id = changed(use);
        if (!id) return null;
        const model = catalog.find((entry) => entry.id === id);
        // Only google models have an automatic probe.
        return model && model.provider === "google" ? { use, id, modality: model.modality as ModelModality } : null;
      })
      .filter((entry): entry is { use: "orchestrator" | "marketingCopy"; id: string; modality: ModelModality } => !!entry);
  }, [routing, catalog]);

  const commitSave = async () => {
    setSaving(true);
    setBanner(null);
    setConfirm(null);
    try {
      await crmApi.putModels({ catalog: { models: catalog }, routing });
      setBanner({ ok: true, text: "Guardado: aplica en el próximo turno del orquestador." });
      await load();
    } catch (err) {
      setBanner({ ok: false, text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  /**
   * Before saving, probes every text model the owner just selected (a few
   * real tokens each): eve fails the turn on an invalid model, so an
   * unproven orchestrator id deserves a warning, not silence.
   */
  const save = async () => {
    setBanner(null);
    const selections = changedTextSelections();
    if (selections.length === 0) {
      await commitSave();
      return;
    }
    setSaving(true);
    const failures: Array<{ id: string; reason: string }> = [];
    for (const { id, modality } of selections) {
      try {
        const { result } = await crmApi.testModel({ provider: "google", modelId: id, modality });
        if (result.ok === false) failures.push({ id, reason: result.reason });
      } catch (err) {
        failures.push({ id, reason: (err as Error).message });
      }
    }
    setSaving(false);
    if (failures.length > 0) {
      setConfirm({ failures });
      return;
    }
    await commitSave();
  };

  const test = async (use: string, provider: ModelProvider, modelId: string, modality: ModelModality) => {
    setTests((prev) => ({ ...prev, [use]: { loading: true, result: null, error: null } }));
    try {
      const { result } = await crmApi.testModel({ provider, modelId, modality });
      setTests((prev) => ({ ...prev, [use]: { loading: false, result, error: null } }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [use]: { loading: false, result: null, error: (err as Error).message } }));
    }
  };

  const openHistory = async (key: "models.catalog" | "models.routing") => {
    if (historyKey === key) {
      setHistoryKey(null);
      setHistory(null);
      return;
    }
    setHistoryKey(key);
    setHistoryLoading(true);
    try {
      const { history: entries } = await crmApi.getSettingHistory(key);
      setHistory(entries);
    } catch (err) {
      setHistory([]);
      setBanner({ ok: false, text: `No se pudo cargar el historial: ${(err as Error).message}` });
    } finally {
      setHistoryLoading(false);
    }
  };

  const effective = (use: "orchestrator" | "marketingCopy" | "image" | "video"): ResolvedModelInfo | null =>
    runtime?.effective?.[use] ?? null;

  const renderUseRow = (
    use: "orchestrator" | "marketingCopy" | "post" | "model",
    modality: ModelModality,
    hint: string
  ) => {
    const value = routeValue(use);
    const liveKey = use === "post" ? "image" : use === "model" ? "video" : use;
    const live = effective(liveKey);
    const state = tests[use];
    const selected = catalog.find((model) => model.id === value);
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-start">
        <div>
          <label className={labelClass}>
            {ROW_LABELS[use]}{" "}
            {live && (
              <span className="text-zinc-500 font-normal">
                · en vivo: <span className="font-mono">{live.modelId}</span> ({SOURCE_LABELS[live.source]})
              </span>
            )}
          </label>
          <select
            className={inputClass}
            value={value ?? ""}
            onChange={(e) => routeTo(use, e.target.value || null)}
          >
            <option value="">— heredar (variable de entorno o default) —</option>
            {modelsOf(modality).map((model) => (
              <option key={model.id} value={model.id}>
                {model.label || model.id} ({model.id})
                {model.provider !== (runtime?.provider ?? "google") ? ` · proveedor ${model.provider}` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>
        </div>
        <div className="pt-6 flex flex-col items-end gap-1">
          <button
            onClick={() => selected && test(use, selected.provider, selected.id, modality)}
            disabled={!selected || state?.loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {state?.loading ? "Probando…" : "Probar"}
          </button>
          {state?.result && (
            <span className={`text-[11px] ${state.result.ok === true ? "text-emerald-400" : state.result.ok === false ? "text-rose-400" : "text-zinc-500"}`}>
              {state.result.ok === true
                ? `✓ responde (${state.result.latencyMs} ms)${state.result.sample ? `: ${state.result.sample}` : ""}`
                : state.result.ok === false
                ? `✗ ${state.result.reason}`
                : state.result.reason}
            </span>
          )}
          {state?.error && <span className="text-[11px] text-rose-400">{state.error}</span>}
        </div>
      </div>
    );
  };

  if (loading) {
    return <p className="text-zinc-500 text-sm">Cargando configuración…</p>;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-bold text-white">Configuración</h2>
        <p className="text-sm text-zinc-500">
          Modelos por uso, sin tocar código. Un guardado deja auditoría y aplica en el próximo turno del
          orquestador; los subagentes y las portadas por marca se configuran en sus propias pantallas.
        </p>
        {runtime && (
          <p className="mt-2 text-xs text-zinc-500">
            Proveedor activo: <span className="font-mono text-zinc-400">{runtime.provider}</span>
            {runtime.envOverrides.length > 0 && (
              <>
                {" "}· variables en uso:{" "}
                {runtime.envOverrides.map((name) => (
                  <span key={name} className="font-mono text-zinc-400 mr-1">
                    {name}
                  </span>
                ))}
              </>
            )}
          </p>
        )}
      </div>

      {banner && (
        <div
          className={`flex items-start gap-2 text-sm rounded-lg border px-4 py-3 ${
            banner.ok
              ? "border-emerald-800 bg-emerald-950/50 text-emerald-300"
              : "border-rose-800 bg-rose-950/50 text-rose-300"
          }`}
        >
          {banner.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <CircleAlert className="w-4 h-4 mt-0.5 shrink-0" />}
          <span className="break-all">{banner.text}</span>
        </div>
      )}

      {/* Ruteo */}
      <div className={cardClass}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Modelos por uso</h3>
          <span className="text-[11px] text-zinc-500">
            guardado: catálogo rev {savedRevisions.catalog} · ruteo rev {savedRevisions.routing}
          </span>
        </div>
        <div className="space-y-5">
          {renderUseRow("orchestrator", "text", "Cerebro de chats, Telegram y crons. Cambia en el próximo turno.")}
          {renderUseRow("marketingCopy", "text", "Caption y prompt visual que redacta el Marketing Studio.")}
          {renderUseRow("post", "image", "Imagen del post. Las portadas por marca viven en Contenido → Configuración Visual.")}
          {renderUseRow("model", "video", "Clip de los slots de video (omni). Sin clave de Google no hay video.")}
        </div>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
          <div>
            <label className={labelClass}>Razonamiento del orquestador</label>
            <select
              className={inputClass}
              value={routing.text.reasoning}
              onChange={(e) => setRouting((prev) => ({ ...prev, text: { ...prev.text, reasoning: e.target.value } }))}
            >
              {REASONING_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? "Guardando…" : routingDirty ? "Guardar cambios" : "Guardar"}
          </button>
        </div>
        {confirm && (
          <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
            <p className="font-semibold">Google no reconoce lo que vas a guardar:</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {confirm.failures.map((failure) => (
                <li key={failure.id}>
                  <span className="font-mono">{failure.id}</span> — {failure.reason}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">Cada turno del orquestador fallaría hasta que lo cambies.</p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  void commitSave();
                }}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50"
              >
                Guardar igual
              </button>
              <button
                onClick={() => setConfirm(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-700 text-amber-200 hover:bg-amber-900/40"
              >
                No guardar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Catálogo */}
      <div className={cardClass}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Catálogo de modelos</h3>
          <button
            onClick={() => setCatalog((prev) => [...prev, newModel()])}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            <Plus className="w-3.5 h-3.5" /> Agregar
          </button>
        </div>
        <div className="space-y-2">
          {catalog.map((model, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,1.2fr)_90px_80px_minmax(0,1fr)_150px_150px_110px_32px] gap-2 items-center">
              <input
                className={`${inputClass} font-mono text-xs`}
                placeholder="id-del-modelo"
                value={model.id}
                onChange={(e) => patchModel(index, { id: e.target.value.trim() })}
              />
              <select
                className={inputClass}
                value={model.modality}
                onChange={(e) => patchModel(index, { modality: e.target.value as ModelModality })}
              >
                <option value="text">texto</option>
                <option value="image">imagen</option>
                <option value="video">video</option>
              </select>
              <select
                className={inputClass}
                value={model.provider}
                onChange={(e) => patchModel(index, { provider: e.target.value as ModelProvider })}
              >
                <option value="google">google</option>
                <option value="meta">meta</option>
              </select>
              <input
                className={inputClass}
                placeholder="Etiqueta"
                value={model.label}
                onChange={(e) => patchModel(index, { label: e.target.value })}
              />
              <input
                className={inputClass}
                placeholder="$ in /M"
                value={model.priceInPerM ?? ""}
                onChange={(e) => patchModel(index, { priceInPerM: e.target.value === "" ? null : Number(e.target.value) })}
              />
              <input
                className={inputClass}
                placeholder="$ out /M"
                value={model.priceOutPerM ?? ""}
                onChange={(e) => patchModel(index, { priceOutPerM: e.target.value === "" ? null : Number(e.target.value) })}
              />
              <input
                className={inputClass}
                placeholder="$ por unidad"
                value={model.pricePerUnit ?? ""}
                onChange={(e) => patchModel(index, { pricePerUnit: e.target.value === "" ? null : Number(e.target.value) })}
              />
              <button
                onClick={() => setCatalog((prev) => prev.filter((_, i) => i !== index))}
                title="Quitar del catálogo (falla si está en uso)"
                className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {catalog.length === 0 && <p className="text-xs text-zinc-500">Catálogo vacío: agrega al menos un modelo.</p>}
        </div>
        <p className="mt-3 text-[11px] text-zinc-500">
          Los precios son informativos (US$, 2 decimales basta). No puedes quitar un modelo que esté en uso:
          el servidor lo rechaza y te dice cuál lo usa.
        </p>
      </div>

      {/* Historial + Conexión */}
      <div className="grid grid-cols-2 gap-4">
        <div className={cardClass}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Historial de cambios</h3>
            <div className="flex gap-2">
              {(["models.catalog", "models.routing"] as const).map((key) => (
                <button
                  key={key}
                  onClick={() => openHistory(key)}
                  className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    historyKey === key
                      ? "border-emerald-600 text-emerald-400"
                      : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" /> {key === "models.catalog" ? "Catálogo" : "Ruteo"}
                </button>
              ))}
            </div>
          </div>
          {historyKey && (
            <div className="mt-3 space-y-2 max-h-56 overflow-y-auto">
              {historyLoading && <p className="text-xs text-zinc-500">Cargando…</p>}
              {history?.length === 0 && <p className="text-xs text-zinc-500">Sin cambios guardados todavía.</p>}
              {history?.map((entry, index) => (
                <div key={index} className="text-[11px] text-zinc-400 border-b border-zinc-800 pb-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-zinc-500">
                      {new Date(entry.createdAt).toLocaleString()} · {entry.actor}
                    </span>
                    <span className="font-mono text-zinc-500">rev {index + 1}</span>
                  </div>
                  <span className="text-rose-400/80 break-all">{compact(entry.before)}</span>
                  <span className="mx-1 text-zinc-600">→</span>
                  <span className="text-emerald-400/80 break-all">{compact(entry.after)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={cardClass}>
          <h3 className="text-sm font-semibold text-white mb-2">Conexión</h3>
          <p className="text-xs text-zinc-500 mb-3">
            URL del API y owner key de esta instalación del desktop.
          </p>
          <button
            onClick={onOpenConnection}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            <Plug className="w-4 h-4" /> Editar conexión
          </button>
        </div>
      </div>
    </div>
  );
};
