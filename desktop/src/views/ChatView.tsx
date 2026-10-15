import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Bot,
  User,
  Send,
  Loader2,
  Wrench,
  Sparkles,
  Database,
  Search,
  AlertTriangle,
  Plus,
  MessageSquareText,
  Trash2,
} from "lucide-react";
import { crmApi, type ChatMessage, type ChatThread } from "../api";

interface ExtendedMessage extends ChatMessage {
  id: string;
  timestamp: string;
  toolCalls?: Array<{
    toolName: string;
    args: any;
  }>;
}

const WELCOME_MESSAGE: ExtendedMessage = {
  id: "initial-1",
  role: "assistant",
  content:
    "Hola. Soy el Orquestador Ejecutivo de Creapolis.Dev. Tengo acceso autónomo directo al CRM para consultar leads, investigar prospectos, registrar incidentes con SLA y despachar tareas de código al agente terminal.\n\n¿En qué nos enfocamos hoy?",
  timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
};

const ACTIVE_THREAD_KEY = "CREAPOLIS_CHAT_THREAD";

function toDisplayTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const ChatView: React.FC = () => {
  const [messages, setMessages] = useState<ExtendedMessage[]>([WELCOME_MESSAGE]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_THREAD_KEY)
  );
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading]);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await crmApi.getChatThreads();
      setThreads(res.threads);
      return res.threads;
    } catch {
      return null;
    }
  }, []);

  const loadThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId);
    localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
    try {
      const res = await crmApi.getChatThread(threadId);
      setMessages(
        res.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: toDisplayTime(m.createdAt),
          toolCalls: m.toolCalls ?? undefined,
        }))
      );
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          role: "assistant",
          content: `⚠️ No pude cargar la conversación: ${err.message || "error de conexión."}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    }
  }, []);

  // Initial load: threads + resume last active conversation.
  useEffect(() => {
    (async () => {
      setThreadsLoading(true);
      const list = await refreshThreads();
      const stored = localStorage.getItem(ACTIVE_THREAD_KEY);
      if (stored && list?.some((t) => t.id === stored)) {
        await loadThread(stored);
      }
      setThreadsLoading(false);
    })();
  }, [refreshThreads, loadThread]);

  const handleNewChat = () => {
    setActiveThreadId(null);
    localStorage.removeItem(ACTIVE_THREAD_KEY);
    setMessages([WELCOME_MESSAGE]);
    setInput("");
  };

  const handleDeleteThread = async (threadId: string) => {
    if (!window.confirm("¿Eliminar esta conversación?")) return;
    try {
      await crmApi.deleteChatThread(threadId);
      const list = await refreshThreads();
      setThreads(list ?? []);
      if (activeThreadId === threadId) handleNewChat();
    } catch (err: any) {
      alert(`No pude eliminar la conversación: ${err.message || "error de conexión."}`);
    }
  };

  const handleSend = async (textToSend?: string) => {
    const text = textToSend || input.trim();
    if (!text || loading) return;

    const userMsg: ExtendedMessage = {
      id: Math.random().toString(),
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setLoading(true);

    try {
      const payload: ChatMessage[] = newHistory
        .filter((m) => m.id !== "initial-1" || newHistory.length > 1)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      const res = await crmApi.sendChatMessage(payload, activeThreadId);

      if (res.threadId && res.threadId !== activeThreadId) {
        setActiveThreadId(res.threadId);
        localStorage.setItem(ACTIVE_THREAD_KEY, res.threadId);
      }

      const assistantMsg: ExtendedMessage = {
        id: Math.random().toString(),
        role: "assistant",
        content: res.reply || "He procesado las acciones solicitadas.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        toolCalls: res.toolCalls,
      };

      setMessages((prev) => [...prev, assistantMsg]);
      void refreshThreads();
    } catch (err: any) {
      const errorMsg: ExtendedMessage = {
        id: Math.random().toString(),
        role: "assistant",
        content: `⚠️ Error al consultar al Orquestador: ${err.message || "Error de conexión con el backend CRM."}`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const quickPrompts = [
    {
      label: "Resumen de Pipeline",
      icon: Database,
      prompt: "Dame un resumen rápido del estado actual del pipeline, tickets de soporte abiertos y borradores pendientes.",
    },
    {
      label: "Buscar Prospectos",
      icon: Search,
      prompt: "¿Qué prospectos tenemos en el CRM actualmente y en qué etapa están?",
    },
    {
      label: "Investigar Prospecto",
      icon: Sparkles,
      prompt: "Investiga a 'Laboratorio Clínico San Mateo', determina dolores operativos de agendamiento y guarda el prospecto con su dossier en el CRM.",
    },
    {
      label: "Ticket Crítico",
      icon: AlertTriangle,
      prompt: "Registra un ticket de soporte crítico para cliente 'Clínica Dental Mendoza' por error 500 en pasarela de pagos.",
    },
  ];

  return (
    <div className="flex h-[calc(100vh-6rem)] bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl">
      {/* Threads Sidebar */}
      <aside className="w-60 shrink-0 border-r border-zinc-800/80 bg-zinc-900/40 flex flex-col">
        <div className="p-3">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs transition shadow-md shadow-emerald-500/20"
          >
            <Plus className="w-4 h-4" />
            <span>Nuevo chat</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
          {threadsLoading && (
            <p className="px-3 py-2 text-[11px] text-zinc-500 font-mono">Cargando…</p>
          )}
          {!threadsLoading && threads.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-zinc-500 font-mono">
              Sin conversaciones todavía.
            </p>
          )}
          {threads.map((t) => (
            <div
              key={t.id}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition ${
                t.id === activeThreadId
                  ? "bg-zinc-800 text-white border border-zinc-700/60"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 border border-transparent"
              }`}
              onClick={() => void loadThread(t.id)}
            >
              <MessageSquareText className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
              <span className="flex-1 truncate">{t.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleDeleteThread(t.id);
                }}
                title="Eliminar conversación"
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-700 text-zinc-500 hover:text-rose-400 transition"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Chat Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/40 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-sm">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">
                  Orquestador Ejecutivo
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/80 border border-emerald-800 text-emerald-400">
                  Muse Spark 1.3
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Coordinación multi-agente, investigación en tiempo real y ejecución CRM
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-mono text-zinc-400">Autónomo + Tools</span>
          </div>
        </div>

        {/* Messages Thread */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((m) => {
            const isUser = m.role === "user";
            return (
              <div
                key={m.id}
                className={`flex gap-3 max-w-3xl ${isUser ? "ml-auto flex-row-reverse" : "mr-auto"}`}
              >
                <div
                  className={`w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold ${
                    isUser
                      ? "bg-emerald-500 text-black shadow-md shadow-emerald-500/20"
                      : "bg-zinc-800 text-zinc-300 border border-zinc-700"
                  }`}
                >
                  {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4 text-emerald-400" />}
                </div>

                <div className="flex flex-col gap-1.5 min-w-0">
                  <div
                    className={`p-4 rounded-xl text-sm leading-relaxed whitespace-pre-wrap ${
                      isUser
                        ? "bg-zinc-800 text-white rounded-tr-none border border-zinc-700/60"
                        : "bg-zinc-900/90 text-zinc-200 rounded-tl-none border border-zinc-800 shadow-lg"
                    }`}
                  >
                    {m.content}

                    {/* Render executed tool calls if any */}
                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-zinc-800/80 flex flex-wrap gap-2">
                        {m.toolCalls.map((tc, idx) => (
                          <div
                            key={idx}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-950/80 border border-zinc-800 text-[11px] font-mono text-emerald-400"
                          >
                            <Wrench className="w-3 h-3 text-emerald-400" />
                            <span>Tool: {tc.toolName}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <span
                    className={`text-[10px] text-zinc-500 px-1 font-mono ${
                      isUser ? "text-right" : "text-left"
                    }`}
                  >
                    {m.timestamp}
                  </span>
                </div>
              </div>
            );
          })}

          {loading && (
            <div className="flex gap-3 max-w-xl mr-auto">
              <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center bg-zinc-800 text-zinc-300 border border-zinc-700">
                <Bot className="w-4 h-4 text-emerald-400 animate-spin" />
              </div>
              <div className="p-4 rounded-xl rounded-tl-none bg-zinc-900/90 border border-zinc-800 text-zinc-400 text-sm flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                <span>El Orquestador está analizando y ejecutando herramientas...</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Suggested Quick Prompts */}
        <div className="px-6 py-2.5 bg-zinc-900/30 border-t border-zinc-800/60 flex items-center gap-2 overflow-x-auto scrollbar-none">
          <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider shrink-0 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-amber-400" /> Atajos:
          </span>
          {quickPrompts.map((qp, i) => {
            const Icon = qp.icon;
            return (
              <button
                key={i}
                onClick={() => handleSend(qp.prompt)}
                disabled={loading}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 hover:text-white transition shrink-0 disabled:opacity-50"
              >
                <Icon className="w-3 h-3 text-emerald-400" />
                <span>{qp.label}</span>
              </button>
            );
          })}
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-zinc-800/80 bg-zinc-900/50">
          <div className="relative flex items-center">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Instruye al Orquestador (ej: 'Investiga la empresa X y crea un borrador de outreach')..."
              rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 pr-24 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/80 focus:ring-1 focus:ring-emerald-500/50 resize-none"
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || loading}
              className="absolute right-3 px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs transition flex items-center gap-1.5 disabled:opacity-40 disabled:hover:bg-emerald-500 shadow-md shadow-emerald-500/20"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <>
                  <span>Enviar</span>
                  <Send className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-zinc-500 font-mono px-1">
            <span>Enter para enviar, Shift+Enter para salto de línea</span>
            <span>Creapolis Multi-Agent Protocol v1.0</span>
          </div>
        </div>
      </div>
    </div>
  );
};
