//! RealmQ Studio integration — sidecar lifecycle + dedicated cockpit window.
//!
//! Spawns a Python FastAPI sidecar on first use, parses its `READY :<port>`
//! handshake line, and stores the port so the frontend can route HTTP calls
//! to it. Opens a separate Tauri `WebviewWindow` for the cockpit (labelled
//! "realmq") so the cockpit gets a full-sized, resizable workspace instead
//! of sharing the cramped popover with Job/Upwork modes.
//!
//! Design notes (per ../../RealmQ/features/00-overview.md):
//! - Tauri (Rust) owns: window lifecycle, sidecar spawn/kill, port handoff.
//! - Frontend (React) owns: UI/UX, calls sidecar via HTTP on 127.0.0.1:<port>.
//! - Sidecar (Python) owns: charts, datasets, LLM ops, SQLite, provenance.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const WINDOW_LABEL: &str = "realmq";
const READY_PREFIX: &str = "READY :";
const READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct RealmQState {
    pub port: Arc<Mutex<Option<u16>>>,
    pub process: Arc<Mutex<Option<Child>>>,
}

/// Find the sidecar directory.
/// 1. `REALMQ_SIDECAR_DIR` env var (explicit override).
/// 2. Walk up from `current_dir()` looking for `RealmQ/sidecar/realmq_sidecar/`.
fn find_sidecar_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("REALMQ_SIDECAR_DIR") {
        let p = PathBuf::from(d);
        if p.join("realmq_sidecar").is_dir() {
            return Some(p);
        }
    }
    let mut here = std::env::current_dir().ok()?;
    for _ in 0..6 {
        let candidate = here.join("RealmQ").join("sidecar");
        if candidate.join("realmq_sidecar").is_dir() {
            return Some(candidate);
        }
        if !here.pop() {
            break;
        }
    }
    None
}

fn python_binary() -> String {
    std::env::var("REALMQ_PYTHON").unwrap_or_else(|_| "python".to_string())
}

/// Spawn the sidecar (idempotent — returns the existing port if already running).
async fn ensure_sidecar(state: &RealmQState) -> Result<u16, String> {
    // Fast-path: already running.
    if let Some(p) = *state.port.lock().unwrap() {
        return Ok(p);
    }

    let dir = find_sidecar_dir().ok_or_else(|| {
        "RealmQ sidecar dir not found — set REALMQ_SIDECAR_DIR or place the project under .../RealmQ/sidecar".to_string()
    })?;

    let mut child: Child = Command::new(python_binary())
        .arg("-m")
        .arg("realmq_sidecar.server")
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "could not spawn Python sidecar (`{} -m realmq_sidecar.server` in {}): {e}",
                python_binary(),
                dir.display()
            )
        })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar produced no stdout pipe".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let read = tokio::time::timeout(READY_TIMEOUT, async move {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix(READY_PREFIX) {
                if let Ok(port) = rest.trim().parse::<u16>() {
                    return Some(port);
                }
            }
        }
        None
    })
    .await;

    let port = match read {
        Ok(Some(p)) => p,
        _ => {
            // Couldn't parse READY in time — kill the orphan and bail.
            let _ = child.kill().await;
            return Err(
                "Python sidecar did not announce `READY :<port>` within 30s (is FastAPI/uvicorn installed?)".to_string(),
            );
        }
    };

    *state.port.lock().unwrap() = Some(port);
    *state.process.lock().unwrap() = Some(child);
    Ok(port)
}

/// Open the RealmQ cockpit window. Spawns the sidecar if it isn't running yet
/// and returns the sidecar's port so the frontend can immediately call it.
#[tauri::command]
pub async fn open_realmq_window(
    app: AppHandle,
    state: tauri::State<'_, RealmQState>,
) -> Result<u16, String> {
    let port = ensure_sidecar(&state).await?;

    // Existing window? Focus it instead of opening a duplicate.
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(port);
    }

    WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::App("/".into()))
        .title("RealmQ Studio")
        .inner_size(1400.0, 900.0)
        .min_inner_size(1000.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("could not create RealmQ window: {e}"))?;

    Ok(port)
}

/// Returns the sidecar's port if it's running; errors otherwise. The frontend
/// uses this on cockpit boot to know where to send HTTP calls.
#[tauri::command]
pub fn realmq_sidecar_port(state: tauri::State<'_, RealmQState>) -> Result<u16, String> {
    state
        .port
        .lock()
        .unwrap()
        .ok_or_else(|| "RealmQ sidecar is not running yet".to_string())
}
