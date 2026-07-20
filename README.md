# Diligently

A desktop AI copilot for job applications. Paste a job description and Diligently
helps you research the company, tailor your CV, draft a cover letter, score the
result against the JD, and track everything — all from a small always-on-top
overlay, using **your own** LLM API key.

- **Job Copilot** — a guided pipeline: JD → company research → CV tailoring →
  gap analysis → cover letter → follow-up.
- **CV & cover-letter rendering** — clean PDF/DOCX output via a LaTeX (Tectonic)
  pipeline.
- **ATS scoring** — score a tailored CV against the job description.
- **Upwork proposals** — a separate flow for freelance proposals.
- **Quick chat** — ask a question without leaving the overlay.

Bring-your-own-key: the app talks directly to the provider you choose (OpenAI,
DeepSeek, or Anthropic). There is no hosted service and no telemetry.

## Architecture

Two pieces, run in two terminals — **no Docker required**:

| Component  | Path        | Stack                     | Talks to                                   |
|------------|-------------|---------------------------|--------------------------------------------|
| Backend    | `backend/`  | Rust · Axum · SQLx        | your Postgres + your S3-compatible bucket  |
| Desktop    | `diligent/` | Tauri · React · TypeScript | the backend + your LLM provider(s)         |

The backend stores your application history and rendered documents; the desktop
app is the UI. Database migrations run automatically the first time the backend
boots.

## Prerequisites

- **Rust** (stable) — https://rustup.rs
- **Node.js 18+** and npm
- A **Postgres** database URL — the free tier at [Neon](https://neon.tech) is the
  quickest; any Postgres works, including local.
- An **S3-compatible bucket** — Cloudflare R2, AWS S3, or a local MinIO.
- At least one **LLM API key** — OpenAI, DeepSeek, or Anthropic.
- *(optional)* a **Tavily** key for the company-research step — free at
  [app.tavily.com](https://app.tavily.com).

## Quickstart

```bash
git clone https://github.com/Talktodre-ops/diligently-jobs.git
cd diligently-jobs

# One-time setup: copies .env.example -> .env, generates a shared token,
# and downloads the Tectonic (LaTeX) binary into backend/tools/.
#   Windows:      powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#   macOS/Linux:  bash scripts/setup.sh
```

Then paste your keys:

- **`backend/.env`** — `DATABASE_URL` (your Postgres) and `R2_*` (your S3 bucket).
- **`diligent/src-tauri/.env`** — at least one of `OPENAI_API_KEY` /
  `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`, and optionally `TAVILY_API_KEY`.

Run it — two terminals:

```bash
# Terminal 1 — backend API (http://localhost:8787)
cd backend && cargo run

# Terminal 2 — desktop app
cd diligent && npm install && npm run tauri dev
```

The first `cargo run` compiles the backend and applies the database migrations;
the first `npm install` pulls the frontend dependencies. After that, both start
quickly. Open **Settings → System health** in the app to confirm the backend and
your API key are wired up.

## Where each key goes

| Key                              | File                        | Used for                          |
|----------------------------------|-----------------------------|-----------------------------------|
| `DATABASE_URL`                   | `backend/.env`              | application history (Postgres)    |
| `R2_*` / S3 credentials          | `backend/.env`              | rendered CV/cover-letter storage  |
| `BEARER_TOKEN` / `VITE_BEARER_TOKEN` | both `.env`s (auto-set) | desktop ↔ backend auth            |
| `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` | `diligent/src-tauri/.env` | chat + CV/cover-letter generation |
| `TAVILY_API_KEY`                 | `diligent/src-tauri/.env`   | company research (web search)     |
| `LLM_API_KEY`                    | `backend/.env`              | async ATS scoring (optional)      |

## Tectonic (PDF rendering)

CV and cover-letter PDFs are produced with [Tectonic](https://tectonic-typesetting.github.io/).
`scripts/setup` downloads it into `backend/tools/` and points `TECTONIC_BIN` at
it. If you already have `tectonic` on your `PATH`, you can delete the
`TECTONIC_BIN` line in `backend/.env` instead.

## Acknowledgments

Diligently is built and maintained by **ANDERSON Victor**
([@Talktodre-ops](https://github.com/Talktodre-ops)).

The desktop shell began as a fork of [Pluely](https://github.com/iamsrikanthnani/pluely)
(MIT, © 2025 Srikanth Nani); the upstream license is retained in
[`diligent/third-party-notices/pluely-mit.txt`](diligent/third-party-notices/pluely-mit.txt).
See [`diligent/NOTICE`](diligent/NOTICE) for attribution details.

## License

[MIT](LICENSE) © 2026 ANDERSON Victor.
