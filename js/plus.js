/* ============================================================================
   Shikaku Plus — the subscription, play credits and ranked matches.

   Everything that matters is decided by the server: credits, the puzzle, who
   solved it first. Credits are only ever spent. Winners gain trophies, which
   are free. Hidden unless SHIKAKU_CONFIG.PLUS.enabled is true.
   ============================================================================ */
const Plus = (() => {
  const cfg = (window.SHIKAKU_CONFIG && window.SHIKAKU_CONFIG.PLUS) || {};
  const enabled = !!(cfg.enabled && cfg.price && cfg.credits > 0 && Cloud.enabled);
  const POLL_MS = 1500, PAID_POLL_MS = 3000, PAID_POLLS = 20, SIZE = 6;
  const MATCH_KEY = 'shikaku_match';
  const SECTIONS = ['plusBuy', 'plusSignIn', 'plusPlay', 'plusWait', 'plusManage'];
  const MESSAGES = {
    'no play credits': 'You have no play credits left. They are added when your next payment goes through.',
    'opponent has no play credits': 'Your opponent has no play credits left.',
    'match not found': 'No open match has that code.',
    'already in a match': 'Finish your current match first.',
    'not signed in with email': 'Sign in with your email first.',
    'not signed in': 'Sign in with the email of this name first.',
    'email is not linked to a name': 'Link this email to your name first.',
    offline: "Couldn't reach the server. Try again."
  };
  let busy = false, info = null, blocked = null, blockedRequest = null;
  let match = null;                    // { id, code, playing, done, startedAt }
  let pollTimer = null, tickTimer = null;
  const board = makeBoard($('rboard'), { lockOnWin: true,
    onChange: () => { $('rLeft').textContent = board.cluesLeft(); }, onWin: () => finish() });

  const say = (text) => { $('plusMsg').textContent = text || ''; };
  const explain = (reason) => MESSAGES[reason] || "That didn't work. Try again.";
  const only = (...ids) => SECTIONS.forEach((id) => $(id).classList.toggle('hide', !ids.includes(id)));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const dateOf = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'long' });
  const isOpenPlan = (s) => ['active', 'trialing', 'past_due', 'unpaid'].includes(s);

  async function once(work){
    if (busy) return undefined;
    busy = true;
    document.querySelectorAll('#ov-plus .btn').forEach((b) => { b.disabled = true; });
    try { return await work(); }
    finally {
      busy = false;
      document.querySelectorAll('#ov-plus .btn').forEach((b) => { b.disabled = false; });
    }
  }

  /* ----------------------------------------------------------- account ---- */
  // The email on this device must own the name shown on this device.
  async function load(){
    info = null;
    if (!(await Cloud.hasEmailSession())) return 'signed_out';
    const r = await Cloud.plus('shikaku_play_status');
    if (r.error === 'offline') return 'offline';
    if (r.error || !r.data || normName(r.data.username) !== normName(Player.data.username)) return 'signed_out';
    info = r.data;
    return 'ok';
  }
  function planText(){
    const s = info.subscription_status;
    if (s === 'past_due') return 'Your last payment failed. Update your card, or cancel.';
    if (s === 'unpaid') return 'Your plan is unpaid and Stripe has stopped charging the card. Cancel it to start again.';
    if (!isOpenPlan(s)) return '';
    if (!info.current_period_end) return info.cancel_at_period_end ? 'Cancelled.' : '';
    return info.cancel_at_period_end ? `Cancelled. Your plan ends on ${dateOf(info.current_period_end)}.`
      : `Renews on ${dateOf(info.current_period_end)}.`;
  }
  function draw(state){
    if (state === 'offline'){ only(); $('plusSummary').textContent = ''; return say(MESSAGES.offline); }
    if (state === 'signed_out'){
      only('plusSignIn');
      $('plusSummary').textContent = `${plural(cfg.credits, 'play credit')} for ${cfg.price} a month`;
      return undefined;
    }
    $('plusSummary').textContent = [`${plural(info.credits, 'play credit')} · ${plural(info.trophies, 'trophy').replace('trophys', 'trophies')}`,
      planText()].filter(Boolean).join(' — ');
    if (match && !match.playing){ $('plusMyCode').textContent = match.code; return only('plusWait'); }
    const open = isOpenPlan(info.subscription_status);
    $('plusTerms').textContent = `${cfg.price} a month, charged until you cancel. Each payment adds ${plural(cfg.credits, 'play credit')} for ranked matches and extra games. Cancel any time and keep the month you paid for. Credits have no cash value and can't be transferred or won.`;
    $('plusCancel').classList.toggle('hide', !open || (info.cancel_at_period_end && info.subscription_status === 'active'));
    return only(...[!open && 'plusBuy', info.credits > 0 && 'plusPlay', open && 'plusManage'].filter(Boolean));
  }
  async function refresh(){ draw(await load()); }
  async function open(){
    if (!enabled || !requireName()) return;
    if (!Cloud.signedInAs(Player.data.username)){ toast('Sign in with your PIN first'); return; }
    if (match && match.playing && !match.done){ hideAll(); showScreen('ranked'); return; }
    hideAll(); say(''); only(); $('plusSummary').textContent = 'Loading…'; show('plus');
    setTimeout(() => $('plusTitle').focus(), 50);
    await refresh();
  }
  function close(){ $('ov-plus').classList.remove('show'); }
  function signIn(mode){
    EmailAuth.open({ mode, name: Player.data.username, onDone: async (r) => { await afterEmailSignIn(r); await open(); } });
  }

  /* ----------------------------------------------------------- billing ---- */
  const goTo = (url) => { if (/^https:\/\/[a-z0-9.-]+\.stripe\.com\//.test(url || '')) location.assign(url); else say("That didn't work. Try again."); };
  function pay(action){
    return once(async () => {
      say('One moment…');
      const r = await Cloud.billing(action);
      if (r.error) return say(r.error);
      return goTo(r.data && r.data.url);
    });
  }
  function cancelPlan(){
    if (!confirm('Cancel your plan? You keep the month you paid for and any credits left.')) return undefined;
    return once(async () => {
      const r = await Cloud.billing('cancel');
      if (r.error) return say(r.error);
      say(r.data.ended ? 'Your plan has ended.' : 'Cancelled. It stays active until the paid month ends.');
      await refresh();
    });
  }
  // Back from checkout: the credits appear when Stripe confirms the payment.
  async function afterCheckout(){
    history.replaceState(null, '', location.pathname);
    await open();
    for (let i = 0; i < PAID_POLLS && $('ov-plus').classList.contains('show'); i++){
      if (info && isOpenPlan(info.subscription_status) && info.credits > 0) return say('Your plan is active.');
      say('Waiting for Stripe to confirm your payment…');
      await new Promise((resolve) => setTimeout(resolve, PAID_POLL_MS));
      await refresh();
    }
    return say('This is taking longer than usual. Your credits will appear when Stripe confirms the payment.');
  }

  /* -------------------------------------------------------- extra game ---- */
  function offerExtra(game){
    blocked = enabled && game && Cloud.signedInAs(Player.data.username) ? game : null;
    blockedRequest = blocked ? Cloud.newRequestId() : null;
    $('limitMsg').textContent = '';
    $('limitPlus').classList.toggle('hide', !blocked);
  }
  // The same request id is sent again after a lost reply, so it costs one credit.
  async function extraGame(){
    if (!blocked || busy) return;
    busy = true; $('limitExtra').disabled = true;
    try {
      const r = await Cloud.startExtraGame(blocked.kind, blocked.world, blocked.level, blockedRequest);
      if (r.error === 'not signed in with email' || r.error === 'not signed in'){ blocked = null; await open(); return; }
      if (r.error){ $('limitMsg').textContent = explain(r.error); return; }
      if (r.data.status === 'no_credits'){ await open(); say(explain('no play credits')); return; }
      if (r.data.status === 'free'){ $('limitMsg').textContent = 'You have free games again. Start one from the menu.'; return; }
      const { begin } = blocked;
      blocked = null; hideAll(); begin(r.data.ticket);
    } finally { busy = false; $('limitExtra').disabled = false; }
  }

  /* ----------------------------------------------------------- matches ---- */
  function remember(){
    try {
      if (match) localStorage.setItem(MATCH_KEY, JSON.stringify({ id: match.id, code: match.code }));
      else localStorage.removeItem(MATCH_KEY);
    } catch (e) {}
  }
  function forget(){ clearTimeout(pollTimer); clearInterval(tickTimer); match = null; remember(); }
  function create(){
    return once(async () => {
      const r = await Cloud.plus('shikaku_match_create', { p_size: SIZE });
      if (r.error) return say(explain(r.error));
      match = { id: r.data.match_id, code: r.data.code }; remember(); say('');
      draw('ok'); return poll();
    });
  }
  function join(){
    const code = $('plusCode').value.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) return say('The code is 6 letters and numbers.');
    return once(async () => {
      const r = await Cloud.plus('shikaku_match_join', { p_code: code });
      if (r.error) return say(explain(r.error));
      match = { id: r.data.match_id, code }; remember(); say('');
      return poll();
    });
  }
  async function poll(){
    clearTimeout(pollTimer);
    const current = match;
    if (!current || current.done) return;
    const r = await Cloud.plus('shikaku_match_state', { p_match: current.id });
    if (match !== current || current.done) return;
    if (r.error === 'no such match') return forget();
    if (r.data && r.data.status === 'playing' && !current.playing) begin(r.data);
    else if (r.data && r.data.result) return end(r.data.result);
    pollTimer = setTimeout(poll, POLL_MS);
  }
  function begin(state){
    match.playing = true;
    match.startedAt = Date.now();
    hideAll(); showScreen('ranked');
    $('rankedLeave').textContent = 'Forfeit';
    $('rankedStatus').textContent = `Racing ${state.opponent || 'your opponent'}. First to solve it wins.`;
    board.load(state.puzzle);
    const tick = () => { $('rTime').textContent = fmt(Math.floor((Date.now() - match.startedAt) / 1000)); };
    clearInterval(tickTimer); tick(); tickTimer = setInterval(tick, 1000);
  }
  async function finish(){
    const current = match;
    if (!current || current.done) return;
    const r = await Cloud.plus('shikaku_match_finish', { p_match: current.id,
      p_rects: board.rects.map(({ r0, c0, r1, c1 }) => ({ r0, c0, r1, c1 })) });
    if (match !== current || current.done) return;
    if (r.data && r.data.status !== 'wrong') return end(r.data.status);
    board.locked = false;
    $('rankedStatus').textContent = r.error ? "Couldn't send your solution. Undo one piece and place it again." : 'Not solved yet. Check your rectangles.';
  }
  function end(result){
    const wasPlaying = match.playing;
    match.done = true;
    clearTimeout(pollTimer); clearInterval(tickTimer);
    forget();
    if (!wasPlaying){ say('That match was closed.'); return refresh(); }
    board.locked = true;
    if (result === 'won') Sound.win(); else Sound.bad();
    $('rankedStatus').textContent = { won: 'You win! +10 trophies 🏆', lost: 'Your opponent solved it first.',
      draw: 'Time is up. Nobody won.', cancelled: 'The match was cancelled.' }[result] || 'The match is over.';
    $('rankedLeave').textContent = 'Menu';
    return undefined;
  }
  async function leave(){
    if (!match){ backToMenu(); return; }
    if (match.playing && !confirm('Forfeit this match? Your opponent wins.')) return;
    const current = match;
    const r = await Cloud.plus('shikaku_match_leave', { p_match: current.id });
    if (r.error && r.error !== 'no such match'){ toast(explain(r.error)); return; }
    if (match === current) forget();
    if (current.playing) backToMenu(); else await refresh();
  }
  async function resume(){
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(MATCH_KEY) || 'null'); } catch (e) {}
    if (!saved || !saved.id || !(await Cloud.hasEmailSession())) return;
    match = { id: saved.id, code: saved.code };
    const r = await Cloud.plus('shikaku_match_state', { p_match: match.id });
    if (r.error === 'offline'){ pollTimer = setTimeout(poll, POLL_MS); return; }
    if (r.error || r.data.result) forget();
    else poll();
  }

  function init(){
    $('plusBtn').classList.toggle('hide', !enabled);
    $('tabTrophies').classList.toggle('hide', !enabled);
    if (!enabled) return;
    $('ov-plus').addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    $('plusCode').addEventListener('keydown', (e) => { if (e.key === 'Enter'){ e.preventDefault(); join(); } });
    if (new URLSearchParams(location.search).get('subscribed')) afterCheckout();
    else resume();
  }

  return { open, close, signIn, subscribe: () => pay('checkout'), portal: () => pay('portal'), cancelPlan,
    create, join, leave, offerExtra, extraGame, init,
    undo: () => board.undo(), reset: () => board.reset(), relayout: () => board.relayout() };
})();
window.Plus = Plus;
Plus.init();
