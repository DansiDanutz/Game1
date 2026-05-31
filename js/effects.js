/* ============================================================================
   Visual effects — drifting particle starfield + victory confetti.
   Lightweight canvas work; pauses when the tab is hidden or the player turns
   animations off (FX.setAnim(false)). Particle colors pull from the live theme
   so effects always match the chosen palette.
   ============================================================================ */
const FX = (() => {
  let animOn = true, running = false, raf = 0;
  let bg, bgx, cf, cfx, W = 0, H = 0, dpr = 1;
  let stars = [], confetti = [];

  function accent(){
    const s = getComputedStyle(document.documentElement);
    return {
      a: (s.getPropertyValue('--neon')  || '#39e6ff').trim(),
      b: (s.getPropertyValue('--neon-2')|| '#b14bff').trim(),
      c: (s.getPropertyValue('--gold')  || '#ffcf4d').trim(),
      d: (s.getPropertyValue('--good')  || '#4dffa1').trim()
    };
  }
  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    [bg, cf].forEach(cv => { if (!cv) return; cv.width = W*dpr; cv.height = H*dpr; cv.style.width = W+'px'; cv.style.height = H+'px'; });
    bgx && bgx.setTransform(dpr,0,0,dpr,0,0);
    cfx && cfx.setTransform(dpr,0,0,dpr,0,0);
  }
  function seedStars(){
    const n = Math.min(70, Math.floor(W*H/22000));
    stars = Array.from({length:n}, () => ({
      x: Math.random()*W, y: Math.random()*H,
      r: Math.random()*1.6+0.4, vy: Math.random()*0.18+0.04,
      tw: Math.random()*Math.PI*2, sp: Math.random()*0.04+0.01
    }));
  }
  function drawBg(){
    bgx.clearRect(0,0,W,H);
    const col = accent();
    for (const st of stars){
      st.y += st.vy; st.tw += st.sp;
      if (st.y > H+2){ st.y = -2; st.x = Math.random()*W; }
      const a = 0.35 + Math.sin(st.tw)*0.3;
      bgx.globalAlpha = Math.max(0.06, a);
      bgx.fillStyle = Math.random() < 0.5 ? col.a : col.b;
      bgx.beginPath(); bgx.arc(st.x, st.y, st.r, 0, 7); bgx.fill();
    }
    bgx.globalAlpha = 1;
  }
  function drawConfetti(){
    cfx.clearRect(0,0,W,H);
    for (let i = confetti.length-1; i >= 0; i--){
      const p = confetti[i];
      p.vy += 0.16; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--;
      cfx.save(); cfx.translate(p.x, p.y); cfx.rotate(p.rot);
      cfx.globalAlpha = Math.max(0, Math.min(1, p.life/24));
      cfx.fillStyle = p.color;
      cfx.fillRect(-p.s/2, -p.s/2, p.s, p.s*0.6);
      cfx.restore();
      if (p.life <= 0 || p.y > H+30) confetti.splice(i,1);
    }
  }
  function loop(){
    if (!running) return;
    drawBg();
    if (confetti.length) drawConfetti(); else if (cfx) cfx.clearRect(0,0,W,H);
    raf = requestAnimationFrame(loop);
  }
  function start(){ if (running || !animOn) return; running = true; raf = requestAnimationFrame(loop); }
  function stop(){ running = false; cancelAnimationFrame(raf); bgx && bgx.clearRect(0,0,W,H); cfx && cfx.clearRect(0,0,W,H); }

  return {
    init(){
      bg = document.getElementById('bgfx'); cf = document.getElementById('confetti');
      if (!bg || !cf) return;
      bgx = bg.getContext('2d'); cfx = cf.getContext('2d');
      resize(); seedStars();
      window.addEventListener('resize', () => { resize(); seedStars(); });
      document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start(); });
      start();
    },
    setAnim(on){ animOn = on; on ? start() : stop(); },
    confetti(){
      if (!animOn || !cfx) return;
      const col = accent(), palette = [col.a, col.b, col.c, col.d, '#ffffff'];
      const cx = W/2, cy = H*0.34;
      for (let i = 0; i < 150; i++){
        const ang = Math.random()*Math.PI*2, spd = Math.random()*9+3;
        confetti.push({
          x: cx, y: cy, vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd - 5,
          s: Math.random()*8+4, rot: Math.random()*7, vr: (Math.random()-0.5)*0.4,
          color: palette[(Math.random()*palette.length)|0], life: 70+Math.random()*40
        });
      }
      if (!running) { running = true; raf = requestAnimationFrame(loop); }
    }
  };
})();
window.FX = FX;
