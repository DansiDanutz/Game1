-- ============================================================================
-- Shikaku: scores decided by the server.
--
-- Before: the browser sent its own score, time and total. Now the server deals
-- the board, checks the solution, takes the time from its own clock and works
-- out the score. The browser only says how many moves and hints it used; those
-- can change a score by at most the accuracy bonus and the hint penalty.
--
--   shikaku_start_game   -> a one-use ticket (counts toward the 10 free games)
--   shikaku_deal_board   -> the board for that ticket; the clock starts here
--   shikaku_finish_game  -> checks the solution and saves the score once
--
-- The boards come from js/levels.js (next migration); the Daily Challenge uses
-- the same generator as js/puzzle.js, so everyone gets the same board.
-- The old saves that trusted the browser are dropped, so the web client must be
-- deployed together with this migration.
-- Friend battles are friendly games between browsers: wins and losses in a
-- profile are still what the player reports, and are shown as such.
-- ============================================================================

create table if not exists public.shikaku_boards (
  size   integer not null check (size between 4 and 9),
  tier   text not null check (tier in ('easy', 'medium', 'hard', 'expert')),
  num    integer not null,
  puzzle jsonb not null,
  primary key (size, tier, num)
);
create table if not exists public.shikaku_quest (
  world integer not null,
  level integer not null,
  size  integer not null,
  tier  text not null,
  mult  double precision not null,
  primary key (world, level)
);
alter table public.shikaku_boards enable row level security;
alter table public.shikaku_quest enable row level security;
revoke all on table public.shikaku_boards, public.shikaku_quest from anon, authenticated;

alter table public.shikaku_game_starts
  add column if not exists puzzle   jsonb,
  add column if not exists dealt_at timestamptz,
  add column if not exists score    integer,
  add column if not exists stars    integer,
  add column if not exists time_sec integer;

-- A game (or a credit) is only taken for a board that can be dealt.
create or replace function public.shikaku_check_start()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'utc')::date;
begin
  if new.kind = 'quest' and not exists (
       select 1 from public.shikaku_quest q where q.world = new.world and q.level = new.level)
     or new.kind = 'daily' and new.world not between                 -- "today" depends on the player's time zone
       to_char(v_today - 1, 'YYYYMMDD')::integer and to_char(v_today + 1, 'YYYYMMDD')::integer then
    raise exception 'shikaku: invalid game';
  end if;
  return new;
end;
$$;
drop trigger if exists shikaku_check_start on public.shikaku_game_starts;
create trigger shikaku_check_start before insert on public.shikaku_game_starts
  for each row execute function public.shikaku_check_start();

-- ------------------------------------------- the generator of js/puzzle.js --

-- Math.imul on unsigned 32-bit numbers.
create or replace function public.shikaku_imul(a bigint, b bigint)
returns bigint language sql immutable set search_path = '' as $$
  select (a * (b & 65535) + (((a * (b >> 16)) & 4294967295) << 16)) & 4294967295;
$$;

-- One mulberry32 step: the number drawn when the state is p_state.
create or replace function public.shikaku_rand(p_state bigint)
returns double precision language plpgsql immutable set search_path = '' as $$
declare t bigint;
begin
  t := public.shikaku_imul(p_state # (p_state >> 15), 1 | p_state);
  t := ((t + public.shikaku_imul(t # (t >> 7), 61 | t)) & 4294967295) # t;
  return ((t # (t >> 14)) & 4294967295)::double precision / 4294967296::double precision;
end;
$$;

-- dailyGrid() of js/puzzle.js. The seed product is a float in JavaScript, so it is one here.
create or replace function public.shikaku_daily_puzzle(p_day integer)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  c_step constant bigint := 1831565813;                       -- 0x6D2B79F5
  n integer := 5 + p_day % 3;
  v_max integer := n + 2;
  s bigint := (p_day::double precision * 2654435761::double precision)::bigint & 4294967295;
  v_owner boolean[] := array_fill(false, array[n * n]);
  v_rects integer[] := '{}';                                  -- r, c, h, w, ...
  v_h integer[]; v_w integer[]; v_grid integer[];
  v_tall integer; v_wide integer; v_pick integer; v_len integer;
begin
  for r in 0 .. n - 1 loop for c in 0 .. n - 1 loop
    continue when v_owner[r * n + c + 1];
    v_tall := 0;
    while r + v_tall < n and not v_owner[(r + v_tall) * n + c + 1] loop v_tall := v_tall + 1; end loop;
    v_h := '{}'; v_w := '{}';
    for h in 1 .. v_tall loop
      v_wide := 0;
      while c + v_wide < n and h * (v_wide + 1) <= v_max loop
        exit when exists (select 1 from generate_series(r, r + h - 1) rr where v_owner[rr * n + c + v_wide + 1]);
        v_wide := v_wide + 1;
      end loop;
      for w in 1 .. v_wide loop v_h := v_h || h; v_w := v_w || w; end loop;
    end loop;
    select array_agg(x.h order by x.h * x.w, x.ord), array_agg(x.w order by x.h * x.w, x.ord) into v_h, v_w
      from unnest(v_h, v_w) with ordinality x(h, w, ord);
    v_len := cardinality(v_h);
    s := (s + c_step) & 4294967295;
    if public.shikaku_rand(s) < 0.55 then
      s := (s + c_step) & 4294967295;
      v_pick := v_len - floor(public.shikaku_rand(s) * least(3, v_len))::integer;
    else
      s := (s + c_step) & 4294967295;
      v_pick := 1 + floor(public.shikaku_rand(s) * v_len)::integer;
    end if;
    for rr in r .. r + v_h[v_pick] - 1 loop for cc in c .. c + v_w[v_pick] - 1 loop
      v_owner[rr * n + cc + 1] := true;
    end loop; end loop;
    v_rects := v_rects || array[r, c, v_h[v_pick], v_w[v_pick]];
  end loop; end loop;

  v_grid := array_fill(0, array[n * n]);
  for i in 0 .. cardinality(v_rects) / 4 - 1 loop
    s := (s + c_step) & 4294967295;
    v_tall := v_rects[i * 4 + 1] + floor(public.shikaku_rand(s) * v_rects[i * 4 + 3])::integer;
    s := (s + c_step) & 4294967295;
    v_wide := v_rects[i * 4 + 2] + floor(public.shikaku_rand(s) * v_rects[i * 4 + 4])::integer;
    v_grid[v_tall * n + v_wide + 1] := v_rects[i * 4 + 3] * v_rects[i * 4 + 4];
  end loop;
  return (select jsonb_agg((select jsonb_agg(v_grid[r * n + c + 1] order by c) from generate_series(0, n - 1) c) order by r)
            from generate_series(0, n - 1) r);
end;
$$;

-- --------------------------------------------------------- deal and finish --

-- Locks and returns the caller's game for this ticket.
create or replace function public.shikaku_ticket_game(p_token text, p_ticket text)
returns public.shikaku_game_starts language plpgsql set search_path = '' as $$
declare v_key text := public.shikaku_session_name(p_token); v_game public.shikaku_game_starts;
begin
  if v_key is null then raise exception 'shikaku: not signed in'; end if;
  select * into v_game from public.shikaku_game_starts
   where ticket_hash = public.shikaku_sha256(coalesce(p_ticket, '')) and name_key = v_key
   for update;
  if not found or v_game.kind not in ('quest', 'daily') then raise exception 'shikaku: invalid ticket'; end if;
  return v_game;
end;
$$;

-- Asking again returns the same board, and the clock keeps running.
create or replace function public.shikaku_deal_board(p_token text, p_ticket text)
returns table (puzzle jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  g public.shikaku_game_starts := public.shikaku_ticket_game(p_token, p_ticket);
  v_puzzle jsonb := g.puzzle;
begin
  if v_puzzle is null then
    if g.kind = 'quest' then
      select b.puzzle into v_puzzle from public.shikaku_quest q
        join public.shikaku_boards b on b.size = q.size and b.tier = q.tier
       where q.world = g.world and q.level = g.level order by random() limit 1;
    else
      v_puzzle := public.shikaku_daily_puzzle(g.world);
    end if;
    if v_puzzle is null then raise exception 'shikaku: invalid game'; end if;
    update public.shikaku_game_starts s set puzzle = v_puzzle, dealt_at = clock_timestamp()
     where s.ticket_hash = g.ticket_hash;
  end if;
  return query select v_puzzle;
end;
$$;

-- The score formula of js/app.js. floor(x + 0.5) is JavaScript's Math.round.
create or replace function public.shikaku_score(
  p_mult double precision, p_time integer, p_moves integer, p_rects integer, p_hints integer)
returns integer language sql immutable set search_path = '' as $$
  select greatest(100, (floor(500 * p_mult + 0.5)
    + floor(greatest(0, 300 - p_time * 4) * p_mult + 0.5)
    + floor(greatest(0, 150 - (p_moves - p_rects) * 15) * p_mult + 0.5))::integer - p_hints * 40);
$$;

create or replace function public.shikaku_refresh_total(p_player uuid)
returns void language sql set search_path = '' as $$
  update public.profiles p set
    total_score = greatest(p.total_score, t.total),
    best_world  = greatest(p.best_world, t.best)
  from (select coalesce(sum(score), 0)::integer total, coalesce(max(world) filter (where world <= 99), 0) best
          from public.scores where player_id = p_player) t
  where p.id = p_player;
$$;

-- status: ok (saved, or already saved by an earlier call) | wrong | expired
create or replace function public.shikaku_finish_game(
  p_token text, p_ticket text, p_username text, p_rects jsonb, p_moves integer, p_hints integer)
returns table (status text, score integer, stars integer, time_sec integer)
language plpgsql security definer set search_path = '' as $$
declare
  g public.shikaku_game_starts := public.shikaku_ticket_game(p_token, p_ticket);
  v_name text := btrim(coalesce(p_username, ''));
  v_player uuid := public.shikaku_id_for_name(v_name);
  v_mult double precision := 1.5;                             -- the Daily Challenge
  v_rects integer; v_time integer; v_score integer; v_stars integer;
begin
  if public.shikaku_name_key(v_name) <> g.name_key or char_length(v_name) not between 2 and 18 then
    raise exception 'shikaku: invalid player';
  end if;
  if g.used_at is not null then
    return query select 'ok'::text, g.score, g.stars, g.time_sec; return;
  end if;
  if g.puzzle is null then raise exception 'shikaku: invalid ticket'; end if;
  if not public.shikaku_is_solution(g.puzzle, p_rects) then
    return query select 'wrong'::text, null::integer, null::integer, null::integer; return;
  end if;
  if clock_timestamp() > g.dealt_at + interval '1 day' then
    return query select 'expired'::text, null::integer, null::integer, null::integer; return;
  end if;

  v_time  := greatest(1, floor(extract(epoch from clock_timestamp() - g.dealt_at))::integer);
  v_rects := jsonb_array_length(p_rects);
  if g.kind = 'quest' then
    select q.mult into v_mult from public.shikaku_quest q where q.world = g.world and q.level = g.level;
  end if;
  v_score := public.shikaku_score(v_mult, v_time, least(greatest(coalesce(p_moves, 0), v_rects), 100000), v_rects,
                                  least(greatest(coalesce(p_hints, 0), 0), 1000));
  v_stars := case when v_score > 900 * v_mult then 3 when v_score > 650 * v_mult then 2 else 1 end;
  update public.shikaku_game_starts s set used_at = now(), score = v_score, stars = v_stars, time_sec = v_time
   where s.ticket_hash = g.ticket_hash;

  insert into public.scores as s (player_id, username, world, level, score, stars, time_sec, moves)
  values (v_player, v_name, g.world, g.level, v_score, v_stars, v_time, least(greatest(coalesce(p_moves, 0), v_rects), 100000))
  on conflict (player_id, world, level) do update set
    username = excluded.username,
    moves    = case when excluded.score > s.score then excluded.moves else s.moves end,
    score    = greatest(s.score, excluded.score),
    stars    = greatest(s.stars, excluded.stars),
    time_sec = case when s.time_sec <= 0 then excluded.time_sec else least(s.time_sec, excluded.time_sec) end
  where public.shikaku_name_key(s.username) = g.name_key;
  perform public.shikaku_refresh_total(v_player);
  return query select 'ok'::text, v_score, v_stars, v_time;
end;
$$;

-- ------------------------------------------ profiles no longer send a total --

-- p_total_score and p_best_world stay in the signature but are not used: both
-- come from the saved scores.
create or replace function public.shikaku_save_profile(
  p_id uuid, p_username text, p_avatar text, p_theme text, p_accent text,
  p_total_score integer, p_best_world integer, p_wins integer, p_losses integer,
  p_token text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_key  text := public.shikaku_name_key(p_username);
begin
  if p_id is null or char_length(v_name) < 2 or char_length(v_name) > 18 then
    raise exception 'shikaku: invalid profile';
  end if;
  if public.shikaku_session_name(p_token) is distinct from v_key then
    raise exception 'shikaku: not signed in';
  end if;
  if p_id <> public.shikaku_id_for_name(v_name) then
    raise exception 'shikaku: id does not belong to this name';
  end if;
  if coalesce(p_wins, 0) not between 0 and 1000000 or coalesce(p_losses, 0) not between 0 and 1000000 then
    raise exception 'shikaku: invalid stats';
  end if;
  insert into public.profiles as p
    (id, username, avatar, theme, accent, total_score, best_world, wins, losses, updated_at)
  values
    (p_id, v_name, left(coalesce(p_avatar, '🎮'), 16), left(coalesce(p_theme, 'neon'), 16),
     left(p_accent, 16), 0, 0, coalesce(p_wins, 0), coalesce(p_losses, 0), now())
  on conflict (id) do update set
    username   = excluded.username,
    avatar     = excluded.avatar,
    theme      = excluded.theme,
    accent     = excluded.accent,
    wins       = greatest(p.wins, excluded.wins),
    losses     = greatest(p.losses, excluded.losses),
    updated_at = now();
  perform public.shikaku_refresh_total(p_id);
end;
$$;

drop function if exists public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer, text);
drop function if exists public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer, text, text);

revoke all on function public.shikaku_check_start() from public, anon, authenticated;
revoke all on function public.shikaku_imul(bigint, bigint) from public, anon, authenticated;
revoke all on function public.shikaku_rand(bigint) from public, anon, authenticated;
revoke all on function public.shikaku_daily_puzzle(integer) from public, anon, authenticated;
revoke all on function public.shikaku_ticket_game(text, text) from public, anon, authenticated;
revoke all on function public.shikaku_score(double precision, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.shikaku_refresh_total(uuid) from public, anon, authenticated;
revoke all on function public.shikaku_deal_board(text, text) from public, anon, authenticated;
revoke all on function public.shikaku_finish_game(text, text, text, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.shikaku_deal_board(text, text) to anon, authenticated;
grant execute on function public.shikaku_finish_game(text, text, text, jsonb, integer, integer) to anon, authenticated;
revoke all on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer, text) to anon, authenticated;
