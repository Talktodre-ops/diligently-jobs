#!/usr/bin/env bash
# Run the API on 127.0.0.1:8787 against the local test services only (never
# the database or bucket in backend/.env). Uses a database `diligently_dev`
# and a bucket `diligently-dev`, created if missing. AI keys are read from
# KEYS_ENV_FILE (default: the desktop app's env file) without printing them.
#
#   scripts/dev-local.sh              start (foreground), log to stdout
#   DEV_RESET=1 scripts/dev-local.sh  drop and recreate diligently_dev first
set -euo pipefail
cd "$(dirname "$0")/.."
BACKEND="$PWD"
KEYS_ENV_FILE="${KEYS_ENV_FILE:-$BACKEND/../diligent/src-tauri/.env}"

scripts/test-services.sh up >/dev/null
if [ "${DEV_RESET:-0}" = "1" ]; then
  docker exec diligently-test-pg psql -U diligently -qc "drop database if exists diligently_dev with (force)"
fi
docker exec diligently-test-pg psql -U diligently -tAc "select 1 from pg_database where datname = 'diligently_dev'" | grep -q 1 \
  || docker exec diligently-test-pg psql -U diligently -qc "create database diligently_dev"
curl -s -o /dev/null -X PUT http://127.0.0.1:59000/diligently-dev

if ss -ltn 2>/dev/null | grep -q ':8787 '; then
  echo "something already listens on 8787; use it or stop it first" >&2
  exit 1
fi
[ -x target/release/diligently-api ] || cargo build --release

ANTHROPIC_API_KEY=""; ANTHROPIC_MODEL=""; TAVILY_API_KEY=""
if [ -f "$KEYS_ENV_FILE" ]; then
  set -a
  eval "$(grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_MODEL|TAVILY_API_KEY)=' "$KEYS_ENV_FILE")"
  set +a
fi

# Run from /tmp so dotenvy cannot pick up backend/.env.
cd /tmp
exec env -i PATH="$PATH" HOME="$HOME" \
  BIND_ADDR=127.0.0.1:8787 \
  DATABASE_URL=postgres://diligently:diligently@127.0.0.1:55432/diligently_dev \
  R2_ENDPOINT=http://127.0.0.1:59000 R2_REGION=us-east-1 R2_BUCKET=diligently-dev \
  R2_ACCESS_KEY_ID=dev R2_SECRET_ACCESS_KEY=dev \
  APP_BASE_URL=http://localhost:5173 COOKIE_SECURE=false \
  TECTONIC_BIN="$BACKEND/tools/tectonic" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" ANTHROPIC_MODEL="$ANTHROPIC_MODEL" TAVILY_API_KEY="$TAVILY_API_KEY" \
  RUST_LOG="${RUST_LOG:-diligently_api=info,tower_http=warn}" \
  "$BACKEND/target/release/diligently-api"
