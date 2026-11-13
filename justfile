# Diligently: one entry point for the whole repository.
# Run `just` to list recipes. Backend-only recipes live in backend/justfile.

default:
    @just --list

# Start the dev stack (db, s3, api, web) in the background
up:
    mkdir -p backend/.outbox
    docker compose up -d

# Stop the dev stack (data stays in named volumes)
down:
    docker compose down

# Follow logs: `just logs` or `just logs api`
logs *services:
    docker compose logs -f {{services}}

# Use Neon and R2 from backend/.env instead of the local db and s3
up-neon:
    docker compose -f compose.yaml -f compose.neon.yaml up -d api

# Rebuild images after a Dockerfile change
rebuild:
    docker compose build api
    docker compose --profile e2e build e2e
    docker compose up -d

# Browser tests in Microsoft Edge: `just e2e`, or `just e2e tests/auth.spec.ts --project=mobile`
e2e *args:
    mkdir -p backend/.outbox
    docker compose run --rm e2e npx playwright test {{args}}

# Every check that gates a commit: backend fmt, clippy, tests; web types, lint, unit tests
check:
    cd backend && cargo fmt --check && cargo clippy --all-targets -- -D warnings && scripts/test.sh
    docker compose exec -T web sh -c "npx tsc --noEmit && npx eslint . && npx vitest run"
    cd e2e && npx tsc --noEmit

# Web checks only (runs in the web container)
check-web:
    docker compose exec -T web sh -c "npx tsc --noEmit && npx eslint . && npx vitest run"

# A verified, onboarded local account: `just seed you@example.com "a long password"`
seed email password:
    docker compose exec -T api cargo run -q --bin diligently-api -- dev-seed --email {{email}} --password "{{password}}"

# psql into the local dev database
psql:
    docker compose exec db psql -U diligently diligently
