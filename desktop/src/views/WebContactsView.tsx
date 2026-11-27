import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleAlert, Globe, Inbox, RefreshCw, Send, User } from "lucide-react";
import { crmApi, type WebContactItem, type WebContactMessage } from "../api";
import { Badge, EmptyState, SectionList, Skeleton, SlideOver } from "../components/ui";
import { buildReplyPrompt } from "../lib/webContactReply";

/**
 * Bandeja de contactos web: los chats que abren los visitantes de
 * creapolis.dev, separados del Orquestador Chat. Cada contacto queda "sin
 * revisar" hasta que se abre (reversible). Abrirlo carga la conversación y
 * permite pedirle al Orquestador un borrador de respuesta, que queda en
 * Outbox esperando aprobación.
 */

type ReadFilter = "unread" | "read" | "all";

const dtf = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmt = (iso: string) => dtf.format(new Date(iso));

const LIST_EXCERPT_CHARS = 140;

/** Primer mensaje del visitante en una línea, como título de la lista. */
const contactTitle = (firstMessage: string | null) => {
  const line = (firstMessage ?? "Sin mensajes").replace(/\s+/g, " ").trim();
  return line.length > LIST_EXCERPT_CHARS ? `${line.slice(0, LIST_EXCERPT_CHARS)}…` : line;
};

const READ_FILTERS: Array<{ key: ReadFilter; label: string }> = [
  { key: "unread", label: "Sin revisar" },
  { key: "read", label: "Revisados" },
  { key: "all", label: "Todos" },
];

export const WebContactsView: React.FC<{ onAskOrchestrator: (text: string) => void }> = ({
  onAskOrchestrator,
}) => {
  const [contacts, setContacts] = useState<WebContactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [readFilter, setReadFilter] = useState<ReadFilter>("unread");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WebContactMessage[] | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const selectedRef = useRef<string | null>(null);

  const selected = contacts.find((c) => c.id === selectedId) ?? null;

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await crmApi.getWebContacts();
      setContacts(res.contacts);
    } catch (err) {
      setBanner({ ok: false, text: `No se pudieron cargar los contactos web: ${(err as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setReviewed = useCallback(
    async (id: string, read: boolean) => {
      // Optimista: el badge del sidebar se refresca con su poll de 15s.
      setContacts((prev) =>
        prev.map((c) => (c.id === id ? { ...c, reviewedAt: read ? new Date().toISOString() : null } : c))
      );
      try {
        await crmApi.markWebContactReviewed(id, read);
      } catch (err) {
        setBanner({ ok: false, text: `No se pudo marcar: ${(err as Error).message}` });
        void load();
      }
    },
    [load]
  );

  const openDetail = async (contact: WebContactItem) => {
    setSelectedId(contact.id);
    selectedRef.current = contact.id;
    setMessages(null);
    setMessagesLoading(true);
    try {
      const res = await crmApi.getWebContact(contact.id);
      // Another contact may have been opened while this one was loading.
      if (selectedRef.current === contact.id) {
        setMessages(res.messages);
        // Mark reviewed only once the conversation is actually on screen: a
        // failed load must not silently drop the contact from "Sin revisar".
        if (!contact.reviewedAt) void setReviewed(contact.id, true);
      }
    } catch (err) {
      setBanner({ ok: false, text: `No se pudo cargar la conversación: ${(err as Error).message}` });
    } finally {
      if (selectedRef.current === contact.id) setMessagesLoading(false);
    }
  };

  const unreadCount = contacts.filter((c) => !c.reviewedAt).length;

  const visible = useMemo(
    () =>
      contacts.filter((c) => {
        if (readFilter === "unread" && c.reviewedAt) return false;
        if (readFilter === "read" && !c.reviewedAt) return false;
        return true;
      }),
    [contacts, readFilter]
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
            <Globe className="w-5 h-5 text-sky-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Contactos web</h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Chats que abren los visitantes de creapolis.dev — {unreadCount} sin revisar
            </p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition shrink-0"
          title="Refrescar"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-lg px-3.5 py-2 text-xs flex items-start justify-between gap-3 border ${
            banner.ok
              ? "bg-emerald-950/50 border-emerald-800 text-emerald-300"
              : "bg-rose-950/50 border-rose-800 text-rose-300"
          }`}
        >
          <span className="flex items-center gap-2">
            <CircleAlert className="w-4 h-4 shrink-0" /> {banner.text}
          </span>
          <button onClick={() => setBanner(null)} className="text-zinc-400 hover:text-white shrink-0">
            ✕
          </button>
        </div>
      )}

      {/* Filtros por estado de revisión */}
      <div className="flex rounded-lg border border-zinc-800 overflow-hidden self-start w-fit">
        {READ_FILTERS.map((f) => {
          const count = f.key === "unread" ? unreadCount : f.key === "read" ? contacts.length - unreadCount : contacts.length;
          return (
            <button
              key={f.key}
              onClick={() => setReadFilter(f.key)}
              className={`px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                readFilter === f.key ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {f.label}
              {count > 0 && <span className="ml-1.5 text-zinc-500">({count})</span>}
            </button>
          );
        })}
      </div>

      {/* Lista */}
      {loading && contacts.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="Nada por aquí"
          hint={
            readFilter === "unread"
              ? "Todo revisado. Los contactos nuevos de la web aparecen aquí automáticamente."
              : "Sin contactos para este filtro."
          }
        />
      ) : (
        <SectionList>
          {visible.map((c) => (
            <div
              key={c.id}
              className="py-3 flex items-center gap-3 cursor-pointer hover:bg-zinc-900/40 transition -mx-4 px-4 rounded-lg"
              onClick={() => void openDetail(c)}
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  c.reviewedAt ? "bg-transparent" : "bg-sky-400 shadow-sm shadow-sky-400/80"
                }`}
                title={c.reviewedAt ? "Revisado" : "Sin revisar"}
              />
              <Globe className="w-4 h-4 text-zinc-500 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className={`text-sm truncate ${c.reviewedAt ? "text-zinc-400" : "text-white font-medium"}`}>
                  {contactTitle(c.firstMessage)}
                </div>
                <div className="text-[11px] text-zinc-500 mt-0.5">
                  {fmt(c.updatedAt)} · {c.messageCount} {c.messageCount === 1 ? "mensaje" : "mensajes"}
                </div>
              </div>
            </div>
          ))}
        </SectionList>
      )}

      {/* Detalle */}
      {selected && (
        <SlideOver
          onClose={() => {
            setSelectedId(null);
            selectedRef.current = null;
          }}
          width="max-w-3xl"
          title={contactTitle(selected.firstMessage)}
          badge={selected.reviewedAt ? <Badge tone="zinc">Revisado</Badge> : <Badge tone="sky">Sin revisar</Badge>}
          meta={
            <>
              <span>llegó {fmt(selected.createdAt)}</span>
              <span>·</span>
              <span>
                {selected.messageCount} {selected.messageCount === 1 ? "mensaje" : "mensajes"}
              </span>
            </>
          }
          actions={
            <>
              <button
                onClick={() => void setReviewed(selected.id, !selected.reviewedAt)}
                className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition whitespace-nowrap"
              >
                {selected.reviewedAt ? "Marcar sin revisar" : "Marcar revisado"}
              </button>
              <button
                onClick={() => {
                  if (messages) onAskOrchestrator(buildReplyPrompt(selected, messages));
                }}
                disabled={!messages}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500 text-black hover:bg-emerald-400 transition disabled:opacity-50 whitespace-nowrap"
                title="Le pide al Orquestador un borrador de respuesta; queda en Outbox esperando tu aprobación"
              >
                <Send className="w-3.5 h-3.5" />
                Pedir respuesta
              </button>
            </>
          }
        >
          <div className="p-6 space-y-5">
            <p className="text-xs text-zinc-500 leading-relaxed">
              El visitante no ve nada de lo que escribas desde acá. «Pedir respuesta» abre el Orquestador Chat con
              esta conversación: el agente deja un borrador en Outbox y nada se envía sin tu aprobación.
            </p>

            {messagesLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-16 w-2/3" />
                <Skeleton className="h-16 w-1/2" />
              </div>
            ) : !messages || messages.length === 0 ? (
              <p className="text-xs text-zinc-500">Sin mensajes en esta conversación.</p>
            ) : (
              <div className="space-y-4">
                {messages.map((m) => {
                  const isVisitor = m.role === "user";
                  return (
                    <div key={m.id} className={`flex gap-3 ${isVisitor ? "" : "flex-row-reverse"}`}>
                      <div
                        className={`w-8 h-8 rounded-lg shrink-0 flex items-center justify-center ${
                          isVisitor
                            ? "bg-sky-500 text-black"
                            : "bg-zinc-800 text-zinc-300 border border-zinc-700"
                        }`}
                      >
                        {isVisitor ? (
                          <User className="w-4 h-4" />
                        ) : (
                          <Bot className="w-4 h-4 text-emerald-400" />
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5 min-w-0 max-w-[85%]">
                        <div
                          className={`p-3.5 rounded-xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
                            isVisitor
                              ? "bg-zinc-800 text-white rounded-tl-none border border-zinc-700/60"
                              : "bg-zinc-900/90 text-zinc-200 rounded-tr-none border border-zinc-800"
                          }`}
                        >
                          {m.content}
                        </div>
                        <span className={`text-[10px] text-zinc-500 px-1 font-mono ${isVisitor ? "" : "text-right"}`}>
                          {isVisitor ? "Visitante" : "Asistente"} · {fmt(m.createdAt)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </SlideOver>
      )}
    </div>
  );
};
