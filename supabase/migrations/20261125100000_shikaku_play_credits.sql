-- ============================================================================
-- Shikaku: play credits, trophies and ranked matches for subscribers.
--
-- Play credits are bought with the subscription and can only be SPENT: one per
-- player when a ranked match starts, whoever wins. They cannot be won, staked,
-- moved to another player or cashed out. No function here can move credits
-- between players, and the ledger has no kind for it.
--
-- Trophies are free. Winners gain them and losers drop them. They cannot be
-- bought, spent or exchanged, so a match has no entry fee that buys a prize.
--
-- Everything paid belongs to the email account (auth.users), never to the PIN
-- or the name: resetting a forgotten PIN must not touch what someone paid for.
--
-- The server makes the puzzle, hides it until the match starts and checks the
-- solution, so a browser cannot claim a win. It cannot stop someone from using
-- a solver, which is one reason nothing of value is won.
-- ============================================================================

create table if not exists public.shikaku_customers (
  user_id            uuid primary key references auth.users (id) on delete restrict,
  stripe_customer_id text not null unique
);

create table if not exists public.shikaku_subscriptions (
  stripe_subscription_id text primary key,
  user_id                uuid not null references auth.users (id) on delete restrict,
  status                 text not null,
  cancel_at_period_end   boolean not null,
  current_period_end     timestamptz,
  seen_at                timestamptz not null       -- when this state was read from Stripe
);
create index if not exists shikaku_subscriptions_user_idx on public.shikaku_subscriptions (user_id);

-- Append-only. The balance is the sum of delta.
create table if not exists public.shikaku_credit_ledger (
  id         text primary key,                      -- names the cause, so it can happen only once
  user_id    uuid not null references auth.users (id) on delete restrict,
  delta      integer not null,
  kind       text not null check (kind in ('grant', 'spend', 'clawback', 'restore')),
  ref        text not null,                         -- Stripe invoice id or match id
  created_at timestamptz not null default now(),
  check ((kind in ('grant', 'restore')) = (delta > 0))
);
create index if not exists shikaku_credit_ledger_user_idx on public.shikaku_credit_ledger (user_id);
create index if not exists shikaku_credit_ledger_ref_idx on public.shikaku_credit_ledger (ref);

-- How many of an invoice's credits its refund and its dispute take back now.
create table if not exists public.shikaku_clawbacks (
  invoice_id text not null,
  source     text not null check (source in ('refund', 'dispute')),
  credits    integer not null check (credits >= 0),
  seen_at    timestamptz not null,
  primary key (invoice_id, source)
);

create table if not exists public.shikaku_trophies (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  trophies integer not null default 0 check (trophies >= 0),
  wins     integer not null default 0,
  losses   integer not null default 0
);

create table if not exists public.shikaku_matches (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  size       integer not null check (size between 5 and 8),
  host       uuid not null references auth.users (id) on delete cascade,
  guest      uuid references auth.users (id) on delete cascade,
  puzzle     jsonb,
  status     text not null default 'open' check (status in ('open', 'playing', 'done', 'cancelled')),
  winner     uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  check (guest is null or guest <> host)
);
create unique index if not exists shikaku_matches_open_code_idx on public.shikaku_matches (code) where status = 'open';
create index if not exists shikaku_matches_host_idx on public.shikaku_matches (host) where status in ('open', 'playing');
create index if not exists shikaku_matches_guest_idx on public.shikaku_matches (guest) where status in ('open', 'playing');

do $$
declare t text;
begin
  foreach t in array array['shikaku_customers', 'shikaku_subscriptions', 'shikaku_credit_ledger',
                           'shikaku_clawbacks', 'shikaku_trophies', 'shikaku_matches'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ helpers --

create or replace function public.shikaku_credit_balance(p_user uuid)
returns integer language sql stable set search_path = '' as $$
  select coalesce(sum(delta), 0)::integer from public.shikaku_credit_ledger where user_id = p_user;
$$;

-- The signed-in email account, which must be linked to a name.
create or replace function public.shikaku_player()
returns uuid language plpgsql stable set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'shikaku: not signed in with email'; end if;
  if not exists (select 1 from public.shikaku_email_links where user_id = v_uid) then
    raise exception 'shikaku: email is not linked to a name';
  end if;
  return v_uid;
end;
$$;

-- Serialises everything that changes a player's credits or matches.
create or replace function public.shikaku_lock_player(p_user uuid)
returns void language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('shikaku-player:' || p_user::text, 0));
$$;

-- Random tiling by repeated splitting, then one clue per rectangle.
create or replace function public.shikaku_new_puzzle(p_size integer)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare
  v_max  integer := p_size + 2;
  v_todo jsonb := jsonb_build_array(jsonb_build_array(0, 0, p_size, p_size));
  v_grid jsonb := (select jsonb_agg((select jsonb_agg(0) from generate_series(1, p_size))) from generate_series(1, p_size));
  v_rect jsonb; r integer; c integer; h integer; w integer; k integer; v_across boolean;
begin
  while jsonb_array_length(v_todo) > 0 loop
    v_rect := v_todo -> 0; v_todo := v_todo - 0;
    r := (v_rect ->> 0)::integer; c := (v_rect ->> 1)::integer;
    h := (v_rect ->> 2)::integer; w := (v_rect ->> 3)::integer;
    if h * w > v_max or (h * w >= 6 and random() < 0.35) then
      v_across := case when h < 2 then false when w < 2 then true else random() < h::float / (h + w) end;
      if v_across then
        k := 1 + floor(random() * (h - 1))::integer;
        v_todo := v_todo || jsonb_build_array(jsonb_build_array(r, c, k, w), jsonb_build_array(r + k, c, h - k, w));
      else
        k := 1 + floor(random() * (w - 1))::integer;
        v_todo := v_todo || jsonb_build_array(jsonb_build_array(r, c, h, k), jsonb_build_array(r, c + k, h, w - k));
      end if;
    else
      v_grid := jsonb_set(v_grid, array[(r + floor(random() * h)::integer)::text, (c + floor(random() * w)::integer)::text], to_jsonb(h * w));
    end if;
  end loop;
  return v_grid;
end;
$$;

-- True when the rectangles cover every cell once and each holds exactly one
-- clue equal to its area.
create or replace function public.shikaku_is_solution(p_puzzle jsonb, p_rects jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  n integer := jsonb_array_length(p_puzzle);
  v_seen boolean[] := array_fill(false, array[n * n]);
  v_rect jsonb; v_key text; r0 integer; c0 integer; r1 integer; c1 integer;
  v_clue integer; v_cell integer; v_covered integer := 0;
begin
  if p_rects is null or jsonb_typeof(p_rects) <> 'array' or jsonb_array_length(p_rects) not between 1 and n * n then
    return false;
  end if;
  for v_rect in select value from jsonb_array_elements(p_rects) loop
    if jsonb_typeof(v_rect) <> 'object' then return false; end if;
    foreach v_key in array array['r0', 'c0', 'r1', 'c1'] loop
      if coalesce(v_rect ->> v_key, '') !~ '^[0-9]$' then return false; end if;
    end loop;
    r0 := (v_rect ->> 'r0')::integer; c0 := (v_rect ->> 'c0')::integer;
    r1 := (v_rect ->> 'r1')::integer; c1 := (v_rect ->> 'c1')::integer;
    if r0 > r1 or c0 > c1 or r1 >= n or c1 >= n then return false; end if;
    v_clue := 0;
    for r in r0 .. r1 loop for c in c0 .. c1 loop
      if v_seen[r * n + c + 1] then return false; end if;
      v_seen[r * n + c + 1] := true; v_covered := v_covered + 1;
      v_cell := (p_puzzle -> r ->> c)::integer;
      if v_cell > 0 then
        if v_clue > 0 then return false; end if;
        v_clue := v_cell;
      end if;
    end loop; end loop;
    if v_clue <> (r1 - r0 + 1) * (c1 - c0 + 1) then return false; end if;
  end loop;
  return v_covered = n * n;
end;
$$;

create or replace function public.shikaku_result_for(p_match public.shikaku_matches, p_user uuid)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_match.status = 'cancelled' then 'cancelled'
    when p_match.status <> 'done' then null
    when p_match.winner is null then 'draw'
    when p_match.winner = p_user then 'won'
    else 'lost' end;
$$;

-- Closes matches nobody finished. A started match ends as a draw.
create or replace function public.shikaku_expire_match(p_id uuid)
returns void language sql set search_path = '' as $$
  update public.shikaku_matches set
    status = case when status = 'open' then 'cancelled' else 'done' end
  where id = p_id
    and ((status = 'open' and created_at < now() - interval '30 minutes')
      or (status = 'playing' and started_at < now() - interval '30 minutes'));
$$;

-- Locks the match for a player in it and returns it.
create or replace function public.shikaku_lock_match(p_id uuid, p_user uuid)
returns public.shikaku_matches language plpgsql set search_path = '' as $$
declare m public.shikaku_matches;
begin
  perform 1 from public.shikaku_matches where id = p_id and p_user in (host, guest) for update;
  if not found then raise exception 'shikaku: no such match'; end if;
  perform public.shikaku_expire_match(p_id);
  select * into m from public.shikaku_matches where id = p_id;
  return m;
end;
$$;

-- The caller holds the match lock, so a match is settled once.
create or replace function public.shikaku_settle_match(m public.shikaku_matches, p_winner uuid)
returns void language plpgsql set search_path = '' as $$
declare v_loser uuid := case when p_winner = m.host then m.guest else m.host end;
begin
  update public.shikaku_matches set status = 'done', winner = p_winner where id = m.id;
  insert into public.shikaku_trophies (user_id) values (least(p_winner, v_loser)), (greatest(p_winner, v_loser))
    on conflict (user_id) do nothing;
  perform 1 from public.shikaku_trophies where user_id in (p_winner, v_loser) order by user_id for update;
  update public.shikaku_trophies set trophies = trophies + 10, wins = wins + 1 where user_id = p_winner;
  update public.shikaku_trophies set trophies = greatest(trophies - 10, 0), losses = losses + 1 where user_id = v_loser;
end;
$$;

-- --------------------------------------------------------- called by players --

create or replace function public.shikaku_play_status()
returns table (credits integer, trophies integer, wins integer, losses integer,
               subscription_status text, cancel_at_period_end boolean, current_period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := public.shikaku_player();
begin
  return query
  select public.shikaku_credit_balance(v_uid), coalesce(t.trophies, 0), coalesce(t.wins, 0), coalesce(t.losses, 0),
         s.status, s.cancel_at_period_end, s.current_period_end
  from (select 1) one
  left join public.shikaku_trophies t on t.user_id = v_uid
  left join lateral (
    select * from public.shikaku_subscriptions x where x.user_id = v_uid
    order by (x.status in ('active', 'trialing', 'past_due', 'unpaid')) desc, x.seen_at desc limit 1) s on true;
end;
$$;

create or replace function public.shikaku_match_create(p_size integer)
returns table (match_id uuid, code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.shikaku_player();
  v_letters constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text; v_id uuid; m record;
begin
  if p_size is null or p_size not between 5 and 8 then raise exception 'shikaku: invalid size'; end if;
  perform public.shikaku_lock_player(v_uid);
  for m in select id from public.shikaku_matches where v_uid in (host, guest) and status = 'playing' loop
    perform public.shikaku_expire_match(m.id);
  end loop;
  if exists (select 1 from public.shikaku_matches x where v_uid in (x.host, x.guest) and x.status = 'playing') then
    raise exception 'shikaku: already in a match';
  end if;
  if public.shikaku_credit_balance(v_uid) < 1 then raise exception 'shikaku: no play credits'; end if;
  update public.shikaku_matches x set status = 'cancelled' where x.host = v_uid and x.status = 'open';
  for i in 1 .. 20 loop
    v_code := (select string_agg(substr(v_letters, 1 + floor(random() * 32)::integer, 1), '') from generate_series(1, 6));
    begin
      insert into public.shikaku_matches (code, size, host) values (v_code, p_size, v_uid) returning id into v_id;
      return query select v_id, v_code;
      return;
    exception when unique_violation then null;   -- code in use, draw another
    end;
  end loop;
  raise exception 'shikaku: try again';
end;
$$;

-- Starts the match: both players pay one credit, or neither does.
create or replace function public.shikaku_match_join(p_code text)
returns table (match_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.shikaku_player();
  v_code text := upper(btrim(coalesce(p_code, '')));
  m public.shikaku_matches;
begin
  -- a retried join (lost reply) finds the match it already started
  select * into m from public.shikaku_matches x
    where x.code = v_code and x.guest = v_uid and x.status = 'playing' order by x.started_at desc limit 1;
  if found then return query select m.id; return; end if;

  select * into m from public.shikaku_matches x where x.code = v_code and x.status = 'open' and x.host <> v_uid;
  if not found then raise exception 'shikaku: match not found'; end if;
  -- always in the same order, so two joins cannot wait for each other
  perform public.shikaku_lock_player(least(m.host, v_uid));
  perform public.shikaku_lock_player(greatest(m.host, v_uid));
  select * into m from public.shikaku_matches x where x.id = m.id for update;
  perform public.shikaku_expire_match(m.id);
  select * into m from public.shikaku_matches x where x.id = m.id;
  if m.status = 'playing' and m.guest = v_uid then return query select m.id; return; end if;
  if m.status <> 'open' then raise exception 'shikaku: match not found'; end if;
  if exists (select 1 from public.shikaku_matches x
             where x.status = 'playing' and x.started_at >= now() - interval '30 minutes'
               and (m.host in (x.host, x.guest) or v_uid in (x.host, x.guest))) then
    raise exception 'shikaku: already in a match';
  end if;
  if public.shikaku_credit_balance(v_uid) < 1 then raise exception 'shikaku: no play credits'; end if;
  if public.shikaku_credit_balance(m.host) < 1 then raise exception 'shikaku: opponent has no play credits'; end if;

  insert into public.shikaku_credit_ledger (id, user_id, delta, kind, ref) values
    ('spend:' || m.id || ':host',  m.host, -1, 'spend', m.id::text),
    ('spend:' || m.id || ':guest', v_uid,  -1, 'spend', m.id::text);
  update public.shikaku_matches x set guest = v_uid, status = 'playing', started_at = now(),
    puzzle = public.shikaku_new_puzzle(m.size) where x.id = m.id;
  update public.shikaku_matches x set status = 'cancelled' where x.host = v_uid and x.status = 'open';
  return query select m.id;
end;
$$;

create or replace function public.shikaku_match_state(p_match uuid)
returns table (status text, result text, puzzle jsonb, opponent text, started_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.shikaku_player(); m public.shikaku_matches;
begin
  m := public.shikaku_lock_match(p_match, v_uid);
  return query select m.status, public.shikaku_result_for(m, v_uid), m.puzzle,
    (select l.display_name from public.shikaku_email_links l
      where l.user_id = case when v_uid = m.host then m.guest else m.host end), m.started_at;
end;
$$;

-- status: won | lost | draw | cancelled (the match is over) or wrong (keep playing)
create or replace function public.shikaku_match_finish(p_match uuid, p_rects jsonb)
returns table (status text)
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.shikaku_player(); m public.shikaku_matches;
begin
  m := public.shikaku_lock_match(p_match, v_uid);
  if m.status = 'playing' then
    if not public.shikaku_is_solution(m.puzzle, p_rects) then return query select 'wrong'::text; return; end if;
    perform public.shikaku_settle_match(m, v_uid);
    return query select 'won'::text; return;
  end if;
  return query select coalesce(public.shikaku_result_for(m, v_uid), 'wrong');
end;
$$;

-- Leaving a started match gives the other player the win.
create or replace function public.shikaku_match_leave(p_match uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.shikaku_player(); m public.shikaku_matches;
begin
  m := public.shikaku_lock_match(p_match, v_uid);
  if m.status = 'open' then
    update public.shikaku_matches set status = 'cancelled' where id = m.id;
  elsif m.status = 'playing' then
    perform public.shikaku_settle_match(m, case when v_uid = m.host then m.guest else m.host end);
  end if;
end;
$$;

create or replace function public.shikaku_top_trophies()
returns table (username text, trophies integer, wins integer, losses integer)
language sql stable security definer set search_path = '' as $$
  select l.display_name, t.trophies, t.wins, t.losses
  from public.shikaku_trophies t join public.shikaku_email_links l on l.user_id = t.user_id
  where t.trophies > 0 order by t.trophies desc, t.wins desc, l.display_name limit 100;
$$;

-- --------------------------- called by the Stripe functions (service_role) --

create or replace function public.shikaku_billing_account(p_user uuid)
returns table (linked boolean, stripe_customer_id text, open_subscription_id text)
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.shikaku_email_links where user_id = p_user),
         (select c.stripe_customer_id from public.shikaku_customers c where c.user_id = p_user),
         (select s.stripe_subscription_id from public.shikaku_subscriptions s
           where s.user_id = p_user and s.status in ('active', 'trialing', 'past_due', 'unpaid')
           order by s.seen_at desc limit 1);
$$;

create or replace function public.shikaku_save_customer(p_user uuid, p_customer text)
returns void language sql security definer set search_path = '' as $$
  insert into public.shikaku_customers (user_id, stripe_customer_id) values (p_user, p_customer)
  on conflict (user_id) do nothing;
$$;

create or replace function public.shikaku_customer_user(p_customer text)
returns uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.shikaku_customers where stripe_customer_id = p_customer;
$$;

-- Events can arrive late or together, so the newest reading wins.
create or replace function public.shikaku_save_subscription(
  p_subscription text, p_user uuid, p_status text, p_cancel boolean, p_period_end timestamptz, p_seen timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into public.shikaku_subscriptions as s
    (stripe_subscription_id, user_id, status, cancel_at_period_end, current_period_end, seen_at)
  values (p_subscription, p_user, p_status, p_cancel, p_period_end, p_seen)
  on conflict (stripe_subscription_id) do update set
    status = excluded.status, cancel_at_period_end = excluded.cancel_at_period_end,
    current_period_end = excluded.current_period_end, seen_at = excluded.seen_at
  where excluded.seen_at >= s.seen_at;
$$;

create or replace function public.shikaku_grant_credits(p_invoice text, p_user uuid, p_credits integer)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_invoice, '') = '' or p_credits is null or p_credits < 1 then raise exception 'shikaku: invalid grant'; end if;
  insert into public.shikaku_credit_ledger (id, user_id, delta, kind, ref)
  values ('grant:' || p_invoice, p_user, p_credits, 'grant', p_invoice) on conflict (id) do nothing;
  return found;
end;
$$;

-- Sets how many credits a refund or dispute takes back now, and books only the
-- difference. Returns false when the invoice's credits are not granted yet.
create or replace function public.shikaku_set_clawback(p_invoice text, p_source text, p_credits integer, p_seen timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_grant public.shikaku_credit_ledger; v_taken integer; v_want integer; v_diff integer;
begin
  select * into v_grant from public.shikaku_credit_ledger where id = 'grant:' || p_invoice for update;
  if not found then return false; end if;
  perform public.shikaku_lock_player(v_grant.user_id);

  insert into public.shikaku_clawbacks as b (invoice_id, source, credits, seen_at)
  values (p_invoice, p_source, p_credits, p_seen)
  on conflict (invoice_id, source) do update set credits = excluded.credits, seen_at = excluded.seen_at
  where excluded.seen_at >= b.seen_at;

  select least(coalesce(sum(credits), 0), v_grant.delta)::integer into v_want from public.shikaku_clawbacks where invoice_id = p_invoice;
  select coalesce(-sum(delta), 0)::integer into v_taken from public.shikaku_credit_ledger
    where ref = p_invoice and kind in ('clawback', 'restore');
  v_diff := v_want - v_taken;
  if v_diff <> 0 then
    insert into public.shikaku_credit_ledger (id, user_id, delta, kind, ref)
    values ('adjust:' || p_invoice || ':' || gen_random_uuid(), v_grant.user_id, -v_diff,
            case when v_diff > 0 then 'clawback' else 'restore' end, p_invoice);
  end if;
  return true;
end;
$$;

-- ------------------------------------------------------------------- grants --

do $$
declare
  f regprocedure;
  v_players constant text[] := array['shikaku_play_status', 'shikaku_match_create', 'shikaku_match_join',
    'shikaku_match_state', 'shikaku_match_finish', 'shikaku_match_leave'];
  v_stripe constant text[] := array['shikaku_billing_account', 'shikaku_save_customer', 'shikaku_customer_user',
    'shikaku_save_subscription', 'shikaku_grant_credits', 'shikaku_set_clawback'];
  v_internal constant text[] := array['shikaku_credit_balance', 'shikaku_player', 'shikaku_lock_player', 'shikaku_new_puzzle',
    'shikaku_is_solution', 'shikaku_result_for', 'shikaku_expire_match', 'shikaku_lock_match', 'shikaku_settle_match'];
  v_has_service boolean := exists (select 1 from pg_roles where rolname = 'service_role');
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (v_players || v_stripe || v_internal || array['shikaku_top_trophies']) loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (v_players) loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  grant execute on function public.shikaku_top_trophies() to anon, authenticated;
  if v_has_service then
    for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = any (v_stripe) loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;
