-- Upwork proposals (Track 20).
--
-- Upwork postings have no "company" and are pasted like a JD. A proposal hangs
-- off an application row (one application per gig), mirroring company_research /
-- cover_letters: newest row = current proposal for the application.
--
-- `openers` holds the AIDA opener variants (the decisive Upwork first line); the
-- user picks one via `selected_opener`. `body` is the rest of the proposal
-- (Interest → Desire → Action). `projects` caches the related open-source repos
-- surfaced as proof/plan material. `strategy` + `proposal_length` record how it
-- was generated so a re-generate can reproduce the settings.
create table proposals (
    id               uuid        primary key default gen_random_uuid(),
    application_id   uuid        not null references applications(id) on delete cascade,
    openers          jsonb       not null default '[]'::jsonb,
    selected_opener  integer     not null default 0,
    body             text        not null,
    strategy         text        not null default 'aida',
    proposal_length  text        not null default 'short',
    angle            text,
    projects         jsonb       not null default '[]'::jsonb,
    created_at       timestamptz not null default now()
);

create index proposals_application_id_idx
    on proposals (application_id, created_at desc);
