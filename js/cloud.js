/* ============================================================================
   Cloud layer — thin wrapper around Supabase.

   Degrades gracefully: if no anon key is configured (or the SDK fails to load)
   `Cloud.enabled` is false and every method becomes a safe no-op, so the game
   stays fully playable offline. Identity is the username itself: the app derives
   a deterministic id from the (case-insensitive) name, so one name = one row =
   one leaderboard entry, recoverable on any device by re-entering the name.
   ============================================================================ */
const Cloud = (() => {
  const cfg = window.SHIKAKU_CONFIG || {};
  let client = null;
  let enabled = false;

  function init(){
    const hasSdk = typeof window.supabase !== 'undefined' && window.supabase.createClient;
    if (hasSdk && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY){
      try {
        client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
          auth: { persistSession: false }
        });
        enabled = true;
      } catch (e){ console.warn('Supabase init failed:', e); enabled = false; }
    }
    return enabled;
  }

  // ---- Writes ------------------------------------------------------------
  // The tables are read-only for the public key (the shared Games project locks
  // them down), so every write goes through a validated SECURITY DEFINER
  // function — see supabase/migrations/*_shikaku_secure_write_rpcs.sql.
  // Failures are reported (window 'cloud-write' event) instead of vanishing.
  // Each save has a key (function + level slot); a failure stays reported until
  // that same save succeeds, so an unrelated success can't hide it.
  const failed = new Set();
  const notify = (detail) => window.dispatchEvent(new CustomEvent('cloud-write', { detail }));
  async function write(fn, args, key){
    if (!enabled) return false;
    key = key || fn;
    try {
      const { error } = await client.rpc(fn, args);
      if (error) throw error;
      if (failed.delete(key) && !failed.size) notify({ ok: true });
      return true;
    } catch (e){
      console.warn(fn, e && e.message);
      const first = !failed.size;
      failed.add(key);
      if (first) notify({ ok: false, fn, message: e && e.message });
      return false;
    }
  }

  // ---- Profiles ----------------------------------------------------------
  // Server keeps counters monotonic and never deletes rows; the leaderboard
  // collapses same-name rows when reading.
  async function upsertProfile(p){
    return write('shikaku_save_profile', {
      p_id: p.id, p_username: p.username, p_avatar: p.avatar, p_theme: p.theme,
      p_accent: p.accent || null, p_total_score: p.total_score|0, p_best_world: p.best_world|0,
      p_wins: p.wins|0, p_losses: p.losses|0
    });
  }
  async function getProfile(id){
    if (!enabled) return null;
    const { data } = await client.from('profiles').select('*').eq('id', id).maybeSingle();
    return data;
  }
  // All profile rows sharing a username (case-insensitive). Used to collapse
  // duplicates created before usernames became the identity.
  async function findProfilesByName(name){
    if (!enabled) return [];
    const { data } = await client.from('profiles').select('*').ilike('username', name);
    const n = (name || '').trim().toLowerCase();
    return (data || []).filter(r => (r.username || '').trim().toLowerCase() === n);
  }
  // ---- Scores ------------------------------------------------------------
  // Server keeps the best score and fastest time per (player, world, level);
  // time_sec 0 means unknown and never beats a real time.
  async function saveScore(s){
    return write('shikaku_save_score', {
      p_player_id: s.player_id, p_username: s.username, p_world: s.world, p_level: s.level,
      p_score: s.score|0, p_stars: s.stars||1, p_time_sec: s.time_sec|0, p_moves: s.moves|0
    }, 'score:' + s.world + ':' + s.level);
  }
  async function getScores(id){
    if (!enabled) return [];
    const { data } = await client.from('scores').select('world,level,score,stars,time_sec').eq('player_id', id);
    return data || [];
  }

  // ---- Daily Challenge race ----------------------------------------------
  // Daily results live in the same `scores` table: world = the YYYYMMDD day
  // number, level = 0. The server keeps each player's fastest time for the day.
  async function saveDaily(s){
    return saveScore({ player_id: s.player_id, username: s.username, world: s.day, level: 0,
      score: s.score, stars: s.stars, time_sec: s.time_sec, moves: s.moves });
  }
  // Today's race: everyone who solved the same daily, fastest time first.
  async function topDaily(day, limit = 50){
    if (!enabled) return null;
    const { data } = await client.from('scores')
      .select('player_id,username,time_sec,score')
      .eq('world', day).eq('level', 0).gt('time_sec', 0)   // 0 = unknown time
      .order('time_sec', { ascending: true }).limit(limit);
    return data || [];
  }

  // ---- Leaderboards ------------------------------------------------------
  async function topQuest(limit = 25){
    if (!enabled) return null;
    const { data } = await client.from('profiles')
      .select('id,username,avatar,total_score,best_world')
      .order('total_score', { ascending: false }).limit(limit);
    return data || [];
  }
  async function topBattle(limit = 25){
    if (!enabled) return null;
    const { data } = await client.from('profiles')
      .select('id,username,avatar,wins,losses')
      .order('wins', { ascending: false }).limit(limit);
    return data || [];
  }

  // ---- Rank --------------------------------------------------------------
  // Returns { rank, total } for the player on the given board ("quest" by
  // total_score, "battle" by wins). Rank = how many players score strictly
  // higher, plus one. Uses head:true count queries (no rows transferred).
  async function myRank(board, id){
    if (!enabled) return null;
    const col = board === 'battle' ? 'wins' : 'total_score';
    const me = await getProfile(id);
    if (!me) return null;
    const myVal = me[col] || 0;
    const ahead = await client.from('profiles')
      .select('id', { count: 'exact', head: true })
      .gt(col, myVal);
    const all = await client.from('profiles')
      .select('id', { count: 'exact', head: true });
    if (ahead.error || all.error) return null;
    return { rank: (ahead.count || 0) + 1, total: all.count || 0, value: myVal };
  }

  // ---- Analytics ---------------------------------------------------------
  // Fire-and-forget event log. Never throws, never blocks gameplay; silent
  // no-op when offline. `props` is small JSON context.
  function track(name, props){
    if (!enabled) return;
    try {
      const Pl = window.Player && window.Player.data;
      client.rpc('shikaku_track', {
        // events can fire before a legacy device id is migrated: only send UUIDs
        p_player_id: (Pl && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(Pl.id)) ? Pl.id : null,
        p_username: (Pl && Pl.username) || null,
        p_name: String(name).slice(0, 40),
        p_props: props || {}
      }).then(() => {}, () => {});
    } catch (e) { /* analytics must never break the game */ }
  }

  // ---- Realtime multiplayer channel -------------------------------------
  function channel(code){
    if (!enabled) return null;
    return client.channel('match:' + code, { config: { broadcast: { self: false }, presence: { key: code } } });
  }

  return { init, get enabled(){ return enabled; }, get client(){ return client; }, track,
    upsertProfile, getProfile, findProfilesByName,
    get writeOk(){ return failed.size === 0; },
    saveScore, getScores, topQuest, topBattle, myRank,
    saveDaily, topDaily, channel };
})();
window.Cloud = Cloud;
