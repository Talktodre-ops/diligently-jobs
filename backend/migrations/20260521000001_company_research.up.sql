-- Company research briefs (Phase 3, M1).
--
-- One row per generated brief, hanging off an application. `brief` holds the
-- structured synthesis (mission, products, tech stack, recent news, culture,
-- why-them angle, talking points); `sources` is the list of cited URLs the
-- brief was built from. Newest row is the current brief for the application.
create table company_research (
    id              uuid        primary key default gen_random_uuid(),
    application_id  uuid        not null references applications(id) on delete cascade,
    brief           jsonb       not null,
    sources         jsonb       not null default '[]'::jsonb,
    created_at      timestamptz not null default now()
);

create index company_research_application_id_idx
    on company_research (application_id, created_at desc);
