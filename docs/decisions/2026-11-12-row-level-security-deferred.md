---
date: 2026-11-12
status: deferred
tags: [tenancy, security, database]
---

# Row-level security is deferred; three other layers hold the line

## Context

The multi-tenant skill recommends Postgres row-level security as a backstop
under application-level scoping. RLS only works when every query runs as a
role that cannot bypass policies and inside a transaction that has set the
current user (`set_config('app.user_id', ..., true)`); otherwise the
policies are silently inert. Behind Neon's pooler (transaction mode) the
setting must be transaction-local.

## Decision

Not now. Isolation rests on three layers instead:

1. Every query filters by the signed-in user, and handlers take the user
   only from the session.
2. The schema refuses cross-user links: rows that hang off an application
   or CV carry composite foreign keys to (id, user_id), and every owned row
   cascades from its user.
3. `tests/isolation_test.rs` (every resource route) plus per-feature
   isolation tests, and `tests/account_test.rs`, which finds every table
   with a user_id and proves deletion leaves nothing. Removing any single
   ownership filter turned the gate red before it was committed.

## Why

The code runs roughly a hundred queries directly on the shared pool, and
the worker has paths that legitimately act across users (the reminder
sweep, the job queue, account deletion). Retrofitting RLS means routing
all of it through a per-request transaction with the user set, and giving
the worker a separate bypass role. Done in one pass, that is the fragile
change the skill warns about: one query left on the plain pool would fail
in production or, worse, a misconfigured role would make the policies
inert while looking enabled.

## Rejected

- RLS on a subset of tables: a false sense of coverage.
- RLS with the app role as table owner: owners bypass policies, so it
  would do nothing.

## Revisit when

Before opening sign-ups beyond a private beta, or when a second service
or a reporting tool gets database access. The path: a `UserTx` executor
that begins a transaction and sets `app.user_id`; handlers take it
instead of the pool; a `diligently_app` role without BYPASSRLS for the
API and a `diligently_worker` role for cross-user work; policies
`using (user_id = current_setting('app.user_id')::uuid)` on every owned
table; and an isolation test that runs a raw unscoped select as the app
role and expects zero rows.
