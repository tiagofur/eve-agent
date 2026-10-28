import React, { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Send,
  Users,
  Building2,
  LifeBuoy,
  FolderKanban,
  Cpu,
  ShieldCheck,
  CircleAlert,
  Bot,
  Megaphone,
  Settings,
} from "lucide-react";
import { DashboardView } from "./views/DashboardView";
import { OutboxView } from "./views/OutboxView";
import { LeadsView } from "./views/LeadsView";
import { ClientesView } from "./views/ClientesView";
import { TicketsView } from "./views/TicketsView";
import { ProjectsView } from "./views/ProjectsView";
import { ChatView } from "./views/ChatView";
import { MarketingView } from "./views/MarketingView";
import { ConnectionSettings } from "./views/ConnectionSettings";
import { API_BASE, crmApi } from "./api";

type Tab = "dashboard" | "chat" | "marketing" | "outbox" | "leads" | "clientes" | "tickets" | "projects";

const apiHost = (() => {
  try {
    return new URL(API_BASE).host;
  } catch {
    return API_BASE;
  }
})();

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [pendingDraftsCount, setPendingDraftsCount] = useState<number>(0);
  const [chatPrompt, setChatPrompt] = useState<{ id: number; text: string } | null>(null);
  const [showConnection, setShowConnection] = useState(false);

  const askOrchestrator = (text: string) => {
    setChatPrompt({ id: Date.now(), text });
    setActiveTab("chat");
  };

  const checkStatus = async () => {
    try {
      await crmApi.getHealth();
      setBackendOnline(true);
      const draftsRes = await crmApi.getPendingDrafts();
      setPendingDraftsCount(draftsRes.drafts.length);
    } catch {
      setBackendOnline(false);
    }
  };

  useEffect(() => {
    checkStatus();
    const timer = setInterval(checkStatus, 15000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500 selection:text-black">
      {/* Sidebar */}
      <aside className="w-64 border-r border-zinc-800 bg-zinc-950/80 backdrop-blur flex flex-col justify-between shrink-0 select-none">
        <div>
          {/* Logo / Branding */}
          <div className="p-5 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Cpu className="w-4 h-4 text-black font-bold" />
              </div>
              <div>
                <h1 className="text-sm font-bold tracking-tight text-white leading-none">
                  Creapolis.Dev
                </h1>
                <span className="text-[10px] text-zinc-500 font-mono tracking-wider uppercase">
                  Agent Ops Desktop
                </span>
              </div>
            </div>
          </div>

          {/* Nav Links */}
          <nav className="p-3 space-y-1">
            <button
              onClick={() => setActiveTab("dashboard")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "dashboard"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <LayoutDashboard className="w-4 h-4 text-emerald-400" />
              <span>Dashboard</span>
            </button>

            <button
              onClick={() => setActiveTab("chat")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "chat"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <Bot className="w-4 h-4 text-emerald-400" />
              <span>Orquestador Chat</span>
            </button>

            <button
              onClick={() => setActiveTab("marketing")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "marketing"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <Megaphone className="w-4 h-4 text-pink-400" />
              <span>Marketing Studio</span>
            </button>

            <button
              onClick={() => setActiveTab("outbox")}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "outbox"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <div className="flex items-center gap-3">
                <Send className="w-4 h-4 text-amber-400" />
                <span>Outbox Approvals</span>
              </div>
              {pendingDraftsCount > 0 && (
                <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-amber-500 text-black">
                  {pendingDraftsCount}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab("leads")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "leads"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <Users className="w-4 h-4 text-emerald-400" />
              <span>Leads & Pipeline</span>
            </button>

            <button
              onClick={() => setActiveTab("clientes")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "clientes"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <Building2 className="w-4 h-4 text-teal-400" />
              <span>Clientes 360°</span>
            </button>

            <button
              onClick={() => setActiveTab("tickets")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "tickets"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <LifeBuoy className="w-4 h-4 text-indigo-400" />
              <span>Support SLA</span>
            </button>

            <button
              onClick={() => setActiveTab("projects")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeTab === "projects"
                  ? "bg-zinc-800 text-white font-semibold shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
              }`}
            >
              <FolderKanban className="w-4 h-4 text-cyan-400" />
              <span>Coding Dispatcher</span>
            </button>
          </nav>
        </div>

        {/* Footer / System Status */}
        <div className="p-4 border-t border-zinc-800/80 bg-zinc-900/40">
          <button
            onClick={() => setShowConnection(true)}
            title={`${API_BASE} — clic para configurar la conexión`}
            className="w-full flex items-center justify-between text-xs group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  backendOnline === true
                    ? "bg-emerald-400 shadow-sm shadow-emerald-400/80 animate-pulse"
                    : backendOnline === false
                    ? "bg-rose-500"
                    : "bg-zinc-500"
                }`}
              />
              <span className="text-zinc-400 font-mono text-[11px] truncate">
                {backendOnline === true
                  ? `CRM Online · ${apiHost}`
                  : backendOnline === false
                  ? `CRM Offline · ${apiHost}`
                  : "Connecting..."}
              </span>
            </div>
            <Settings className="w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition shrink-0" />
          </button>

          <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
            <span className="truncate">Eve Agent + Gentle Shell</span>
            <ShieldCheck className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          </div>
        </div>

        <ConnectionSettings open={showConnection} onClose={() => setShowConnection(false)} />
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-zinc-950">
        {backendOnline === false && (
          <div className="bg-rose-950/80 border-b border-rose-800 text-rose-300 px-6 py-2.5 text-xs flex items-center gap-2">
            <CircleAlert className="w-4 h-4 flex-shrink-0" />
            <span>
              <strong>CRM Backend unreachable:</strong> el API configurado es{" "}
              <code className="font-mono">{API_BASE}</code>. Verifica que esté desplegado y reachable, o
              ajusta la conexión en el panel inferior izquierdo.
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-8 max-w-7xl w-full mx-auto">
          {activeTab === "dashboard" && <DashboardView />}
          {activeTab === "chat" && (
            <ChatView externalPrompt={chatPrompt} onPromptConsumed={() => setChatPrompt(null)} />
          )}
          {activeTab === "marketing" && <MarketingView />}
          {activeTab === "outbox" && <OutboxView />}
          {activeTab === "leads" && <LeadsView />}
          {activeTab === "clientes" && <ClientesView onAskOrchestrator={askOrchestrator} />}
          {activeTab === "tickets" && <TicketsView />}
          {activeTab === "projects" && <ProjectsView onAskOrchestrator={askOrchestrator} />}
        </div>
      </main>
    </div>
  );
};
export default App;
