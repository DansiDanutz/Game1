-- ============================================================================
-- Shikaku: 10 free games per UTC day, checked by the server.
--
-- Puzzles are generated in the browser, so the limit cannot stop anyone from
-- tinkering offline. What it controls is what COUNTS:
--   * a board is counted when it STARTS for a signed-in name
--     (shikaku_start_game), and the start hands back a one-use ticket;
--   * only a counted board can be saved: shikaku_save_score takes the ticket.
-- One started board = one game, whatever the result (won, lost or left):
--   quest levels (retries count), the Daily Challenge (replays count),
--   endless boards and battles. Battles start with a slot, so a battle win is
--   only reported for a counted board. Battle results are still written with
--   shikaku_save_profile.
--
-- Concurrency: a start takes the account's row lock, so two tabs cannot both
-- take the last slot. A client request id makes a retried start (lost reply)
-- return the same ticket without a second slot. Days are UTC: the counter resets
-- at 00:00 UTC. Session tokens are never stored; the ticket is derived from the
-- token and the request id, and only its hash is stored.
--
-- Old clients: shikaku_save_score with 9 arguments (token, no ticket) is KEPT
-- here so clients that have not been updated keep saving. That legacy overload
-- does not check tickets, so the limit is only enforced for saves made with the
-- ticket signature until the follow-up migration drops the legacy overload
-- (see README "Free daily games").
-- ============================================================================

create or replace function public.shikaku_free_daily_games()
returns integer
language sql
immutable
set search_path = ''
as $$ select 10 $$;

create table if not exists public.shikaku_game_starts (
  ticket_hash  text primary key,                  -- sha256 of the ticket; the ticket itself is never stored
  name_key     text not null references public.shikaku_accounts (name_key) on delete cascade,
  request_hash text not null,                     -- sha256 of the client's request id (the retry key)
  kind         text not null check (kind in ('quest', 'daily', 'endless', 'battle')),
  world        integer,                           -- quest world, or the daily YYYYMMDD; null otherwise
  level        integer,                           -- quest level, or 0 for the daily; null otherwise
  started_on   date not null default ((now() at time zone 'utc')::date),
  used_at      timestamptz,                       -- set when the ticket saves a score
  created_at   timestamptz not null default now(),
  unique (name_key, request_hash),
  check ((kind in ('quest', 'daily')) = (world is not null and level is not null))
);

create index if not exists shikaku_game_starts_name_day_idx
  on public.shikaku_game_starts (name_key, started_on);

alter table public.shikaku_game_starts enable row level security;
revoke all on table public.shikaku_game_starts from anon, authenticated;

create or replace function public.shikaku_next_utc_midnight()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc';
$$;

-- Counted boards for this name today (UTC). Internal.
create or replace function public.shikaku_used_today(p_key text)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.shikaku_game_starts
   where name_key = p_key and started_on = (now() at time zone 'utc')::date;
$$;

-- Games left today and the next reset, without taking a slot.
create or replace function public.shikaku_game_quota(p_token text)
returns table (games_left integer, reset_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text := public.shikaku_session_name(p_token);
begin
  if v_key is null then
    raise exception 'shikaku: not signed in';
  end if;
  return query select greatest(public.shikaku_free_daily_games() - public.shikaku_used_today(v_key), 0),
                      public.shikaku_next_utc_midnight();
end;
$$;

-- Start a board. status: ok (ticket issued, or the same ticket for a retried
-- request id) | limit (no slot left today; nothing is written).
create or replace function public.shikaku_start_game(
  p_token text, p_request_id text, p_kind text, p_world integer, p_level integer)
returns table (status text, ticket text, games_left integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key    text := public.shikaku_session_name(p_token);
  v_ticket text;
  v_hash   text;
  v_req    text;
  v_row    public.shikaku_game_starts;
begin
  if v_key is null then
    raise exception 'shikaku: not signed in';
  end if;
  if coalesce(p_request_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'shikaku: invalid request';
  end if;
  if p_kind is null or p_kind not in ('quest', 'daily', 'endless', 'battle')
     or (p_kind in ('quest', 'daily')) <> (p_world is not null and p_level is not null)
     or (p_kind = 'quest' and not (p_world between 0 and 99 and p_level between 0 and 99))
     or (p_kind = 'daily' and not (p_world between 20200101 and 21001231 and p_level = 0)) then
    raise exception 'shikaku: invalid game';
  end if;

  -- serialise starts for this account (the row lock is held to the end of the call)
  perform 1 from public.shikaku_accounts where name_key = v_key for update;

  v_ticket := public.shikaku_sha256('ticket|' || p_token || '|' || p_request_id);
  v_hash   := public.shikaku_sha256(v_ticket);
  v_req    := public.shikaku_sha256(p_request_id);

  select * into v_row from public.shikaku_game_starts
   where name_key = v_key and request_hash = v_req;
  if found then
    -- a retry of the same start gets its ticket back; any other use of the id is refused
    if v_row.ticket_hash <> v_hash or v_row.kind <> p_kind
       or v_row.world is distinct from p_world or v_row.level is distinct from p_level then
      raise exception 'shikaku: request id already used';
    end if;
    return query select 'ok'::text, v_ticket,
                        greatest(public.shikaku_free_daily_games() - public.shikaku_used_today(v_key), 0),
                        public.shikaku_next_utc_midnight();
    return;
  end if;

  if public.shikaku_used_today(v_key) >= public.shikaku_free_daily_games() then
    return query select 'limit'::text, null::text, 0, public.shikaku_next_utc_midnight();
    return;
  end if;

  insert into public.shikaku_game_starts (ticket_hash, name_key, request_hash, kind, world, level)
  values (v_hash, v_key, v_req, p_kind, p_world, p_level);

  return query select 'ok'::text, v_ticket,
                      greatest(public.shikaku_free_daily_games() - public.shikaku_used_today(v_key), 0),
                      public.shikaku_next_utc_midnight();
end;
$$;

-- Score save that requires a ticket for this name and this exact board. The
-- ticket is spent in the same transaction as the score. Kept beside the legacy
-- 9-argument overload (see the header).
create or replace function public.shikaku_save_score(
  p_player_id uuid, p_username text, p_world integer, p_level integer,
  p_score integer, p_stars integer, p_time_sec integer, p_moves integer,
  p_token text, p_ticket text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_key  text := public.shikaku_name_key(p_username);
  v_game public.shikaku_game_starts;
begin
  if p_player_id is null or char_length(v_name) < 2 or char_length(v_name) > 18 then
    raise exception 'shikaku: invalid player';
  end if;
  if public.shikaku_session_name(p_token) is distinct from v_key then
    raise exception 'shikaku: not signed in';
  end if;
  if p_player_id <> public.shikaku_id_for_name(v_name) then
    raise exception 'shikaku: id does not belong to this name';
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

  -- the ticket must be this name's, unspent, and for this exact board
  select * into v_game from public.shikaku_game_starts
   where ticket_hash = public.shikaku_sha256(coalesce(p_ticket, '')) and name_key = v_key
   for update;
  if not found then
    raise exception 'shikaku: invalid ticket';
  end if;
  if v_game.used_at is not null then
    raise exception 'shikaku: ticket already used';
  end if;
  if v_game.kind <> (case when p_world > 99 then 'daily' else 'quest' end)
     or v_game.world is distinct from p_world or v_game.level is distinct from p_level then
    raise exception 'shikaku: invalid ticket';
  end if;
  update public.shikaku_game_starts set used_at = now() where ticket_hash = v_game.ticket_hash;

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
               end
  where public.shikaku_name_key(s.username) = v_key;
end;
$$;

revoke all on function public.shikaku_free_daily_games() from public, anon, authenticated;
revoke all on function public.shikaku_next_utc_midnight() from public, anon, authenticated;
revoke all on function public.shikaku_used_today(text) from public, anon, authenticated;
revoke all on function public.shikaku_start_game(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.shikaku_game_quota(text) from public, anon, authenticated;
revoke all on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.shikaku_start_game(text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.shikaku_game_quota(text) to anon, authenticated;
grant execute on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer, text, text) to anon, authenticated;
