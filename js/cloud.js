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
          // Paid features need the email session after a reload or a checkout.
          auth: { persistSession: true, detectSessionInUrl: false }
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
  function signOut(){ setSession(null, null); if (enabled) endEmailSession(); }

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
  // ---- Free daily games --------------------------------------------------
  // Every counted board (quest level, Daily Challenge, endless, battle) starts
  // here. The server counts it under the account's row lock and returns a
  // one-use ticket; a score save must present that ticket for the same board.
  // Puzzles are generated in the browser, so this limit decides what counts,
  // not what can be played offline: with no key the board is simply 'local'.
  // The request id is made once per start and reused on retries, so a lost
  // reply cannot cost the player a second game.
  const START_ATTEMPTS = 3;
  const SERVER_REFUSAL = /^shikaku:/;
  function newRequestId(){
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;                      // version 4
    b[8] = (b[8] & 0x3f) | 0x80;                      // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // { status: ok | limit | local | signed_out | error, ticket, gamesLeft, resetAt }
  async function startGame(kind, world, level){
    if (!enabled) return { status: 'local' };
    if (!session || !session.token) return { status: 'signed_out' };
    const args = { p_token: session.token, p_request_id: newRequestId(),
                   p_kind: kind, p_world: world, p_level: level };
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt++){
      let res;
      try { res = await client.rpc('shikaku_start_game', args); }
      catch (e) { res = { data: null, error: { message: String(e && e.message) } }; }
      const { data, error } = res;
      if (error){
        const msg = error.message || '';
        if (SERVER_REFUSAL.test(msg)){
          if (/not signed in/.test(msg)){ setSession(null, null); notify({ ok: false, auth: true, fn: 'shikaku_start_game' }); return { status: 'signed_out' }; }
          return { status: 'error' };        // refused (e.g. bad request): retrying cannot help
        }
        continue;                              // no answer from the server: retry with the same id
      }
      const row = data && data[0];
      if (!row) return { status: 'error' };
      return { status: row.status, ticket: row.ticket || null, gamesLeft: row.games_left, resetAt: row.reset_at };
    }
    return { status: 'error' };
  }
  // Games left today and the next UTC reset, or null when unknown.
  async function gameQuota(){
    if (!enabled || !session || !session.token) return null;
    try {
      const { data, error } = await client.rpc('shikaku_game_quota', { p_token: session.token });
      const row = !error && data && data[0];
      return row ? { gamesLeft: row.games_left, resetAt: row.reset_at } : null;
    } catch (e) { return null; }
  }

  // ---- Scores ------------------------------------------------------------
  // The server deals the board for a ticket, times it, checks the solution and
  // decides the score. Both calls can be repeated safely after a lost reply.
  async function ticketCall(fn, args){
    for (let attempt = 1; attempt <= START_ATTEMPTS && session; attempt++){
      const { data, error } = await client.rpc(fn, Object.assign({ p_token: session.token }, args))
        .then((r) => r, (e) => ({ error: { message: String(e && e.message) } }));
      if (!error) return (data && data[0]) || null;
      if (SERVER_REFUSAL.test(error.message || '')){
        if (/not signed in/.test(error.message)){ setSession(null, null); notify({ ok: false, auth: true, fn }); }
        return null;
      }
    }
    return null;
  }
  // The board for a ticket, or null.
  async function dealBoard(ticket){
    if (!enabled || !ticket) return null;
    const row = await ticketCall('shikaku_deal_board', { p_ticket: ticket });
    return (row && row.puzzle) || null;
  }
  // { status: ok | wrong | expired, score, stars, time }, or null when it was not saved.
  async function finishGame(g){
    if (!enabled || !g.ticket || !signedInAs(g.username)) return null;
    const row = await ticketCall('shikaku_finish_game', { p_ticket: g.ticket, p_username: g.username,
      p_rects: g.rects.map(({ r0, c0, r1, c1 }) => ({ r0, c0, r1, c1 })), p_moves: g.moves|0, p_hints: g.hints|0 });
    if (!row || row.status !== 'ok'){ notify({ ok: false, fn: 'shikaku_finish_game' }); return null; }
    return { status: row.status, score: row.score, stars: row.stars, time: row.time_sec };
  }
  async function getScores(id){
    if (!enabled) return [];
    const { data } = await client.from('scores').select('world,level,score,stars,time_sec').eq('player_id', id);
    return data || [];
  }

  // ---- Daily Challenge race ----------------------------------------------
  // Daily results live in the same `scores` table: world = the YYYYMMDD day
  // number, level = 0. The server keeps each player's fastest time for the day.
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

  // ---- Email sign-in -----------------------------------------------------
  // Supabase Auth mails a one-time code; no password is ever set. After the code
  // is verified, the Supabase session gives auth.uid() to the RPCs, which link
  // or return the account; they hand back a PIN-style session token, so saves
  // work the same way. The Supabase session stays on this device until sign-out,
  // because play credits belong to the email account: a PIN cannot spend them.
  const normEmail = (e) => String(e || '').trim().toLowerCase();
  const mapMessage = (message, table, fallback) => {
    const hit = table.find(([re]) => re.test(message || ''));
    return hit ? hit[1] : fallback;
  };
  const RATE_LIMIT = [/seconds|rate|too many/i, 'rate_limited'];
  async function endEmailSession(){
    try { await client.auth.signOut({ scope: 'local' }); } catch (e) { /* nothing to clear */ }
  }
  async function sendEmailCode(email){
    if (!enabled) return { ok: false, status: 'offline' };
    const { error } = await client.auth.signInWithOtp({
      email: normEmail(email), options: { shouldCreateUser: true } });
    if (error) return { ok: false, status: mapMessage(error.message, [RATE_LIMIT, [/invalid|format/i, 'invalid_email']], 'error') };
    return { ok: true, status: 'sent' };
  }
  async function verifyEmailCode(email, code){
    if (!enabled) return { ok: false, status: 'offline' };
    const { error } = await client.auth.verifyOtp({ email: normEmail(email), token: String(code || '').trim(), type: 'email' });
    if (error) return { ok: false, status: mapMessage(error.message, [RATE_LIMIT], 'bad_code') };
    return { ok: true, status: 'verified' };
  }
  // Link the signed-in name to the verified email (once, for both).
  async function linkEmail(name){
    if (!enabled || !signedInAs(name)) return { ok: false, status: 'signed_out' };
    let linked = false;
    try {
      const { error } = await client.rpc('shikaku_link_email', { p_token: session.token, p_username: name });
      if (error) return { ok: false, status: mapMessage(error.message, [
        [/already linked/, 'email_linked'], [/already has an email/, 'name_has_email'],
        [/not signed in with email/, 'no_email_session'], [/not signed in/, 'signed_out']], 'error') };
      linked = true;
      return { ok: true, status: 'linked' };
    } finally { if (!linked) await endEmailSession(); }
  }
  // Sign in with a verified, linked email: { ok, name, token } on success.
  async function emailSignIn(){
    if (!enabled) return { ok: false, status: 'offline' };
    let row = null;
    try {
      const { data, error } = await client.rpc('shikaku_email_sign_in');
      if (error) return { ok: false, status: mapMessage(error.message, [
        [/not linked/, 'unlinked'], [/not signed in with email/, 'no_email_session']], 'error') };
      row = data && data[0];
      return row ? { ok: true, status: 'ok', name: row.username, token: row.token } : { ok: false, status: 'error' };
    } finally { if (!row) await endEmailSession(); }
  }

  // ---- Shikaku Plus: play credits and ranked matches --------------------
  // { data } or { error: 'plain reason from the server', or 'offline' }.
  async function plus(fn, args){
    if (!enabled) return { error: 'offline' };
    try {
      const { data, error } = await client.rpc(fn, args || {});
      if (error) return { error: SERVER_REFUSAL.test(error.message || '') ? error.message.replace(SERVER_REFUSAL, '').trim()
        : error.code === '42501' ? 'not signed in with email' : 'offline' };
      return { data: Array.isArray(data) ? data[0] || null : data };
    } catch (e) { return { error: 'offline' }; }
  }
  async function hasEmailSession(){
    if (!enabled) return false;
    try { const { data } = await client.auth.getSession(); return !!(data && data.session); }
    catch (e) { return false; }
  }
  function startExtraGame(kind, world, level, requestId){
    return plus('shikaku_start_extra_game', { p_token: session && session.token, p_request_id: requestId,
      p_kind: kind, p_world: world, p_level: level });
  }
  async function topTrophies(){
    if (!enabled) return [];
    const { data } = await client.rpc('shikaku_top_trophies');
    return data || [];
  }
  // action: checkout | cancel | portal
  async function billing(action){
    if (!enabled) return { error: 'You are offline.' };
    try {
      const { data, error } = await client.functions.invoke('shikaku-billing', { body: { action } });
      if (!error) return { data };
      const body = error.context && error.context.json ? await error.context.json().catch(() => null) : null;
      return { error: (body && body.error) || "Couldn't reach the payment service. Try again." };
    } catch (e) { return { error: "Couldn't reach the payment service. Try again." }; }
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
    dealBoard, finishGame, getScores, topQuest, topBattle, myRank,
    topDaily, channel,
    startGame, gameQuota, sendEmailCode, verifyEmailCode, linkEmail, emailSignIn,
    plus, hasEmailSession, startExtraGame, newRequestId, topTrophies, billing };
})();
window.Cloud = Cloud;
