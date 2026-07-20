//! Microphone input stream — cross-platform via cpal.
//!
//! Lives parallel to `speaker/` for the interview "use my mic" flow. The
//! speaker module captures system audio (what's playing through the
//! speakers — i.e., the interviewer's voice over Zoom); this module
//! captures the default mic so the user can test the pipeline without an
//! interviewer present, or use the app for in-person interviews where
//! there's nothing playing through the speakers.
//!
//! cpal's Stream type is `!Send` on some platforms, so we run the capture
//! on a dedicated `std::thread` and bridge samples to the async caller
//! through `Arc<Mutex<VecDeque<f32>>>` + a `Waker`. Same pattern as
//! `speaker/windows.rs::SpeakerStream`.

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use futures_util::Stream;
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Mutex};
use std::task::{Poll, Waker};
use std::thread;
use std::time::Duration;

pub struct MicInput {}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
    shutdown: bool,
}

pub struct MicStream {
    sample_queue: Arc<Mutex<VecDeque<f32>>>,
    waker_state: Arc<Mutex<WakerState>>,
    _capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
}

impl MicInput {
    pub fn new() -> Result<Self> {
        Ok(Self {})
    }

    pub fn stream(self) -> Result<MicStream> {
        let sample_queue = Arc::new(Mutex::new(VecDeque::<f32>::new()));
        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
            shutdown: false,
        }));
        let (init_tx, init_rx) = mpsc::channel::<Result<u32>>();

        let queue_for_thread = sample_queue.clone();
        let waker_for_thread = waker_state.clone();
        let init_tx_for_thread = init_tx.clone();

        let thread = thread::spawn(move || {
            if let Err(err) = run_capture(queue_for_thread, waker_for_thread, init_tx_for_thread) {
                let _ = init_tx.send(Err(err));
            }
        });

        let sample_rate = init_rx
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| anyhow!("microphone init timed out (no default input device?)"))??;

        Ok(MicStream {
            sample_queue,
            waker_state,
            _capture_thread: Some(thread),
            sample_rate,
        })
    }
}

impl MicStream {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

impl Stream for MicStream {
    type Item = f32;

    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<f32>> {
        let this = self.get_mut();
        // Fast path — there's queued data.
        if let Some(s) = this.sample_queue.lock().unwrap().pop_front() {
            return Poll::Ready(Some(s));
        }
        // No data — register a waker and yield.
        let mut ws = this.waker_state.lock().unwrap();
        if ws.shutdown {
            return Poll::Ready(None);
        }
        ws.has_data = false;
        ws.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for MicStream {
    fn drop(&mut self) {
        // Tell the capture thread to exit so cpal releases the input device.
        let mut ws = self.waker_state.lock().unwrap();
        ws.shutdown = true;
        if let Some(w) = ws.waker.take() {
            w.wake();
        }
    }
}

fn run_capture(
    queue: Arc<Mutex<VecDeque<f32>>>,
    waker_state: Arc<Mutex<WakerState>>,
    init_tx: mpsc::Sender<Result<u32>>,
) -> Result<()> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!("no default input device"))?;
    let device_name = device.name().unwrap_or_else(|_| "unknown".into());
    let supported = device
        .default_input_config()
        .context("default_input_config failed (mic permission denied?)")?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let fmt = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();

    tracing::info!(
        "[mic] device='{device_name}' rate={sample_rate}Hz channels={channels} fmt={fmt:?}"
    );

    // Tell the caller what sample rate we ended up at. The Deepgram WS URL
    // bakes this in.
    let _ = init_tx.send(Ok(sample_rate));

    // Helper for the audio callback to push samples + wake the async caller.
    // Also tracks total samples so we can warn loudly if cpal opened the
    // stream but no data is actually flowing (silent mic / OS denial).
    let total_samples = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let flush = {
        let total = total_samples.clone();
        move |queue: &Arc<Mutex<VecDeque<f32>>>,
              waker_state: &Arc<Mutex<WakerState>>,
              mono: Vec<f32>| {
            if mono.is_empty() {
                return;
            }
            total.fetch_add(mono.len() as u64, std::sync::atomic::Ordering::Relaxed);
            queue.lock().unwrap().extend(mono);
            let mut ws = waker_state.lock().unwrap();
            ws.has_data = true;
            if let Some(w) = ws.waker.take() {
                w.wake();
            }
        }
    };

    let err_fn = |err: cpal::StreamError| {
        tracing::warn!("[mic] cpal stream error: {err}");
    };

    let stream = match fmt {
        SampleFormat::F32 => {
            let q = queue.clone();
            let w = waker_state.clone();
            let flush = flush.clone();
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let mono = downmix_f32(data, channels);
                    flush(&q, &w, mono);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::I16 => {
            let q = queue.clone();
            let w = waker_state.clone();
            let flush = flush.clone();
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let as_f32: Vec<f32> =
                        data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    let mono = downmix_f32(&as_f32, channels);
                    flush(&q, &w, mono);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::U16 => {
            let q = queue.clone();
            let w = waker_state.clone();
            let flush = flush.clone();
            device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    let as_f32: Vec<f32> = data
                        .iter()
                        .map(|&s| (s as f32 - 32768.0) / 32768.0)
                        .collect();
                    let mono = downmix_f32(&as_f32, channels);
                    flush(&q, &w, mono);
                },
                err_fn,
                None,
            )?
        }
        other => {
            return Err(anyhow!(
                "unsupported microphone sample format: {other:?} — only F32/I16/U16 are wired"
            ))
        }
    };

    stream.play().context("cpal stream play failed")?;
    tracing::info!(
        "[mic] capture started — {sample_rate}Hz, {channels}ch, fmt={fmt:?}"
    );

    // Park the thread until the MicStream is dropped (shutdown flag set).
    // cpal's stream stays live as long as we hold `stream` in scope.
    let mut last_total = 0_u64;
    let mut elapsed_ms = 0_u64;
    loop {
        thread::sleep(Duration::from_millis(500));
        elapsed_ms += 500;
        if waker_state.lock().unwrap().shutdown {
            break;
        }
        // Periodically log sample-flow stats so it's obvious from the log
        // whether cpal is actually delivering data. If nothing's arriving
        // after 2s, almost always means OS-level mic permission denied.
        let cur = total_samples.load(std::sync::atomic::Ordering::Relaxed);
        if elapsed_ms == 2000 && cur == 0 {
            tracing::warn!(
                "[mic] NO samples received in first 2s — check Windows mic permission \
                 (Settings → Privacy & security → Microphone) and that '{device_name}' \
                 isn't muted/disabled."
            );
        }
        if elapsed_ms % 5000 == 0 {
            let delta = cur - last_total;
            tracing::debug!("[mic] last 5s: {delta} samples (total {cur})");
            last_total = cur;
        }
    }
    drop(stream);
    tracing::info!("[mic] capture thread exited");
    Ok(())
}

fn downmix_f32(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}
