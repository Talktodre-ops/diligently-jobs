-- Reverse of 20260511000001_initial_schema.up.sql.
-- Order matters: drop tables before the function they depend on, drop the
-- function before the extension we relied on. Use `if exists` so reverting a
-- partial migration doesn't error out.

drop trigger if exists chat_conversations_set_updated_at on chat_conversations;
drop trigger if exists applications_set_updated_at      on applications;
drop function if exists set_updated_at();

drop table if exists chat_conversations;
drop table if exists interviews;
drop table if exists cover_letters;
drop table if exists tailored_bullets;
drop table if exists gap_analyses;
drop table if exists cv_versions;
drop table if exists applications;
drop table if exists events;
