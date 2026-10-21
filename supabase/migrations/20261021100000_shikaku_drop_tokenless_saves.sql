-- ============================================================================
-- Shikaku: remove the token-less save functions.
--
-- Apply AFTER the PIN client (which calls the p_token versions) is live.
-- Until then the old signatures keep older clients saving; after this, every
-- profile/score save needs a session from shikaku_claim / shikaku_login.
-- ============================================================================
drop function if exists public.shikaku_save_profile(uuid, text, text, text, text, integer, integer, integer, integer);
drop function if exists public.shikaku_save_score(uuid, text, integer, integer, integer, integer, integer, integer);
