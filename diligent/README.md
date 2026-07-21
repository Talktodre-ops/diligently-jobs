# Diligently — desktop app

The Tauri + React desktop client for Diligently, a bring-your-own-key AI copilot
for job applications. It runs as a small always-on-top overlay: paste a job
description and it helps you research the company, tailor your CV, draft a cover
letter, and track the application. It talks to the Diligently backend
(`../backend`) and directly to your chosen LLM provider.

> Full setup and quickstart live in the [root README](../README.md). This file
> covers desktop-specific development.

## Stack

- **Tauri 2** + **Rust** — native shell, global shortcuts, screenshot capture
- **React 19** + **TypeScript** + **Vite** + **Tailwind 4** — UI
- **OpenAI / DeepSeek / Anthropic** — LLM completion (bring your own key; pick in Settings)
- **Tavily** — company-research web search (optional)

## Develop

Prereqs: Node ≥18, Rust stable, and the Tauri platform deps
(<https://v2.tauri.app/start/prerequisites/>).

```bash
npm install
npm run tauri dev    # full desktop app (Rust shell + webview)
npm run dev          # frontend only (faster UI iteration)
npm run build        # tsc + vite production bundle
npm run tauri build  # platform installers under src-tauri/target/release/bundle/
npm run lint
```

## Environment

Provider keys live in `src-tauri/.env` (see `.env.example`); `scripts/setup` in
the repo root creates it for you. You need at least one LLM key:

```
OPENAI_API_KEY=...
DEEPSEEK_API_KEY=...
ANTHROPIC_API_KEY=...
TAVILY_API_KEY=...      # optional — company research
```

The backend URL + shared token live in `diligent/.env` (`VITE_BACKEND_URL` /
`VITE_BEARER_TOKEN`). Any provider key left empty here can also be set in
Settings → AI providers.

## Global shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + \` | Toggle the overlay |
| `Ctrl + Shift + S` | Screenshot into chat |

## Layout

```
src/                     React UI
  components/job/         Job Copilot (JD -> research -> CV -> gaps -> cover letter)
  components/upwork/      Upwork proposal flow
  components/completion/  Quick chat
  components/settings/    Settings (providers, system health, backend status)
  lib/backend/            Typed client for the Diligently backend API
  lib/functions/          LLM step functions
src-tauri/
  src/api.rs              LLM chat command + provider key resolution
  src/research.rs         Tavily web_search command
  src/window.rs           Overlay window setup + positioning
  src/shortcuts.rs        Global shortcuts (toggle, screenshot)
```

## License

MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
