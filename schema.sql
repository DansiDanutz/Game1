-- ============================================================================
--  Shikaku: Puzzle Quest — Supabase schema
--  Run this in your Supabase project: SQL Editor → New query → paste → Run.
--  Project: https://lxhjfdxowpxzrybxdasi.supabase.co
--
--  Auth model: lightweight "username only". Players are identified by a
--  device-generated UUID (player_id) kept in localStorage. There is no
--  password login, so the policies below intentionally allow the public
--  (anon) role to read and write. This is fine for a casual game; do NOT
--  store anything sensitive here. The anon key is safe to ship in the client.
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
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.scores   enable row level security;

-- profiles: public read + public write (username-only model, no auth.uid()).
drop policy if exists "profiles_read"   on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (true);
create policy "profiles_update" on public.profiles for update using (true) with check (true);

-- scores: public read + public write.
drop policy if exists "scores_read"   on public.scores;
drop policy if exists "scores_insert" on public.scores;
drop policy if exists "scores_update" on public.scores;
create policy "scores_read"   on public.scores for select using (true);
create policy "scores_insert" on public.scores for insert with check (true);
create policy "scores_update" on public.scores for update using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Realtime: multiplayer uses ephemeral broadcast channels (match:<CODE>),
-- which need no table replication. Broadcast works out of the box with the
-- anon key, so nothing extra is required here.
-- ---------------------------------------------------------------------------
