import React, { useEffect, useState } from "react";
import { crmApi, ProjectItem, TaskItem } from "../api";
import {
  FolderKanban,
  Terminal,
  GitBranch,
  RefreshCw,
  Building2,
  CheckCircle2,
  Copy,
  Check,
  AlertCircle,
} from "lucide-react";

export const ProjectsView: React.FC = () => {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"projects" | "queue">("queue");
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [projRes, taskRes] = await Promise.all([
        crmApi.getProjects(),
        crmApi.getReadyTasks(),
      ]);
      setProjects(projRes.projects);
      setTasks(taskRes.tasks);
    } catch (err: any) {
      setError(err.message || "Failed to load project & task data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const copyWorkerCommand = (taskId: string) => {
    const cmd = `pnpm --filter crm gentle-worker --run ${taskId}`;
    navigator.clipboard.writeText(cmd);
    setCopiedTaskId(taskId);
    setTimeout(() => setCopiedTaskId(null), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <FolderKanban className="w-7 h-7 text-cyan-400" />
            Projects & Gentle Coding Dispatcher
          </h2>
          <p className="text-sm text-zinc-400">
            Autonomous coding task queue created by Eve PM Agent for terminal agent{" "}
            <span className="text-cyan-300 font-mono">gentle-shell</span>.
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-4 bg-rose-950/50 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-3 text-sm">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 gap-6">
        <button
          onClick={() => setActiveTab("queue")}
          className={`pb-3 text-sm font-semibold flex items-center gap-2 transition border-b-2 ${
            activeTab === "queue"
              ? "border-cyan-400 text-cyan-400"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Terminal className="w-4 h-4" />
          Coding Queue ({tasks.length} Ready)
        </button>
        <button
          onClick={() => setActiveTab("projects")}
          className={`pb-3 text-sm font-semibold flex items-center gap-2 transition border-b-2 ${
            activeTab === "projects"
              ? "border-cyan-400 text-cyan-400"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <FolderKanban className="w-4 h-4" />
          Active Projects ({projects.length})
        </button>
      </div>

      {/* Queue View */}
      {activeTab === "queue" && (
        <div className="space-y-4">
          <div className="p-3.5 bg-cyan-950/30 border border-cyan-800/60 rounded-xl text-xs text-cyan-300 flex items-center justify-between">
            <div>
              <span className="font-semibold">Terminal Worker Integration:</span> Tasks here are
              claimed and executed by your local <span className="font-mono">gentle-shell</span> CLI
              worker.
            </div>
            <div className="font-mono text-zinc-400">Assignee: gentle-shell</div>
          </div>

          {loading && tasks.length === 0 ? (
            <div className="text-center py-12 text-zinc-500">Checking task queue...</div>
          ) : tasks.length === 0 ? (
            <div className="p-8 text-center bg-zinc-900/40 border border-zinc-800 rounded-xl text-zinc-400 text-sm">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              Coding queue is empty. All PM-dispatched specs have been executed or none are in
              ready state.
            </div>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition"
              >
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-950 text-cyan-300 border border-cyan-800">
                        {task.status.toUpperCase()}
                      </span>
                      <h3 className="text-base font-semibold text-white">{task.title}</h3>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-400 mt-1">
                      <span>Project: {task.projectName}</span>
                      {task.repoUrl && (
                        <a
                          href={task.repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-cyan-400 hover:underline"
                        >
                          <GitBranch className="w-3 h-3" />
                          Repository
                        </a>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => copyWorkerCommand(task.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium font-mono transition"
                  >
                    {copiedTaskId === task.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" /> Copied Command
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" /> Copy Worker CLI
                      </>
                    )}
                  </button>
                </div>

                {/* Spec Box */}
                <div className="mt-4 bg-zinc-950 border border-zinc-800/80 rounded-lg p-3">
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-cyan-400" /> Specification for gentle-shell
                  </div>
                  <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {task.spec}
                  </pre>
                </div>

                <div className="flex justify-between items-center text-xs text-zinc-500 mt-3 pt-3 border-t border-zinc-800/60">
                  <span>Task ID: {task.id}</span>
                  <span>Dispatched: {new Date(task.createdAt).toLocaleString()}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Projects List View */}
      {activeTab === "projects" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {loading && projects.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 col-span-2">Loading projects...</div>
          ) : projects.length === 0 ? (
            <div className="p-8 text-center bg-zinc-900/40 border border-zinc-800 rounded-xl text-zinc-400 text-sm col-span-2">
              No registered client projects yet. Eve PM agent creates projects when contracts are
              won.
            </div>
          ) : (
            projects.map((proj) => (
              <div
                key={proj.id}
                className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition"
              >
                <div className="flex justify-between items-start mb-2">
                  <h3 className="text-base font-semibold text-white">{proj.name}</h3>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800">
                    {proj.status}
                  </span>
                </div>

                {proj.organizationName && (
                  <div className="flex items-center gap-1 text-xs text-zinc-400 mb-3">
                    <Building2 className="w-3.5 h-3.5 text-zinc-500" />
                    {proj.organizationName}
                  </div>
                )}

                {proj.repoUrl && (
                  <div className="flex items-center gap-1.5 text-xs text-cyan-400 mb-3">
                    <GitBranch className="w-3.5 h-3.5" />
                    <a
                      href={proj.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline truncate"
                    >
                      {proj.repoUrl}
                    </a>
                  </div>
                )}

                <div className="text-xs text-zinc-500 pt-3 border-t border-zinc-800/60 flex justify-between">
                  <span>Created {new Date(proj.createdAt).toLocaleDateString()}</span>
                  <span>ID: {proj.id.slice(0, 8)}...</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
