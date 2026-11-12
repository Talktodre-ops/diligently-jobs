# Diligently — backend

Rust + Axum + sqlx + Postgres (Neon) + R2. Single-user audit-log service that the
desktop client and any companion devices write to. Bearer-token auth, presigned
R2 URLs for blobs, append-only `events` table as the spine.

## Quickstart

```bash
# 1. Set up .env from the template
cp .env.example .env
# (fill in DATABASE_URL and R2_*)

# 2. Run with Docker (recommended for dev — hot reload via cargo-watch)
docker compose up

# 3. Or run locally without Docker
cargo install cargo-watch        # one-time
cargo watch -x run               # or: just dev
```

The server listens on `BIND_ADDR` (default `0.0.0.0:8787`). Hit it:

```bash
curl http://localhost:8787/health
# {"status":"ok","postgres":{"ok":true,...},"r2":{"ok":true,...}}
```

## Tests

```bash
scripts/test.sh            # starts local test services if needed, runs cargo test
scripts/test.sh auth       # filter, same as cargo test
scripts/test-services.sh down
```

The suite runs only against a throwaway Postgres on 127.0.0.1:55432 and a
SeaweedFS S3 emulator on 127.0.0.1:59000, both in Docker with tmpfs storage.
Each test gets its own migrated database. The harness refuses any database or
storage URL that is not localhost, so it can never reach the database or bucket
in `.env`. See `docs/decisions/2026-11-12-tests-run-on-local-services-only.md`.

## Project layout

```
backend/
├── Cargo.toml              # deps + [[bin]] name
├── Dockerfile              # multi-stage prod image (~80MB)
├── Dockerfile.dev          # dev image with rust toolchain + cargo-watch
├── docker-compose.yml      # dev stack (volume-mounted hot reload)
├── justfile                # task runner (just <target>)
├── .env.example            # template
├── .env                    # YOUR creds (gitignored)
├── migrations/             # sqlx migrations live here (NNNN_<name>.sql)
├── src/
│   ├── lib.rs              # AppState + router (used by main and tests)
│   ├── main.rs             # startup, worker, graceful shutdown
│   ├── config.rs           # env loading + validation
│   ├── db.rs               # sqlx Postgres pool init + migrate
│   ├── r2.rs               # Cloudflare R2 client (S3-compatible)
│   ├── auth/               # passwords, sessions, CSRF, /v1/auth routes
│   ├── error.rs            # AppError + IntoResponse
│   └── routes/
│       ├── mod.rs
│       └── health.rs       # GET /health (public — pings PG + R2)
├── scripts/                # test.sh, test-services.sh
└── tests/
    ├── common/mod.rs       # per-test database + real router harness
    └── health_test.rs
```

## Environment variables

| Var | Purpose | Required |
|---|---|---|
| `BIND_ADDR` | host:port to listen on | yes |
| `DATABASE_URL` | Postgres connection string (Neon pooler endpoint) | yes |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | yes |
| `R2_REGION` | always `auto` for R2 | optional (default `auto`) |
| `R2_BUCKET` | bucket name | yes |
| `R2_ACCESS_KEY_ID` | from Cloudflare → R2 → API Tokens | yes |
| `R2_SECRET_ACCESS_KEY` | from same place; shown once | yes |
| `RUST_LOG` | `tracing-subscriber` filter | optional |

## Auth model

Email and password accounts (argon2id). A successful sign-in sets an HttpOnly,
SameSite=Lax session cookie holding a random token; only its SHA-256 is stored
in `sessions`, so signing out or resetting a password ends sessions immediately.
State-changing requests must come from an origin in `ALLOWED_ORIGINS`. Every
resource is owned by one user and every query is scoped to the signed-in user;
`tests/isolation_test.rs` guards that. `/health` is public.

Data from the single-user desktop era belongs to a placeholder owner after the
tenancy migration. Move it to your account once you have signed up:

```bash
cargo run -- claim-legacy --email you@example.com
```

See `docs/decisions/` for why sessions are cookies rather than JWTs.

## Deployment options

| Target | When | How |
|---|---|---|
| Local Docker | dev iteration | `docker compose up` |
| Tailscale-only VPS (recommended) | personal use | Hetzner/Fly box, bind to `100.x.x.x:8787`, only your tailnet sees it |
| Public | standard | Bind `0.0.0.0` behind a TLS terminator (Caddy/nginx), set `TRUST_PROXY=true` and `COOKIE_SECURE=true`. |
| Localhost | air-gapped | API + desktop both on same machine, bind `127.0.0.1:8787` |

## Migrations

```bash
just migrate-new add_events_table   # creates a NNNN_add_events_table.{up,down}.sql pair
# edit the files
just migrate                        # apply
just migrate-revert                 # roll back the latest
```

Migrations run automatically at startup (`db::migrate` in `main.rs`). For schema
changes that need backfill / non-trivial coordination, run them manually with
`sqlx migrate run` against the Neon dev branch first.

## What's next

This is the Track 5 scaffold. Schema work (Track 6) and R2 routes (Track 7) live
in `TASKS.md`. Once those are in, the desktop app gets wired up in Track 9.
