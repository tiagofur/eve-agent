import React, { useEffect, useState } from "react";
import { PlugZap, CheckCircle2, AlertCircle, RotateCcw } from "lucide-react";
import { Modal } from "../components/ui";
import { API_BASE, OWNER_KEY } from "../api";

const normalizeUrl = (raw: string) => raw.trim().replace(/\/+$/, "");

interface Props {
  open: boolean;
  onClose: () => void;
}

export const ConnectionSettings: React.FC<Props> = ({ open, onClose }) => {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (open) {
      setUrl(localStorage.getItem("CREAPOLIS_API_URL") || import.meta.env.VITE_CRM_API_URL || API_BASE);
      setKey(localStorage.getItem("CREAPOLIS_OWNER_KEY") || import.meta.env.VITE_CRM_OWNER_KEY || "");
      setTestState(null);
    }
  }, [open]);

  if (!open) return null;

  const testConnection = async () => {
    setTesting(true);
    setTestState(null);
    try {
      const res = await fetch(`${normalizeUrl(url)}/health`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        setTestState({ ok: true, message: "Conexión correcta con el backend." });
      } else {
        setTestState({ ok: false, message: `El backend respondió ${res.status}. Revisa la owner key.` });
      }
    } catch {
      setTestState({ ok: false, message: "No se pudo alcanzar la URL. Verifica dominio, puerto y HTTPS." });
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    localStorage.setItem("CREAPOLIS_API_URL", normalized);
    localStorage.setItem("CREAPOLIS_OWNER_KEY", key);
    window.location.reload();
  };

  const resetToBundled = () => {
    localStorage.removeItem("CREAPOLIS_API_URL");
    localStorage.removeItem("CREAPOLIS_OWNER_KEY");
    window.location.reload();
  };

  return (
    <Modal
      onClose={onClose}
      title="Conexión al backend"
      footer={
        <>
          <button
            onClick={resetToBundled}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Valores compilados
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={testConnection}
              disabled={testing || !normalizeUrl(url)}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition disabled:opacity-40"
            >
              <PlugZap className="w-3.5 h-3.5" />
              {testing ? "Probando…" : "Probar"}
            </button>
            <button
              onClick={save}
              disabled={!normalizeUrl(url)}
              className="rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-semibold text-black hover:bg-emerald-400 transition disabled:opacity-40"
            >
              Guardar y reconectar
            </button>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Apunta la app al CRM online (el nginx del servidor proxea <code className="font-mono">/</code> al API).
          El agente eve y Postgres son internos del servidor: el API los resuelve por la red de Docker.
        </p>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5" htmlFor="conn-url">
            URL del API
          </label>
          <input
            id="conn-url"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://tu-dominio.com"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5" htmlFor="conn-key">
            Owner key
          </label>
          <input
            id="conn-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="cp_owner_…"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500"
          />
        </div>

        {testState && (
          <div
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
              testState.ok
                ? "border-emerald-800 bg-emerald-950/60 text-emerald-300"
                : "border-rose-800 bg-rose-950/60 text-rose-300"
            }`}
          >
            {testState.ok ? (
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            )}
            <span>{testState.message}</span>
          </div>
        )}

        <p className="text-[10px] text-zinc-600 font-mono truncate" title={API_BASE}>
          Activo ahora: {API_BASE} {OWNER_KEY ? "· con key" : "· sin key"}
        </p>
      </div>
    </Modal>
  );
};
