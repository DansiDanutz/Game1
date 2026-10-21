/* ============================================================================
   Cloud layer — thin wrapper around Supabase.

   Degrades gracefully: if no anon key is configured (or the SDK fails to load)
   `Cloud.enabled` is false and every method becomes a safe no-op, so the game
   stays fully playable offline. Identity is the username: the app derives a
   deterministic id from the (case-insensitive) name, so one name = one row =
   one leaderboard entry. A name is claimed with a 4-digit PIN; signing in with
   name + PIN gives a session token (kept in localStorage) that every save
   must carry, so nobody else can save under your name.
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

  // ---- Account / PIN -----------------------------------------------------
  // One session per device: { key: normalised name, token }.
  const SESSION_KEY = 'shikaku_session';
  const nameKey = (n) => (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
  function setSession(name, token){
    session = token ? { key: nameKey(name), token } : null;
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }
  const signedInAs = (name) => !!(session && session.token && session.key === nameKey(name));
  // 'new' | 'claimed' | 'locked', or null when the server can't be reached.
  async function accountStatus(name){
    if (!enabled) return null;
    const { data, error } = await client.rpc('shikaku_account_status', { p_username: name });
    return error ? null : data;
  }
  // Both resolve to { ok, status, token }: status is ok | taken | wrong | locked
  // | unknown | error. They don't sign the device in by themselves: the caller
  // installs the token with useSession() only if the player is still waiting
  // for it (they may have pressed Back while the request was in flight).
  async function claim(name, pin){
    if (!enabled) return { ok: false, status: 'error' };
    const { data, error } = await client.rpc('shikaku_claim', { p_username: name, p_pin: pin });
    if (error) return { ok: false, status: /name taken/.test(error.message || '') ? 'taken' : 'error' };
    return { ok: !!data, status: data ? 'ok' : 'error', token: data };
  }
  async function login(name, pin){
    if (!enabled) return { ok: false, status: 'error' };
    const { data, error } = await client.rpc('shikaku_login', { p_username: name, p_pin: pin });
    const r = !error && data && data[0];
    if (!r) return { ok: false, status: 'error' };
    if (r.status === 'ok' && r.token) return { ok: true, status: 'ok', token: r.token };
    return { ok: false, status: r.status };
  }
  function useSession(name, token){ setSession(name, token); }
  function signOut(){ setSession(null, null); }

  // ---- Writes ------------------------------------------------------------
  // The tables are read-only for the public key (the shared Games project locks
  // them down), so every write goes through a validated SECURITY DEFINER
  // function — see supabase/migrations/*_shikaku_secure_write_rpcs.sql.
  // Failures are reported (window 'cloud-write' event) instead of vanishing.
  // Each save has a key (function + level slot); a failure stays reported until
  // that same save succeeds, so an unrelated success can't hide it.
  // Saves need a session for the player's name; without one they are skipped
  // (not failures). If the server rejects the token, the session is dropped
  // and a 'cloud-write' event with auth:true asks the app to sign in again.
  const failed = new Set();
  const notify = (detail) => window.dispatchEvent(new CustomEvent('cloud-write', { detail }));
  async function write(fn, args, key){
    if (!enabled || !signedInAs(args.p_username)) return false;
    key = key || fn;
    try {
      const { error } = await client.rpc(fn, Object.assign({}, args, { p_token: session.token }));
      if (error && /not signed in/.test(error.message || '')){
        setSession(null, null);
        failed.clear();
        notify({ ok: false, auth: true, fn });
        return false;
      }
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
  // Returns { rank, total, value } for the player on the given board ("quest"
  // by total_score, "battle" by wins). Computed in SQL (shikaku_rank) over the
  // whole board, grouping rows by case-insensitive username with the best value
  // — exactly like the leaderboard — so neither a row cap nor a retained older
  // same-name row can skew the rank or the player count.
  async function myRank(board, id){
    if (!enabled) return null;
    const me = await getProfile(id);
    if (!me) return null;
    const { data, error } = await client.rpc('shikaku_rank', {
      p_board: board === 'battle' ? 'battle' : 'quest', p_username: me.username });
    if (error || !data || !data.length) return null;
    const r = data[0];
    return { rank: r.rank, total: r.total, value: r.value };
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
    accountStatus, claim, login, useSession, signOut, signedInAs,
    upsertProfile, getProfile, findProfilesByName,
    get writeOk(){ return failed.size === 0; },
    saveScore, getScores, topQuest, topBattle, myRank,
    saveDaily, topDaily, channel };
})();
window.Cloud = Cloud;
