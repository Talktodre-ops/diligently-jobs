//! System-audio capture → Deepgram WebSocket streaming.
//!
//! Pipeline:
//!   SpeakerInput (cpal/wasapi/CoreAudio) → f32 samples
//!     → batch every ~80ms
//!     → i16 LE conversion (single pass)
//!     → split: (a) Deepgram WS  (b) WAV writer on disk
//!
//! Deepgram's nova-3 endpointing fires transcript-final events without us
//! doing any local VAD. The WAV on disk gives us the post-stop audio blob to
//! upload to R2 async (see useSystemAudio.stopCapture in the desktop).
//!
//! Capture lifecycle:
//!   start → spawn task → task loops on `select!` between audio stream and
//!     a oneshot stop signal → on stop, flush + close Deepgram + finalize WAV
//!     + emit `capture-finished` with the WAV path.

use crate::deepgram_stream;
use crate::microphone::MicInput;
use crate::speaker::SpeakerInput;
use anyhow::Result;
use futures_util::{Stream, StreamExt};
use hound::{WavSpec, WavWriter};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::pin::Pin;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;

/// Per-session live capture state stored on `AudioState`.
pub struct CaptureSession {
    pub stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pub task: tokio::task::JoinHandle<()>,
    pub wav_path: PathBuf,
}

/// 80ms of audio at any sample rate — Deepgram recommends 50-100ms cadence.
fn batch_size_for(sample_rate: u32) -> usize {
    (sample_rate as usize) * 80 / 1000
}

fn audio_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir error: {e}"))?
        .join("interview_audio");
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir)
}

/// Source dispatch — "system" (default, WASAPI loopback / coreaudio output)
/// or "mic" (cpal default input). Anything else is treated as system.
fn open_audio_stream(
    source: Option<&str>,
) -> Result<(Pin<Box<dyn Stream<Item = f32> + Send>>, u32), String> {
    match source.unwrap_or("system") {
        "mic" | "microphone" => {
            let input = MicInput::new().map_err(|e| e.to_string())?;
            let stream = input.stream().map_err(|e| e.to_string())?;
            let sr = stream.sample_rate();
            Ok((Box::pin(stream), sr))
        }
        _ => {
            let input = SpeakerInput::new().map_err(|e| e.to_string())?;
            let stream = input.stream();
            let sr = stream.sample_rate();
            Ok((Box::pin(stream), sr))
        }
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    source: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    {
        let guard = state.session.lock().unwrap();
        if guard.is_some() {
            return Err("Capture already running".to_string());
        }
    }

    let (mut stream, sr) = open_audio_stream(source.as_deref())?;
    if sr == 0 {
        return Err("audio source returned sample_rate=0".to_string());
    }
    tracing::info!(
        "[capture] starting source={} sample_rate={sr}",
        source.as_deref().unwrap_or("system")
    );

    // Open the WAV file on disk before we start receiving samples — having
    // the path available means stop() can emit it without the task needing
    // to call back into AudioState.
    let dir = audio_dir(&app)?;
    // Filename uses unix-millis — easy to sort, easy to correlate with backend.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let wav_path = dir.join(format!("session-{ts}.wav"));
    let spec = WavSpec {
        channels: 1,
        sample_rate: sr,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::create(&wav_path, spec).map_err(|e| format!("WavWriter: {e}"))?;

    // Open Deepgram WS. If this fails the capture still proceeds (just no
    // live transcript) — we don't want to block the user from recording.
    let dg = match deepgram_stream::open(app.clone(), sr).await {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("[capture] Deepgram unavailable, recording-only: {e}");
            let _ = app.emit(
                "transcript-error",
                json!({ "message": format!("Deepgram WS open failed: {e}") }),
            );
            None
        }
    };

    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let app_for_task = app.clone();
    let wav_path_for_task = wav_path.clone();

    let task = tokio::spawn(async move {
        let batch = batch_size_for(sr);
        let mut buf: Vec<i16> = Vec::with_capacity(batch);
        // Throttle the audio-level event — emitting once per 80ms batch
        // would be 12.5 fires per second per channel; the UI doesn't need
        // that. ~10Hz is plenty for a level meter.
        let mut last_level_emit = std::time::Instant::now();
        let mut peak_in_window: f32 = 0.0;
        const LEVEL_EMIT_INTERVAL: std::time::Duration =
            std::time::Duration::from_millis(100);

        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => break,
                next = stream.next() => {
                    let Some(sample) = next else { break };
                    let clamped = sample.clamp(-1.0, 1.0);
                    let s_i16 = (clamped * i16::MAX as f32) as i16;
                    buf.push(s_i16);

                    if buf.len() >= batch {
                        let rms = flush_batch(&mut buf, &dg, &mut writer);
                        peak_in_window = peak_in_window.max(rms);
                        if last_level_emit.elapsed() >= LEVEL_EMIT_INTERVAL {
                            let _ = app_for_task.emit("audio-level", peak_in_window);
                            peak_in_window = 0.0;
                            last_level_emit = std::time::Instant::now();
                        }
                    }
                }
            }
        }

        // Drain anything still buffered (last partial batch).
        if !buf.is_empty() {
            flush_batch(&mut buf, &dg, &mut writer);
        }
        // Final level emit so the UI meter zeros out cleanly on stop.
        let _ = app_for_task.emit("audio-level", 0.0_f32);

        // Tell Deepgram we're done so it emits its final transcript.
        if let Some(dg_ref) = &dg {
            dg_ref.close();
        }

        // Finalize WAV header (writes RIFF sizes).
        let duration_seconds = match writer.finalize() {
            Ok(()) => {
                // Re-read the file's metadata for the duration. Cheap.
                std::fs::metadata(&wav_path_for_task)
                    .ok()
                    .map(|m| {
                        // 44-byte WAV header + sample bytes; 2 bytes per sample at 16-bit mono.
                        let data_bytes = m.len().saturating_sub(44) as f64;
                        data_bytes / (sr as f64 * 2.0)
                    })
                    .unwrap_or(0.0)
            }
            Err(e) => {
                tracing::warn!("[capture] WAV finalize failed: {e}");
                0.0
            }
        };

        let _ = app_for_task.emit(
            "capture-finished",
            json!({
                "wav_path": wav_path_for_task.to_string_lossy(),
                "sample_rate": sr,
                "duration_seconds": duration_seconds,
            }),
        );
    });

    let mut guard = state.session.lock().unwrap();
    *guard = Some(CaptureSession {
        stop_tx: Some(stop_tx),
        task,
        wav_path,
    });
    Ok(())
}

/// Convert + send + write one batch. Inlined helper so the hot loop stays flat.
/// Also returns RMS (0..1) of the batch so the caller can throttle-emit an
/// `audio-level` event the UI uses to show a live meter — that's the
/// fastest way for a user to spot "mic is on but silent" issues.
fn flush_batch(
    buf: &mut Vec<i16>,
    dg: &Option<deepgram_stream::DeepgramSession>,
    writer: &mut WavWriter<std::io::BufWriter<std::fs::File>>,
) -> f32 {
    // RMS for the level meter. i16 → normalized -1..1 → squared sum → sqrt.
    let mut sumsq = 0.0f32;
    for &s in buf.iter() {
        let f = s as f32 / i16::MAX as f32;
        sumsq += f * f;
    }
    let rms = if buf.is_empty() {
        0.0
    } else {
        (sumsq / buf.len() as f32).sqrt()
    };

    // Bytes for Deepgram (i16 LE).
    if let Some(dg) = dg {
        let mut bytes = Vec::with_capacity(buf.len() * 2);
        for &s in buf.iter() {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        dg.send_pcm_i16_bytes(bytes);
    }
    // Samples for WAV writer.
    for &s in buf.iter() {
        let _ = writer.write_sample(s);
    }
    buf.clear();
    rms
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    // Take the session out under lock, then drop the guard before awaiting.
    let session = state.session.lock().unwrap().take();

    let Some(mut s) = session else {
        return Ok(()); // not capturing
    };

    // Signal the task to exit its select! loop.
    if let Some(tx) = s.stop_tx.take() {
        let _ = tx.send(());
    }
    // Wait up to 5s for the task to finish flushing + closing.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), s.task).await;
    let _ = app; // app handle is currently unused once stop is signalled
    Ok(())
}

#[tauri::command]
pub async fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    // Windows: WASAPI loopback doesn't need explicit user permission. Don't
    // wait for an actual audio sample — a silent desktop produces zero
    // samples and `stream.next().await` blocks forever, which is what made
    // the "Starting interview capture…" spinner hang on first click.
    #[cfg(target_os = "windows")]
    {
        // Just verify we can construct the input device.
        let _input = SpeakerInput::new().map_err(|e| e.to_string())?;
        return Ok(true);
    }

    // macOS / Linux: try to read a sample, but bail after 1s. On macOS, lack
    // of "Audio Capture" permission usually surfaces as SpeakerInput::new()
    // failing outright, so the timeout path means "OS is silent" not
    // "permission denied" — assume OK and let the real capture call surface
    // any error.
    #[cfg(not(target_os = "windows"))]
    {
        let mut stream = SpeakerInput::new().map_err(|e| e.to_string())?.stream();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(1000),
            stream.next(),
        )
        .await;
        Ok(match result {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(_) => true,
        })
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("powershell")
            .args(["-Command", "Start-Process 'ms-settings:sound'"])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
    }
    Ok(())
}
