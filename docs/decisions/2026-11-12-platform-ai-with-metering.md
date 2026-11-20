---
date: 2026-11-12
status: accepted
tags: [ai, cost, billing]
---

# AI runs on the platform's keys, metered per call

## Context

The desktop app called Claude with each user's own key. The hosted product
moves AI server-side. Someone pays for every token, and no billing provider
has been chosen yet.

## Decision

The server calls Claude (Messages API over HTTPS, structured JSON output) and
Tavily with the platform's keys. Every AI call goes through `usage::call`,
which refuses when `AI_DISABLED` is set, when today's platform spend has
reached `AI_DAILY_SPEND_CAP_USD`, or when one user exceeds 40 calls in ten
minutes, and otherwise records tokens and cost in micro-dollars in
`ai_usage`. Plans are data: `users.plan` plus `PLAN_LIMITS` (applications
per calendar month). The model comes from `ANTHROPIC_MODEL`. Server-side
refusal fallbacks are on, so a classifier decline is retried on another
model inside the same call.

## Why

Users should not need an Anthropic account to apply for a job. A ledger per
call answers "what does one application cost" before any price is set, and
the kill switch and daily cap bound the worst case while there is no
billing. Limiting applications rather than tokens matches what users see on
the Settings screen.

## Rejected

- Bring your own key: friction at sign-up, and support for every key
  problem.
- Per-user token budgets: invisible to users and hard to explain.
- Choosing a billing provider now: deferred until the cost per application
  is measured.

## Revisit when

Cost per application is measured on real traffic, a billing provider is
chosen, or a cheaper model holds quality on the extraction prompts.
