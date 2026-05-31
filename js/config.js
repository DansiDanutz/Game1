/* ============================================================================
   Shikaku: Puzzle Quest — runtime configuration

   To enable cloud features (profiles sync, leaderboard, multiplayer) paste
   your Supabase "anon public" key below. You can find it in:
     Supabase Dashboard → Project Settings → API → Project API keys → anon public

   The anon key is SAFE to ship in client code — it only grants the access
   allowed by your Row Level Security policies (see schema.sql).

   Leave SUPABASE_ANON_KEY empty to run the game fully offline (localStorage
   only). Everything still works; cloud-only features show a gentle prompt.
   ============================================================================ */
window.SHIKAKU_CONFIG = {
  SUPABASE_URL: "https://lxhjfdxowpxzrybxdasi.supabase.co",
  SUPABASE_ANON_KEY: "" // <-- paste your anon public key here
};
