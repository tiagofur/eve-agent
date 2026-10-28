import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { crmApi, PipelineTaskItem, ProjectItem, FolderCheckData, TaskRunItem } from "../api";
import {
  FolderKanban,
  Terminal,
  GitBranch,
  RefreshCw,
  Building2,
  CheckCircle2,
  AlertCircle,
  Play,
  XCircle,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  Plus,
  X,
  Send,
  FolderOpen,
  CheckCheck,
} from "lucide-react";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* ------------------------------------------------------------------ */
/* Issue composition: the structured instructions handed to gentle-shell */
/* ------------------------------------------------------------------ */

function buildIssue(task: PipelineTaskItem, branch: string): { markdown: string; prompt: string } {
  const p = task.project;
  const markdown = [
    `# ${task.kind === "correction" ? "Corrección" : "Tarea"}: ${task.title}`,
    ``,
    `- **Proyecto:** ${p.name ?? task.projectId}`,
    `- **Organización:** ${p.organizationName ?? "—"}`,
    `- **Repo:** ${p.repoUrl ?? "(solo local)"}`,
    `- **Carpeta local:** ${p.localPath ?? "NO CONFIGURADA"}`,
    `- **Rama base:** ${p.defaultBranch} · **Rama de trabajo:** ${branch}`,
    `- **Comando de verificación:** ${p.testCommand ?? "no configurado"}`,
    ``,
    `## Issue — instrucciones completas`,
    ``,
    task.spec,
    ``,
    `## Restricciones`,
    ``,
    `- Trabaja únicamente dentro de la carpeta del proyecto.`,
    `- No hagas push ni publiques nada: deja los cambios commiteados en la rama ${branch}.`,
    `- Si algo referenciado no existe, no lo inventes: repórtalo en el reporte final.`,
    ``,
    `## Reporte final obligatorio`,
    ``,
    `Termina tu salida con este bloque exacto:`,
    ``,
    `-----RUN REPORT-----`,
    `BRANCH: <rama final>`,
    `CHANGES: <resumen en una línea>`,
    `VERIFICATION: <comandos ejecutados y su resultado>`,
    `PR: <url o none>`,
  ].join("\n");

  const prompt = [
    `Eres el agente de corrección de código de Creapolis.Dev. Ejecuta el issue completo abajo.`,
    `Crea la rama ${branch} desde ${p.defaultBranch}, aplica los cambios, verifica${
      p.testCommand ? ` (como mínimo: ${p.testCommand})` : " lo que puedas"
    } y termina tu salida con el bloque de reporte indicado al final del issue.`,
    ``,
    markdown,
  ].join("\n");

  return { markdown, prompt };
}

function parseRunReport(tail: string): { resultSummary: string; prUrl?: string } {
  const idx = tail.lastIndexOf("-----RUN REPORT-----");
  if (idx === -1) {
    return { resultSummary: tail.slice(-1500).trim() || "sin salida del agente" };
  }
  const block = tail.slice(idx).trim();
  const prMatch = block.match(/^PR:\s*(\S+)/m);
  const prUrl =
    prMatch && /^https?:\/\//.test(prMatch[1]) ? prMatch[1] : undefined;
  return { resultSummary: block.slice(0, 2000), prUrl };
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

const folderState = (p: PipelineTaskItem["project"] | ProjectItem) => {
  if (!p.localPath) return "missing" as const;
  return p.folderVerifiedAt ? "verified" as const : "unverified" as const;
};

const FolderBadge: React.FC<{ project: PipelineTaskItem["project"] | ProjectItem }> = ({ project }) => {
  const state = folderState(project);
  if (state === "missing") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-950/60 text-amber-300 border border-amber-800">
        <ShieldAlert className="w-3 h-3" /> Sin carpeta
      </span>
    );
  }
  if (state === "unverified") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-950/60 text-amber-300 border border-amber-800">
        <ShieldAlert className="w-3 h-3" /> Carpeta sin verificar
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800">
      <ShieldCheck className="w-3 h-3" /> Carpeta verificada
    </span>
  );
};

const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const tone =
    status === "pending_approval"
      ? "bg-amber-950 text-amber-300 border-amber-800"
      : status === "approved"
        ? "bg-cyan-950 text-cyan-300 border-cyan-800"
        : status === "in_review"
          ? "bg-violet-950 text-violet-300 border-violet-800"
          : status === "done"
            ? "bg-emerald-950 text-emerald-300 border-emerald-800"
            : "bg-zinc-800 text-zinc-300 border-zinc-700";
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${tone}`}>
      {status.replace(/_/g, " ").toUpperCase()}
    </span>
  );
};

const SpecBox: React.FC<{ spec: string; maxH?: string }> = ({ spec, maxH = "max-h-48" }) => (
  <div className="mt-3 bg-zinc-950 border border-zinc-800/80 rounded-lg p-3">
    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
      <Terminal className="w-3.5 h-3.5 text-cyan-400" /> Issue para gentle-shell
    </div>
    <pre className={`text-xs text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed ${maxH} overflow-y-auto`}>
      {spec}
    </pre>
  </div>
);

/* ------------------------------------------------------------------ */
/* Main view                                                           */
/* ------------------------------------------------------------------ */

export const ProjectsView: React.FC<{ onAskOrchestrator?: (text: string) => void }> = ({
  onAskOrchestrator,
}) => {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [tasks, setTasks] = useState<PipelineTaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"pipeline" | "projects">("pipeline");
  const [launching, setLaunching] = useState<Record<string, boolean>>({});
  const [autoLaunch, setAutoLaunch] = useState(
    () => localStorage.getItem("CREAPOLIS_AUTOLAUNCH") !== "off"
  );
  const [showForm, setShowForm] = useState(false);
  const [liveLogs, setLiveLogs] = useState<Record<string, string>>({});
  const newCorrectionBtnRef = useRef<HTMLButtonElement>(null);

  interface ActiveRun {
    runId: string;
    pid: number;
    logPath: string;
  }
  const activeRuns = useRef<Record<string, ActiveRun>>({});
  const unlisteners = useRef<Array<() => void>>([]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [projRes, pipeRes] = await Promise.all([
        crmApi.getProjects(),
        crmApi.getPipelineTasks(),
      ]);
      setProjects(projRes.projects);
      setTasks(pipeRes.tasks);
    } catch (err: any) {
      setError(err.message || "Failed to load project & task data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 15000);
    return () => {
      clearInterval(timer);
      unlisteners.current.forEach((u) => u());
      unlisteners.current = [];
    };
  }, []);

  const toggleAutoLaunch = () => {
    const next = !autoLaunch;
    setAutoLaunch(next);
    localStorage.setItem("CREAPOLIS_AUTOLAUNCH", next ? "on" : "off");
  };

  /* ---------------- launch flow ---------------- */

  const finishRun = async (taskId: string, logPath: string) => {
    const active = activeRuns.current[taskId];
    try {
      const tail = await invoke<string>("read_run_log", { logPath, tailBytes: 65536 });
      const report = parseRunReport(tail);
      if (active) {
        await crmApi.closeTaskRun(taskId, active.runId, {
          exitCode: 0,
          resultSummary: report.resultSummary,
          ...(report.prUrl ? { prUrl: report.prUrl } : {}),
        });
      }
    } catch (err: any) {
      setActionError(`No se pudo cerrar el run de ${taskId.slice(0, 8)}: ${err?.message ?? err}`);
    } finally {
      delete activeRuns.current[taskId];
      fetchData();
    }
  };

  const launchTask = async (task: PipelineTaskItem): Promise<boolean> => {
    if (!isTauri()) {
      setActionError("El lanzamiento de gentle-shell requiere la app de escritorio (Tauri).");
      return false;
    }
    if (!task.project.localPath) {
      setActionError(`El proyecto "${task.project.name}" no tiene carpeta configurada. Configúrala en la pestaña Proyectos.`);
      return false;
    }
    setLaunching((prev) => ({ ...prev, [task.id]: true }));
    setActionError(null);
    try {
      // (1) Mechanical certainty: re-verify the folder right before launching.
      const check = await invoke<FolderCheckData>("verify_project_folder", {
        path: task.project.localPath,
        expectedRemote: task.project.repoUrl ?? null,
      });
      const stamped = { ...check, checkedAt: new Date().toISOString() };
      try {
        await crmApi.reportFolderCheck(task.projectId, stamped);
      } catch {
        // Recording the check is best-effort; the local gate below is what blocks.
      }
      const remoteOk = task.project.repoUrl ? stamped.remoteMatches === true : true;
      if (!stamped.exists || !stamped.isGit || !remoteOk) {
        setActionError(
          `Carpeta no verificada para "${task.project.name}": ${
            stamped.error ?? (remoteOk ? "" : `el remote (${stamped.remoteUrl ?? "sin origin"}) no coincide con ${task.project.repoUrl}`)
          }`
        );
        return false;
      }

      // (2) Compose the issue + prompt, spawn gentle-shell inside the folder.
      const branch = `fix/${task.id.slice(0, 8)}`;
      const { markdown, prompt } = buildIssue(task, branch);
      const info = await invoke<{ pid: number; logPath: string; issuePath: string | null }>(
        "launch_correction",
        { folder: task.project.localPath, prompt, taskId: task.id, issueMarkdown: markdown }
      );

      // (3) Register the run in the CRM; if that fails, kill the orphan process.
      let run: TaskRunItem;
      try {
        const res = await crmApi.openTaskRun(task.id, {
          logPath: info.logPath,
          issuePath: info.issuePath ?? undefined,
          branch,
        });
        run = res.run;
      } catch (err: any) {
        await invoke("cancel_run", { pid: info.pid }).catch(() => {});
        throw err;
      }

      await crmApi.updateTaskStatus(task.id, "in_progress");
      activeRuns.current[task.id] = { runId: run.id, pid: info.pid, logPath: info.logPath };

      // (4) Stream + finish: log chunks arrive via events; exit closes the run.
      if (isTauri()) {
        const unlog = await listen<string>(`run://log/${task.id}`, (e) => {
          setLiveLogs((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? "") + e.payload }));
        });
        const unexit = await listen<number>(`run://exit/${task.id}`, async (e) => {
          unlog();
          unexit();
          const code = e.payload;
          if (code === 0) {
            await finishRun(task.id, info.logPath);
          } else {
            try {
              const tail = await invoke<string>("read_run_log", { logPath: info.logPath, tailBytes: 65536 });
              await crmApi.closeTaskRun(task.id, run.id, {
                exitCode: code,
                resultSummary: `gentle-shell terminó con código ${code}\n${tail.slice(-1000)}`,
              });
            } catch {
              /* best effort */
            }
            delete activeRuns.current[task.id];
            setActionError(`El run de "${task.title}" falló (exit ${code}). Revisa el log: ${info.logPath}`);
            fetchData();
          }
        });
        unlisteners.current.push(unlog, unexit);
      }
      return true;
    } catch (err: any) {
      setActionError(err?.message ?? String(err));
      return false;
    } finally {
      setLaunching((prev) => ({ ...prev, [task.id]: false }));
      fetchData();
    }
  };

  const cancelTask = async (task: PipelineTaskItem) => {
    const active = activeRuns.current[task.id];
    if (!active) return;
    try {
      await invoke("cancel_run", { pid: active.pid });
    } catch (err: any) {
      setActionError(err?.message ?? String(err));
    }
  };

  const approveAndMaybeLaunch = async (task: PipelineTaskItem) => {
    try {
      await crmApi.approveTask(task.id);
      if (autoLaunch) {
        await launchTask({ ...task, status: "approved" });
      } else {
        fetchData();
      }
    } catch (err: any) {
      setActionError(err?.message ?? String(err));
    }
  };

  const rejectWithReason = async (task: PipelineTaskItem) => {
    const reason = window.prompt(`Motivo del rechazo de "${task.title}":`, "");
    if (reason === null) return;
    try {
      await crmApi.rejectTask(task.id, reason || undefined);
      fetchData();
    } catch (err: any) {
      setActionError(err?.message ?? String(err));
    }
  };

  /* ---------------- derived groups ---------------- */

  const pending = tasks.filter((t) => t.status === "pending_approval");
  const running = tasks.filter(
    (t) =>
      (t.status === "dispatched" || t.status === "in_progress") &&
      (t.latestRun?.status === "running" || activeRuns.current[t.id])
  );
  const launchable = tasks.filter(
    (t) =>
      t.status === "approved" ||
      ((t.status === "in_progress" || t.status === "dispatched") &&
        !(t.latestRun?.status === "running" || activeRuns.current[t.id]))
  );
  const review = tasks.filter((t) => t.status === "in_review");

  // Refresh logs of running tasks every 3s (also covers restarts of the app).
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(async () => {
      for (const t of running) {
        const logPath = activeRuns.current[t.id]?.logPath ?? t.latestRun?.logPath;
        if (!logPath || !isTauri()) continue;
        try {
          const tail = await invoke<string>("read_run_log", { logPath, tailBytes: 16384 });
          setLiveLogs((prev) => ({ ...prev, [t.id]: tail }));
        } catch {
          /* log file lives on the machine that launched the run */
        }
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [running.length]);

  /* ---------------- render ---------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <FolderKanban className="w-7 h-7 text-cyan-400" />
            Correcciones & Coding Dispatcher
          </h2>
          <p className="text-sm text-zinc-400">
            Issue → aprobación del owner → <span className="text-cyan-300 font-mono">gentle-shell</span> en la carpeta del proyecto.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoLaunch}
              onChange={toggleAutoLaunch}
              className="accent-cyan-500 w-4 h-4"
            />
            Lanzar al aprobar
          </label>
          <button
            ref={newCorrectionBtnRef}
            onClick={() => setShowForm((v) => !v)}
            aria-haspopup="dialog"
            className="flex items-center gap-1.5 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition"
          >
            <Plus className="w-4 h-4" /> Nueva corrección
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-2 px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-950/50 border border-rose-800 text-rose-300 rounded-xl flex items-center gap-3 text-sm">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {actionError && (
        <div className="p-4 bg-amber-950/50 border border-amber-800 text-amber-300 rounded-xl flex items-center justify-between gap-3 text-sm">
          <span className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            {actionError}
          </span>
          <button onClick={() => setActionError(null)} className="text-amber-400 hover:text-amber-200">
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      )}
      {!isTauri() && (
        <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-xl text-xs text-zinc-400">
          Vista en navegador: aprobación y seguimiento disponibles; el lanzamiento de gentle-shell
          requiere la app de escritorio.
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 gap-6">
        <button
          onClick={() => setActiveTab("pipeline")}
          className={`pb-3 text-sm font-semibold flex items-center gap-2 transition border-b-2 ${
            activeTab === "pipeline"
              ? "border-cyan-400 text-cyan-400"
              : "border-transparent text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <Terminal className="w-4 h-4" />
          Correcciones ({pending.length} pendientes · {launchable.length} listas)
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
          Proyectos y carpetas ({projects.length})
        </button>
      </div>

      {activeTab === "pipeline" && (
        <div className="space-y-6">
          {showForm && (
            <NewCorrectionForm
              projects={projects}
              onCreated={() => {
                setShowForm(false);
                fetchData();
              }}
              onCancel={() => setShowForm(false)}
              onAskOrchestrator={onAskOrchestrator}
              openButtonRef={newCorrectionBtnRef}
            />
          )}

          {loading && tasks.length === 0 ? (
            <div className="text-center py-12 text-zinc-500">Consultando pipeline…</div>
          ) : tasks.length === 0 ? (
            <div className="p-8 text-center bg-zinc-900/40 border border-zinc-800 rounded-xl text-zinc-400 text-sm">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              No hay correcciones activas. Pide una por chat con Eve o con "Nueva corrección".
            </div>
          ) : (
            <>
              {/* Pending approval */}
              {pending.length > 0 && (
                <Section title={`Pendientes de tu aprobación (${pending.length})`}>
                  {pending.map((task) => (
                    <div key={task.id} className="bg-zinc-900/60 border border-amber-900/50 rounded-xl p-5">
                      <div className="flex flex-col sm:flex-row justify-between items-start gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusPill status={task.status} />
                            <h3 className="text-base font-semibold text-white">{task.title}</h3>
                            <FolderBadge project={task.project} />
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400 mt-1 flex-wrap">
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" />
                              {task.project.name} · {task.project.organizationName}
                            </span>
                            {task.project.localPath && (
                              <span className="font-mono text-zinc-500">{task.project.localPath}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => approveAndMaybeLaunch(task)}
                            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold transition"
                          >
                            <CheckCheck className="w-4 h-4" />
                            {autoLaunch ? "Aprobar y lanzar" : "Aprobar"}
                          </button>
                          <button
                            onClick={() => rejectWithReason(task)}
                            className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-rose-900/60 text-zinc-300 hover:text-rose-200 rounded-lg text-sm font-medium transition"
                          >
                            <XCircle className="w-4 h-4" /> Rechazar
                          </button>
                        </div>
                      </div>
                      <SpecBox spec={task.spec ?? ""} />
                      <div className="text-xs text-zinc-500 mt-3 pt-3 border-t border-zinc-800/60 flex justify-between">
                        <span>Task {task.id.slice(0, 8)} · {task.kind}</span>
                        <span>{new Date(task.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </Section>
              )}

              {/* Launchable (approved or rework relaunch) */}
              {launchable.length > 0 && (
                <Section title={`Aprobadas · listas para lanzar (${launchable.length})`}>
                  {launchable.map((task) => (
                    <div key={task.id} className="bg-zinc-900/60 border border-cyan-900/50 rounded-xl p-5">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusPill status={task.status} />
                            <h3 className="text-base font-semibold text-white">{task.title}</h3>
                            <FolderBadge project={task.project} />
                          </div>
                          <div className="flex items-center gap-4 text-xs text-zinc-400 mt-1 flex-wrap">
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" /> {task.project.name}
                            </span>
                            {task.project.localPath && (
                              <span className="font-mono text-zinc-500">{task.project.localPath}</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => launchTask(task)}
                          disabled={launching[task.id]}
                          className="flex items-center gap-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-white rounded-lg text-sm font-semibold transition"
                        >
                          {launching[task.id] ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" /> Lanzando…
                            </>
                          ) : (
                            <>
                              <Play className="w-4 h-4" /> Lanzar gentle-shell
                            </>
                          )}
                        </button>
                      </div>
                      <SpecBox spec={task.spec ?? ""} maxH="max-h-32" />
                    </div>
                  ))}
                </Section>
              )}

              {/* Running */}
              {running.length > 0 && (
                <Section title={`Ejecutándose (${running.length})`}>
                  {running.map((task) => (
                    <div key={task.id} className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusPill status={task.status} />
                            <h3 className="text-base font-semibold text-white flex items-center gap-2">
                              {task.title}
                              <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                            </h3>
                          </div>
                          <div className="text-xs text-zinc-400 mt-1 flex items-center gap-3 flex-wrap">
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" /> {task.project.name}
                            </span>
                            {task.latestRun?.branch && (
                              <span className="flex items-center gap-1 text-cyan-400">
                                <GitBranch className="w-3 h-3" /> {task.latestRun.branch}
                              </span>
                            )}
                          </div>
                        </div>
                        {activeRuns.current[task.id] && (
                          <button
                            onClick={() => cancelTask(task)}
                            className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-rose-900/60 text-zinc-300 hover:text-rose-200 rounded-lg text-sm font-medium transition"
                          >
                            <XCircle className="w-4 h-4" /> Cancelar
                          </button>
                        )}
                      </div>
                      <LogBox text={liveLogs[task.id] ?? "esperando salida del agente…"} />
                    </div>
                  ))}
                </Section>
              )}

              {/* In review */}
              {review.length > 0 && (
                <Section title={`En revisión (${review.length})`}>
                  {review.map((task) => (
                    <div key={task.id} className="bg-zinc-900/60 border border-violet-900/40 rounded-xl p-5">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusPill status={task.status} />
                            <h3 className="text-base font-semibold text-white">{task.title}</h3>
                          </div>
                          <div className="text-xs text-zinc-400 mt-1 flex items-center gap-3 flex-wrap">
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" /> {task.project.name}
                            </span>
                            {task.latestRun?.branch && (
                              <span className="flex items-center gap-1 text-cyan-400">
                                <GitBranch className="w-3 h-3" /> {task.latestRun.branch}
                              </span>
                            )}
                            {task.prUrl && (
                              <a
                                href={task.prUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-cyan-400 hover:underline"
                              >
                                PR
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => {
                              try {
                                await crmApi.updateTaskStatus(task.id, "done");
                                fetchData();
                              } catch (err: any) {
                                setActionError(err?.message ?? String(err));
                              }
                            }}
                            className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-semibold transition"
                          >
                            <CheckCheck className="w-4 h-4" /> Marcar resuelta
                          </button>
                          <button
                            onClick={async () => {
                              const note = window.prompt("Qué se debe retrabajar:", "");
                              if (note === null) return;
                              try {
                                await crmApi.updateTaskStatus(task.id, "in_progress", {
                                  resultSummary: `RETRABAJO: ${note}`.slice(0, 2000),
                                });
                                fetchData();
                              } catch (err: any) {
                                setActionError(err?.message ?? String(err));
                              }
                            }}
                            className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
                          >
                            <RefreshCw className="w-4 h-4" /> Re-trabajar
                          </button>
                        </div>
                      </div>
                      {task.resultSummary && (
                        <div className="mt-3 bg-zinc-950 border border-zinc-800/80 rounded-lg p-3">
                          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                            Reporte del agente
                          </div>
                          <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                            {task.resultSummary}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "projects" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {loading && projects.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 col-span-2">Cargando proyectos…</div>
          ) : projects.length === 0 ? (
            <div className="p-8 text-center bg-zinc-900/40 border border-zinc-800 rounded-xl text-zinc-400 text-sm col-span-2">
              No hay proyectos registrados. Eve PM los crea al ganar contratos.
            </div>
          ) : (
            projects.map((proj) => (
              <ProjectFolderCard key={proj.id} project={proj} onSaved={fetchData} />
            ))
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Sub components                                                      */
/* ------------------------------------------------------------------ */

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-3">
    <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">{title}</h3>
    {children}
  </div>
);

const LogBox: React.FC<{ text: string }> = ({ text }) => (
  <div className="mt-3 bg-black border border-zinc-800/80 rounded-lg p-3">
    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
      <Terminal className="w-3.5 h-3.5 text-cyan-400" /> Salida en vivo
    </div>
    <pre className="text-[11px] text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto">
      {text}
    </pre>
  </div>
);

const NewCorrectionForm: React.FC<{
  projects: ProjectItem[];
  onCreated: () => void;
  onCancel: () => void;
  onAskOrchestrator?: (text: string) => void;
  openButtonRef?: React.RefObject<HTMLButtonElement>;
}> = ({ projects, onCreated, onCancel, onAskOrchestrator, openButtonRef }) => {
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const projectSelectRef = useRef<HTMLSelectElement>(null);

  const selected = projects.find((p) => p.id === projectId);

  // Dismiss paths (Cancel button, X, ESC, backdrop) only close the dialog:
  // they never call the API and are inert while a submission is in flight.
  // Unmounting on close resets fields, errors and the submitting flag, so
  // reopening always starts from an empty form.
  const close = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);

  const submit = async () => {
    if (!projectId || !title.trim() || !spec.trim()) {
      setErr("Proyecto, título y descripción son obligatorios.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await crmApi.createCorrectionTask({ projectId, title: title.trim(), spec: spec.trim(), kind: "correction" });
      onCreated();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // Initial focus on the first field; when the dialog closes, focus returns
  // to the button that opened it.
  useEffect(() => {
    projectSelectRef.current?.focus();
    return () => openButtonRef?.current?.focus();
  }, [openButtonRef]);

  // ESC closes the dialog; Tab is trapped inside it while it is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-correction-title"
        className="my-auto w-full max-w-2xl space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
      >
        <h3
          id="new-correction-title"
          className="text-sm font-semibold text-zinc-200 flex items-center gap-2"
        >
          <Plus className="w-4 h-4 text-cyan-400" /> Nueva corrección (cae en pendiente de aprobación)
          <button
            onClick={close}
            disabled={busy}
            aria-label="Cerrar"
            title="Cerrar sin crear"
            className="ml-auto p-1 text-zinc-500 hover:text-zinc-200 disabled:opacity-40 rounded transition"
          >
            <X className="w-4 h-4" />
          </button>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400">Proyecto</label>
            <select
              ref={projectSelectRef}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200"
            >
              <option value="">— elegir —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.localPath ? (p.folderVerifiedAt ? " ✅" : " ⚠️ sin verificar") : " ⚠️ sin carpeta"}
                </option>
              ))}
            </select>
            {selected && !selected.localPath && (
              <p className="text-xs text-amber-400 mt-1">
                Este proyecto no tiene carpeta configurada: configúrala abajo antes de lanzar.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-zinc-400">Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: Login falla al expirar la sesión"
              className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-zinc-400">
            Descripción del issue (contexto, comportamiento esperado, criterios de aceptación)
          </label>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={5}
            className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono"
          />
        </div>
        {err && <p className="text-xs text-rose-400">{err}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={submit}
            disabled={busy}
            className="flex items-center gap-1.5 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-white rounded-lg text-sm font-semibold transition"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Crear issue
          </button>
          <button
            onClick={close}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800/60 border border-zinc-700 hover:bg-zinc-800 disabled:opacity-60 text-zinc-300 hover:text-zinc-100 rounded-lg text-sm font-medium transition"
          >
            Cancelar
          </button>
          {onAskOrchestrator && (
            <button
              onClick={() =>
                onAskOrchestrator(
                  `Redacta una corrección (issue con contexto, criterios de aceptación, archivos afectados y comandos de verificación) para el proyecto ${
                    selected?.name ?? "(dime cuál)"
                  }: ${title || "(describe la corrección)"} — ${spec}`
                )
              }
              className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm font-medium transition"
            >
              Redactar con Eve
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const ProjectFolderCard: React.FC<{ project: ProjectItem; onSaved: () => void }> = ({
  project,
  onSaved,
}) => {
  const [localPath, setLocalPath] = useState(project.localPath ?? "");
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch);
  const [testCommand, setTestCommand] = useState(project.testCommand ?? "");
  const [busy, setBusy] = useState<"save" | "verify" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLocalPath(project.localPath ?? "");
    setDefaultBranch(project.defaultBranch);
    setTestCommand(project.testCommand ?? "");
  }, [project.id, project.localPath, project.defaultBranch, project.testCommand]);

  const save = async () => {
    setBusy("save");
    setErr(null);
    setMsg(null);
    try {
      await crmApi.updateProjectFolder(project.id, {
        localPath: localPath.trim() || null,
        defaultBranch: defaultBranch.trim() || "main",
        testCommand: testCommand.trim() || null,
      });
      setMsg("Configuración guardada.");
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (!isTauri()) {
      setErr("La verificación requiere la app de escritorio (Tauri).");
      return;
    }
    if (!localPath.trim()) {
      setErr("Configura primero la ruta de la carpeta.");
      return;
    }
    setBusy("verify");
    setErr(null);
    setMsg(null);
    try {
      // Save the folder config first: a verification only makes sense
      // attached to a stored path (and saving voids any stale check).
      await crmApi.updateProjectFolder(project.id, {
        localPath: localPath.trim() || null,
        defaultBranch: defaultBranch.trim() || "main",
        testCommand: testCommand.trim() || null,
      });
      const check = await invoke<FolderCheckData>("verify_project_folder", {
        path: localPath.trim(),
        expectedRemote: project.repoUrl ?? null,
      });
      const stamped = { ...check, checkedAt: new Date().toISOString() };
      const res = await crmApi.reportFolderCheck(project.id, stamped);
      setMsg(
        res.verified
          ? `✅ Verificada: git ok${check.branch ? `, rama ${check.branch}` : ""}${
              check.remoteUrl ? `, origin ${check.remoteUrl}` : ""
            }${check.clean === false ? " (worktree con cambios sin commit)" : ""}`
          : `⚠️ No verificada: ${check.error ?? "revisa la ruta y el remote"}`
      );
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 space-y-3">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-base font-semibold text-white flex items-center gap-2">
            {project.name}
            <FolderBadge project={project} />
          </h3>
          <div className="flex items-center gap-1 text-xs text-zinc-400 mt-0.5">
            <Building2 className="w-3 h-3" /> {project.organizationName}
          </div>
        </div>
        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800">
          {project.status}
        </span>
      </div>

      {project.repoUrl && (
        <div className="flex items-center gap-1.5 text-xs text-cyan-400">
          <GitBranch className="w-3.5 h-3.5" />
          <a href={project.repoUrl} target="_blank" rel="noreferrer" className="hover:underline truncate">
            {project.repoUrl}
          </a>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <input
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/Users/tiagofur/workspace/mi-app"
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono"
          />
          <button
            onClick={async () => {
              if (!isTauri()) {
                setErr("El selector de carpeta requiere la app de escritorio (Tauri).");
                return;
              }
              try {
                const picked = await openFolderDialog({
                  directory: true,
                  multiple: false,
                  title: "Elige la carpeta del proyecto",
                });
                if (typeof picked === "string" && picked) setLocalPath(picked);
              } catch (e: any) {
                setErr(e?.message ?? String(e));
              }
            }}
            title="Seleccionar carpeta…"
            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium transition shrink-0"
          >
            Elegir…
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            placeholder="main"
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono"
          />
          <input
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
            placeholder="npm test"
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </div>
      </div>

      {msg && <p className="text-xs text-emerald-400">{msg}</p>}
      {err && <p className="text-xs text-rose-400">{err}</p>}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-60 text-zinc-200 rounded-lg text-xs font-medium transition"
        >
          {busy === "save" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Guardar
        </button>
        <button
          onClick={verify}
          disabled={busy !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-60 text-white rounded-lg text-xs font-semibold transition"
        >
          {busy === "verify" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="w-3.5 h-3.5" />
          )}
          Verificar carpeta
        </button>
        {project.folderVerifiedAt && (
          <span className="text-[10px] text-zinc-500">
            verificada {new Date(project.folderVerifiedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
};
