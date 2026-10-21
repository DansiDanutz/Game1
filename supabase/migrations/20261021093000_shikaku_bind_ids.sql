-- ============================================================================
-- Shikaku: bind player ids to the signed-in name.
--
-- The client derives a player's id from the name (idForName → cyrb128 in
-- js/app.js), so ids are predictable. Checking only the token's name let a
-- signed-in player insert rows under someone else's id (a level slot they had
-- not saved yet, or their profile before they created it). The server now
-- derives the id from the name the same way and rejects any other id, so a
-- name can only ever write rows under its own id. Since the id is verified,
-- the owner may also take over any row under it (the old "same name only"
-- conflict guard is no longer needed).
-- ============================================================================

-- Math.imul on unsigned 32-bit values: low 32 bits of the product.
create or replace function public.shikaku_imul(a bigint, b bigint)
returns bigint language sql immutable set search_path = '' as $$
  select ((a::numeric * b::numeric) % 4294967296)::bigint;
$$;

-- Port of idForName(): cyrb128('shikaku:' + normName(name)) over UTF-16 code
-- units, formatted as a v4 UUID. Must stay byte-for-byte equal to js/app.js
-- (tools/sql.test.js checks it against the real JS for a range of names).
create or replace function public.shikaku_id_for_name(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
declare
  s  text := 'shikaku:' || public.shikaku_name_key(p_name);
  h1 bigint := 1779033703; h2 bigint := 3144134277;
  h3 bigint := 1013904242; h4 bigint := 2773480762;
  cp integer; k bigint; units bigint[] := '{}'; hx text; b6 integer; b8 integer;
begin
  for i in 1 .. char_length(s) loop
    cp := ascii(substr(s, i, 1));
    if cp > 65535 then   -- astral character: JS sees a surrogate pair
      units := units || (55296 + ((cp - 65536) >> 10))::bigint || (56320 + ((cp - 65536) & 1023))::bigint;
    else
      units := units || cp::bigint;
    end if;
  end loop;
  foreach k in array units loop
    h1 := h2 # public.shikaku_imul(h1 # k, 597399067);
    h2 := h3 # public.shikaku_imul(h2 # k, 2869860233);
    h3 := h4 # public.shikaku_imul(h3 # k, 951274213);
    h4 := h1 # public.shikaku_imul(h4 # k, 2716044179);
  end loop;
  h1 := public.shikaku_imul(h3 # (h1 >> 18), 597399067);
  h2 := public.shikaku_imul(h4 # (h2 >> 22), 2869860233);
  h3 := public.shikaku_imul(h1 # (h3 >> 17), 951274213);
  h4 := public.shikaku_imul(h2 # (h4 >> 19), 2716044179);
  hx := lpad(to_hex(h1 # h2 # h3 # h4), 8, '0') || lpad(to_hex(h2), 8, '0')
     || lpad(to_hex(h3), 8, '0') || lpad(to_hex(h4), 8, '0');
  b6 := (('x' || substr(hx, 13, 2))::bit(8)::integer & 15) | 64;    -- version 4
  b8 := (('x' || substr(hx, 17, 2))::bit(8)::integer & 63) | 128;   -- variant
  hx := substr(hx, 1, 12) || lpad(to_hex(b6), 2, '0') || substr(hx, 15, 2)
     || lpad(to_hex(b8), 2, '0') || substr(hx, 19);
  return hx::uuid;
end;
$$;

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
  if p_id <> public.shikaku_id_for_name(v_name) then
    raise exception 'shikaku: id does not belong to this name';
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

revoke all on function public.shikaku_imul(bigint, bigint) from public, anon, authenticated;
revoke all on function public.shikaku_id_for_name(text) from public, anon, authenticated;
