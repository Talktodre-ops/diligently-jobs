---
date: 2026-11-12
status: accepted
tags: [testing, database, storage]
---

# Tests run on local services only

## Context

The backend's only data lives on a Neon Postgres database and an R2 bucket, and
`backend/.env` points at both. The old smoke test was an ignored probe against a
running server, so nothing exercised handlers against a real database. The
hosted product needs integration tests for auth and tenant isolation on every
change.

## Decision

`scripts/test-services.sh` runs a throwaway Postgres (postgres:16-alpine) and a
SeaweedFS S3 emulator, both bound to 127.0.0.1 with tmpfs storage.
`scripts/test.sh` exports explicit test env, which wins over `backend/.env`, and
runs `cargo test`. The harness in `backend/tests/common` creates a fresh migrated
database per test, builds the real router from the lib crate, drops the database
on teardown, and panics if either URL is not localhost. CI runs the same script.

## Why

A per-test database makes tests independent and safe to run in parallel without
transaction tricks, and Postgres creates one in milliseconds. The localhost guard
is in the harness itself rather than in a wrapper script, so running `cargo test`
by hand with the wrong env fails loudly instead of migrating Neon.

## Rejected

- `#[sqlx::test]`: it reads `DATABASE_URL`, the same variable that points at
  Neon, so one forgotten export would create and migrate databases there.
- MinIO: the Docker Hub and quay.io images are no longer pullable anonymously.
  SeaweedFS speaks the same S3 API, including presigned URLs.
- A filesystem stand-in for storage: it would leave the S3 code path untested.

## Revisit when

The suite gets slow enough that per-test databases dominate (switch to a
template database cloned per test), or storage moves off the S3 API.
