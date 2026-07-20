# Clean-room rewrite tracker

Diligently is a fork of Pluely (MIT, © 2025 Srikanth Nani). All Pluely
*strings, names, and branding* have been stripped from source. The *code*
itself is still derived in many places — until each file in this tracker is
either rewritten from scratch or independently verified to be implementation
-trivial, the upstream MIT terms continue to apply to that file.

When every file below is marked **REWRITTEN** or **TRIVIAL**, the project is
fully owned and `LICENSE` can be replaced with whatever final license you pick.

## Legend

- **DERIVED** — file is substantially the upstream Pluely implementation. Needs a from-scratch rewrite before we can claim full ownership.
- **REWRITTEN** — file has been reimplemented from a blank page based only on the public Tauri / React / Deepgram docs.
- **TRIVIAL** — file is short, mechanical, or obvious enough that copyright doesn't meaningfully attach (e.g. a 5-line type definition, a glue file). No rewrite needed; record the rationale.
- **NEW** — file added by us, not present upstream. Already owned.

## Rust (`src-tauri/src/`)

| File | Status | Notes |
|---|---|---|
| `main.rs` | TRIVIAL | 3-line bin entry. |
| `lib.rs` | DERIVED | Tauri builder + invoke handler list. Rewrite when locking down command surface. |
| `api.rs` | DERIVED | Deepgram batch transcribe + managed `chat_stream` + license storage. Will be replaced by the streaming Deepgram WS rewrite anyway. |
| `activate.rs` | DERIVED | License-key activation flow. Slated for deletion (managed-API monetization is not our model). |
| `window.rs` | TRIVIAL | Standard Tauri window positioning math. |
| `shortcuts.rs` | DERIVED | Needs a fresh pass when we redesign the shortcut surface. |
| `speaker/mod.rs` | TRIVIAL | Platform dispatch shim. |
| `speaker/commands.rs` | DERIVED | VAD constants + chunk loop. Will be rewritten alongside the streaming WS work. |
| `speaker/windows.rs` | DERIVED | WASAPI capture loop. |
| `speaker/macos.rs` | DERIVED | ScreenCaptureKit/cidre capture loop. |
| `speaker/linux.rs` | DERIVED | PulseAudio simple-API capture loop. |
| `build.rs` | TRIVIAL | dotenv → cargo:rustc-env passthroughs. |

## Frontend (`src/`)

| File | Status | Notes |
|---|---|---|
| `App.tsx` | DERIVED | Top-level layout + popover wiring. |
| `main.tsx` | TRIVIAL | React 19 root mount. |
| `global.css` | DERIVED | Tailwind base + a few custom utilities. |
| `components/completion/*` | DERIVED | The chat input + VAD + screenshot flow. Heaviest rewrite candidate. |
| `components/history/*` | DERIVED | Conversation history UI. |
| `components/Header/*` | DERIVED | |
| `components/Markdown/*` | DERIVED | react-markdown wiring with shiki. |
| `components/Selection/*` | DERIVED | |
| `components/settings/*` | DERIVED | All settings panels (AI configs, STT configs, screenshot, system prompt, etc). |
| `components/speech/*` | DERIVED | Audio visualizer + status indicator. |
| `components/TextInput/*` | DERIVED | |
| `components/ui/*` | TRIVIAL | shadcn/ui primitives — these are shadcn upstream code under MIT, attribute via shadcn's terms not Pluely. |
| `components/updater/*` | DERIVED | Tauri updater glue. |
| `components/job/*` | NEW | Job Copilot — Diligently-original. |
| `config/ai-providers.constants.ts` | DERIVED | Provider catalog with per-provider curl templates. |
| `config/stt.constants.ts` | DERIVED | STT provider catalog. |
| `config/constants.ts` | DERIVED | localStorage keys + defaults. |
| `contexts/app.context.tsx` | DERIVED | Global app state. |
| `contexts/theme.context.tsx` | DERIVED | |
| `hooks/useCompletion.ts` | DERIVED | Heavy file — chat orchestration. |
| `hooks/useSystemAudio.ts` | DERIVED | System-audio session controller. Will be rewritten alongside the streaming WS work. |
| `hooks/useGlobalShortcuts.ts` | DERIVED | |
| `hooks/useWindow.ts` | DERIVED | |
| `hooks/useSettings.ts` | DERIVED | |
| `hooks/useHistory.ts` | DERIVED | |
| `hooks/useTitles.ts` | DERIVED | |
| `hooks/useVersion.ts` | DERIVED | |
| `hooks/useCustomProvider.ts` | DERIVED | |
| `hooks/useCustomSttProviders.ts` | DERIVED | |
| `hooks/useCopyToClipboard.ts` | TRIVIAL | |
| `hooks/useJobWorkspace.ts` | NEW | Job Copilot state machine. |
| `lib/functions/ai-response.function.ts` | DERIVED | LLM streaming integration. |
| `lib/functions/stt.function.ts` | DERIVED | STT dispatch integration. |
| `lib/functions/common.function.ts` | DERIVED | curl variable substitution + path lookup helpers. |
| `lib/functions/managed-api.ts` | TRIVIAL | One function, one localStorage key. |
| `lib/functions/job.function.ts` | NEW | JD parser + gap analyzer + bullet tailor. |
| `lib/storage/*` | DERIVED, except `job.storage.ts` (NEW) | |
| `lib/chat-history.ts` | DERIVED | |
| `lib/utils.ts` | DERIVED | |
| `lib/version.ts` | TRIVIAL | |
| `types/*` | TRIVIAL | Type-only declarations. |

## Other

| Path | Status | Notes |
|---|---|---|
| `src-tauri/Cargo.toml` | NEW | Renamed package metadata. |
| `src-tauri/tauri.conf.json` | DERIVED | Standard Tauri config; rewrite is mostly mechanical. |
| `src-tauri/info.plist` | TRIVIAL | Boilerplate macOS plist. |
| `src-tauri/diligently.desktop` | NEW | |
| `src-tauri/.env.example` | NEW | |
| `src-tauri/build.rs` | TRIVIAL | |
| `package.json` | NEW | Renamed; deps untouched. |
| `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `components.json` | TRIVIAL | Boilerplate config. |
| `README.md` | NEW | Written from scratch. |
| `TASKS.md` | NEW | Job Copilot tracker, our work. |
| `LICENSE` | NEW | |
| `third-party-notices/pluely-mit.txt` | UPSTREAM | Preserved upstream MIT, do not edit. |

## How to use this file

When you rewrite a DERIVED file:

1. Open the upstream Pluely file at the version you forked from.
2. Read it once to understand intent. Then close it.
3. Reimplement from scratch using only public docs (Tauri, React, Deepgram, etc.).
4. Bump that file's row to **REWRITTEN** here, with the date.

When every row is REWRITTEN, TRIVIAL, NEW, or UPSTREAM (preserved), swap `LICENSE` for the final one and remove this file's nag.
