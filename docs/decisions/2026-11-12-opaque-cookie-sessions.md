---
date: 2026-11-12
status: accepted
tags: [auth, security]
---

# Opaque server-side sessions in a cookie, not JWTs

## Context

Diligently becomes a hosted multi-user web app. The production-auth skill
describes dual-transport JWTs with refresh rotation, a JTI blacklist and a
per-user watermark, built for a Django API serving browsers and mobile apps
across origins. Diligently has one Rust service and one web app, served from
the same origin, and no mobile client.

## Decision

Sessions are random 32-byte tokens in an HttpOnly, SameSite=Lax cookie
(`dl_session`, Secure in production). Only the SHA-256 is stored, in a
`sessions` row with a sliding 30-day expiry and a 90-day absolute cap. Every
authenticated request looks the row up. Unsafe requests must carry an Origin
or Referer from ALLOWED_ORIGINS. Passwords use argon2id. Email links use the
same random-token scheme, single-use, claimed with one conditional UPDATE.

## Why

Revocation is a row delete that takes effect on the next request, which
gives sign-out, "sign out other devices" and reset-kills-sessions with no
blacklist or watermark. The JWT benefit, validation without a database read,
does not matter when every request reads the database anyway. Random
32-byte link tokens remove the brute-force problem the skill flags for
6-digit email codes.

## Rejected

- JWT access plus refresh rotation: more moving parts (rotation, replay
  cascade, blacklist) for a benefit this app does not need.
- Tokens in localStorage: readable by any script, so one XSS leaks sessions.
- 6-digit verification codes: brute-forceable unless capped per code; a link
  is also easier to use on a phone.

## Revisit when

A native mobile client or a third-party API needs bearer tokens, or the
session lookup shows up in latency profiles.
