/* ============================================================================
   Cloud layer — thin wrapper around Supabase.

   Degrades gracefully: if no anon key is configured (or the SDK fails to load)
   `Cloud.enabled` is false and every method becomes a safe no-op, so the game
   stays fully playable offline. Identity is a device UUID (no passwords).
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
  async function bumpBattle(id, won){
    if (!enabled) return;
    const prof = await getProfile(id);
    if (!prof) return;
    await client.from('profiles').update({
      wins: (prof.wins||0) + (won ? 1 : 0),
      losses: (prof.losses||0) + (won ? 0 : 1),
      updated_at: new Date().toISOString()
    }).eq('id', id);
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

  // ---- Realtime multiplayer channel -------------------------------------
  function channel(code){
    if (!enabled) return null;
    return client.channel('match:' + code, { config: { broadcast: { self: false }, presence: { key: code } } });
  }

  return { init, get enabled(){ return enabled; }, get client(){ return client; },
    upsertProfile, getProfile, bumpBattle, saveScore, topQuest, topBattle, channel };
})();
window.Cloud = Cloud;
