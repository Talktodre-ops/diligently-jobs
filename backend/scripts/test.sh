#!/usr/bin/env bash
# Run the backend test suite against the local test services only.
# Explicit env here wins over backend/.env, which points at the real database.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/test-services.sh up >/dev/null

# Drop per-test databases left behind by a test that panicked during setup.
docker exec diligently-test-pg psql -U diligently -d diligently -tAc \
  "select datname from pg_database where datname ~ '^t_[0-9a-f]{32}$'" \
  | while read -r db; do
      [ -n "$db" ] && docker exec diligently-test-pg psql -U diligently -d diligently -qc \
        "drop database if exists \"$db\" with (force)" >/dev/null
    done

export TEST_DATABASE_URL="postgres://diligently:diligently@127.0.0.1:55432/diligently"
export TEST_S3_ENDPOINT="http://127.0.0.1:59000"
export DATABASE_URL="$TEST_DATABASE_URL"
unset R2_ENDPOINT R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY LLM_API_KEY ANTHROPIC_API_KEY TAVILY_API_KEY RESEND_API_KEY || true

# Render tests compile real PDFs. Use the pinned Tectonic in tools/ (gitignored),
# fetching it once if missing. Same version and URL as the Dockerfile.
TECTONIC_VERSION=0.15.0
if [ ! -x tools/tectonic ]; then
  mkdir -p tools
  curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
    | tar -xz -C tools tectonic
fi
export TECTONIC_BIN="$PWD/tools/tectonic"

cargo test "$@"
