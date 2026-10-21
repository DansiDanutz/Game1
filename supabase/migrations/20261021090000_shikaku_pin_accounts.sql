-- ============================================================================
-- Shikaku: 4-digit PIN accounts.
--
-- Before this, the username was the whole account: anyone who typed a name
-- could save under it. Now a name is claimed with a PIN (first come, first
-- served), signing in with name + PIN returns a session token, and every
-- profile/score save must carry a token for that same name.
--
--   shikaku_account_status(name)  -> 'new' | 'claimed' | 'locked'
--   shikaku_claim(name, pin)      -> token   (name must be unclaimed)
--   shikaku_login(name, pin)      -> (token, status) status: ok|wrong|locked|unknown
--   shikaku_save_profile(..., p_token) / shikaku_save_score(..., p_token)
--
-- Brute force: 5 wrong PINs lock the name for 15 minutes. The accounts and
-- sessions tables are private (RLS on, no policies, no grants to anon).
--
-- Forgotten PIN (run as the project owner; the player then claims the name
-- again with a new PIN, keeping all their scores):
--   delete from public.shikaku_accounts where name_key = lower('TheirName');
-- ============================================================================

create table if not exists public.shikaku_accounts (
  name_key     text primary key,                 -- shikaku_name_key(username)
  pin_salt     text not null,
  pin_hash     text not null,
  failed       integer not null default 0,       -- wrong PINs since last lock/login
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists public.shikaku_sessions (
  token_hash text primary key,                   -- sha256 of the token; raw token never stored
  name_key   text not null references public.shikaku_accounts(name_key) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists shikaku_sessions_name_idx on public.shikaku_sessions(name_key);

alter table public.shikaku_accounts enable row level security;
alter table public.shikaku_sessions enable row level security;
revoke all on public.shikaku_accounts from anon, authenticated;
revoke all on public.shikaku_sessions from anon, authenticated;

-- Same normalisation as the client's normName(): trim, lowercase, collapse spaces.
create or replace function public.shikaku_name_key(p_name text)
returns text language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
$$;

create or replace function public.shikaku_sha256(p_text text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

-- Name the token belongs to, or null. Internal: not callable by the public key.
create or replace function public.shikaku_session_name(p_token text)
returns text language sql stable security definer set search_path = '' as $$
  select s.name_key from public.shikaku_sessions s
  where p_token is not null and s.token_hash = public.shikaku_sha256(p_token);
$$;

create or replace function public.shikaku_new_session(p_key text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into public.shikaku_sessions (token_hash, name_key) values (public.shikaku_sha256(v_token), p_key);
  return v_token;
end;
$$;

create or replace function public.shikaku_account_status(p_username text)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when a.name_key is null then 'new'
    when a.locked_until > now() then 'locked'
    else 'claimed' end
  from (select 1) one
  left join public.shikaku_accounts a on a.name_key = public.shikaku_name_key(p_username);
$$;

create or replace function public.shikaku_claim(p_username text, p_pin text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_key  text := public.shikaku_name_key(p_username);
  v_salt text := replace(gen_random_uuid()::text, '-', '');
begin
  if char_length(v_key) < 2 or char_length(v_key) > 18 then
    raise exception 'shikaku: invalid name';
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then
    raise exception 'shikaku: invalid pin';
  end if;
  insert into public.shikaku_accounts (name_key, pin_salt, pin_hash)
  values (v_key, v_salt, public.shikaku_sha256(v_salt || ':' || p_pin))
  on conflict (name_key) do nothing;
  if not found then
    raise exception 'shikaku: name taken';
  end if;
  return public.shikaku_new_session(v_key);
end;
$$;

-- Returns a row instead of raising on a wrong PIN, so the failed-attempt
-- counter is committed (an exception would roll it back).
create or replace function public.shikaku_login(p_username text, p_pin text)
returns table (token text, status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := public.shikaku_name_key(p_username);
  a public.shikaku_accounts;
begin
  select * into a from public.shikaku_accounts where name_key = v_key for update;
  if not found then
    return query select null::text, 'unknown'::text; return;
  end if;
  if a.locked_until > now() then
    return query select null::text, 'locked'::text; return;
  end if;
  if coalesce(p_pin, '') ~ '^[0-9]{4}$'
     and public.shikaku_sha256(a.pin_salt || ':' || p_pin) = a.pin_hash then
    update public.shikaku_accounts set failed = 0, locked_until = null where name_key = v_key;
    return query select public.shikaku_new_session(v_key), 'ok'::text; return;
  end if;
  if a.failed + 1 >= 5 then
    update public.shikaku_accounts set failed = 0, locked_until = now() + interval '15 minutes' where name_key = v_key;
    return query select null::text, 'locked'::text; return;
  end if;
  update public.shikaku_accounts set failed = a.failed + 1 where name_key = v_key;
  return query select null::text, 'wrong'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Saves now require a session token for the same name. The old token-less
-- signatures are dropped in the next migration (once the client that sends
-- tokens is deployed) so they can't be used to bypass the PIN.
-- ---------------------------------------------------------------------------

create or replace function public.shikaku_save_profile(
  p_id uuid, p_username text, p_avatar text, p_theme text, p_accent text,
  p_total_score integer, p_best_world integer, p_wins integer, p_losses integer,
  p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
    updated_at  = now()
  where public.shikaku_name_key(p.username) = v_key;   -- never touch another name's row
end;
$$;

create or replace function public.shikaku_save_score(
  p_player_id uuid, p_username text, p_world integer, p_level integer,
  p_score integer, p_stars integer, p_time_sec integer, p_moves integer,
  p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_key  text := public.shikaku_name_key(p_username);
begin
  if p_player_id is null or char_length(v_name) < 2 or char_length(v_name) > 18 then
    raise exception 'shikaku: invalid player';
  end if;
  if public.shikaku_session_name(p_token) is distinct from v_key then
    raise exception 'shikaku: not signed in';
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
               end
  where public.shikaku_name_key(s.username) = v_key;   -- never touch another name's row
end;
$$;

revoke all on function public.shikaku_name_key(text) from public, anon, authenticated;
revoke all on function public.shikaku_sha256(text) from public, anon, authenticated;
revoke all on function public.shikaku_session_name(text) from public, anon, authenticated;
revoke all on function public.shikaku_new_session(text) from public, anon, authenticated;
revoke all on function public.shikaku_account_status(text) from public, anon, authenticated;
revoke all on function public.shikaku_claim(text, text) from public, anon, authenticated;
revoke all on function public.shikaku_login(text, text) from public, anon, authenticated;
revoke all on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer, text) from public, anon, authenticated;
revoke all on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.shikaku_account_status(text) to anon, authenticated;
grant execute on function public.shikaku_claim(text, text) to anon, authenticated;
grant execute on function public.shikaku_login(text, text) to anon, authenticated;
grant execute on function public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer, text) to anon, authenticated;
grant execute on function public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer, text) to anon, authenticated;
