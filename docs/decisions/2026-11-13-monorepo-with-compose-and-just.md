---
date: 2026-11-13
status: accepted
tags: [build, tooling, dev-environment]
---

# One repository, held together by Compose and just, not Bazel

## Context

The repository now holds a Rust API (`backend/`), a Vite and React web app
(`web/`), browser tests (`e2e/`) and the desktop app (`diligent/`). Bazel was
raised as a way to keep them comfortable together.

## Decision

Each package keeps its own native tool: Cargo for the API, npm for the web
app and the browser tests. `compose.yaml` at the root runs everything for
development, each app in its own container with its source mounted and a
reloader running, so code changes never need a rebuild. A root `justfile`
gives one set of commands (`just up`, `just e2e`, `just check`).

## Why

Bazel pays off with many packages, shared libraries across languages, and
build times worth caching remotely. Here there are two apps that share no
code, only an HTTP contract. Bazel would replace Cargo and npm with
rules_rust and rules_js, hide cargo-watch and Vite's dev server behind
another layer, and make every dependency bump a Bazel change. That is a
large, permanent maintenance cost for no build-time win at this size.

## Rejected

- Bazel: see above. Worth revisiting if the repository grows to several
  services sharing generated code.
- npm workspaces or Turborepo across web and e2e: two packages with
  different lifecycles (the e2e package pins Playwright to its image) gain
  nothing from a shared lockfile.

## Consequences

The API contract is held by `docs/api.md`, the backend integration tests and
the browser tests, not by a shared type package. If drift becomes a problem,
generate TypeScript types from the Rust handlers rather than adopting Bazel.
