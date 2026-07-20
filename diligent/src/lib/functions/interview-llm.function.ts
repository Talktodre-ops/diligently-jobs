// Interview-mode LLM calls. Locked to Anthropic (Sonnet default; Haiku/Opus as
// escalation toggles). Talks to /v1/messages directly so we can set
// `cache_control: ephemeral` on the system prompt — a single interview
// session reuses the same large prompt across every turn, which makes
// caching a near-pure win:
//
//   First turn: writes cache (1.25x normal input cost on the prefix)
//   Each subsequent turn within ~5min: reads cache (0.1x normal input cost)
//
// Cost per ~15-turn interview drops from ~$0.11 → ~$0.02 on system-prompt
// tokens, and the cached reads also cut TTFT (Anthropic skips re-processing
// the long prefix).
//
// We deliberately do NOT route through the shared `fetchAIResponse` curl
// template: that template's "system" is a plain string, but caching
// requires the array-of-content-blocks form. Mutating the template would
// also turn on caching for non-interview Claude usage where the prompt
// isn't reused — that'd cost extra (1.25x write with no read savings).

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import type { Message } from "@/types";

export type InterviewModel =
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-7";

/** Total tokens used across all interview turns this app session — handy
 *  for the upcoming cost meter. Module-level so it survives unmount and
 *  accumulates across multiple `fetchInterviewResponse` calls. */
export const interviewUsage = {
  input: 0,
  output: 0,
  cache_creation: 0,
  cache_read: 0,
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

interface InterviewOpts {
  model: InterviewModel;
  systemPrompt: string;
  history: Message[];
  userMessage: string;
  imagesBase64?: string[];
  /** AbortSignal to cancel an in-flight stream (the settle-window state
   *  machine uses this for interrupt-and-restart). */
  signal?: AbortSignal;
}

/**
 * Stream an interview response from Claude with prompt caching on the
 * system prompt. The system message is sent as a single content block
 * tagged with `cache_control: ephemeral`; the rest of the request (the
 * messages array — the volatile, per-turn part) is uncached.
 */
export async function* fetchInterviewResponse(
  opts: InterviewOpts
): AsyncIterable<string> {
  const apiKey = await invoke<string | null>("get_ai_provider_api_key", {
    providerId: "claude",
  });
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      "ANTHROPIC_API_KEY not set in src-tauri/.env (or Settings). Interview mode needs Claude."
    );
  }

  // Build the user message content. When an image is attached (the
  // screenshot/code-mode path), Anthropic wants an array of content blocks
  // with the text + image alongside; otherwise a plain string is fine.
  //
  // media_type is image/jpeg — the Rust capture_to_base64 compresses to
  // JPEG to stay under Anthropic's 5MB cap. PNG is rejected with 400 if
  // the bytes are actually JPEG (Anthropic doesn't sniff, it trusts the
  // declared media_type).
  const userContent: unknown =
    opts.imagesBase64 && opts.imagesBase64.length > 0
      ? [
          { type: "text", text: opts.userMessage },
          ...opts.imagesBase64.map((data) => ({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data },
          })),
        ]
      : opts.userMessage;

  const body = {
    model: opts.model,
    max_tokens: 4096,
    stream: true,
    system: [
      {
        type: "text",
        text: opts.systemPrompt,
        // The magic line. Marks this content block for ephemeral caching;
        // identical prompts within ~5min hit the cache at 0.1x input cost.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      ...opts.history.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user", content: userContent },
    ],
  };

  const response = await tauriFetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Tauri webview = browser context. Anthropic requires this opt-in
      // header to allow direct browser API calls (otherwise it returns
      // 401 with `CORS request must set anthropic-dangerous-direct-browser-access`).
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) {
    // Anthropic's error body is JSON of shape
    //   { type: "error", error: { type: "invalid_request_error", message: "..." } }
    // We extract `error.message` so the UI shows the actual reason (e.g.
    // "image exceeds 5MB", "invalid_api_key") instead of a bare 400/401.
    let detail = "";
    try {
      const raw = await response.text();
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || parsed?.message || raw;
      } catch {
        detail = raw;
      }
    } catch {
      /* ignore */
    }
    throw new Error(
      `Anthropic ${response.status} ${response.statusText}${
        detail ? ` — ${detail}` : ""
      }`
    );
  }
  if (!response.body) {
    throw new Error("Anthropic returned no response body");
  }

  // Stream parser. Anthropic SSE format is `event: ...\ndata: {...}\n\n` —
  // we only care about `data:` lines, the `event:` lines are duplicated
  // info already available in the JSON's `type` field.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        // Token text chunks live in content_block_delta events.
        if (
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta" &&
          typeof parsed.delta.text === "string"
        ) {
          yield parsed.delta.text;
        }

        // Usage / cache analytics arrive in message_start (initial counts)
        // and message_delta (final output count). Track running totals
        // so the cost meter can read them.
        if (parsed.type === "message_start" && parsed.message?.usage) {
          const u = parsed.message.usage;
          interviewUsage.input += u.input_tokens ?? 0;
          interviewUsage.cache_creation += u.cache_creation_input_tokens ?? 0;
          interviewUsage.cache_read += u.cache_read_input_tokens ?? 0;
        }
        if (parsed.type === "message_delta" && parsed.usage) {
          interviewUsage.output += parsed.usage.output_tokens ?? 0;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
