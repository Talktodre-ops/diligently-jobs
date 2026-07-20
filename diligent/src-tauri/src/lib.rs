// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod window;
mod shortcuts;
mod api;
mod research;

#[cfg(target_os = "macos")]
use tauri_plugin_macos_permissions;
use xcap::Monitor;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, ImageBuffer, ImageEncoder, Rgba};
use tauri::Manager;
use tauri_plugin_http;

/// Anthropic's vision endpoint caps images at 5 MB *encoded base64*. We aim
/// slightly under to leave room for JSON escaping + safety margin.
const SCREENSHOT_MAX_BASE64_LEN: usize = 4_500_000;
/// Resize ceiling — 1080p is plenty for vision-quality analysis of code on
/// screen, and shrinks 4K screenshots ~4x before the JPEG step even starts.
const SCREENSHOT_MAX_W: u32 = 1920;
const SCREENSHOT_MAX_H: u32 = 1080;
/// Quality ladder. Start near-lossless; step down only if the cap is breached
/// (rare past 1080p). Stops at q=30 — below that, code text becomes hard to
/// read for the model.
const JPEG_QUALITY_LADDER: &[u8] = &[80, 70, 60, 50, 40, 30];

use std::sync::Mutex;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// JS log forwarder. In Tauri 2, JS console.log goes only to the webview's
/// devtools console — easy to miss when the cargo terminal is the usual
/// debug surface. This command bridges JS logs to stdout so `npm run tauri
/// dev` shows the [ai] / [json-utils] / etc. lines alongside Rust logs.
#[tauri::command]
fn dev_log(line: String) {
    eprintln!("{}", line);
}

#[tauri::command]
fn set_window_height(window: tauri::WebviewWindow, height: u32) -> Result<(), String> {
    use tauri::{LogicalSize, Size};

    let new_size = LogicalSize::new(700.0, height as f64);

    // Don't auto-reposition on every resize — that fought user drags and
    // snapped the window back to top-center constantly. Initial top-center
    // positioning still happens once at startup via setup_main_window.
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))
}

/// Capture the primary monitor as a base64-encoded JPEG.
///
/// Returns a compressed JPEG sized to fit under Anthropic's 5 MB encoded
/// limit so the screenshot code-capture flow doesn't randomly fail
/// at high resolutions. Errors are prefixed with a category tag
/// (`MonitorEnum:`, `NoPrimaryMonitor`, `CaptureFailed:`, `EmptyImage`,
/// `EncodeFailed:`, `CannotCompress`) so the JS side can decide retry vs.
/// permanent-failure without parsing English.
#[tauri::command]
fn capture_to_base64() -> Result<String, String> {
    let monitors = Monitor::all()
        .map_err(|e| format!("MonitorEnum: failed to list monitors: {}", e))?;
    let monitor_count = monitors.len();

    let primary = monitors
        .into_iter()
        .find(|m| m.is_primary())
        .ok_or_else(|| format!(
            "NoPrimaryMonitor: {} monitor(s) enumerated but none flagged primary",
            monitor_count
        ))?;

    let raw = primary
        .capture_image()
        .map_err(|e| format!("CaptureFailed: {}", e))?;

    let (w, h) = (raw.width(), raw.height());
    if w == 0 || h == 0 {
        return Err(format!("EmptyImage: capture returned {}x{}", w, h));
    }
    eprintln!("[capture] primary monitor captured at {}x{}", w, h);

    let rgba = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(w, h, raw.into_raw())
        .ok_or_else(|| "EncodeFailed: pixel buffer length did not match w*h*4".to_string())?;

    let mut dyn_img = DynamicImage::ImageRgba8(rgba);
    if w > SCREENSHOT_MAX_W || h > SCREENSHOT_MAX_H {
        let scale = (SCREENSHOT_MAX_W as f32 / w as f32)
            .min(SCREENSHOT_MAX_H as f32 / h as f32);
        let new_w = ((w as f32) * scale).round().max(1.0) as u32;
        let new_h = ((h as f32) * scale).round().max(1.0) as u32;
        eprintln!("[capture] resizing to {}x{}", new_w, new_h);
        dyn_img = dyn_img.resize(new_w, new_h, FilterType::Triangle);
    }

    // JPEG has no alpha. Strip it once so the q-ladder loop doesn't redo work.
    let rgb = dyn_img.to_rgb8();
    let (final_w, final_h) = rgb.dimensions();

    for &quality in JPEG_QUALITY_LADDER {
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, quality)
            .write_image(rgb.as_raw(), final_w, final_h, ColorType::Rgb8.into())
            .map_err(|e| format!("EncodeFailed: {}", e))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
        if b64.len() <= SCREENSHOT_MAX_BASE64_LEN {
            eprintln!(
                "[capture] encoded JPEG q={} jpeg_bytes={} b64_len={}",
                quality,
                buf.len(),
                b64.len()
            );
            return Ok(b64);
        }
        eprintln!(
            "[capture] q={} produced b64_len={} (> cap {}), stepping quality down",
            quality, b64.len(), SCREENSHOT_MAX_BASE64_LEN
        );
    }

    Err(format!(
        "CannotCompress: even q=30 exceeds the {}-byte base64 cap. Reduce monitor resolution and retry.",
        SCREENSHOT_MAX_BASE64_LEN
    ))
}

/// Save base64-encoded bytes to the user's Downloads folder and return the full
/// path. Used for client-generated artifacts (e.g. the architecture diagram PNG/
/// SVG) — WebView2 silently drops programmatic blob/anchor downloads, so the
/// bytes are written from Rust instead. Filenames are reduced to their base name
/// (no path traversal) and de-duplicated with " (n)" if they already exist.
#[tauri::command]
fn save_file_to_downloads(
    app: tauri::AppHandle,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    use std::io::Write;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("Invalid base64 data: {}", e))?;

    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("Could not locate Downloads folder: {}", e))?;

    let safe = std::path::Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("diagram")
        .to_string();

    let mut target = dir.join(&safe);
    if target.exists() {
        let (stem, ext) = match safe.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), format!(".{}", e)),
            None => (safe.clone(), String::new()),
        };
        let mut n = 1;
        loop {
            let candidate = dir.join(format!("{} ({}){}", stem, n, ext));
            if !candidate.exists() {
                target = candidate;
                break;
            }
            n += 1;
        }
    }

    let mut f =
        std::fs::File::create(&target).map_err(|e| format!("Could not create file: {}", e))?;
    f.write_all(&bytes)
        .map_err(|e| format!("Could not write file: {}", e))?;

    Ok(target.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load `src-tauri/.env` at runtime so `std::env::var` (e.g. TAVILY_API_KEY) applies without a rebuild.
    let _ = dotenv::from_path(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env"));

    let builder = tauri::Builder::default()
        .manage(shortcuts::WindowVisibility(Mutex::new(false)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())  // Add shell plugin
        .invoke_handler(tauri::generate_handler![
            greet,
            get_app_version,
            set_window_height,
            capture_to_base64,
            dev_log,
            save_file_to_downloads,
            shortcuts::get_shortcuts,
            shortcuts::check_shortcuts_registered,
            shortcuts::set_app_icon_visibility,
            shortcuts::set_always_on_top,
            api::chat_stream,
            api::fetch_models,
            api::check_license_status,
            api::get_ai_provider_api_key,
            api::get_ai_provider_default_model,
            research::web_search
        ])
        .setup(|app| {
            // Setup main window positioning
            window::setup_main_window(app).expect("Failed to setup main window");
            
            // Setup global shortcuts
            if let Err(e) = shortcuts::setup_global_shortcuts(app.handle()) {
                eprintln!("Failed to setup global shortcuts: {}", e);
            }
            
            Ok(())
        });

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}