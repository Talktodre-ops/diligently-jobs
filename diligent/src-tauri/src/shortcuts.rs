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
const DEFAULT_AUDIO_SHORTCUT: &str = "cmd+shift+a";
#[cfg(not(target_os = "macos"))]
const DEFAULT_AUDIO_SHORTCUT: &str = "ctrl+shift+a";

#[cfg(target_os = "macos")]
const DEFAULT_SCREENSHOT_SHORTCUT: &str = "cmd+shift+s";
#[cfg(not(target_os = "macos"))]
const DEFAULT_SCREENSHOT_SHORTCUT: &str = "ctrl+shift+s";

#[cfg(target_os = "macos")]
const DEFAULT_SYSTEM_AUDIO_SHORTCUT: &str = "cmd+shift+m";
#[cfg(not(target_os = "macos"))]
const DEFAULT_SYSTEM_AUDIO_SHORTCUT: &str = "ctrl+shift+m";

// Click-through toggle hotkey. Iterated twice — Ctrl+Shift+P collided with
// VSCode's Command Palette (Windows' RegisterHotKey is first-come-first-
// served, so VSCode's registration shadowed ours); Ctrl+Alt+C collided
// with an OEM laptop command. Alt+F-key combos are essentially never
// claimed by mainstream apps OR by Windows/OEM utilities.
//
// If Alt+F9 also conflicts on a specific machine, the startup log will
// print "[shortcuts] failed to register click-through shortcut: ..." and
// the frontend gets a `shortcut-conflict` event. Pick another from this
// pool — all are well-unused: alt+f9, alt+f10, alt+f12, ctrl+alt+shift+c.
#[cfg(target_os = "macos")]
const DEFAULT_CLICK_THROUGH_SHORTCUT: &str = "alt+f9";
#[cfg(not(target_os = "macos"))]
const DEFAULT_CLICK_THROUGH_SHORTCUT: &str = "alt+f9";

// Stealth copy hotkey. F13 is virtually never owned by any application or
// OEM utility — it doesn't exist on most physical keyboards, which means
// nothing claims it. Users remap a free key (ScrollLock, Right-Ctrl) to F13
// via PowerToys Keyboard Manager. Picking F13 keeps us out of conflict with
// any host page that wires up Ctrl+C / Ctrl+A intercepts (those handlers
// never fire — no Ctrl modifier in our chord).
#[cfg(target_os = "macos")]
const DEFAULT_STEALTH_COPY_SHORTCUT: &str = "f13";
#[cfg(not(target_os = "macos"))]
const DEFAULT_STEALTH_COPY_SHORTCUT: &str = "f13";

// Stealth select-all-and-copy chord. PowerToys remap (Keyboard Manager →
// Remap a shortcut): F13 + A → Alt + F23. We can't register F13+A directly
// because Win32 RegisterHotKey only accepts Alt/Ctrl/Shift/Win as modifier
// slots — F13 isn't a valid modifier there. Alt+F23 is the target because
// no mainstream app claims F-keys above F12 with the Alt modifier.
#[cfg(target_os = "macos")]
const DEFAULT_STEALTH_SELECT_ALL_SHORTCUT: &str = "alt+f23";
#[cfg(not(target_os = "macos"))]
const DEFAULT_STEALTH_SELECT_ALL_SHORTCUT: &str = "alt+f23";

// Stealth copy alias chord. PowerToys remap: F13 + C → Alt + F24. Behaves
// identically to F13 alone — both call copy_focused_selection — but lets
// users with Ctrl+C muscle memory hit F13+C and have it Just Work.
#[cfg(target_os = "macos")]
const DEFAULT_STEALTH_COPY_ALIAS_SHORTCUT: &str = "alt+f24";
#[cfg(not(target_os = "macos"))]
const DEFAULT_STEALTH_COPY_ALIAS_SHORTCUT: &str = "alt+f24";

/// Initialize global shortcuts for the application
pub fn setup_global_shortcuts<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let toggle_shortcut = DEFAULT_TOGGLE_SHORTCUT.parse::<Shortcut>()?;
    let audio_shortcut = DEFAULT_AUDIO_SHORTCUT.parse::<Shortcut>()?;
    let screenshot_shortcut = DEFAULT_SCREENSHOT_SHORTCUT.parse::<Shortcut>()?;
    let system_audio_shortcut = DEFAULT_SYSTEM_AUDIO_SHORTCUT.parse::<Shortcut>()?;
    let click_through_shortcut = DEFAULT_CLICK_THROUGH_SHORTCUT.parse::<Shortcut>()?;
    let stealth_copy_shortcut = DEFAULT_STEALTH_COPY_SHORTCUT.parse::<Shortcut>()?;
    let stealth_select_all_shortcut = DEFAULT_STEALTH_SELECT_ALL_SHORTCUT.parse::<Shortcut>()?;
    let stealth_copy_alias_shortcut = DEFAULT_STEALTH_COPY_ALIAS_SHORTCUT.parse::<Shortcut>()?;

    // Defensive cleanup BEFORE any on_shortcut calls. The tauri global-
    // shortcut plugin's internal registry can carry stale registrations
    // across a crashed `cargo tauri dev` process. Without this clear, the
    // first on_shortcut that hits one of those would error with
    // "HotKey already registered" — and worse, that error used to ?-bail
    // out of the whole setup, leaving every shortcut after it unbound.
    // Best-effort: unregister can fail (e.g. we never owned the shortcut)
    // and that's fine, we proceed regardless.
    for sc in [
        toggle_shortcut, audio_shortcut, screenshot_shortcut,
        system_audio_shortcut, click_through_shortcut, stealth_copy_shortcut,
        stealth_select_all_shortcut, stealth_copy_alias_shortcut,
    ] {
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
    if let Err(e) = app.global_shortcut().on_shortcut(audio_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_audio_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register audio: {e}");
        failed.push("audio");
    } else {
        registered.push("audio");
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

    let app_handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(system_audio_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_system_audio_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register system-audio: {e}");
        failed.push("system audio");
    } else {
        registered.push("system audio");
    }

    let app_handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(click_through_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_click_through_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register click-through: {e}");
        failed.push("click-through");
    } else {
        registered.push("click-through");
    }

    let app_handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(stealth_copy_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_stealth_copy_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register stealth-copy: {e}");
        failed.push("stealth-copy");
    } else {
        registered.push("stealth-copy");
    }

    let app_handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(stealth_select_all_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            handle_stealth_select_all_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register stealth-select-all: {e}");
        failed.push("stealth-select-all");
    } else {
        registered.push("stealth-select-all");
    }

    let app_handle = app.clone();
    if let Err(e) = app.global_shortcut().on_shortcut(stealth_copy_alias_shortcut, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            // Same handler as bare F13 — F13+C is just an ergonomic alias.
            handle_stealth_copy_shortcut(&app_handle);
        }
    }) {
        eprintln!("[shortcuts] failed to register stealth-copy-alias: {e}");
        failed.push("stealth-copy-alias");
    } else {
        registered.push("stealth-copy-alias");
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


/// Handle audio shortcut
fn handle_audio_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Ensure window is visible
        if let Ok(false) = window.is_visible() {
            if let Err(e) = window.show() {
                eprintln!("Failed to show window: {}", e);
                return;
            }
            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {}", e);
            }
        }
        
        // Emit event to start audio recording
        if let Err(e) = window.emit("start-audio-recording", json!({})) {
            eprintln!("Failed to emit audio recording event: {}", e);
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

/// Handle click-through (mouse pass-through) shortcut. Toggles BOTH:
/// - Tauri's `set_ignore_cursor_events` (the cross-platform API; on Windows
///   it manages WS_EX_LAYERED + WS_EX_TRANSPARENT together which is what
///   actually makes clicks pass through)
/// - Our custom `stealth::set_click_through` which keeps a mutex state so
///   `is_click_through()` queries stay accurate, and toggles WS_EX_TRANSPARENT
///   directly as belt-and-suspenders.
///
/// Both calls are necessary — without `set_ignore_cursor_events`, the
/// global shortcut couldn't *disable* a state set by the JS-side button
/// (the JS path uses set_ignore_cursor_events to enable, and a Rust-only
/// WS_EX_TRANSPARENT clear wouldn't unset the LAYERED + cursor-events flags).
fn handle_click_through_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("Main window not found for click-through toggle");
        return;
    };
    let next = !crate::stealth::is_click_through();
    if let Err(e) = window.set_ignore_cursor_events(next) {
        eprintln!("set_ignore_cursor_events failed: {e}");
    }
    crate::stealth::set_click_through(&window, next);
    if let Err(e) = window.emit("click-through-changed", next) {
        eprintln!("Failed to emit click-through-changed event: {}", e);
    }
}

/// Handle the stealth-copy hotkey (F13 tap, or F13+C alias).
///
/// Uses UIA to read the currently-selected text in the focused window and
/// writes it to the system clipboard. Bypasses the host-page Ctrl+C/copy-
/// event blockers entirely — no keyboard or clipboard event reaches the
/// browser's JS.
///
/// Emits a `stealth-copy-result` event for completeness; no UI listener is
/// wired (visible feedback would defeat stealth). Diagnostic feedback lives
/// in the eprintln below — run the app via `npm run tauri dev` to see it.
fn handle_stealth_copy_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let payload = match crate::clipboard::copy_focused_selection() {
        Ok(text) => {
            let char_count = text.chars().count();
            let preview: String = text.chars().take(40).collect();
            let preview = if text.chars().count() > 40 {
                format!("{}…", preview)
            } else {
                preview
            };
            eprintln!("[stealth-copy] selection copied: {} chars", char_count);
            json!({ "ok": true, "charCount": char_count, "preview": preview })
        }
        Err(e) => {
            eprintln!("[stealth-copy] selection failed: {}", e);
            json!({ "ok": false, "error": e })
        }
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("stealth-copy-result", payload);
    }
}

/// Handle the stealth select-all-and-copy chord (F13+A → Alt+F23 via
/// PowerToys). Uses UIA's DocumentRange to extract ALL text from the focused
/// element without ever changing selection state — so unlike a real Ctrl+A,
/// the browser shows no highlight at any point. Result goes straight to
/// the clipboard.
fn handle_stealth_select_all_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let payload = match crate::clipboard::copy_focused_document_text() {
        Ok(text) => {
            let char_count = text.chars().count();
            let preview: String = text.chars().take(40).collect();
            let preview = if text.chars().count() > 40 {
                format!("{}…", preview)
            } else {
                preview
            };
            eprintln!("[stealth-copy] document copied: {} chars", char_count);
            json!({ "ok": true, "charCount": char_count, "preview": preview })
        }
        Err(e) => {
            eprintln!("[stealth-copy] document failed: {}", e);
            json!({ "ok": false, "error": e })
        }
    };

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("stealth-copy-result", payload);
    }
}

/// Handle system audio shortcut
fn handle_system_audio_shortcut<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Ensure window is visible
        if let Ok(false) = window.is_visible() {
            if let Err(e) = window.show() {
                eprintln!("Failed to show window: {}", e);
                return;
            }
            if let Err(e) = window.set_focus() {
                eprintln!("Failed to focus window: {}", e);
            }
        }
        
        // Emit event to toggle system audio capture - frontend will determine current state
        if let Err(e) = window.emit("toggle-system-audio", json!({})) {
            eprintln!("Failed to emit system audio event: {}", e);
        }
    }
}

/// Tauri command to get current shortcuts
#[tauri::command]
pub fn get_shortcuts() -> serde_json::Value {
    json!({
        "toggle": DEFAULT_TOGGLE_SHORTCUT,
        "audio": DEFAULT_AUDIO_SHORTCUT,
        "screenshot": DEFAULT_SCREENSHOT_SHORTCUT,
        "systemAudio": DEFAULT_SYSTEM_AUDIO_SHORTCUT,
        "clickThrough": DEFAULT_CLICK_THROUGH_SHORTCUT,
        "stealthCopy": DEFAULT_STEALTH_COPY_SHORTCUT,
        "stealthSelectAll": DEFAULT_STEALTH_SELECT_ALL_SHORTCUT,
        "stealthCopyAlias": DEFAULT_STEALTH_COPY_ALIAS_SHORTCUT
    })
}

/// Tauri command to check if shortcuts are registered
#[tauri::command]
pub fn check_shortcuts_registered<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let shortcuts = [
        DEFAULT_TOGGLE_SHORTCUT,
        DEFAULT_AUDIO_SHORTCUT,
        DEFAULT_SCREENSHOT_SHORTCUT,
        DEFAULT_SYSTEM_AUDIO_SHORTCUT,
        DEFAULT_CLICK_THROUGH_SHORTCUT,
        DEFAULT_STEALTH_COPY_SHORTCUT,
        DEFAULT_STEALTH_SELECT_ALL_SHORTCUT,
        DEFAULT_STEALTH_COPY_ALIAS_SHORTCUT,
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
