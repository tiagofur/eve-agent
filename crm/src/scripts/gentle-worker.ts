import "dotenv/config";

const CRM_URL = process.env.CRM_API_URL ?? "http://localhost:8787";
const DEV_KEY = process.env.DEV_API_KEY ?? process.env.CRM_DEV_KEY ?? "";

interface ReadyTask {
  id: string;
  projectId: string;
  projectName: string;
  repoUrl: string | null;
  title: string;
  spec: string;
  status: string;
  assignee: string;
  createdAt: string;
}

async function fetchReadyTasks(): Promise<ReadyTask[]> {
  const res = await fetch(`${CRM_URL}/api/projects/tasks/ready`, {
    headers: {
      Authorization: `Bearer ${DEV_KEY}`,
    },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to fetch tasks (${res.status}): ${error}`);
  }

  const data = (await res.json()) as { tasks: ReadyTask[] };
  return data.tasks;
}

async function updateTaskStatus(taskId: string, status: string, prUrl?: string) {
  const res = await fetch(`${CRM_URL}/api/projects/tasks/${taskId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEV_KEY}`,
    },
    body: JSON.stringify({ status, prUrl }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to update task (${res.status}): ${error}`);
  }

  return await res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "--list";

  if (!DEV_KEY) {
    console.error("❌ Error: DEV_API_KEY (or CRM_DEV_KEY) is not set in environment.");
    process.exit(1);
  }

  if (command === "--list" || command === "-l") {
    console.log("🔍 Querying Creapolis CRM for ready tasks...\n");
    const tasks = await fetchReadyTasks();

    if (tasks.length === 0) {
      console.log("✅ No tasks pending execution. All caught up!");
      return;
    }

    console.log(`📋 Found ${tasks.length} task(s) ready for coding agents:\n`);
    for (const t of tasks) {
      console.log(`--------------------------------------------------`);
      console.log(`Task ID   : ${t.id}`);
      console.log(`Project   : ${t.projectName} (${t.repoUrl ?? "No repo configured"})`);
      console.log(`Title     : ${t.title}`);
      console.log(`Assignee  : ${t.assignee}`);
      console.log(`Status    : ${t.status}`);
      console.log(`--------------------------------------------------`);
    }
    console.log("\nRun `npm run gentle -- --run <task-id>` to generate prompt packet for gentle-shell.");
    return;
  }

  if (command === "--run" || command === "-r") {
    const taskId = args[1];
    if (!taskId) {
      console.error("❌ Please provide a taskId: --run <taskId>");
      process.exit(1);
    }

    const tasks = await fetchReadyTasks();
    const task = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));

    if (!task) {
      console.error(`❌ Task "${taskId}" not found in ready tasks queue.`);
      process.exit(1);
    }

    // Automatically mark as in_progress in CRM
    await updateTaskStatus(task.id, "in_progress");

    console.log("==================================================");
    console.log(`🚀 GENTLE-SHELL TASK PACKET: [${task.title}]`);
    console.log(`📁 Project: ${task.projectName}`);
    if (task.repoUrl) console.log(`🔗 Repo: ${task.repoUrl}`);
    console.log(`🆔 CRM Task ID: ${task.id}`);
    console.log("==================================================\n");
    console.log("### INSTRUCTIONS FOR GENTLE-SHELL / PI AGENT:\n");
    console.log(task.spec);
    console.log("\n==================================================");
    console.log("💡 When finished, submit your PR and mark complete with:");
    console.log(`   npm run gentle -- --complete ${task.id} --pr <github_pr_url>`);
    console.log("==================================================");
    return;
  }

  if (command === "--complete" || command === "-c") {
    const taskId = args[1];
    const prIndex = args.indexOf("--pr");
    const prUrl = prIndex !== -1 ? args[prIndex + 1] : undefined;

    if (!taskId) {
      console.error("❌ Please provide a taskId: --complete <taskId> [--pr <url>]");
      process.exit(1);
    }

    await updateTaskStatus(taskId, "in_review", prUrl);
    console.log(`✅ Task ${taskId} marked as "in_review" in Creapolis CRM.`);
    if (prUrl) console.log(`🔗 PR attached: ${prUrl}`);
    return;
  }

  console.log("Usage:");
  console.log("  npm run gentle -- --list                        # List pending tasks");
  console.log("  npm run gentle -- --run <taskId>                # Fetch task spec & set to in_progress");
  console.log("  npm run gentle -- --complete <taskId> --pr <url> # Mark task in_review with PR link");
}

main().catch((err) => {
  console.error("Worker error:", err);
  process.exit(1);
});
