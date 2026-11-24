-- ============================================================================
-- Shikaku: after the 10 free games, a subscriber can start one more for a
-- play credit. It is a separate call, so a credit is only spent on request.
-- The email session must own the name: a 4-digit PIN cannot spend credits.
-- ============================================================================

create or replace function public.shikaku_start_extra_game(
  p_token text, p_request_id text, p_kind text, p_world integer, p_level integer)
returns table (status text, ticket text, credits integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := public.shikaku_player();
  v_key    text := public.shikaku_session_name(p_token);
  v_ticket text;
  v_row    public.shikaku_game_starts;
begin
  if v_key is null or not exists (
    select 1 from public.shikaku_email_links l where l.user_id = v_uid and l.name_key = v_key) then
    raise exception 'shikaku: not signed in';
  end if;
  if coalesce(p_request_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'shikaku: invalid request';
  end if;
  if p_kind is null or p_kind not in ('quest', 'daily', 'endless')
     or (p_kind in ('quest', 'daily')) <> (p_world is not null and p_level is not null)
     or (p_kind = 'quest' and not (p_world between 0 and 99 and p_level between 0 and 99))
     or (p_kind = 'daily' and not (p_world between 20200101 and 21001231 and p_level = 0)) then
    raise exception 'shikaku: invalid game';
  end if;

  perform 1 from public.shikaku_accounts where name_key = v_key for update;
  perform public.shikaku_lock_player(v_uid);
  v_ticket := public.shikaku_sha256('ticket|' || p_token || '|' || p_request_id);

  select * into v_row from public.shikaku_game_starts
   where name_key = v_key and request_hash = public.shikaku_sha256(p_request_id);
  if found then
    if v_row.ticket_hash <> public.shikaku_sha256(v_ticket) or v_row.kind <> p_kind
       or v_row.world is distinct from p_world or v_row.level is distinct from p_level then
      raise exception 'shikaku: request id already used';
    end if;
    return query select 'ok'::text, v_ticket, public.shikaku_credit_balance(v_uid);
    return;
  end if;
  if public.shikaku_used_today(v_key) < public.shikaku_free_daily_games() then
    return query select 'free'::text, null::text, public.shikaku_credit_balance(v_uid);
    return;
  end if;
  if public.shikaku_credit_balance(v_uid) < 1 then
    return query select 'no_credits'::text, null::text, public.shikaku_credit_balance(v_uid);
    return;
  end if;

  insert into public.shikaku_game_starts (ticket_hash, name_key, request_hash, kind, world, level)
  values (public.shikaku_sha256(v_ticket), v_key, public.shikaku_sha256(p_request_id), p_kind, p_world, p_level);
  insert into public.shikaku_credit_ledger (id, user_id, delta, kind, ref)
  values ('spend:' || public.shikaku_sha256(v_ticket), v_uid, -1, 'spend', 'extra-game');
  return query select 'ok'::text, v_ticket, public.shikaku_credit_balance(v_uid);
end;
$$;

revoke all on function public.shikaku_start_extra_game(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.shikaku_start_extra_game(text, text, text, integer, integer) to authenticated;
