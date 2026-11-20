-- A running job's worker stamps heartbeat_at every few seconds. A running row
-- whose stamp has gone stale lost its worker (a restart, a deploy, a crash)
-- and is put back in the queue by the periodic sweep, instead of waiting for
-- the next boot.
alter table jobs add column heartbeat_at timestamptz;
