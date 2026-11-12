# Diligently decision journal

One decision per file, named `YYYY-MM-DD-<slug>.md`, with frontmatter (`date`,
`status`: proposed | accepted | superseded | deferred, `tags`) and the sections
Context, Decision, Why, Rejected and Revisit when. A changed decision is edited
in place or superseded by a new record that links back. Records are never
deleted. What went wrong, or nearly did, goes in `../lessons/`.

## Index

- [[2026-11-12-tests-run-on-local-services-only]]: per-test Postgres databases and an S3 emulator on localhost, never Neon or R2
- [[2026-11-12-opaque-cookie-sessions]]: random tokens in an HttpOnly cookie, hashed in Postgres; revocation is a row delete
- [[2026-11-12-tenancy-by-user-id]]: user_id on every row, composite keys to the parent, legacy data claimed explicitly
