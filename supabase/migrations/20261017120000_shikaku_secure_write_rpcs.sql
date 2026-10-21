-- ============================================================================
-- Shikaku: secure write functions.
--
-- The Games project is shared with other apps. In June 2026 the WorldCup
-- migration `worldcup_function_security_hardening` (intentionally) removed all
-- public INSERT/UPDATE/DELETE policies from the legacy game tables, which left
-- Shikaku's profiles/scores read-only for the anon key and silently broke
-- every cloud save.
--
-- Rather than re-opening table writes, Shikaku now writes ONLY through these
-- validated SECURITY DEFINER functions. The tables themselves stay read-only
-- for anon/authenticated.
-- ============================================================================

-- Private analytics table (game-specific name; another app already owns
-- `analytics_events`). No RLS policies => no direct client reads or writes.
create table if not exists public.shikaku_events (
  id          bigint generated always as identity primary key,
  player_id   uuid,
  username    text,
  name        text not null,
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.shikaku_events enable row level security;
revoke all on table public.shikaku_events from anon, authenticated;
create index if not exists shikaku_events_name_time_idx on public.shikaku_events (name, created_at desc);

-- ---------------------------------------------------------------------------
-- Profile upsert. Counters only ever increase (a direct call cannot wipe a
-- player's record). Also collapses older duplicate rows for the same name
-- (username = account), which the client can no longer delete itself.
-- ---------------------------------------------------------------------------
create or replace function public.shikaku_save_profile(
  p_id uuid, p_username text, p_avatar text, p_theme text, p_accent text,
  p_total_score integer, p_best_world integer, p_wins integer, p_losses integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
begin
  if p_id is null or char_length(v_name) < 2 or char_length(v_name) > 18 then
    raise exception 'shikaku: invalid profile';
  end if;
  if coalesce(p_total_score, 0) not between 0 and 10000000
     or coalesce(p_best_world, 0) not between 0 and 100
     or coalesce(p_wins, 0) not between 0 and 1000000
     or coalesce(p_losses, 0) not between 0 and 1000000 then
    raise exception 'shikaku: invalid stats';
  end if;

  insert into public.profiles as p
    (id, username, avatar, theme, accent, total_score, best_world, wins, losses, updated_at)
  values
    (p_id, v_name, left(coalesce(p_avatar, '🎮'), 16), left(coalesce(p_theme, 'neon'), 16),
     left(p_accent, 16), coalesce(p_total_score, 0), coalesce(p_best_world, 0),
     coalesce(p_wins, 0), coalesce(p_losses, 0), now())
  on conflict (id) do update set
    username    = excluded.username,
    avatar      = excluded.avatar,
    theme       = excluded.theme,
    accent      = excluded.accent,
    total_score = greatest(p.total_score, excluded.total_score),
    best_world  = greatest(p.best_world,  excluded.best_world),
    wins        = greatest(p.wins,        excluded.wins),
    losses      = greatest(p.losses,      excluded.losses),
    updated_at  = now();

  -- collapse stale duplicates of this name that don't out-score the saved row
  with dupes as (
    delete from public.profiles d
     where lower(d.username) = lower(v_name)
       and d.id <> p_id
       and d.total_score <= (select x.total_score from public.profiles x where x.id = p_id)
    returning d.id
  )
  delete from public.scores s using dupes where s.player_id = dupes.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Score upsert for quest levels (world/level index) and the Daily Race
-- (world = YYYYMMDD, level = 0). Keeps the best score and the fastest time.
-- ---------------------------------------------------------------------------
create or replace function public.shikaku_save_score(
  p_player_id uuid, p_username text, p_world integer, p_level integer,
  p_score integer, p_stars integer, p_time_sec integer, p_moves integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
begin
  if p_player_id is null or char_length(v_name) < 2 or char_length(v_name) > 18 then
    raise exception 'shikaku: invalid player';
  end if;
  if not ((p_world between 0 and 99 and p_level between 0 and 99)
          or (p_world between 20200101 and 21001231 and p_level = 0)) then
    raise exception 'shikaku: invalid slot';
  end if;
  if coalesce(p_score, -1) not between 0 and 1000000
     or coalesce(p_stars, 1) not between 1 and 3
     or coalesce(p_time_sec, -1) not between 0 and 86400
     or coalesce(p_moves, 0) not between 0 and 100000 then
    raise exception 'shikaku: invalid score';
  end if;

  insert into public.scores as s
    (player_id, username, world, level, score, stars, time_sec, moves)
  values
    (p_player_id, v_name, p_world, p_level, p_score, coalesce(p_stars, 1), p_time_sec, coalesce(p_moves, 0))
  on conflict (player_id, world, level) do update set
    username = excluded.username,
    moves    = case when excluded.score > s.score then excluded.moves else s.moves end,
    score    = greatest(s.score, excluded.score),
    stars    = greatest(s.stars, excluded.stars),
    time_sec = least(s.time_sec, excluded.time_sec);
end;
$$;

-- ---------------------------------------------------------------------------
-- Analytics: fire-and-forget event insert with size limits.
-- ---------------------------------------------------------------------------
create or replace function public.shikaku_track(
  p_player_id uuid, p_username text, p_name text, p_props jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name is null or p_name !~ '^[a-z_]{1,40}$' then return; end if;
  if p_props is not null and pg_column_size(p_props) > 2048 then return; end if;
  insert into public.shikaku_events (player_id, username, name, props)
  values (p_player_id, left(btrim(p_username), 18), p_name, coalesce(p_props, '{}'::jsonb));
end;
$$;

revoke all on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer) from public;
revoke all on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer) from public;
revoke all on function public.shikaku_track(uuid, text, text, jsonb) from public;
grant execute on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.shikaku_track(uuid, text, text, jsonb) to anon, authenticated;
