-- ============================================================================
-- Shikaku: normalise names exactly like the client's normName().
--
-- normName() is name.trim().toLowerCase().replace(/\s+/g, ' '). JavaScript's
-- trim() and \s use a fixed whitespace set (including U+FEFF, U+00A0, U+3000
-- …), while Postgres' btrim() strips only spaces and its \s depends on the
-- locale. A name like "Neon<U+FEFF>Ninja" therefore got a different key on the
-- server, so shikaku_id_for_name() disagreed with the browser's id and every
-- save for that name was rejected. Use JavaScript's exact set here.
-- ============================================================================
create or replace function public.shikaku_name_key(p_name text)
returns text language sql immutable set search_path = '' as $$
  -- [\t\n\v\f\r    -     　﻿]
  -- = ECMAScript WhiteSpace + LineTerminator, i.e. what trim() and \s match.
  select lower(regexp_replace(
           regexp_replace(coalesce(p_name, ''),
             '^[\t\n\u000b\f\r    -     　﻿]+|[\t\n\u000b\f\r    -     　﻿]+$',
             '', 'g'),
           '[\t\n\u000b\f\r    -     　﻿]+', ' ', 'g'));
$$;
revoke all on function public.shikaku_name_key(text) from public, anon, authenticated;
