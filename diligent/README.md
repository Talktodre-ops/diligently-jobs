# Diligently

A privacy-first desktop AI copilot for job applications, interviews, and meetings.

Diligently lives as a translucent overlay on your desktop. It listens for what
the interviewer is saying, sees what's on your screen, knows your CV, and
turns a job description into a gap-analysed, tailored application package.

## Status

Active development. The codebase is mid clean-room rewrite from a forked
upstream — see `CLEANROOM.md` for the current progress and `LICENSE` for what
that means legally.

## Stack

- **Tauri 2** + **Rust** (native shell, ~10MB binary, system audio capture, global shortcuts, screenshot)
- **React 19.2** + **TypeScript** + **Vite** + **Tailwind 4** (UI)
- **Deepgram** (`nova-3`) for system-audio STT, with WebSocket streaming on the roadmap
- **DeepSeek** + **OpenAI** for LLM completion (BYOK; multi-provider via curl templates)
- **Postgres + R2** memory backend (planned — see `TASKS.md`)

## Run it

Prereqs: Node ≥18, Rust stable, the Tauri Windows/macOS/Linux deps from
<https://v2.tauri.app/start/prerequisites/>.

```bash
npm install
npm run tauri dev      # full desktop app
npm run dev            # frontend only (faster UI iteration)
npm run build          # tsc + vite production bundle
npm run tauri build    # platform installers in src-tauri/target/release/bundle/
npm run lint
```

### Environment

Backend secrets live in `src-tauri/.env` (see `.env.example`). Required for
audio + the env-fallback LLM path:

```
DEEPGRAM_API_KEY=...
DEEPGRAM_MODEL=nova-3
OPENAI_API_KEY=...
DEEPSEEK_API_KEY=...
```

If `.env` is missing, configure providers in Settings → AI Configs / STT
Configs instead.

### Global shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + \` | Toggle window |
| `Ctrl + Shift + A` | Voice input (mic) |
| `Ctrl + Shift + S` | Screenshot |
| `Ctrl + Shift + M` | System audio capture (interviewer side) |

## Layout

```
src/                    React UI
  components/job/       Job Copilot (JD, CV, gaps, tailored bullets)
  hooks/useSystemAudio  System-audio capture + transcription pipeline
  lib/functions/        AI + STT integrations
src-tauri/
  src/api.rs            Deepgram + managed-API HTTP commands
  src/speaker/          Per-platform system-audio capture + VAD
  src/activate.rs       License/secure-storage commands (legacy, shrinking)
```

## Roadmap

See `TASKS.md`. Current work:

- Phase 1 (JD → gap analysis) — done
- Phase 2 (tailored CV bullets w/ per-bullet approval) — done
- Phase 3 (company research + cited cover letter) — pending
- Phase 4 (Markdown export of full application package) — pending
- Deepgram WebSocket streaming for sub-second interviewer responses — pending
- Postgres + R2 memory backend — pending
