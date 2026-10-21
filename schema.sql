-- ============================================================================
--  Shikaku: Puzzle Quest — Supabase schema
--  Run this in your Supabase project: SQL Editor → New query → paste → Run.
--  Project: https://lxhjfdxowpxzrybxdasi.supabase.co
--
--  Auth model: lightweight "username only" (no passwords). A player's id is
--  derived from their case-insensitive username, so one name = one row.
--
--  Access model: this project is SHARED with other apps. Tables are
--  READ-ONLY for the public (anon) key; all game writes go through validated
--  SECURITY DEFINER functions defined in
--  supabase/migrations/20261017120000_shikaku_secure_write_rpcs.sql
--  (shikaku_save_profile, shikaku_save_score, shikaku_track).
--  Do NOT re-add public insert/update/delete policies — another app on this
--  project removed them deliberately (worldcup_function_security_hardening).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Profiles: one row per player. Drives the leaderboard.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key,                 -- device player_id
  username     text not null,
  avatar       text not null default '🎮',
  theme        text not null default 'neon',
  accent       text,                             -- custom accent hex, nullable
  total_score  integer not null default 0,       -- sum of best level scores
  best_world   integer not null default 0,       -- furthest world reached
  wins         integer not null default 0,       -- multiplayer wins
  losses       integer not null default 0,       -- multiplayer losses
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Scores: history of solved levels (powers per-level leaderboards / stats).
-- One best row per (player, world, level) thanks to the unique index + upsert.
-- ---------------------------------------------------------------------------
create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  player_id   uuid not null,
  username    text not null,
  world       integer not null,
  level       integer not null,
  score       integer not null,
  stars       smallint not null default 1,
  time_sec    integer not null default 0,
  moves       integer not null default 0,
  created_at  timestamptz not null default now()
);

create unique index if not exists scores_player_level_uidx
  on public.scores (player_id, world, level);

create index if not exists scores_world_level_score_idx
  on public.scores (world, level, score desc);

-- ---------------------------------------------------------------------------
-- Row Level Security — public READ only. Writes: see the migration above.
-- (Analytics live in the private `shikaku_events` table, also created there.)
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.scores   enable row level security;

drop policy if exists "profiles_read" on public.profiles;
create policy "profiles_read" on public.profiles for select using (true);

drop policy if exists "scores_read" on public.scores;
create policy "scores_read" on public.scores for select using (true);

-- ---------------------------------------------------------------------------
-- Realtime: multiplayer uses ephemeral broadcast channels (match:<CODE>),
-- which need no table replication. Broadcast works out of the box with the
-- anon key, so nothing extra is required here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Username = identity (optional DB-level hardening)
-- ---------------------------------------------------------------------------
-- The app derives each player's id deterministically from their case-insensitive
-- username, so one name already maps to one row, and the leaderboard collapses
-- any older same-name rows when reading (the client never deletes rows). The block below ADDITIONALLY enforces uniqueness in the
-- database. Run it ONCE, after the app has been deployed (so duplicates have had
-- a chance to merge). It removes any remaining same-name duplicates (keeping the
-- highest score) and then adds a case-insensitive unique index.
--
--   delete from public.profiles p using public.profiles q
--   where lower(p.username) = lower(q.username)
--     and (p.total_score, p.id) < (q.total_score, q.id);
--
--   create unique index if not exists profiles_username_lower_udx
--     on public.profiles (lower(username));
-- ---------------------------------------------------------------------------
