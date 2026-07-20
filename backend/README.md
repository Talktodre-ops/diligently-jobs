# Diligently — backend

Rust + Axum + sqlx + Postgres (Neon) + R2. Single-user audit-log service that the
desktop client and any companion devices write to. Bearer-token auth, presigned
R2 URLs for blobs, append-only `events` table as the spine.

## Quickstart

```bash
# 1. Set up .env from the template
cp .env.example .env
# (fill in DATABASE_URL, R2_*, generate BEARER_TOKEN)

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

## Smoke test

```bash
# Server must be running
just smoke
# or: cargo test -- --ignored --nocapture
```

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
│   ├── main.rs             # axum router + startup
│   ├── config.rs           # env loading + validation
│   ├── db.rs               # sqlx Postgres pool init + migrate
│   ├── r2.rs               # Cloudflare R2 client (S3-compatible)
│   ├── auth.rs             # bearer-token Tower middleware
│   ├── error.rs            # AppError + IntoResponse
│   └── routes/
│       ├── mod.rs
│       └── health.rs       # GET /health (public — pings PG + R2)
└── tests/
    └── health_test.rs      # #[ignore]-marked integration tests
```

## Environment variables

| Var | Purpose | Required |
|---|---|---|
| `BIND_ADDR` | host:port to listen on | yes |
| `BEARER_TOKEN` | shared secret with the desktop app | yes |
| `DATABASE_URL` | Postgres connection string (Neon pooler endpoint) | yes |
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | yes |
| `R2_REGION` | always `auto` for R2 | optional (default `auto`) |
| `R2_BUCKET` | bucket name | yes |
| `R2_ACCESS_KEY_ID` | from Cloudflare → R2 → API Tokens | yes |
| `R2_SECRET_ACCESS_KEY` | from same place; shown once | yes |
| `RUST_LOG` | `tracing-subscriber` filter | optional |

## Auth model

Single user, single shared secret. Every request to a protected route must carry:

```
Authorization: Bearer <BEARER_TOKEN>
```

Compared in constant time (`subtle::ConstantTimeEq`) to avoid timing-leak side-channels.
`/health` is public — deployment platforms (Tailscale, Fly, k8s) can probe it without
holding the secret.

To rotate: regenerate `BEARER_TOKEN`, redeploy backend, rebuild the desktop app
with the matching value, reinstall.

## Deployment options

| Target | When | How |
|---|---|---|
| Local Docker | dev iteration | `docker compose up` |
| Tailscale-only VPS (recommended) | personal use | Hetzner/Fly box, bind to `100.x.x.x:8787`, only your tailnet sees it |
| Public + bearer | quick & dirty | Bind `0.0.0.0`, rely on bearer + TLS terminator (Caddy/nginx). Higher attack surface. |
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
