use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Mechanical verification of a project's local folder, as configured in the
/// CRM. `checked_at` is stamped by the frontend; Rust only reports facts.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderCheck {
    pub exists: bool,
    pub is_git: bool,
    pub remote_url: Option<String>,
    pub remote_matches: Option<bool>,
    pub branch: Option<String>,
    pub clean: Option<bool>,
    pub error: Option<String>,
}

fn git(folder: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(folder).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// git@github.com:owner/repo.git and https://github.com/owner/repo(.git) are the same origin.
fn normalize_git_url(url: &str) -> String {
    let mut u = url.trim().to_string();
    if let Some(rest) = u.strip_prefix("git@github.com:") {
        u = format!("https://github.com/{rest}");
    }
    u.trim_end_matches(".git").trim_end_matches('/').to_string()
}

#[tauri::command]
fn verify_project_folder(path: String, expected_remote: Option<String>) -> FolderCheck {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return FolderCheck {
            exists: false,
            is_git: false,
            remote_url: None,
            remote_matches: None,
            branch: None,
            clean: None,
            error: Some("la carpeta no existe".into()),
        };
    }

    if git(&path, &["rev-parse", "--git-dir"]).is_none() {
        return FolderCheck {
            exists: true,
            is_git: false,
            remote_url: None,
            remote_matches: None,
            branch: None,
            clean: None,
            error: Some("la carpeta no es un repositorio git".into()),
        };
    }

    let remote_url = git(&path, &["remote", "get-url", "origin"]);
    let branch = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let clean = git(&path, &["status", "--porcelain"]).map(|s| s.is_empty());
    let remote_matches = match (&remote_url, &expected_remote) {
        (Some(r), Some(e)) => Some(normalize_git_url(r) == normalize_git_url(e)),
        (None, Some(_)) => Some(false),
        _ => None,
    };

    FolderCheck {
        exists: true,
        is_git: true,
        remote_url,
        remote_matches,
        branch,
        clean,
        error: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pub pid: u32,
    pub log_path: String,
    pub issue_path: Option<String>,
}

/// gentle-shell lives in ~/.local/bin, which GUI apps do not get in PATH.
fn resolve_gentle_bin() -> String {
    if let Ok(p) = std::env::var("GENTLE_SHELL_BIN") {
        if !p.is_empty() {
            return p;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = PathBuf::from(home).join(".local/bin/gentle-shell");
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    "gentle-shell".into()
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Spawn gentle-shell (print mode) inside the project folder. Output is
/// appended to <appData>/runs/<taskId>/run-<ts>.log and streamed to the
/// frontend via `run://log/<taskId>`; the final exit code arrives on
/// `run://exit/<taskId>`.
#[tauri::command]
async fn launch_correction(
    app: AppHandle,
    folder: String,
    prompt: String,
    task_id: String,
    issue_markdown: Option<String>,
) -> Result<LaunchInfo, String> {
    if !Path::new(&folder).is_dir() {
        return Err(format!("la carpeta del proyecto no existe: {folder}"));
    }

    let data_dir: PathBuf = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let run_dir = data_dir.join("runs").join(&task_id);
    std::fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;

    let issue_path = match &issue_markdown {
        Some(md) => {
            let p = run_dir.join("issue.md");
            std::fs::write(&p, md).map_err(|e| e.to_string())?;
            Some(p.to_string_lossy().to_string())
        }
        None => None,
    };

    let log_path = run_dir.join(format!("run-{}.log", now_millis()));
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;

    let bin = resolve_gentle_bin();
    let mut cmd = Command::new(&bin);
    cmd.args(["-p", "--mode", "text", "--", &prompt])
        .current_dir(&folder)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        // Own process group so cancel_run can kill the whole agent tree.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("no se pudo lanzar gentle-shell ({bin}): {e}"))?;
    let pid = child.id();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let streams: Vec<Box<dyn Read + Send>> = vec![
        stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
        stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();

    for stream in streams {
        let log_handle = log_file.try_clone().map_err(|e| e.to_string())?;
        let (app2, task2) = (app.clone(), task_id.clone());
        thread::spawn(move || {
            let mut file = log_handle;
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = file.write_all(&buf[..n]);
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app2.emit(format!("run://log/{task2}").as_str(), chunk);
                    }
                }
            }
        });
    }

    let (app3, task3) = (app.clone(), task_id);
    thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = app3.emit(format!("run://exit/{task3}").as_str(), code);
    });

    Ok(LaunchInfo {
        pid,
        log_path: log_path.to_string_lossy().to_string(),
        issue_path,
    })
}

/// Tail of a run log (whole file when it fits in tail_bytes).
#[tauri::command]
fn read_run_log(log_path: String, tail_bytes: u64) -> Result<String, String> {
    let mut f = std::fs::File::open(&log_path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(tail_bytes);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut s = String::new();
    f.read_to_string(&mut s).map_err(|e| e.to_string())?;
    if start > 0 {
        Ok(format!("…[{} bytes previos omitidos]\n{s}", start))
    } else {
        Ok(s)
    }
}

/// Kill a run's process group (child was spawned with process_group(0)).
#[tauri::command]
fn cancel_run(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let out = Command::new("kill")
            .arg("-TERM")
            .arg(format!("-{pid}"))
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "kill -TERM -{pid} falló: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        return Err("cancel_run solo está soportado en unix".into());
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            verify_project_folder,
            launch_correction,
            read_run_log,
            cancel_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
