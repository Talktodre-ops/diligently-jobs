# Diligently API

Reference for the web app. Paths are relative to the API origin. Every body is
JSON unless noted. The integration tests in `backend/tests/` exercise every
endpoint listed here and are the executable version of this document.

## Conventions

**Sessions.** Signing up, signing in and resetting a password set an HttpOnly
`dl_session` cookie. Send requests with credentials (`fetch(..., { credentials:
"include" })`). JavaScript never sees the token. A request without a valid
session gets `401 unauthorized`.

**Verified email.** Endpoints marked *verified* spend AI or upload files and
answer `403 email_not_verified` until the user has confirmed their email.

**Origin.** POST, PUT, PATCH and DELETE must come from an origin listed in
`ALLOWED_ORIGINS` (default `APP_BASE_URL`). Browsers send it automatically.
Anything else gets `403 origin_not_allowed`.

**Errors.** Every failure has the same shape:

```json
{ "error": { "code": "invalid_input", "message": "Use at least 10 characters", "field": "password" } }
```

Branch on `code`; show `message`; `field` names the input when there is one.

| Status | code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed JSON, wrong types, bad id in the path |
| 401 | `unauthorized` | No session, or it ended |
| 403 | `email_not_verified`, `origin_not_allowed` | Not allowed |
| 404 | `not_found` | Missing, or belongs to someone else (never distinguished) |
| 409 | `email_taken`, `pipeline_not_failed` | Conflicts with current state |
| 413 | `too_large` | JSON body over 1 MiB |
| 422 | `invalid_input` (with `field`), `token_invalid`, `no_master_cv`, `plan_limit_reached`, `ai_declined`, `link_unreadable`, `no_letter`, `no_summary`, `no_suggestion`, `company_unknown`, `nothing_found` | Understood but cannot be done |
| 429 | `rate_limited` | Slow down; see `Retry-After` |
| 503 | `ai_unavailable`, `ai_failed`, `web_failed`, `timeout` | A dependency is down or paused; try again |

**Polling.** Long work runs as a background job. The response carries a
`job_id`; poll `GET /v1/jobs/{id}` every second or two until `status` is `done`
or `failed`.

**Ids** are UUIDs. Timestamps are RFC 3339 in UTC.

## Accounts (Welcome, Sign up, Verify email, Sign in, Settings)

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/auth/signup` | `{ email, password }` | `201 { user }`, sets cookie, sends a verification email |
| `POST /v1/auth/signin` | `{ email, password }` | `200 { user }`, sets cookie. Wrong email or password share one 401 |
| `POST /v1/auth/signout` | none | `204`, clears cookie |
| `GET /v1/auth/me` | | `{ user }` |
| `POST /v1/auth/verify` | `{ token }` from the email link | `{ ok: true }`. Works without a session |
| `POST /v1/auth/resend-verification` | none | `202 { ok: true }` |
| `POST /v1/auth/forgot-password` | `{ email }` | `202 { ok: true }` whether or not the account exists |
| `POST /v1/auth/reset-password` | `{ token, password }` | `{ user }`, signs this device in and every other device out |
| `POST /v1/auth/change-password` | `{ current_password, new_password }` | `{ ok: true }`, other devices signed out |
| `POST /v1/auth/change-email` | `{ new_email, password }` | `202`; nothing changes until the new address confirms |
| `POST /v1/auth/confirm-email` | `{ token }` | `{ ok: true }` |
| `GET /v1/auth/sessions` | | `{ sessions: [{ id, user_agent, ip, created_at, last_seen_at, current }] }` |
| `DELETE /v1/auth/sessions/{id}` | | `204` |
| `POST /v1/auth/sessions/revoke-others` | none | `{ revoked: n }` |

`user` is `{ id, email, email_verified, plan, created_at }`. Passwords are 10 to
128 characters and may not equal the email. Email links point at
`APP_BASE_URL` + `/verify-email?token=`, `/reset-password?token=` and
`/confirm-email?token=`; the web app posts the token back.

## Profile and settings (Onboarding targets, Profile, Settings)

`GET /v1/profile` and `PATCH /v1/profile` return `{ profile }`:

```json
{ "full_name": "Ada Okafor", "headline": "Senior Backend Engineer", "location": "Lagos",
  "target_roles": ["Backend Engineer"], "work_settings": ["remote", "hybrid"],
  "paper_size": "a4", "theme": "system",
  "notifications": { "follow_ups": true, "interview_prep": true, "product_news": false },
  "onboarding_step": "check", "updated_at": "..." }
```

PATCH changes only the fields sent; an empty string clears a text field.
`paper_size` is `a4` or `letter`; `theme` is `system`, `light` or `dark`;
`work_settings` items are `remote`, `hybrid`, `onsite`; `onboarding_step` is
`upload`, `check`, `targets` or `done`. Unknown fields are refused.

`GET /v1/usage` (Settings plan card): `{ plan, applications_this_month, monthly_limit, resets_on }`.

## Master CV and upload (Onboarding upload and check, Profile)

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/cv/upload` *verified* | multipart, one `file` field, PDF or DOCX up to 5 MB | `202 { upload, job_id }` |
| `GET /v1/cv/uploads/{id}` | | `{ upload: { id, filename, kind, status, error, cv_version_id, ... } }`; `status` is `queued`, `reading`, `done` or `failed` |
| `GET /v1/cv/master` | | `{ cv: { id, doc, issues, updated_at } }` or `422 no_master_cv` |
| `PUT /v1/cv/master` | `{ doc }` | same as GET; saves a new version |

`doc` is the ResumeDoc used everywhere a CV appears:

```json
{ "header": { "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com",
              "phone": null, "linkedin": { "url": "https://linkedin.com/in/ada", "display": "linkedin.com/in/ada" },
              "github": null, "website": null },
  "summary": "...",
  "experience": [{ "role": "...", "company": "...", "location": null, "start": "2021", "end": "Present", "bullets": ["..."] }],
  "education": [{ "institution": "...", "location": null, "degree": "...", "start": null, "end": null }],
  "skills": [{ "label": "Languages", "items": ["Go", "Rust"] }],
  "projects": [{ "name": null, "description": "...", "link": null }] }
```

`issues` (Check screen) is `[{ path: "experience[1]", message: "Dates are missing for Kestrel." }]`.
After a successful upload the profile moves to `onboarding_step: "check"`.

## New job and Running

`POST /v1/applications/start` *verified*

```json
{ "jd_text": "the full posting (200 to 30,000 characters)", "research": true, "letter": true }
```

or `{ "url": "https://..." }` instead of `jd_text`. Needs a master CV and room in
the monthly plan limit. Response `202 { application_id, job_id, progress }`.

`GET /v1/jobs/{id}` returns `{ id, kind, status, result, attempts, max_attempts, progress }`.
For the pipeline, `progress` is the Running screen:

```json
[ { "key": "read_job", "label": "Reading the job", "status": "done" },
  { "key": "compare", "label": "Comparing it with your CV", "status": "running" },
  { "key": "rewrite", "label": "Rewriting your strongest bullets", "status": "pending" },
  { "key": "research", "label": "Researching the company", "status": "pending" },
  { "key": "letter", "label": "Drafting your cover letter", "status": "skipped" } ]
```

Step status is `pending`, `running`, `done`, `skipped` or `failed`. A failed
pipeline retries once on its own; after that `POST /v1/applications/{id}/pipeline/retry`
*verified* queues it again and returns `{ job_id, progress }`.

## Workspace

`GET /v1/applications/{id}/brief`:

```json
{ "application": { "id": "...", "company": "Halcyon Health", "role": "Senior Backend Engineer",
                   "status": "draft", "source_url": null, "location": "Remote", "summary": "...", "created_at": "..." },
  "pipeline": { "job_id": "...", "status": "done", "progress": [] },
  "score": { "before": 72, "projected": 86, "current": 78, "rescored": null, "decided": 1, "pending": 2 },
  "rewrites": { "total": 2, "pending": 1, "accepted": 1, "kept": 0, "edited": 0 },
  "summary": { "proposed": true, "status": "pending" },
  "gaps": { "total": 3, "missing": 2, "partial": 0, "unanswered": 2, "top": ["GraphQL API design"] },
  "research": { "overview": "...", "talking_points": 3 },
  "letter": { "id": "...", "tone": "direct", "words": 240 } }
```

`score.current` moves from `before` toward `projected` as proposals are
accepted. `research` and `letter` are null until they exist.

## Review

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/applications/{id}/rewrites` | | `{ summary: { original, proposed, status } or null, rewrites: [...], score }` |
| `PATCH /v1/rewrites/{id}` | `{ action: "accept" }`, `{ action: "keep" }` or `{ action: "edit", text }` | `{ rewrite, score }` |
| `PATCH /v1/applications/{id}/summary` | same actions | `{ score }` |
| `POST /v1/applications/{id}/rescore` *verified* | none | `202 { job_id, cv_version_id }`; the brief's `score.rescored` fills in when done |

A rewrite is `{ id, bullet_id, section, original, rewrite, why, needs_number, status, final_text }`.
`needs_number: true` means the rewrite would be stronger with a figure the CV
does not have; show `why` as the hint. `status` is `pending`, `accepted`, `kept`
or `edited`.

## Gaps

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/applications/{id}/gaps` | | `{ gaps: [...] }` |
| `POST /v1/gaps/{id}/answer` *verified* | `{ have: true, text, entry: 0 }` or `{ have: false, text? }` | `{ gap, note? }` |
| `PATCH /v1/gaps/{id}` | `{ bullet: "accept" }` or `{ bullet: "discard" }` | `{ gap }` |

A gap is `{ id, requirement, importance, status, evidence, ask, answer, answer_text, suggested_bullet, bullet_status, target_entry }`.
`status` is `covered`, `partial` or `missing`; show `ask` as the question.
`entry` is the experience index the new bullet belongs to. When `have: true`
does not yield a usable bullet, `note` says what to add.

## Research and cover letter

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/applications/{id}/research` | | `{ id, brief, sources, created_at }` |
| `POST /v1/applications/{id}/research/refresh` *verified* | none | same; runs inline (a few seconds) |
| `GET /v1/applications/{id}/cover-letters` | | newest letter |
| `POST /v1/applications/{id}/cover-letters/regenerate` *verified* | `{ tone: "direct" or "warm" or "formal" }` | new letter; runs inline |
| `PATCH /v1/cover-letters/{id}` | `{ paragraphs: ["...", "..."] }` | updated letter |

`brief` is `{ overview, products, recent_news: [{ text, source }], culture, talking_points: [{ text, source }], why_them }`;
`source` is a 1-based index into `sources` (`[{ title, url, snippet, published }]`).
A letter is `{ id, application_id, body, doc, tone, r2_pdf_key, r2_docx_key, generated_at }`;
`doc.paragraphs` holds the body.

## CV preview, Send and Documents

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/applications/{id}/cv` | | `{ doc, issues, paper_size }` for the Read view |
| `POST /v1/applications/{id}/render` | `{ include_letter: true }` | `202 { cv_version_id, cv_job_id, letter_job_id }` |
| `GET /v1/applications/{id}/files` | | `{ cv: { pdf_url, docx_url, rendered_at, up_to_date }, letter: { pdf_url, docx_url }, expires_in_seconds }` |
| `GET /v1/documents?kind=cv` | `kind` is `all`, `cv` or `letter` | `{ documents: [...] }` |

File URLs are presigned and last ten minutes; fetch them fresh before showing a
download or share sheet. `up_to_date: false` means decisions changed since the
last render. The Page view is the PDF from `pdf_url`.

## Tracking (Send confirm, Jobs, Follow-up)

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/applications/{id}/applied` | `{ reminder_days: 7 }` (1 to 30, or null for none) | `{ application_id, stage, reminder }` |
| `PATCH /v1/applications/{id}/stage` | `{ stage }`: `saved`, `applied`, `interviewing`, `offer`, `closed` | `{ application_id, stage }` |
| `GET /v1/applications?stage=applied` | | list of applications |
| `GET /v1/applications/stages` | | `{ stages: { saved: 2, applied: 5, ... } }` |
| `GET /v1/applications/{id}/follow-ups` | | `{ drafts: { email, linkedin }, reminder }` |
| `POST /v1/applications/{id}/follow-ups` *verified* | `{ channel: "email" or "linkedin" }` | `{ draft: { id, channel, subject, body, created_at } }` |
| `POST /v1/reminders/{id}/snooze` | `{ days }` (1 to 14) | `{ reminder }` |
| `POST /v1/reminders/{id}/done` | none | `{ reminder }` |

Drafts address the reader as `{name}` for the user to fill in. When a reminder
falls due, the server drafts the email follow-up and, if the user has follow-up
reminders on, emails them.

## Home

`GET /v1/home`:

```json
{ "first_name": "Ada",
  "needs_you": [ { "type": "follow_up", "application_id": "...", "reminder_id": "...", "company": "Halcyon Health",
                   "role": "...", "due_at": "...", "text": "Follow up with Halcyon Health" } ],
  "this_week": [ { "at": "...", "kind": "applied", "application_id": "...", "company": "Halcyon Health", "text": "Applied to Halcyon Health" } ],
  "stats": { "applied_this_week": 1, "active": 3, "interviewing": 1 } }
```

Card `type` is `follow_up`, `retry`, `review` (with `pending`) or `prepare`.

## Account (Settings)

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/account/export` | | JSON file download of everything the user owns, with hour-long file links |
| `DELETE /v1/account` | `{ password }` | `204`; deletes every row and file, clears the cookie |

## Older endpoints

These predate the hosted app and stay for the data they hold. All are
user-scoped. The web app should prefer the endpoints above.

`/v1/events` (GET, POST), `/v1/applications` (POST creates a bare
application), `/v1/applications/{id}` (GET, PATCH), `/v1/applications/{id}/timeline`,
`/v1/applications/{id}/ats-score` (GET, POST), `/v1/cv-versions` (GET, POST),
`/v1/cv-versions/{id}` (GET), `/v1/cv-versions/{id}/render`,
`/v1/cover-letters/{id}/render`, `/v1/interviews` (GET, POST),
`/v1/interviews/{id}` (GET, PATCH), `/v1/blobs/presign-download`.

## Health

`GET /health` (no session): `{ status: "ok" or "degraded", postgres: { ok }, r2: { ok } }`.
