-- ============================================================================
-- Shikaku: email sign-in (Supabase Auth one-time code), linked to a name once.
--
-- Supabase Auth proves the email with a one-time code; this project never
-- stores a password, and never stores the email either (it stays in auth.users).
-- An existing name (PIN account) is linked to ONE auth user, once:
--
--   shikaku_link_email(token, name)  needs the name's PIN session token AND an
--                                    email session (auth.uid() from the JWT)
--   shikaku_email_sign_in()          needs an email session; returns the linked
--                                    name and a NEW PIN-style session token, so
--                                    the save functions work unchanged
--
-- The client never supplies a user id. PIN sign-in keeps working for every name.
-- Rules: one email per name (name_key unique), one name per email (user_id
-- primary key). The table is private: RLS on, no grants to anon/authenticated.
-- ============================================================================

create table if not exists public.shikaku_email_links (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  name_key     text not null unique references public.shikaku_accounts (name_key) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 18),
  created_at   timestamptz not null default now()
);

alter table public.shikaku_email_links enable row level security;
revoke all on table public.shikaku_email_links from anon, authenticated;

create or replace function public.shikaku_link_email(p_token text, p_username text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_key  text := public.shikaku_name_key(p_username);
  v_name text := btrim(coalesce(p_username, ''));
begin
  if v_uid is null then
    raise exception 'shikaku: not signed in with email';
  end if;
  if public.shikaku_session_name(p_token) is distinct from v_key then
    raise exception 'shikaku: not signed in';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 18 then
    raise exception 'shikaku: invalid name';
  end if;
  if exists (select 1 from public.shikaku_email_links where user_id = v_uid) then
    raise exception 'shikaku: email already linked';
  end if;
  if exists (select 1 from public.shikaku_email_links where name_key = v_key) then
    raise exception 'shikaku: name already has an email';
  end if;
  begin
    insert into public.shikaku_email_links (user_id, name_key, display_name)
    values (v_uid, v_key, v_name);
  exception when unique_violation then
    -- two links raced for the same email or name: the loser retries and sees the rule
    raise exception 'shikaku: link conflict, try again';
  end;
end;
$$;

create or replace function public.shikaku_email_sign_in()
returns table (username text, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_link public.shikaku_email_links;
begin
  if v_uid is null then
    raise exception 'shikaku: not signed in with email';
  end if;
  select * into v_link from public.shikaku_email_links where user_id = v_uid;
  if not found then
    raise exception 'shikaku: email is not linked to a name';
  end if;
  return query select v_link.display_name, public.shikaku_new_session(v_link.name_key);
end;
$$;

revoke all on function public.shikaku_link_email(text, text) from public, anon, authenticated;
revoke all on function public.shikaku_email_sign_in() from public, anon, authenticated;
grant execute on function public.shikaku_link_email(text, text) to authenticated;
grant execute on function public.shikaku_email_sign_in() to authenticated;
