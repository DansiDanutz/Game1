/* ============================================================================
   Shikaku: Puzzle Quest — application logic
   Profiles · themes · settings · quest · endless · leaderboard · 1v1 battle
   ============================================================================ */
/* puzzle.js declares top-level `const WORLDS`/`generatePuzzle` in the shared
   global scope, so we must NOT redeclare those names here (doing so throws
   "Identifier 'WORLDS' has already been declared" and aborts this whole file).
   Read them off the namespace object under local aliases instead. */
const QUEST = window.SHIKAKU_PUZZLE.WORLDS;
const genPuzzle = window.SHIKAKU_PUZZLE.generatePuzzle;
const pickGrid = window.SHIKAKU_PUZZLE.levelGrid;
const TIERS = window.SHIKAKU_PUZZLE.TIER_LABEL;
const $ = (id) => document.getElementById(id);

/* ----------------------------------- UI helpers --------------------------- */
function show(id){ $('ov-' + id).classList.add('show'); }
function hideAll(){ document.querySelectorAll('.ov').forEach(o => o.classList.remove('show')); }
function toast(t){ const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 1800); }
function showScreen(name){
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hide'));
  $('screen-' + name).classList.remove('hide');
  if (name === 'menu') renderLevels();
}
function fmt(s){ return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0'); }

/* ----------------------------------- Sound -------------------------------- */
const Sound = (() => {
  let ctx = null;
  function tone(freq, dur, type){
    if (!Player.data.sound) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.start(); o.stop(ctx.currentTime + dur);
    } catch(e){}
  }
  return {
    place(){ tone(520, 0.08, 'triangle'); },
    good(){ tone(680, 0.10, 'sine'); setTimeout(() => tone(880, 0.12, 'sine'), 80); },
    bad(){ tone(180, 0.12, 'sawtooth'); },
    win(){ [523,659,784,1047].forEach((f,i) => setTimeout(() => tone(f, 0.18, 'triangle'), i*120)); }
  };
})();

/* ----------------------------------- Themes ------------------------------- */
const THEMES = {
  neon:   { label:'Neon',    vars:{ '--bg-0':'#070b18','--bg-1':'#0d1428','--bg-2':'#141d3a','--neon':'#39e6ff','--neon-2':'#b14bff','--gold':'#ffcf4d','--ink':'#e8f0ff','--muted':'#8597c4','--glow1':'rgba(177,75,255,.18)','--glow2':'rgba(57,230,255,.16)' } },
  aurora: { label:'Aurora',  vars:{ '--bg-0':'#03140f','--bg-1':'#062019','--bg-2':'#0a2e22','--neon':'#3dffb0','--neon-2':'#37d6ff','--gold':'#ffe08a','--ink':'#eafff6','--muted':'#7fb8a6','--glow1':'rgba(61,255,176,.16)','--glow2':'rgba(55,214,255,.14)' } },
  sunset: { label:'Sunset',  vars:{ '--bg-0':'#1a0712','--bg-1':'#2a0c1a','--bg-2':'#3a1020','--neon':'#ff7a59','--neon-2':'#ff3d81','--gold':'#ffd166','--ink':'#fff0ee','--muted':'#c79aa6','--glow1':'rgba(255,61,129,.20)','--glow2':'rgba(255,122,89,.16)' } },
  mono:   { label:'Mono',    vars:{ '--bg-0':'#0a0a0c','--bg-1':'#121216','--bg-2':'#1c1c22','--neon':'#cfd6e6','--neon-2':'#8a93a8','--gold':'#e8c66b','--ink':'#f2f4fa','--muted':'#8b909c','--glow1':'rgba(207,214,230,.08)','--glow2':'rgba(138,147,168,.08)' } },
  matrix: { label:'Matrix',  vars:{ '--bg-0':'#020a04','--bg-1':'#04140a','--bg-2':'#062012','--neon':'#41ff7a','--neon-2':'#1fae52','--gold':'#b6ff6b','--ink':'#dfffe6','--muted':'#5fae77','--glow1':'rgba(65,255,122,.16)','--glow2':'rgba(31,174,82,.12)' } },
  light:  { label:'Daylight',vars:{ '--bg-0':'#eef3ff','--bg-1':'#e2eaff','--bg-2':'#d4e0ff','--neon':'#2b6fff','--neon-2':'#8a3dff','--gold':'#d99a17','--ink':'#0d1428','--muted':'#5a6a90','--glow1':'rgba(138,61,255,.12)','--glow2':'rgba(43,111,255,.12)' } }
};

function applyTheme(name, accent){
  const t = THEMES[name] || THEMES.neon;
  const root = document.documentElement.style;
  Object.entries(t.vars).forEach(([k,v]) => root.setProperty(k, v));
  root.setProperty('--line', name === 'light' ? 'rgba(40,70,150,.22)' : 'rgba(90,130,220,.22)');
  if (accent){ root.setProperty('--neon', accent); }
}

/* ----------------------------------- Player ------------------------------- */
const AVATARS = ['🎮','🦊','🐉','🚀','🧠','👾','🦉','🐼','⚡','🌟','🎯','🧩','🔥','🌈','🦄','🤖','🐺','🦅','🍄','💎','🎲','♠️','🌀','👑'];
const Player = {
  data: null,
  load(){
    let d;
    try { d = JSON.parse(localStorage.getItem('shikaku_profile') || 'null'); } catch(e){ d = null; }
    if (!d){
      // migrate legacy progress if present
      let legacy = {};
      try { legacy = JSON.parse(localStorage.getItem('shikaku_prog') || '{}'); } catch(e){}
      d = { id: cryptoId(), username:'', avatar:'🎮', theme:'neon', accent:null,
            sound:true, anim:true, progress: legacy, wins:0, losses:0 };
    }
    d.progress = d.progress || {}; d.wins = d.wins||0; d.losses = d.losses||0;
    if (d.sound === undefined) d.sound = true;
    if (d.anim === undefined) d.anim = true;
    this.data = d;
  },
  save(){ localStorage.setItem('shikaku_profile', JSON.stringify(this.data)); syncProfile(); },
  totalScore(){ return Object.values(this.data.progress).reduce((a,p) => a + (p.score||0), 0); },
  bestWorld(){ let m = 0; Object.keys(this.data.progress).forEach(k => { const w = +k.split('-')[0]; if (w > m) m = w; }); return m; }
};
function cryptoId(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0; return (c === 'x' ? r : (r&0x3|0x8)).toString(16);
  });
}

/* ----------------------- Identity: name IS the account -------------------
   The player id is derived deterministically from the (case-insensitive)
   username, so the SAME name always maps to the SAME profile row — on any
   device. That guarantees: usernames are unique on the leaderboard (one row
   per name), the account is tied to the device via the saved name (auto-login),
   and a player can recover their account on a new device just by entering the
   same name. Changing your name switches you to a different identity, so your
   points stay with the old name (you can switch back by typing it again). */
function cyrb128(str){
  let h1=1779033703,h2=3144134277,h3=1013904242,h4=2773480762;
  for (let i=0,k;i<str.length;i++){ k=str.charCodeAt(i);
    h1=h2^Math.imul(h1^k,597399067); h2=h3^Math.imul(h2^k,2869860233);
    h3=h4^Math.imul(h3^k,951274213); h4=h1^Math.imul(h4^k,2716044179); }
  h1=Math.imul(h3^(h1>>>18),597399067); h2=Math.imul(h4^(h2>>>22),2869860233);
  h3=Math.imul(h1^(h3>>>17),951274213); h4=Math.imul(h2^(h4>>>19),2716044179);
  return [(h1^h2^h3^h4)>>>0, h2>>>0, h3>>>0, h4>>>0];
}
function normName(name){ return (name||'').trim().toLowerCase().replace(/\s+/g,' '); }
function idForName(name){
  const [a,b,c,d] = cyrb128('shikaku:' + normName(name));
  const hx = v => (v>>>0).toString(16).padStart(8,'0');
  const by = (hx(a)+hx(b)+hx(c)+hx(d)).match(/.{2}/g);
  by[6] = ((parseInt(by[6],16)&0x0f)|0x40).toString(16).padStart(2,'0'); // v4
  by[8] = ((parseInt(by[8],16)&0x3f)|0x80).toString(16).padStart(2,'0'); // variant
  const h = by.join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/* Merge every cloud row + score for `name` into one progress map (best score
   per level, max battle record), optionally seeded with local progress. */
async function consolidateAccount(name, seedProgress){
  const progress = Object.assign({}, seedProgress || {});
  let wins = 0, losses = 0;
  if (Cloud.enabled){
    let rows = [];
    try { rows = await Cloud.findProfilesByName(name) || []; } catch(e){}
    for (const r of rows){
      wins = Math.max(wins, r.wins||0); losses = Math.max(losses, r.losses||0);
      let sc = [];
      try { sc = await Cloud.getScores(r.id) || []; } catch(e){}
      sc.forEach(s => { const k = s.world+'-'+s.level, prev = progress[k];
        if (!prev || (prev.score||0) < (s.score||0))
          progress[k] = { score: s.score||0, stars: '★'.repeat(Math.max(1, s.stars||1)) };
      });
    }
  }
  return { progress, wins, losses };
}

/* Point this device at the account for `name`: canonical id, merged progress,
   then push it to the cloud and delete any leftover duplicate rows.
   carryLocal=true keeps the current device's progress (migration/first claim);
   false discards it (switching to a different name). */
async function adoptIdentity(name, carryLocal){
  const id = idForName(name);
  const seed = carryLocal ? Player.data.progress : {};
  const merged = await consolidateAccount(name, seed);
  Player.data.id = id;
  Player.data.username = name;
  Player.data.progress = merged.progress;
  Player.data.wins = merged.wins;
  Player.data.losses = merged.losses;
  Player.save();                              // upserts the canonical profile row
  if (Cloud.enabled){
    try {
      for (const k in merged.progress){
        const [w,l] = k.split('-').map(Number); const p = merged.progress[k];
        await Cloud.saveScore({ player_id:id, username:name, world:w, level:l,
          score:p.score, stars:(p.stars||'★').length, time_sec:0, moves:0 });
      }
      await Cloud.deleteProfilesByNameExcept(name, id);   // collapse duplicates
    } catch(e){}
  }
}

/* On boot: make sure this device uses the canonical id for its name and that no
   duplicate rows remain. Also pulls cloud progress so a fresh device recovers. */
async function ensureIdentity(){
  if (!Player.data.username) return;
  const canon = idForName(Player.data.username);
  if (Player.data.id !== canon){
    await adoptIdentity(Player.data.username, true);   // migrate legacy random-id row
  } else if (Cloud.enabled){
    try {
      const merged = await consolidateAccount(Player.data.username, Player.data.progress);
      Player.data.progress = merged.progress;
      Player.data.wins = Math.max(Player.data.wins, merged.wins);
      Player.data.losses = Math.max(Player.data.losses, merged.losses);
      Player.save();
      await Cloud.deleteProfilesByNameExcept(Player.data.username, canon);
    } catch(e){}
  }
  refreshChip(); renderLevels();
}

function refreshChip(){
  $('pcAv').textContent = Player.data.avatar;
  $('pcName').textContent = Player.data.username || 'Player';
  $('meName').textContent = Player.data.username || 'You';
  $('meAv').textContent = Player.data.avatar;
  const dot = $('cloudDot');
  dot.className = 'cloud-dot ' + (Cloud.enabled ? 'on' : 'off');
  dot.title = Cloud.enabled ? 'Cloud sync on' : 'Offline (localStorage only)';
}

async function syncProfile(){
  if (!Cloud.enabled || !Player.data.username) return;
  await Cloud.upsertProfile({
    id: Player.data.id, username: Player.data.username, avatar: Player.data.avatar,
    theme: Player.data.theme, accent: Player.data.accent,
    total_score: Player.totalScore(), best_world: Player.bestWorld(),
    wins: Player.data.wins, losses: Player.data.losses
  });
}

/* --------------------------- Profile / onboarding ------------------------- */
let pendingAvatar = '🎮';
function openProfile(force){
  pendingAvatar = Player.data.avatar;
  $('inpName').value = Player.data.username || '';
  $('profTitle').textContent = Player.data.username ? 'YOUR PROFILE' : 'WELCOME!';
  $('profCancel').classList.toggle('hide', !Player.data.username && force);
  const grid = $('avGrid'); grid.innerHTML = '';
  AVATARS.forEach(a => {
    const b = document.createElement('button');
    b.textContent = a; b.className = (a === pendingAvatar ? 'sel' : '');
    b.onclick = () => { pendingAvatar = a; grid.querySelectorAll('button').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); };
    grid.appendChild(b);
  });
  const s = $('profStats');
  s.innerHTML = Player.data.username
    ? `<span>🏅 ${Player.totalScore()} pts</span><span>⚔️ ${Player.data.wins}W / ${Player.data.losses}L</span>`
    : '';
  show('profile');
}
async function saveProfile(){
  const name = $('inpName').value.trim();
  if (!name){ toast('Please enter a name'); return; }
  if (name.length < 2){ toast('Name is too short'); return; }
  const had = Player.data.username;
  const renamed = had && normName(name) !== normName(had);
  // Your username IS your account. Switching to a different name moves you to
  // that account — your points stay with the old name (re-enter it to return).
  if (renamed){
    const ok = confirm(`Switch your name to “${name}”?\n\nYour name is your account. Your points & ranking stay with “${had}” — “${name}” will load its own progress. You can switch back anytime by entering “${had}” again.`);
    if (!ok) return;
  }
  Player.data.avatar = pendingAvatar;
  const btn = document.querySelector('#ov-profile .btn.primary');
  if (btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    // adopt the account for this name (claim / recover / switch). carryLocal only
    // for the very first claim, so renaming never transfers points to a new name.
    await adoptIdentity(name, !had);
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = 'Save'; }
  }
  refreshChip();
  renderLevels();
  hideAll();
  toast(renamed ? `Switched to ${name}` : (had ? 'Profile saved ✔' : `Welcome, ${name}!`));
}

/* ------------------------------- Settings --------------------------------- */
function openSettings(){
  const grid = $('themeGrid'); grid.innerHTML = '';
  Object.entries(THEMES).forEach(([key,t]) => {
    const d = document.createElement('div');
    d.className = 'theme-swatch' + (Player.data.theme === key ? ' sel' : '');
    d.textContent = t.label;
    d.style.background = `linear-gradient(135deg, ${t.vars['--neon']}, ${t.vars['--neon-2']})`;
    d.style.color = key === 'light' ? '#0d1428' : '#05101f';
    d.onclick = () => {
      Player.data.theme = key; Player.data.accent = null;
      applyTheme(key, null); $('inpAccent').value = t.vars['--neon'];
      grid.querySelectorAll('.theme-swatch').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel'); Player.save();
    };
    grid.appendChild(d);
  });
  $('inpAccent').value = Player.data.accent || THEMES[Player.data.theme].vars['--neon'];
  $('inpAccent').oninput = (e) => { Player.data.accent = e.target.value; applyTheme(Player.data.theme, e.target.value); Player.save(); };
  $('swSound').classList.toggle('on', Player.data.sound);
  $('swAnim').classList.toggle('on', Player.data.anim);
  $('cloudInfo').innerHTML = Cloud.enabled
    ? '🟢 Connected — progress, leaderboards and battles are live.'
    : '⚪ Offline. Add your Supabase anon key in <code>js/config.js</code> to enable cloud sync, leaderboards and online battles.';
  show('settings');
}
function toggleSetting(key, el){
  Player.data[key] = !Player.data[key];
  el.classList.toggle('on', Player.data[key]);
  document.body.classList.toggle('no-anim', !Player.data.anim);
  if (key === 'anim' && window.FX) FX.setAnim(Player.data.anim);
  Player.save();
}
function clearAccent(){
  Player.data.accent = null; applyTheme(Player.data.theme, null);
  $('inpAccent').value = THEMES[Player.data.theme].vars['--neon']; Player.save();
}
function resetProgress(){
  if (!confirm('Reset all level progress on this device?')) return;
  Player.data.progress = {}; Player.save(); renderLevels(); toast('Progress reset');
}

/* ------------------------------ Board engine ------------------------------ */
/* Reusable Shikaku board bound to a DOM element. */
function makeBoard(el, opts){
  opts = opts || {};
  const B = { el, GRID:[], N:0, cellPx:64, rects:[], startCell:null, drawing:null, locked:false };

  // Size the board to fit BOTH the available width and height, so even a 9×9
  // fits on a small phone in portrait or landscape. Rebuilds cells/clues at the
  // new cell size and re-renders existing rectangles (so it's safe to call on
  // resize / orientation change without losing the player's progress).
  function applyLayout(){
    const shell = el.parentElement;
    let side = Math.min(shell ? shell.clientWidth : window.innerWidth - 48, 560);
    if (shell){
      const top = shell.getBoundingClientRect().top;
      const availH = window.innerHeight - top - 84;   // leave room for the controls below
      if (availH > 60) side = Math.min(side, availH);  // fit height too (esp. landscape)
    }
    B.cellPx = Math.max(18, Math.floor(side / B.N));
    el.style.width = el.style.height = (B.cellPx * B.N) + 'px';
    el.innerHTML = '';
    for (let r = 0; r < B.N; r++) for (let c = 0; c < B.N; c++){
      const d = document.createElement('div'); d.className = 'cell';
      d.style.left = c*B.cellPx+'px'; d.style.top = r*B.cellPx+'px';
      d.style.width = B.cellPx+'px'; d.style.height = B.cellPx+'px';
      el.appendChild(d);
      if (B.GRID[r][c] > 0){
        const num = document.createElement('div'); num.className = 'num';
        num.style.left = c*B.cellPx+'px'; num.style.top = r*B.cellPx+'px';
        num.style.width = B.cellPx+'px'; num.style.height = B.cellPx+'px';
        num.style.fontSize = Math.floor(B.cellPx*.42)+'px'; num.textContent = B.GRID[r][c];
        el.appendChild(num);
      }
    }
    render();
  }
  B.load = function(grid){
    B.GRID = grid.map(r => r.slice()); B.N = grid.length; B.rects = []; B.locked = false;
    applyLayout();
  };
  // Recompute size in place (keeps rects) — called on window resize/rotate.
  B.relayout = function(){ if (B.N && el.offsetParent !== null) applyLayout(); };

  function rectStats(rc){
    let clues = [], area = (rc.r1-rc.r0+1)*(rc.c1-rc.c0+1);
    for (let r = rc.r0; r <= rc.r1; r++) for (let c = rc.c0; c <= rc.c1; c++)
      if (B.GRID[r][c] > 0) clues.push(B.GRID[r][c]);
    return { clues, area };
  }
  function isValid(rc){ const s = rectStats(rc); return s.clues.length === 1 && s.clues[0] === s.area; }
  B.isValid = isValid;

  function render(){
    el.querySelectorAll('.rect,.preview').forEach(e => e.remove());
    B.rects.forEach((rc,i) => {
      const valid = isValid(rc);
      const r = document.createElement('div'); r.className = 'rect ' + (valid ? 'ok' : 'bad');
      r.style.left = rc.c0*B.cellPx+2+'px'; r.style.top = rc.r0*B.cellPx+2+'px';
      r.style.width = (rc.c1-rc.c0+1)*B.cellPx-4+'px'; r.style.height = (rc.r1-rc.r0+1)*B.cellPx-4+'px';
      r.onclick = (e) => { if (B.locked) return; e.stopPropagation(); B.rects.splice(i,1); Sound.place(); changed(); };
      el.appendChild(r);
    });
  }
  B.cluesLeft = function(){
    let left = 0;
    for (let r = 0; r < B.N; r++) for (let c = 0; c < B.N; c++) if (B.GRID[r][c] > 0){
      const ok = B.rects.some(rc => r>=rc.r0 && r<=rc.r1 && c>=rc.c0 && c<=rc.c1 && isValid(rc));
      if (!ok) left++;
    }
    return left;
  };
  B.progressPct = function(){
    const seen = Array.from({length:B.N}, () => Array(B.N).fill(false));
    B.rects.forEach(rc => { if (isValid(rc)) for (let r=rc.r0;r<=rc.r1;r++) for (let c=rc.c0;c<=rc.c1;c++) seen[r][c] = true; });
    let n = 0; seen.forEach(row => row.forEach(v => { if (v) n++; }));
    return Math.round(n / (B.N*B.N) * 100);
  };
  function coverage(){
    const seen = Array.from({length:B.N}, () => Array(B.N).fill(false));
    let bad = false, count = 0;
    B.rects.forEach(rc => { for (let r=rc.r0;r<=rc.r1;r++) for (let c=rc.c0;c<=rc.c1;c++){ if (seen[r][c]) bad = true; seen[r][c] = true; } });
    seen.forEach(row => row.forEach(v => { if (v) count++; }));
    return { count, bad, full: count === B.N*B.N };
  }
  function changed(){
    render();
    if (opts.onChange) opts.onChange(B);
    const cov = coverage();
    if (cov.full && !cov.bad && B.rects.length && B.rects.every(isValid) && B.cluesLeft() === 0){
      B.locked = !!opts.lockOnWin;
      if (opts.onWin) opts.onWin(B);
    }
  }
  B.changed = changed;

  /* pointer */
  function cellFrom(e){
    const rect = el.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return { c: Math.max(0,Math.min(B.N-1,Math.floor(x/B.cellPx))), r: Math.max(0,Math.min(B.N-1,Math.floor(y/B.cellPx))) };
  }
  function preview(){
    el.querySelectorAll('.preview').forEach(p => p.remove());
    if (!B.startCell || !B.drawing) return;
    const r0=Math.min(B.startCell.r,B.drawing.r), r1=Math.max(B.startCell.r,B.drawing.r);
    const c0=Math.min(B.startCell.c,B.drawing.c), c1=Math.max(B.startCell.c,B.drawing.c);
    const p = document.createElement('div'); p.className = 'preview';
    p.style.left=c0*B.cellPx+2+'px'; p.style.top=r0*B.cellPx+2+'px';
    p.style.width=(c1-c0+1)*B.cellPx-4+'px'; p.style.height=(r1-r0+1)*B.cellPx-4+'px';
    el.appendChild(p);
  }
  const overlap = (a,b) => !(a.c1<b.c0||a.c0>b.c1||a.r1<b.r0||a.r0>b.r1);
  function onDown(e){ if (B.locked || e.target.classList.contains('rect')) return; e.preventDefault(); B.startCell = cellFrom(e); B.drawing = B.startCell; preview(); }
  function onMove(e){ if (!B.startCell) return; e.preventDefault(); B.drawing = cellFrom(e); preview(); }
  function onUp(){
    if (!B.startCell) return;
    const a = B.startCell, b = B.drawing || B.startCell;
    const rc = { r0:Math.min(a.r,b.r), r1:Math.max(a.r,b.r), c0:Math.min(a.c,b.c), c1:Math.max(a.c,b.c) };
    B.startCell = null; B.drawing = null;
    el.querySelectorAll('.preview').forEach(p => p.remove());
    B.rects = B.rects.filter(r => !overlap(r, rc));
    B.rects.push(rc);
    isValid(rc) ? Sound.good() : Sound.place();
    changed();
  }
  el.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  el.addEventListener('touchstart', onDown, { passive:false });
  el.addEventListener('touchmove', onMove, { passive:false });
  el.addEventListener('touchend', onUp);

  B.undo = function(){ if (B.locked) return; if (B.rects.length){ B.rects.pop(); changed(); } };
  B.reset = function(){ if (B.locked) return; B.rects = []; changed(); };
  return B;
}

/* ------------------------------- Quest game ------------------------------- */
const game = (() => {
  let moves = 0, hints = 0, timer = 0, tInt = null;
  let ctx = { mode:'quest', w:0, l:0, name:'', world:'' };
  const board = makeBoard($('board'), {
    onChange(){ moves++; updHud(); },
    onWin(){ win(); }
  });

  function updHud(){
    $('hTime').textContent = fmt(timer);
    $('hMoves').textContent = moves;
    $('hLeft').textContent = board.cluesLeft();
  }
  function startTimer(){ clearInterval(tInt); timer = 0; tInt = setInterval(() => { timer++; updHud(); }, 1000); }

  function startLevel(w, l){
    const lvl = QUEST[w].levels[l];
    const tierLabel = TIERS[lvl.tier] || '';
    ctx = { mode:'quest', w, l, name: lvl.n, world: QUEST[w].name,
            size: lvl.size, tier: lvl.tier, mult: lvl.mult || 1,
            label: `${lvl.n} · ${lvl.size}×${lvl.size} · ${tierLabel}` };
    begin(pickGrid(lvl.size, lvl.tier));   // fresh random board (size + difficulty) each play
  }
  function startEndless(size){
    const N = size || (5 + Math.floor(Math.random()*3)); // 5..7
    const { g } = genPuzzle(N);
    ctx = { mode:'endless', name:`Random ${N}×${N}`, world:'Endless' };
    begin(g);
  }
  function begin(grid){
    moves = 0; hints = 0;
    $('worldTag').textContent = ctx.world.split('—')[0].trim();
    $('lvlName').textContent = ctx.label || ctx.name;
    showScreen('game'); hideAll();
    board.load(grid); startTimer(); updHud();
  }

  function hint(){
    hints++;
    for (let r = 0; r < board.N; r++) for (let c = 0; c < board.N; c++){
      if (board.GRID[r][c] > 0){
        const covered = board.rects.some(rc => r>=rc.r0&&r<=rc.r1&&c>=rc.c0&&c<=rc.c1&&board.isValid(rc));
        if (!covered){ toast(`Try enclosing the ${board.GRID[r][c]} at row ${r+1}, col ${c+1}`); updHud(); return; }
      }
    }
    toast('All clues look satisfied!'); updHud();
  }

  async function win(){
    clearInterval(tInt); Sound.win(); window.FX && FX.confetti();
    const mult = ctx.mult || 1;                       // harder level/tier => worth more
    const base = Math.round(500 * mult);
    const tBonus = Math.round(Math.max(0, 300 - timer*4) * mult);
    const accBonus = Math.round(Math.max(0, 150 - (moves - board.rects.length)*15) * mult);
    const hPen = hints*40;
    const final = Math.max(100, base + tBonus + accBonus - hPen);
    const stars = final > 900*mult ? '★★★' : final > 650*mult ? '★★' : '★';
    $('winLvl').textContent = `${ctx.label || ctx.name} — Cleared`;
    $('sBase').textContent = base;
    $('sTime').textContent = '+' + tBonus;
    $('sAcc').textContent = '+' + accBonus;
    $('sHint').textContent = '-' + hPen;
    $('sFinal').textContent = final + ' pts' + (mult > 1 ? `  (×${mult})` : '');
    $('winStats').textContent = `⏱️ ${fmt(timer)} · 🖱️ ${moves} moves · ${stars}`;

    if (ctx.mode === 'quest'){
      const key = ctx.w + '-' + ctx.l;
      const prev = Player.data.progress[key];
      if (!prev || prev.score < final){
        Player.data.progress[key] = { score: final, stars };
        Player.save();
        Cloud.saveScore({ player_id: Player.data.id, username: Player.data.username || 'Player',
          world: ctx.w, level: ctx.l, score: final, stars: stars.length, time_sec: timer, moves });
      }
    }
    show('win');
    // sync the new total to the cloud, then show the player's leaderboard place
    Promise.resolve(syncProfile()).then(() => showRank('quest'));
  }

  return {
    startLevel, startEndless,
    undo: () => board.undo(), reset: () => { board.reset(); }, hint,
    relayout: () => board.relayout(),
    get ctx(){ return ctx; }
  };
})();

/* Show the player's leaderboard position after a win. `board` is 'quest' or
   'battle'; targets the matching modal's rank line. Offline shows a local hint. */
async function showRank(board){
  const el = board === 'battle' ? $('resRank') : $('winRank');
  if (!el) return;
  if (!Cloud.enabled){
    el.innerHTML = board === 'battle'
      ? `🏆 Your record: <b>${Player.data.wins}W / ${Player.data.losses}L</b> · connect cloud to rank globally`
      : `🏆 Your total: <b>${Player.totalScore()} pts</b> · connect cloud to rank globally`;
    return;
  }
  el.innerHTML = `<span class="spin"></span> Finding your place…`;
  const r = await Cloud.myRank(board, Player.data.id);
  if (!r){ el.textContent = ''; return; }
  const pct = r.total > 1 ? Math.round((1 - (r.rank - 1) / r.total) * 100) : 100;
  const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '🏆';
  const what = board === 'battle' ? 'Battle wins' : 'Quest score';
  el.innerHTML = `${medal} <b>#${r.rank}</b> of ${r.total} · ${what} — top ${pct}%`
    + (r.rank === 1 ? ' · 👑 Champion!' : r.rank <= 3 ? ' · podium!' : '');
}

function startEndless(){ if (requireName()) game.startEndless(); }
function nextLevel(){
  if (game.ctx.mode === 'endless'){ game.startEndless(); return; }
  let { w, l } = game.ctx; l++;
  if (l >= QUEST[w].levels.length){ w++; l = 0; }
  if (w >= QUEST.length){ hideAll(); backToMenu(); toast('🏆 Quest complete! All worlds cleared.'); return; }
  game.startLevel(w, l);
}

/* ------------------------------ Level select ------------------------------ */
function renderLevels(){
  const wrap = $('worlds'); wrap.innerHTML = '';
  QUEST.forEach((world, wi) => {
    const wEl = document.createElement('div'); wEl.className = 'world';
    wEl.innerHTML = `<h3>${world.name}</h3>`;
    const lv = document.createElement('div'); lv.className = 'levels';
    world.levels.forEach((lvl, li) => {
      const key = wi + '-' + li, done = Player.data.progress[key];
      const el = document.createElement('div');
      el.className = 'lv tier-' + (lvl.tier || 'easy') + (done ? ' done' : '');
      el.innerHTML =
        `<span class="lv-num">${li+1}</span>` +
        `<span class="lv-tier">${(TIERS[lvl.tier]||'').toUpperCase()}</span>` +
        `<span class="lv-size">${lvl.size}×${lvl.size}</span>` +
        (done ? `<span class="lv-score">${done.stars||'★'} ${done.score}</span>`
              : `<span class="lv-play">▶</span>`);
      el.onclick = () => { if (requireName()) game.startLevel(wi, li); };
      lv.appendChild(el);
    });
    wEl.appendChild(lv); wrap.appendChild(wEl);
  });
}
function backToMenu(){ battle.cleanup(); hideAll(); showScreen('menu'); }
function requireName(){ if (!Player.data.username){ openProfile(true); return false; } return true; }

/* ------------------------------ Leaderboard ------------------------------- */
let lbMode = 'quest';
function openLeaderboard(){ showScreen('leaderboard'); switchLb('quest'); }
function switchLb(mode){
  lbMode = mode;
  $('tabQuest').classList.toggle('active', mode === 'quest');
  $('tabBattle').classList.toggle('active', mode === 'battle');
  loadLb();
}
async function loadLb(){
  const list = $('lbList');
  list.innerHTML = '<div class="lb-empty"><span class="spin"></span> Loading…</div>';
  if (!Cloud.enabled){
    list.innerHTML = `<div class="lb-empty">Leaderboards need cloud sync.<br><br>
      Add your Supabase anon key in <code>js/config.js</code> to compete globally.<br><br>
      Your ${lbMode === 'quest' ? `total score: <b>${Player.totalScore()} pts</b>` : `record: <b>${Player.data.wins}W / ${Player.data.losses}L</b>`}</div>`;
    return;
  }
  let rows = lbMode === 'quest' ? await Cloud.topQuest(100) : await Cloud.topBattle(100);
  rows = dedupeByName(rows, lbMode).slice(0, 25);
  if (!rows.length){ list.innerHTML = '<div class="lb-empty">No scores yet — be the first!</div>'; return; }
  list.innerHTML = '';
  const myName = normName(Player.data.username);
  rows.forEach((r, i) => {
    const me = (r.username||'').trim().toLowerCase() === myName;
    const val = lbMode === 'quest' ? `${r.total_score||0} pts` : `${r.wins||0}W`;
    const sub = lbMode === 'quest' ? `World ${(r.best_world||0)+1}` : `${r.losses||0}L`;
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i+1);
    const el = document.createElement('div'); el.className = 'lb-row' + (me ? ' me' : '');
    el.innerHTML = `<div class="lb-rank">${rank}</div><div class="lb-av">${escapeHtml(r.avatar||'🎮')}</div>
      <div class="lb-name">${escapeHtml(r.username||'Player')}<div class="muted" style="font-size:11px">${sub}</div></div>
      <div class="lb-val">${val}</div>`;
    list.appendChild(el);
  });
}
// Collapse rows that share a username (case-insensitive), keeping the best — a
// safety net so the same name never shows twice even while older duplicate cloud
// rows still exist (they get cleaned up as each player loads the app).
function dedupeByName(rows, mode){
  const metric = r => mode === 'quest' ? (r.total_score||0) : (r.wins||0);
  const best = new Map();
  (rows||[]).forEach(r => {
    const k = (r.username||'').trim().toLowerCase();
    const cur = best.get(k);
    if (!cur || metric(r) > metric(cur)) best.set(k, r);
  });
  return [...best.values()].sort((a,b) => metric(b) - metric(a));
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* -------------------------------- Battle ---------------------------------- */
const battle = (() => {
  let ch = null, code = null, isHost = false, size = 6;
  let timer = 0, tInt = null, joinTimer = null;
  let myFinished = false, foeFinished = false, myTime = 0, foeTime = 0, resolved = false, active = false;
  let foeName = 'Opponent', foeAvatar = '🤖';
  let iWantRematch = false, foeWantRematch = false;

  const board = makeBoard($('bboard'), {
    lockOnWin: true,
    onChange(){ updHud(); broadcastProgress(); },
    onWin(){ finishLocal(); }
  });

  function updHud(){ $('bTime').textContent = fmt(timer); $('bLeft').textContent = board.cluesLeft(); setFill('me', board.progressPct()); }
  function setFill(who, pct){ $(who+'Fill').style.width = pct + '%'; $(who+'Pct').textContent = pct + '%'; }
  function startTimer(){ clearInterval(tInt); timer = 0; tInt = setInterval(() => { timer++; $('bTime').textContent = fmt(timer); }, 1000); }

  function rndCode(){ const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i=0;i<4;i++) s += a[Math.floor(Math.random()*a.length)]; return s; }

  function ensureCloud(){
    if (!Cloud.enabled){ toast('Battle needs cloud — add your Supabase key in js/config.js'); return false; }
    return true;
  }

  function open(){
    if (!requireName()) return;
    cleanup();
    hideAll();   // close any open overlay (e.g. the battle-result modal on "Rematch")
    $('lobbyConfig').classList.remove('hide');
    $('lobbyWaiting').classList.add('hide');
    show('lobby');
  }
  function setSize(s){ size = s; }

  function create(){
    if (!ensureCloud()) return;
    isHost = true; code = rndCode();
    $('lobbyCode').textContent = code;
    $('lobbyConfig').classList.add('hide');
    $('lobbyWaiting').classList.remove('hide');
    connect();
  }
  function join(){
    if (!ensureCloud()) return;
    const c = ($('inpCode').value || '').trim().toUpperCase();
    if (c.length !== 4){ toast('Enter the 4-letter code'); return; }
    isHost = false; code = c;
    $('lobbyConfig').classList.add('hide');
    $('lobbyWaiting').classList.remove('hide');
    $('lobbyCode').textContent = code;
    connect();
  }

  function connect(){
    ch = Cloud.channel(code);
    if (!ch){ toast('Connection failed'); return; }
    ch.on('broadcast', { event: 'hello' }, ({ payload }) => {
      foeName = payload.name; foeAvatar = payload.avatar;
      if (isHost){
        // host builds the puzzle and sends it to the guest
        const seed = (Math.random()*1e9)|0;
        const { g } = genPuzzle(size, seed);
        ch.send({ type:'broadcast', event:'start', payload:{ grid:g, size, name:Player.data.username, avatar:Player.data.avatar } });
        beginBattle(g);
      }
    });
    ch.on('broadcast', { event: 'start' }, ({ payload }) => {
      if (isHost) return;
      foeName = payload.name; foeAvatar = payload.avatar;
      beginBattle(payload.grid);
    });
    ch.on('broadcast', { event: 'progress' }, ({ payload }) => { if (active) setFill('foe', payload.pct); });
    ch.on('broadcast', { event: 'finish' }, ({ payload }) => onFoeFinish(payload));
    ch.on('broadcast', { event: 'left' }, () => {
      if (active && !resolved){ toast('Opponent left'); resolve(true, 'Opponent forfeited'); }
      else if (resolved && iWantRematch){ toast(foeName + ' left'); $('resSub').textContent = foeName + ' left — start a New Match'; }
    });
    ch.on('broadcast', { event: 'rematch' }, () => {
      foeWantRematch = true;
      if (resolved && !iWantRematch) $('resSub').textContent = `${foeName} wants a rematch — tap Rematch!`;
      maybeRematch();
    });
    // detect an opponent who closes their tab / loses connection mid-match
    ch.on('presence', { event: 'leave' }, () => { if (active && !resolved){ toast('Opponent disconnected'); resolve(true, 'Opponent disconnected'); } });
    ch.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      try { ch.track({ id: Player.data.id, name: Player.data.username, avatar: Player.data.avatar }); } catch(e){}
      if (!isHost){
        ch.send({ type:'broadcast', event:'hello', payload:{ name:Player.data.username, avatar:Player.data.avatar } });
        clearTimeout(joinTimer);
        joinTimer = setTimeout(() => { if (!active){ toast('Match not found — check the code'); cancelLobby(); } }, 12000);
      }
    });
  }

  function beginBattle(grid){
    clearTimeout(joinTimer);
    myFinished = foeFinished = resolved = false; myTime = foeTime = 0; active = true;
    iWantRematch = foeWantRematch = false;
    $('foeName').textContent = foeName; $('foeAv').textContent = foeAvatar;
    setFill('me', 0); setFill('foe', 0);
    $('battleStatus').textContent = `Racing ${foeName} — first to tile the ${grid.length}×${grid.length} grid wins!`;
    hideAll(); showScreen('battle');
    board.load(grid); startTimer(); updHud();
    toast('⚔️ Go!');
  }

  function broadcastProgress(){ if (ch && active) ch.send({ type:'broadcast', event:'progress', payload:{ pct: board.progressPct() } }); }

  function finishLocal(){
    if (myFinished) return;
    myFinished = true; myTime = timer; clearInterval(tInt);
    setFill('me', 100);
    if (ch) ch.send({ type:'broadcast', event:'finish', payload:{ time: myTime } });
    if (foeFinished){ resolve(myTime <= foeTime, null); }
    else { resolve(true, null); }   // finished first
  }
  function onFoeFinish(payload){
    foeFinished = true; foeTime = payload.time || 9999; setFill('foe', 100);
    if (resolved) return;
    if (myFinished) resolve(myTime <= foeTime, null);
    else resolve(false, null);      // foe finished first
  }

  function resolve(won, note){
    if (resolved) return; resolved = true; active = false; clearInterval(tInt);
    board.locked = true;
    won ? (Sound.win(), window.FX && FX.confetti()) : Sound.bad();
    if (won) Player.data.wins++; else Player.data.losses++;
    Player.save();   // persists locally and upserts wins/losses to the cloud
    $('resTitle').textContent = won ? 'YOU WIN! 🏆' : 'DEFEAT';
    $('resTitle').style.color = won ? '' : 'var(--bad)';
    $('resSub').textContent = note || (won ? 'First to finish 🎉' : `${foeName} finished first`);
    $('resStats').textContent = myFinished ? `⏱️ Your time: ${fmt(myTime)}` : `You were racing ${foeName}`;
    show('result');
    // ensure the cloud has the updated W/L before we read back the rank
    Promise.resolve(syncProfile()).then(() => showRank('battle'));
  }

  /* One-tap rematch with the SAME opponent: the channel stays alive after a
     match, so both players just re-arm. When both have tapped Rematch, the host
     builds a fresh puzzle and broadcasts it (same path as the first game). If the
     channel is gone (opponent left / offline), fall back to the lobby. */
  function rematch(){
    if (!ch || !Cloud.enabled){ open(); return; }   // no live channel -> fresh setup
    if (iWantRematch) return;                         // already requested
    iWantRematch = true;
    try { ch.send({ type:'broadcast', event:'rematch', payload:{} }); } catch(e){}
    $('resSub').textContent = foeWantRematch ? 'Starting rematch…' : `Rematch sent — waiting for ${foeName}…`;
    maybeRematch();
  }
  function maybeRematch(){
    if (!(iWantRematch && foeWantRematch)) return;
    if (isHost){
      const seed = (Math.random()*1e9)|0;
      const { g } = genPuzzle(size, seed);
      ch.send({ type:'broadcast', event:'start', payload:{ grid:g, size, name:Player.data.username, avatar:Player.data.avatar } });
      beginBattle(g);
    }
    // guest waits for the host's 'start' broadcast, which calls beginBattle
  }

  function leave(){
    if (ch && active && !resolved){ ch.send({ type:'broadcast', event:'left', payload:{} }); }
    cleanup(); backToMenu(); toast('Left the battle');
  }
  function cancelLobby(){ cleanup(); hideAll(); }
  function cleanup(){
    active = false; clearInterval(tInt); clearTimeout(joinTimer);
    if (ch){ try { Cloud.client.removeChannel(ch); } catch(e){} ch = null; }
  }

  return { open, setSize, create, join, finishLocal, cleanup, leave, cancelLobby, rematch,
    get code(){ return code; },
    relayout: () => board.relayout(),
    undo: () => board.undo(), reset: () => board.reset() };
})();

function openBattle(){ battle.open(); }
function rematch(){ battle.rematch(); }

/* Keep whichever board is on screen sized to the device on resize / rotate. */
let _relayoutT;
function relayoutBoards(){ try { game.relayout(); } catch(e){} try { battle.relayout(); } catch(e){} }
window.addEventListener('resize', () => { clearTimeout(_relayoutT); _relayoutT = setTimeout(relayoutBoards, 120); });
window.addEventListener('orientationchange', () => setTimeout(relayoutBoards, 280));
function pickSize(s, el){ battle.setSize(s); document.querySelectorAll('#sizeSeg button').forEach(b => b.classList.remove('sel')); el.classList.add('sel'); }
function createMatch(){ battle.create(); }
function joinMatch(){ battle.join(); }
function leaveBattle(){ battle.leave(); }
function cancelLobby(){ battle.cancelLobby(); }
function copyCode(){ if (battle.code){ navigator.clipboard?.writeText(battle.code); toast('Code copied: ' + battle.code); } }
function shareCode(){
  const text = `Join my Shikaku battle! Code: ${battle.code} — ${location.href}`;
  if (navigator.share){ navigator.share({ title:'Shikaku Battle', text }).catch(()=>{}); }
  else { navigator.clipboard?.writeText(text); toast('Invite copied'); }
}

/* ------------------------------- PWA install ------------------------------ */
let deferredInstall = null;
function isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream; }
function showInstallBtn(on){ const b = $('installBtn'); if (b) b.classList.toggle('hide', !on); }

// Chromium-based browsers fire this when the app is installable; stash it and
// reveal our own button so we control where the prompt appears.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstall = e;
  if (!isStandalone()) showInstallBtn(true);
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null; showInstallBtn(false);
  $('installBtn2') && $('installBtn2').classList.add('hide');   // hide the Settings button too
  toast('Installed! Open Shikaku from your home screen 🎉');
});

function installApp(){
  // Always open a visible modal (so the button never "does nothing"). If Chrome
  // gave us a deferred prompt, offer a one-tap "Install now"; always include the
  // manual steps as a reliable fallback for every browser.
  const wrap = $('installNowWrap');
  if (wrap){
    if (deferredInstall){
      wrap.innerHTML = '<button class="btn gold full" id="installNowBtn">⬇️ Install now</button>';
      $('installNowBtn').onclick = async () => {
        const ev = deferredInstall; if (!ev) return;
        deferredInstall = null;
        try { ev.prompt(); await ev.userChoice; } catch(e){}
        showInstallBtn(false);
        $('installBtn2') && $('installBtn2').classList.add('hide');
        hideAll();
      };
    } else {
      wrap.innerHTML = '';
    }
  }
  const steps = isIOS()
    ? ['1. Tap the <b>Share</b> icon (the box with an ↑) in Safari',
       '2. Scroll and choose <b>Add to Home Screen</b>',
       '3. Tap <b>Add</b>, then open <b>Shikaku</b> from your home screen']
    : ['1. Open Chrome\'s <b>⋮</b> menu (top-right)',
       '2. Tap <b>Install app</b> (or <b>Add to Home screen</b>)',
       '3. Confirm <b>Install</b> — Shikaku opens like a normal app'];
  $('installSteps').innerHTML = steps.map(s => '<div>' + s + '</div>').join('');
  hideAll();          // close Settings (or any overlay) before showing the modal
  show('install');
}

function initPWA(){
  if ('serviceWorker' in navigator){
    // when a freshly-deployed worker takes control, reload once so the device
    // always runs the latest code (no manual cache clearing needed)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem('sw-reloaded')) return;
      sessionStorage.setItem('sw-reloaded', '1');
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').then(reg => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          sw && sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) sw.postMessage('skipWaiting');
          });
        });
      }).catch(() => {});
    });
  }
  if (isStandalone()){
    showInstallBtn(false);
    $('installBtn2') && $('installBtn2').classList.add('hide');   // already installed
  } else if (isIOS()) showInstallBtn(true);   // iOS never fires beforeinstallprompt
}

/* --------------------------------- Boot ----------------------------------- */
(function init(){
  // inline onclick handlers resolve against the global object, but `game`/`battle`
  // are lexical consts — expose them so the control buttons work everywhere.
  window.game = game; window.battle = battle;
  Player.load();
  Cloud.init();
  applyTheme(Player.data.theme, Player.data.accent);
  document.body.classList.toggle('no-anim', !Player.data.anim);
  if (window.FX){ FX.init(); FX.setAnim(Player.data.anim); }
  if (!navigator.share) $('shareBtn')?.classList.add('hide');
  refreshChip();
  renderLevels();
  showScreen('menu');
  initPWA();
  // prompt for a name, or reconcile this device to its canonical account
  // (collapsing any legacy duplicate rows and recovering cloud progress)
  if (!Player.data.username){
    openProfile(true);
  } else {
    ensureIdentity();
  }
})();
