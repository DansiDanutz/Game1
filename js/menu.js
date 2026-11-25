/* ============================================================================
   The menu. It is drawn as a solved Shikaku board: every option is a rectangle
   and its number is its size in cells.
   ============================================================================ */
function renderMenu(){ renderContinue(); refreshDaily(); refreshQuota(); renderLevels(); }

// The first level that is not cleared yet, or null when all are.
function nextUncleared(){
  for (let w = 0; w < QUEST.length; w++)
    for (let l = 0; l < QUEST[w].levels.length; l++)
      if (!Player.data.progress[w + '-' + l]) return { w, l };
  return null;
}
function playLevel(w, l){ if (requireName()) game.startLevel(w, l); }
function playNext(){
  const n = nextUncleared();
  if (n) playLevel(n.w, n.l); else startEndless();
}
function renderContinue(){
  const n = nextUncleared();
  const started = Object.keys(Player.data.progress).some((k) => questKey(k));
  $('contKicker').textContent = !n ? 'Quest complete' : started ? 'Continue' : 'Start here';
  $('contTitle').textContent = n ? QUEST[n.w].name.split('—')[1].trim() : 'Endless boards';
  const lvl = n && QUEST[n.w].levels[n.l];
  $('contSub').textContent = n ? `World ${n.w + 1} · Level ${n.l + 1} · ${lvl.size}×${lvl.size} ${TIERS[lvl.tier]}` : 'All 108 levels cleared';
}

function refreshDaily(){
  const done = Player.data.lastDaily === todayNum(), s = liveStreak();
  $('dailyCard').classList.toggle('done', done);
  $('dailyTitle').textContent = s > 0 ? `${s}-day streak` : 'Daily';
  $('dailySub').textContent = done ? 'Done. New board tomorrow.' : s > 0 ? 'Play today to keep it.' : 'One board for everyone, every day.';
}

/* Free games left today, as ten cells. */
function setQuota(left, resetAt){
  const el = $('gamesLeft');
  el.textContent = `${left} of ${FREE_DAILY_GAMES} free games left today`;
  el.dataset.reset = resetAt || '';
  $('gamesPips').innerHTML = Array.from({ length: FREE_DAILY_GAMES }, (_, i) => `<i class="${i < left ? 'on' : ''}"></i>`).join('');
  $('quota').classList.remove('hide');
}
function refreshQuota(){
  const hideQuota = () => $('quota').classList.add('hide');
  if (!Cloud.enabled || !Cloud.signedInAs(Player.data.username)) return hideQuota();
  return Cloud.gameQuota().then((q) => { if (q) setQuota(q.gamesLeft, q.resetAt); else hideQuota(); });
}

/* Worlds fold; the one to play next is open. */
function renderLevels(){
  const wrap = $('worlds'), next = nextUncleared();
  const open = next ? next.w : QUEST.length - 1;
  wrap.innerHTML = '';
  QUEST.forEach((world, wi) => {
    const cleared = world.levels.filter((_, li) => Player.data.progress[wi + '-' + li]).length;
    const [num, name] = world.name.split('—').map((x) => x.trim());
    const el = document.createElement('details');
    el.className = 'world'; el.open = wi === open;
    el.innerHTML = `<summary><span class="w-num">${num}</span><span class="w-name">${name}</span>
      <span class="w-bar" aria-hidden="true"><i style="width:${Math.round(cleared / world.levels.length * 100)}%"></i></span>
      <span class="w-count">${cleared}<span class="sr"> of </span><span aria-hidden="true">/</span>${world.levels.length}</span></summary>`;
    const grid = document.createElement('div'); grid.className = 'levels';
    world.levels.forEach((lvl, li) => grid.appendChild(levelTile(wi, li, lvl, next)));
    el.appendChild(grid); wrap.appendChild(el);
  });
}
function levelTile(wi, li, lvl, next){
  const done = Player.data.progress[wi + '-' + li];
  const el = document.createElement('button');
  el.className = `lv tier-${lvl.tier}${done ? ' done' : ''}${next && next.w === wi && next.l === li ? ' next' : ''}`;
  el.setAttribute('aria-label', `Level ${li + 1}, ${lvl.size} by ${lvl.size}, ${TIERS[lvl.tier]}${done ? `, cleared, ${done.score} points` : ''}`);
  el.innerHTML = `<span class="lv-num">${li + 1}</span><span class="lv-size">${lvl.size}×${lvl.size}</span>`
    + (done ? `<span class="lv-score">${done.stars || '★'}</span>` : `<span class="lv-tier">${TIERS[lvl.tier]}</span>`);
  el.onclick = () => playLevel(wi, li);
  return el;
}
