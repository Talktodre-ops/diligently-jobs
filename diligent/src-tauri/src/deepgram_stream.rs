//! Streaming Deepgram speech-to-text via WebSocket.
//!
//! Replaces the batch `/v1/listen` POST flow that buffered each utterance into
//! a WAV before transcribing. The streaming path opens one WS at capture start,
//! forwards PCM frames as they arrive (50-100ms cadence), and emits interim +
//! final transcripts to the frontend continuously.
//!
//! Lifecycle:
//!   1. `open(app, sample_rate)` → connects, spawns writer + reader tasks,
//!      returns a `DeepgramSession` handle.
//!   2. caller pushes i16 PCM bytes via `send_pcm_i16_bytes` as audio arrives.
//!   3. caller calls `close()` on stop — flushes a CloseStream message so
//!      Deepgram emits its final transcript before disconnecting.
//!
//! All errors are logged but never bubble — capture stays running locally
//! even if the WS drops, so the desktop doesn't crash the interview.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::env;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

/// A handle to an open Deepgram WebSocket session.
///
/// Cheap to hold across the speaker task — dropping it tears down the WS,
/// but explicit `close()` is preferred so Deepgram emits its final transcript.
pub struct DeepgramSession {
    pcm_tx: mpsc::UnboundedSender<DgCommand>,
}

enum DgCommand {
    /// i16 little-endian PCM bytes — what Deepgram expects for `encoding=linear16`.
    Audio(Vec<u8>),
    /// Flush + graceful close.
    Close,
}

/// Deepgram message shape we care about. Many other fields exist but we only
/// surface transcript text + finality.
#[derive(Debug, Deserialize)]
struct DgMessage {
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    speech_final: bool,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    channel: DgChannel,
}

#[derive(Debug, Default, Deserialize)]
struct DgChannel {
    #[serde(default)]
    alternatives: Vec<DgAlternative>,
}

#[derive(Debug, Deserialize)]
struct DgAlternative {
    #[serde(default)]
    transcript: String,
    /// Per-word details — used to extract the dominant speaker id for the
    /// utterance. When diarize=true, each word has a speaker number; we
    /// pick the majority speaker for the whole final segment.
    #[serde(default)]
    words: Vec<DgWord>,
}

#[derive(Debug, Deserialize)]
struct DgWord {
    #[serde(default)]
    speaker: Option<i64>,
}

/// Open a Deepgram streaming session.
///
/// Requires `DEEPGRAM_API_KEY` in the environment (loaded from `src-tauri/.env`
/// at app startup — see `lib.rs::run`).
pub async fn open(app: AppHandle, sample_rate: u32) -> Result<DeepgramSession> {
    let api_key = env::var("DEEPGRAM_API_KEY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .context("DEEPGRAM_API_KEY not set in src-tauri/.env")?;

    let model = env::var("DEEPGRAM_MODEL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "nova-3".to_string());

    // `endpointing=300` = 300ms of silence triggers a `speech_final` segment.
    // `interim_results=true` = stream hypothesis updates as words finalize.
    // `smart_format=true` adds punctuation, casing, and number formatting.
    // diarize=true tags each transcript word with a speaker id (0, 1, 2…).
    // The frontend uses this to filter out the user's own voice on the
    // mic-source path so the AI doesn't react to the candidate answering.
    let url = format!(
        "wss://api.deepgram.com/v1/listen\
         ?model={model}\
         &encoding=linear16\
         &sample_rate={sample_rate}\
         &channels=1\
         &interim_results=true\
         &smart_format=true\
         &punctuate=true\
         &diarize=true\
         &endpointing=300"
    );

    let mut request = url
        .into_client_request()
        .context("invalid Deepgram URL")?;
    let auth = HeaderValue::from_str(&format!("Token {api_key}"))
        .context("Deepgram API key has invalid characters")?;
    request.headers_mut().insert("Authorization", auth);

    let (ws, _response) = tokio_tungstenite::connect_async(request)
        .await
        .context("failed to connect to Deepgram WebSocket")?;
    tracing::info!("[deepgram] WS connected, sample_rate={sample_rate}, model={model}");

    let (mut sink, mut stream) = ws.split();
    let (pcm_tx, mut pcm_rx) = mpsc::unbounded_channel::<DgCommand>();

    // Writer task — drains the mpsc and pushes binary frames to Deepgram.
    tokio::spawn(async move {
        while let Some(cmd) = pcm_rx.recv().await {
            match cmd {
                DgCommand::Audio(bytes) => {
                    if let Err(e) = sink.send(Message::Binary(bytes.into())).await {
                        tracing::warn!("[deepgram] send failed: {e}");
                        break;
                    }
                }
                DgCommand::Close => {
                    // CloseStream tells Deepgram to flush pending results
                    // and emit final transcripts before shutting the socket.
                    let _ = sink
                        .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
                        .await;
                    let _ = sink.close().await;
                    break;
                }
            }
        }
    });

    // Reader task — parses incoming JSON, emits Tauri events.
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!("[deepgram] WS read error: {e}");
                    break;
                }
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => {
                    tracing::info!("[deepgram] WS closed by server");
                    break;
                }
                _ => continue,
            };

            let parsed: DgMessage = match serde_json::from_str(&text) {
                Ok(p) => p,
                Err(_) => continue, // metadata, keepalive, etc.
            };

            let alt = match parsed.channel.alternatives.first() {
                Some(a) => a,
                None => continue,
            };
            let transcript = alt.transcript.trim().to_string();
            if transcript.is_empty() {
                continue;
            }

            // Majority-speaker tally across the word list. When diarize=true
            // each word carries a speaker id; we tag the utterance with
            // whichever speaker dominated. None when no words are tagged.
            let mut counts = std::collections::HashMap::<i64, i64>::new();
            for w in &alt.words {
                if let Some(s) = w.speaker {
                    *counts.entry(s).or_insert(0) += 1;
                }
            }
            let speaker: Option<i64> = counts
                .into_iter()
                .max_by_key(|(_, c)| *c)
                .map(|(s, _)| s);

            // Deepgram emits `is_final` (this hypothesis won't change) and
            // separately `speech_final` (utterance boundary). We forward both
            // as `transcript-final`; the frontend's settle window decides
            // when to actually fire the LLM.
            if parsed.is_final || parsed.speech_final {
                let _ = app_for_reader.emit(
                    "transcript-final",
                    json!({
                        "text": transcript,
                        "start": parsed.start,
                        "duration": parsed.duration,
                        "speech_final": parsed.speech_final,
                        "speaker": speaker,
                    }),
                );
            } else {
                let _ = app_for_reader.emit(
                    "transcript-interim",
                    json!({ "text": transcript, "speaker": speaker }),
                );
            }
        }
        tracing::info!("[deepgram] reader task exited");
        let _ = app_for_reader.emit("transcript-disconnected", ());
    });

    Ok(DeepgramSession { pcm_tx })
}

impl DeepgramSession {
    /// Push pre-encoded i16 LE PCM bytes to Deepgram. Caller owns the
    /// conversion (same bytes are typically also written to the session
    /// WAV file, so we don't want to do it twice in here).
    pub fn send_pcm_i16_bytes(&self, bytes: Vec<u8>) {
        let _ = self.pcm_tx.send(DgCommand::Audio(bytes));
    }

    /// Flush + close. Safe to call from any context; the writer task picks
    /// up the Close command and shuts the socket gracefully so Deepgram
    /// emits its final transcript.
    pub fn close(&self) {
        let _ = self.pcm_tx.send(DgCommand::Close);
    }
}
