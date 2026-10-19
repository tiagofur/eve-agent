import React, { useEffect, useState } from "react";
import { crmApi, InteractionItem } from "../api";
import { FollowUpForm } from "./FollowUpForm";
import { Bot, MessageSquareText, Send, X } from "lucide-react";

interface Props {
  contactId: string;
  contactName: string;
  organizationId?: string;
  organizationName?: string | null;
  onClose: () => void;
  onAskOrchestrator: (prompt: string) => void;
}

const CHANNELS = ["whatsapp", "email", "telegram", "linkedin", "phone", "web", "other"];

/** Hilo unificado de un contacto: historial + registro manual + pedir respuesta al orquestador. */
export const ThreadDrawer: React.FC<Props> = ({
  contactId,
  contactName,
  organizationId,
  organizationName,
  onClose,
  onAskOrchestrator,
}) => {
  const [entries, setEntries] = useState<InteractionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [followUpAt, setFollowUpAt] = useState<string | null>(null);
  const [followUpNote, setFollowUpNote] = useState<string | null>(null);
  const [channel, setChannel] = useState("whatsapp");
  const [direction, setDirection] = useState<"inbound" | "outbound">("inbound");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchThread = async () => {
    try {
      setLoading(true);
      const res = await crmApi.getContactThread(contactId);
      setEntries(res.interactions);
      setFollowUpAt(res.contact.nextFollowUpAt);
      setFollowUpNote(res.contact.followUpNote);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  const handleLog = async () => {
    if (!content.trim() || saving) return;
    try {
      setSaving(true);
      await crmApi.logInteraction({
        contactId,
        organizationId,
        channel,
        direction,
        content: content.trim(),
      });
      setContent("");
      await fetchThread();
    } catch (err: any) {
      alert(`No se pudo registrar: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleAsk = () => {
    const lastInbound = [...entries].reverse().find((e) => e.direction === "inbound");
    const prompt =
      `Actuá como mi orquestador y redactá una respuesta para ${contactName}` +
      (organizationName ? ` (${organizationName})` : "") +
      ` por ${channel}.` +
      (lastInbound ? `\n\nSu último mensaje fue:\n\"${lastInbound.content}\"\n(por ${lastInbound.channel}, ${new Date(lastInbound.createdAt).toLocaleString()})` : "") +
      `\n\nMostrame el borrador y, si lo apruebo, registrá tu respuesta con log_client_interaction (direction outbound, contactId ${contactId}${organizationId ? `, organizationId ${organizationId}` : ""}).`;
    onAskOrchestrator(prompt);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-xl h-full flex flex-col bg-zinc-950 border-l border-zinc-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-zinc-800 flex items-start justify-between bg-zinc-900/40">
          <div>
            <div className="text-xs font-mono text-teal-400 uppercase font-semibold flex items-center gap-1.5">
              <MessageSquareText className="w-3.5 h-3.5" /> Hilo unificado
            </div>
            <h3 className="text-lg font-bold text-white mt-0.5">{contactName}</h3>
            {organizationName && <p className="text-xs text-zinc-500">{organizationName}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {loading ? (
            <p className="text-sm text-zinc-500">Cargando hilo...</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-zinc-600">Sin mensajes registrados todavía.</p>
          ) : (
            entries.map((e) => (
              <div
                key={e.id}
                className={`p-3 rounded-xl border text-sm max-w-[90%] ${
                  e.direction === "inbound"
                    ? "bg-zinc-900 border-zinc-800 text-zinc-200"
                    : "bg-teal-950/40 border-teal-800/60 text-teal-100 ml-auto"
                }`}
              >
                <div className="text-[10px] font-mono uppercase text-zinc-500 mb-1">
                  {e.direction === "inbound" ? "Cliente" : "Nosotros"} · {e.channel} ·{" "}
                  {new Date(e.createdAt).toLocaleString()}
                </div>
                <div className="whitespace-pre-wrap">{e.content}</div>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-zinc-800 space-y-2 bg-zinc-900/30">
          <FollowUpForm
            kind="contact"
            entityId={contactId}
            currentAt={followUpAt}
            currentNote={followUpNote}
            onSaved={() => fetchThread()}
          />
          <div className="flex gap-2">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-xs text-zinc-200"
            >
              {CHANNELS.map((ch) => (
                <option key={ch} value={ch}>{ch}</option>
              ))}
            </select>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as "inbound" | "outbound")}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-2 text-xs text-zinc-200"
            >
              <option value="inbound">Entrante</option>
              <option value="outbound">Saliente</option>
            </select>
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Registrar mensaje..."
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600"
            />
            <button
              onClick={handleLog}
              disabled={saving || !content.trim()}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={handleAsk}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-700/60 text-sm font-medium transition"
          >
            <Bot className="w-4 h-4" /> Pedir al orquestador que conteste
          </button>
        </div>
      </div>
    </div>
  );
};
