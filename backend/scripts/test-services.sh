#!/usr/bin/env bash
# Local services for the test suite: a throwaway Postgres and an S3-compatible
# store (SeaweedFS). Both bind to 127.0.0.1 only and keep data in tmpfs, so
# nothing persists and the suite never touches the real database or bucket.
#
#   scripts/test-services.sh up     start (or reuse) both containers
#   scripts/test-services.sh down   stop and remove them
#   scripts/test-services.sh status
set -euo pipefail

PG_NAME=diligently-test-pg
PG_PORT=55432
S3_NAME=diligently-test-s3
S3_PORT=59000

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }
exists() { docker inspect "$1" >/dev/null 2>&1; }

up() {
  if ! running "$PG_NAME"; then
    exists "$PG_NAME" && docker rm -f "$PG_NAME" >/dev/null
    docker run -d --name "$PG_NAME" \
      -e POSTGRES_USER=diligently -e POSTGRES_PASSWORD=diligently -e POSTGRES_DB=diligently \
      -p "127.0.0.1:${PG_PORT}:5432" --tmpfs /var/lib/postgresql/data \
      postgres:16-alpine -c fsync=off -c synchronous_commit=off -c full_page_writes=off \
      -c max_connections=300 >/dev/null
  fi
  if ! running "$S3_NAME"; then
    exists "$S3_NAME" && docker rm -f "$S3_NAME" >/dev/null
    docker run -d --name "$S3_NAME" -p "127.0.0.1:${S3_PORT}:8333" --tmpfs /data \
      chrislusf/seaweedfs:latest server -dir=/data -s3 -master.volumeSizeLimitMB=64 >/dev/null
  fi
  for _ in $(seq 1 60); do
    if docker exec "$PG_NAME" pg_isready -U diligently -q 2>/dev/null \
      && curl -s -o /dev/null "http://127.0.0.1:${S3_PORT}/"; then
      echo "test services ready (postgres :${PG_PORT}, s3 :${S3_PORT})"
      return 0
    fi
    sleep 1
  done
  echo "test services did not become ready" >&2
  exit 1
}

down() { docker rm -f "$PG_NAME" "$S3_NAME" >/dev/null 2>&1 || true; echo "test services removed"; }

status() { docker ps --filter "name=diligently-test-" --format '{{.Names}}\t{{.Status}}'; }

case "${1:-up}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
