-- ============================================================================
-- Shikaku: review fixes for the secure write functions.
--
-- 1. shikaku_save_profile no longer deletes "duplicate" rows for a name.
--    Players are anonymous (username = account), so the server cannot verify
--    who owns a row; a caller passing a fresh id + someone else's name + a high
--    total could erase that player's profile and scores (including Daily Race
--    history). The function is now strictly non-destructive: it only upserts
--    the caller's own row with monotonic counters. The leaderboard already
--    collapses same-name rows when reading.
-- 2. time_sec = 0 means "unknown" (older builds uploaded fake zero times).
--    least() kept those zeros forever; unknown times now never win the merge
--    and a real time replaces them.
-- ============================================================================

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
end;
$$;

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
    -- 0 = unknown time: it never beats a real time, and a real time replaces it
    time_sec = case
                 when s.time_sec <= 0        then excluded.time_sec
                 when excluded.time_sec <= 0 then s.time_sec
                 else least(s.time_sec, excluded.time_sec)
               end;
end;
$$;

revoke all on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer) from public;
revoke all on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer) from public;
grant execute on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer) to anon, authenticated;
grant execute on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer) to anon, authenticated;
