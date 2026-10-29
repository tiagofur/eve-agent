import "dotenv/config";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * VPS worker del pipeline de correcciones (gentle-shell en el servidor).
 *
 * Loop cada POLL_SECONDS: reclama la siguiente corrección aprobada
 * (openTaskRun es atómico: si el desktop la lanzó primero, pierde), prepara
 * el workspace (clone/pull), lanza gentle-shell -p y reporta el resultado al
 * CRM (closeTaskRun) con el bloque RUN REPORT. Todo sobrevive al cierre de la
 * app desktop: el run vive en el VPS, no en la Mac.
 *
 * Requisitos del contenedor/host: git, gentle-pi (npm i -g) y para repos
 * privados GITHUB_TOKEN. Sin shell disponible el worker queda idle con un
 * log claro y no reclama tareas.
 */

const CRM_URL = process.env.CRM_API_URL ?? "http://localhost:8787";
const OPS_KEY = process.env.OPS_API_KEY ?? process.env.CRM_OPS_KEY ?? "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const POLL_SECONDS = Number(process.env.WORKER_POLL_SECONDS ?? 30);
const LEASE_HOURS = Number(process.env.WORKER_LEASE_HOURS ?? 4);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/data/workspaces";
const LOG_ROOT = process.env.WORKER_LOG_ROOT ?? "/data/worker/runs";
const SHELL_CMD = process.env.GENTLE_SHELL_CMD ?? "gentle-shell";

interface PipelineTask {
  id: string;
  status: string;
  kind: string;
  title: string;
  spec: string;
  project: {
    name: string | null;
    repoUrl: string | null;
    defaultBranch: string;
    testCommand: string | null;
  };
  latestRun: { id: string; status: string; startedAt: string } | null;
}

function auth(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${OPS_KEY}` };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CRM_URL}${path}`, {
    ...init,
    headers: { ...auth(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`API ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0, out: `${stdout}${stderr}` });
    });
  });
}

function runShell(bin: string, args: string[], cwd: string, logFile: fs.FileHandle): Promise<ChildProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const pipe = (stream: NodeJS.ReadableStream) => {
      stream.on("data", (chunk: Buffer) => {
        void logFile.appendFile(chunk);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on("error", (err) => {
      void logFile.appendFile(Buffer.from(`\n[worker] no se pudo lanzar ${bin}: ${err.message}\n`));
      resolve({ code: 127 });
    });
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}

interface ChildProcessResult {
  code: number;
}

function parseRunReport(tail: string): { resultSummary: string; prUrl?: string } {
  const idx = tail.lastIndexOf("-----RUN REPORT-----");
  if (idx === -1) {
    return { resultSummary: tail.slice(-1500).trim() || "sin salida del agente" };
  }
  const block = tail.slice(idx).trim();
  const prMatch = block.match(/^PR:\s*(\S+)/m);
  const prUrl = prMatch && prMatch[1] && /^https?:\/\//.test(prMatch[1]) ? prMatch[1] : undefined;
  return { resultSummary: block.slice(0, 2000), prUrl };
}

function buildIssue(task: PipelineTask, branch: string): { markdown: string; prompt: string } {
  const p = task.project;
  const markdown = [
    `# ${task.kind === "correction" ? "Corrección" : "Tarea"}: ${task.title}`,
    ``,
    `- **Proyecto:** ${p.name ?? task.id}`,
    `- **Repo:** ${p.repoUrl ?? "(sin repo)"}`,
    `- **Rama base:** ${p.defaultBranch} · **Rama de trabajo:** ${branch}`,
    `- **Comando de verificación:** ${p.testCommand ?? "no configurado"}`,
    `- **Ejecutado por:** worker VPS`,
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

async function repoUrlWithAuth(repoUrl: string): Promise<string> {
  if (!GITHUB_TOKEN || !repoUrl.includes("github.com/")) return repoUrl;
  return repoUrl.replace("https://github.com/", `https://x-access-token:${GITHUB_TOKEN}@github.com/`);
}

async function prepareWorkspace(task: PipelineTask): Promise<{ ok: true; folder: string } | { ok: false; error: string }> {
  const repoUrl = task.project.repoUrl;
  if (!repoUrl) return { ok: false, error: "proyecto sin repoUrl" };
  const folder = path.join(WORKSPACE_ROOT, task.id);
  try {
    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    const gitDir = path.join(folder, ".git");
    const base = task.project.defaultBranch || "main";
    if (
      (await fs
        .access(gitDir)
        .then(() => true)
        .catch(() => false))
    ) {
      const origin = await sh("git", ["remote", "get-url", "origin"], folder);
      const wanted = await repoUrlWithAuth(repoUrl);
      if (origin.out.trim() !== wanted.trim()) {
        await sh("git", ["remote", "set-url", "origin", wanted], folder);
      }
      const fetched = await sh("git", ["fetch", "--all", "--prune"], folder);
      if (fetched.code !== 0) return { ok: false, error: `git fetch falló: ${fetched.out.slice(-300)}` };
      const reset = await sh("git", ["reset", "--hard", `origin/${base}`], folder);
      if (reset.code !== 0) return { ok: false, error: `git reset falló: ${reset.out.slice(-300)}` };
    } else {
      const cloned = await sh("git", ["clone", await repoUrlWithAuth(repoUrl), folder], WORKSPACE_ROOT);
      if (cloned.code !== 0) return { ok: false, error: `git clone falló: ${cloned.out.slice(-300)}` };
    }
    const branch = `fix/${task.id.slice(0, 8)}`;
    const co = await sh("git", ["checkout", "-B", branch, base], folder);
    if (co.code !== 0) return { ok: false, error: `git checkout falló: ${co.out.slice(-300)}` };
    return { ok: true, folder };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

async function recoverStaleRuns(): Promise<void> {
  const data = await api<{ tasks: PipelineTask[] }>("/api/projects/tasks/pipeline");
  const now = Date.now();
  for (const t of data.tasks) {
    const run = t.latestRun;
    if (!run || run.status !== "running") continue;
    if (!["dispatched", "in_progress"].includes(t.status)) continue;
    const hours = (now - new Date(run.startedAt).getTime()) / 3600000;
    if (hours < LEASE_HOURS) continue;
    console.log(`[lease] run de "${t.title}" abierto hace ${hours.toFixed(1)}h; cerrando y devolviendo a ready`);
    await api(`/api/projects/tasks/${t.id}/runs/${run.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        exitCode: 1,
        resultSummary: `Lease de ${LEASE_HOURS}h vencido sin cierre: run recuperado automáticamente por el worker VPS.`,
      }),
    });
    await api(`/api/projects/tasks/${t.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready", resultSummary: "Recuperado tras lease vencido; reclamable de nuevo." }),
    });
  }
}

async function tick(): Promise<void> {
  await recoverStaleRuns();

  const data = await api<{ tasks: PipelineTask[] }>("/api/projects/tasks/pipeline");
  const candidate = data.tasks.find((t) => t.status === "approved" || t.status === "ready");
  if (!candidate) return;

  if (!candidate.project.repoUrl) {
    console.log(`[skip] "${candidate.title}" sin repoUrl; el worker VPS no puede ejecutarlo.`);
    return;
  }

  console.log(`[claim] intentando "${candidate.title}" (${candidate.project.name})`);
  const prep = await prepareWorkspace(candidate);
  if (!prep.ok) {
    console.error(`[workspace] ${prep.error}`);
    await api(`/api/projects/tasks/${candidate.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready", resultSummary: `Worker VPS: workspace no preparable — ${prep.error}`.slice(0, 2000) }),
    });
    return;
  }

  const branch = `fix/${candidate.id.slice(0, 8)}`;
  const runDir = path.join(LOG_ROOT, candidate.id);
  await fs.mkdir(runDir, { recursive: true });
  const logPath = path.join(runDir, `run-${Date.now()}.log`);
  const issuePath = path.join(runDir, "issue.md");
  const { markdown, prompt } = buildIssue(candidate, branch);
  await fs.writeFile(issuePath, markdown, "utf-8");

  let runId: string | null = null;
  try {
    const opened = await api<{ run: { id: string } }>(`/api/projects/tasks/${candidate.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ logPath, issuePath, branch }),
    });
    runId = opened.run.id;
  } catch (err: any) {
    console.log(`[claim] perdida: ${String(err?.message ?? err).slice(0, 200)}`);
    return;
  }

  await api(`/api/projects/tasks/${candidate.id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "in_progress" }),
  });

  const logFile = await fs.open(logPath, "a");
  try {
    console.log(`[run] gentle-shell ejecutando en ${prep.folder} (run ${runId.slice(0, 8)})`);
    const started = Date.now();
    const result = await runShell(SHELL_CMD, ["-p", "--mode", "text", "--", prompt], prep.folder, logFile);
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`[run] terminó con código ${result.code} en ${minutes} min`);

    const body = await fs.readFile(logPath, "utf-8");
    const report = parseRunReport(body.slice(-65536));
    await api(`/api/projects/tasks/${candidate.id}/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify({
        exitCode: result.code,
        resultSummary: report.resultSummary.slice(0, 4000),
        ...(report.prUrl ? { prUrl: report.prUrl } : {}),
      }),
    });
    console.log(`[run] reportado al CRM (exit ${result.code})`);
  } finally {
    await logFile.close();
  }
}

async function main() {
  if (!OPS_KEY) {
    console.error("OPS_API_KEY no configurada; el worker no puede hablar con el CRM.");
    process.exit(1);
  }
  const shellCheck = await sh(SHELL_CMD, ["--version"], process.cwd());
  if (shellCheck.code !== 0) {
    console.error(
      `gentle-shell no disponible (comando "${SHELL_CMD}", exit ${shellCheck.code}). ` +
        `Instálalo en el contenedor (npm i -g gentle-pi) o ajusta GENTLE_SHELL_CMD; el worker queda idle.`
    );
    process.exit(1);
  }
  console.log(`worker VPS listo: CRM=${CRM_URL}, poll=${POLL_SECONDS}s, lease=${LEASE_HOURS}h, workspace=${WORKSPACE_ROOT}`);
  for (;;) {
    try {
      await tick();
    } catch (err: any) {
      console.error(`[tick] ${err?.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }
}

main().catch((err) => {
  console.error("worker error:", err);
  process.exit(1);
});
