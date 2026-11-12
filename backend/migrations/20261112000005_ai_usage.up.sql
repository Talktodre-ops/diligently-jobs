-- Append-only ledger of AI calls: what each user's work cost, and what the
-- platform spends per day (the daily cap reads it). Cost is integer
-- micro-dollars, never floating point.
create table ai_usage (
    id                    uuid        primary key default gen_random_uuid(),
    user_id               uuid        not null references users (id) on delete cascade,
    task                  text        not null,
    model                 text        not null,
    input_tokens          bigint      not null default 0,
    output_tokens         bigint      not null default 0,
    cache_read_tokens     bigint      not null default 0,
    cache_write_tokens    bigint      not null default 0,
    cost_micros           bigint      not null default 0,
    application_id        uuid,
    created_at            timestamptz not null default now()
);

create index ai_usage_user_created_idx on ai_usage (user_id, created_at desc);
create index ai_usage_created_idx on ai_usage (created_at);
