---
date: 2026-11-12
status: accepted
tags: [ai, product, trust]
---

# Nothing reaches a tailored CV without the user's decision, and AI never invents numbers

## Context

The desktop tailoring prompt told the model it could add "plausible"
metrics to bullets because "the candidate will defend the specifics". The
hosted design (canvas, Review and Gaps screens) promises the opposite:
nothing is added to your CV unless you confirm it, and every rewrite says
where its facts came from. A hosted product also answers for what it
writes in thousands of CVs, not one.

## Decision

- The tailored CV is composed from the master CV version the application
  started from plus the user's decisions only: accepted or edited rewrites,
  an accepted summary, accepted gap bullets. Pending proposals change
  nothing, and the master CV is never edited by tailoring.
- Generated rewrites, summaries, gap bullets and letters may not contain a
  number absent from their sources (the CV, the user's own words, the job,
  the research). This is checked in code after the model answers; a
  failing rewrite is discarded, a failing letter is refused. When a metric
  would help, the model flags `needs_number` and says what to measure.
- "I have this" turns only the user's words into a bullet. "I don't"
  becomes a note that stops the letter from claiming the skill.

## Why

Trust is the product. A recruiter who catches one invented number stops
believing the rest, and the user carries that risk, not us. Checking in
code rather than relying on the prompt means a model slip cannot reach a
recruiter. The live run (2026-11-12) showed the cost is low: rewrites kept
the real figures and still read as tailored, and the letter addressed gaps
honestly.

## Rejected

- Plausible invented metrics (the desktop behaviour): fabrication on the
  user's behalf.
- Applying all rewrites by default and letting users undo: the CV would
  contain AI text the user never read.

## Revisit when

Users ask for help estimating numbers they do not have; then build an
explicit "help me quantify this" flow where the user supplies the figure.
