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

  // ---- Profiles ----------------------------------------------------------
  async function upsertProfile(p){
    if (!enabled) return null;
    const { data, error } = await client.from('profiles').upsert({
      id: p.id, username: p.username, avatar: p.avatar, theme: p.theme,
      accent: p.accent || null, total_score: p.total_score|0, best_world: p.best_world|0,
      wins: p.wins|0, losses: p.losses|0, updated_at: new Date().toISOString()
    }, { onConflict: 'id' }).select().single();
    if (error){ console.warn('upsertProfile', error.message); return null; }
    return data;
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
  // Delete every row for a username except the canonical one (scores cascade).
  // Resolves exact (case-insensitive) matches first, then deletes by id list so
  // wildcard characters in a name can never widen the delete.
  async function deleteProfilesByNameExcept(name, keepId){
    if (!enabled) return;
    const rows = await findProfilesByName(name);
    const ids = rows.map(r => r.id).filter(id => id !== keepId);
    if (!ids.length) return;
    const { error } = await client.from('profiles').delete().in('id', ids);
    if (error) console.warn('dedupe', error.message);
  }
  // ---- Scores ------------------------------------------------------------
  async function saveScore(s){
    if (!enabled) return;
    const { error } = await client.from('scores').upsert({
      player_id: s.player_id, username: s.username, world: s.world, level: s.level,
      score: s.score, stars: s.stars, time_sec: s.time_sec, moves: s.moves
    }, { onConflict: 'player_id,world,level' });
    if (error) console.warn('saveScore', error.message);
  }
  async function getScores(id){
    if (!enabled) return [];
    const { data } = await client.from('scores').select('world,level,score,stars').eq('player_id', id);
    return data || [];
  }

  // ---- Daily Challenge race ----------------------------------------------
  // Daily results live in the same `scores` table: world = the YYYYMMDD day
  // number, level = 0. Upsert keeps one row per player/day; we only overwrite
  // when the new time is faster (handled by the caller). No schema change.
  async function saveDaily(s){
    if (!enabled) return;
    const { error } = await client.from('scores').upsert({
      player_id: s.player_id, username: s.username, world: s.day, level: 0,
      score: s.score, stars: s.stars||1, time_sec: s.time_sec, moves: s.moves||0
    }, { onConflict: 'player_id,world,level' });
    if (error) console.warn('saveDaily', error.message);
  }
  // Today's race: everyone who solved the same daily, fastest time first.
  async function topDaily(day, limit = 50){
    if (!enabled) return null;
    const { data } = await client.from('scores')
      .select('player_id,username,time_sec,score')
      .eq('world', day).eq('level', 0)
      .order('time_sec', { ascending: true }).limit(limit);
    return data || [];
  }
  // The player's existing daily row (to know if they can improve their time).
  async function myDaily(day, id){
    if (!enabled) return null;
    const { data } = await client.from('scores')
      .select('time_sec,score').eq('world', day).eq('level', 0).eq('player_id', id).maybeSingle();
    return data;
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
      client.from('events').insert({
        player_id: (Pl && Pl.id) || null,
        username: (Pl && Pl.username) || null,
        name: String(name).slice(0, 40),
        props: props || {}
      }).then(() => {}, () => {});
    } catch (e) { /* analytics must never break the game */ }
  }

  // ---- Realtime multiplayer channel -------------------------------------
  function channel(code){
    if (!enabled) return null;
    return client.channel('match:' + code, { config: { broadcast: { self: false }, presence: { key: code } } });
  }

  return { init, get enabled(){ return enabled; }, get client(){ return client; }, track,
    upsertProfile, getProfile, findProfilesByName, deleteProfilesByNameExcept,
    saveScore, getScores, topQuest, topBattle, myRank,
    saveDaily, topDaily, myDaily, channel };
})();
window.Cloud = Cloud;
