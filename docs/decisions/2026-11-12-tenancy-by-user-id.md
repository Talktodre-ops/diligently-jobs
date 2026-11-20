---
date: 2026-11-12
status: accepted
tags: [tenancy, security, database]
---

# Every row carries its owner, and the database checks the links

## Context

The backend was single-user: one shared bearer token, no owner columns.
Hosting it for many users means one user must never see or touch another's
applications, CVs, letters, research, scores, interviews, jobs or files. The
multi-tenant skill puts the boundary in the query filter, with database
policies as a backstop. Diligently has no organisations, so the tenant is the
user.

## Decision

Every user-owned table has `user_id not null references users on delete
cascade`. Handlers take `CurrentUser` and filter every query by it; attaching
to an application checks ownership first and answers 404. Rows that hang off
an application also have a composite foreign key to `applications (id,
user_id)` (and scores to `cv_versions (id, user_id)`), cascading on delete and
update. Jobs record their owner and workers scope by it. Files live under
`u/{user_id}/` and presigned URLs are only signed for the caller's prefix.

Existing rows are assigned to a password-less `legacy@diligently.local`
owner, created only when data exists. `diligently-api claim-legacy --email`
moves them to a real account in one transaction.

`tests/isolation_test.rs` is the regression gate. Removing any one ownership
filter turned it red before it was committed.

## Why

Denormalising `user_id` onto child rows makes every query a single indexed
filter, makes account deletion a cascade, and gives row-level security a
column to key on later. The composite keys turn "a handler forgot the
ownership check on insert" from a silent cross-user link into a constraint
error. 404 rather than 403 for other users' ids avoids confirming they exist.

The placeholder owner lets the migration add `not null` in one step on a
database that already has data, without guessing which account is Dre's.

## Rejected

- Scoping children only through a join to `applications`: every query needs
  the join, and nothing stops an insert that links to another user's row.
- Nullable `user_id` with a later tightening migration: two deploys and a
  window where unowned rows are visible to nobody or, worse, everybody.
- Assigning legacy rows to the first account that signs up: that guesses,
  which is the exact bug class the multi-tenant skill warns about.

## Revisit when

Shared workspaces or teams arrive (the tenant stops being the user), or
row-level security is added on top (P7.3 of the build plan).
