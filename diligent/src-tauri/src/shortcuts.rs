use tauri::{AppHandle, Manager, Runtime, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use serde_json::json;
use std::sync::Mutex;
// State for window visibility
pub struct WindowVisibility(pub Mutex<bool>);

// Default shortcuts
#[cfg(target_os = "macos")]
const DEFAULT_TOGGLE_SHORTCUT: &str = "cmd+backslash";
#[cfg(not(target_os = "macos"))]
const DEFAULT_TOGGLE_SHORTCUT: &str = "ctrl+backslash";

#[cfg(target_os = "macos")]
const DEFAULT_SCREENSHOT_SHORTCUT: &str = "cmd+shift+s";
#[cfg(not(target_os = "macos"))]
const DEFAULT_SCREENSHOT_SHORTCUT: &str = "ctrl+shift+s";

/// Initialize global shortcuts for the application
pub fn setup_global_shortcuts<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let toggle_shortcut = DEFAULT_TOGGLE_SHORTCUT.parse::<Shortcut>()?;
    let screenshot_shortcut = DEFAULT_SCREENSHOT_SHORTCUT.parse::<Shortcut>()?;

    // Defensive cleanup BEFORE any on_shortcut calls. The tauri global-
    // shortcut plugin's internal registry can carry stale registrations
    // across a crashed `cargo tauri dev` process. Without this clear, the
    // first on_shortcut that hits one of those would error with
    // "HotKey already registered" — and worse, that error used to ?-bail
    // out of the whole setup, leaving every shortcut after it unbound.
    // Best-effort: unregister can fail (e.g. we never owned the shortcut)
    // and that's fine, we proceed regardless.
    for sc in [toggle_shortcut, screenshot_shortcut] {
        let _ = app.global_shortcut().unregister(sc);
    }

    // Track binding outcomes so a single conflict doesn't take down the
    // rest, and so we get a clear startup-summary log.
    let mut registered: Vec<&str> = Vec::new();
    let mut failed: Vec<&str> = Vec::new();

    // toggle (uses the closure-arg `app` directly — special-cased because
    // its handler dispatches to whichever AppHandle Tauri passes in).
    if let Err(e) = app.global_shortcut().on_shortcut(toggle_shortcut, move |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_toggle_window(&app);
        }
    }) {
        eprintln!("[shortcuts] failed to register toggle: {e}");
        failed.push("toggle");
    } else {
        registered.push("toggle");
    }

    let app_handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(screenshot_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_screenshot_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register screenshot: {e}");
        failed.push("screenshot");
    } else {
        registered.push("screenshot");
    }

    // Single startup summary so we can confirm what's bound when a user
    // reports a hotkey not firing.
    eprintln!("[shortcuts] registered: {}", registered.join(", "));

    if !failed.is_empty() {
        // Fire-and-forget — if no window is up yet the frontend listener
        // hasn't subscribed; we mostly rely on the eprintln above.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(
                "shortcut-conflict",
                json!({ "failed": failed }),
            );
        }
    }

    Ok(())
}

/// Handle app toggle (hide/show) with input focus and app icon management
fn handle_toggle_window<R: Runtime>(app: &AppHandle<R>) {
    // Get the main window
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("Main window not found");
        return;
    };

    #[cfg(target_os = "windows")]
    {
        let state = app.state::<WindowVisibility>();
        let mut is_hidden = state.0.lock().unwrap();
        *is_hidden = !*is_hidden;

        if let Err(e) = window.emit("toggle-window-visibility", *is_hidden) {
            eprintln!("Failed to emit toggle-window-visibility event: {}", e);
        }
        return;
    }

    #[cfg(not(target_os = "windows"))]
    match window.is_visible() {
        Ok(true) => {
            // Window is visible, hide it and handle app icon based on user settings
            if let Err(e) = window.hide() {
                eprintln!("Failed to hide window: {}", e);
            }

         }
        Ok(false) => {
            // Window is hidden, show it and handle app icon based on user settings
            if let Err(e) = window.show() {
                eprintln!("Failed to show window: {}", e);
            }

            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {}", e);
            }

            // Emit event to focus text input
            if let Err(e) = window.emit("focus-text-input", json!({})) {
                eprintln!("Failed to emit focus event: {}", e);
            }
        }
        Err(e) => {
            eprintln!("Failed to check window visibility: {}", e);
        }
    }
}


/// Handle screenshot shortcut - mode will be determined by user settings in frontend
fn handle_screenshot_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Emit event to trigger screenshot - frontend will determine auto/manual mode
        if let Err(e) = window.emit("trigger-screenshot", json!({})) {
            eprintln!("Failed to emit screenshot event: {}", e);
        }
    }
}

/// Tauri command to get current shortcuts
#[tauri::command]
pub fn get_shortcuts() -> serde_json::Value {
    json!({
        "toggle": DEFAULT_TOGGLE_SHORTCUT,
        "screenshot": DEFAULT_SCREENSHOT_SHORTCUT
    })
}

/// Tauri command to check if shortcuts are registered
#[tauri::command]
pub fn check_shortcuts_registered<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let shortcuts = [
        DEFAULT_TOGGLE_SHORTCUT,
        DEFAULT_SCREENSHOT_SHORTCUT,
    ];

    for shortcut_str in shortcuts {
        if let Ok(shortcut) = shortcut_str.parse::<Shortcut>() {
            let registered = app.global_shortcut().is_registered(shortcut);
            if !registered {
                return Ok(false);
            }
        } else {
            return Err(format!("Failed to parse shortcut: {}", shortcut_str));
        }
    }
    
    Ok(true)
}
// Tauri command to set app icon visibility in dock/taskbar
#[tauri::command]
pub fn set_app_icon_visibility<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
    println!("Setting app icon visibility to: {}", visible);
    
    #[cfg(target_os = "macos")]
    {
        // On macOS, use activation policy to control dock icon
        let policy = if visible {
            println!("Setting macOS activation policy to Regular (visible)");
            tauri::ActivationPolicy::Regular
        } else {
            println!("Setting macOS activation policy to Accessory (hidden)");
            tauri::ActivationPolicy::Accessory
        };
        
        app.set_activation_policy(policy)
            .map_err(|e| {
                eprintln!("Failed to set activation policy: {}", e);
                format!("Failed to set activation policy: {}", e)
            })?;
        
        println!("Successfully set macOS activation policy");
    }
    
    #[cfg(target_os = "windows")]
    {
        // On Windows, control taskbar icon visibility
        if let Some(window) = app.get_webview_window("main") {
            println!("Setting Windows taskbar visibility to: {}", visible);
            window.set_skip_taskbar(!visible)
                .map_err(|e| {
                    eprintln!("Failed to set taskbar visibility: {}", e);
                    format!("Failed to set taskbar visibility: {}", e)
                })?;
            println!("Successfully set Windows taskbar visibility");
        } else {
            eprintln!("Main window not found on Windows");
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        // On Linux, control panel icon visibility
        if let Some(window) = app.get_webview_window("main") {
            println!("Setting Linux panel visibility to: {}", visible);
            window.set_skip_taskbar(!visible)
                .map_err(|e| {
                    eprintln!("Failed to set panel visibility: {}", e);
                    format!("Failed to set panel visibility: {}", e)
                })?;
            println!("Successfully set Linux panel visibility");
        } else {
            eprintln!("Main window not found on Linux");
        }
    }
    
    Ok(())
}

/// Tauri command to set always on top state
#[tauri::command]
pub fn set_always_on_top<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    println!("Setting always on top to: {}", enabled);
    
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled)
            .map_err(|e| {
                eprintln!("Failed to set always on top: {}", e);
                format!("Failed to set always on top: {}", e)
            })?;
        
        println!("Successfully set always on top to: {}", enabled);
    } else {
        eprintln!("Main window not found");
        return Err("Main window not found".to_string());
    }
    
    Ok(())
}
