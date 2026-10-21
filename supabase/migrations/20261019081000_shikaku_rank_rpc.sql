-- ============================================================================
-- Shikaku: win-screen rank computed in SQL.
--
-- The client used to download profile rows and rank them in JS, which the
-- API's row cap (1000 by default) silently truncates on a large board. This
-- read-only function groups rows by case-insensitive, trimmed username with
-- the best value per name (the same grouping the leaderboard uses) and returns
-- the caller's rank, the number of distinct players and their value.
-- SECURITY INVOKER: it only reads data the public key can already select.
-- ============================================================================
create or replace function public.shikaku_rank(p_board text, p_username text)
returns table (rank integer, total integer, value integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with grouped as (
    select lower(btrim(p.username)) as k,
           max(case when p_board = 'battle' then p.wins else p.total_score end) as v
      from public.profiles p
     group by 1
  ),
  me as (
    select g.v from grouped g where g.k = lower(btrim(coalesce(p_username, '')))
  )
  select (select count(*) from grouped g where g.v > me.v)::integer + 1,
         (select count(*) from grouped)::integer,
         me.v::integer
    from me;
$$;

revoke all on function public.shikaku_rank(text, text) from public;
grant execute on function public.shikaku_rank(text, text) to anon, authenticated;
