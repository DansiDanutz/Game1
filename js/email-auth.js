/* ============================================================================
   Email sign-in — the overlay and its two steps (email, then one-time code).
   EmailAuth.open({ mode, name, onDone }):
     mode 'link'   the signed-in name is linked to the verified email (once);
     mode 'signin' a linked email returns its name and a session token.
   onDone receives { mode, name } (link) or { mode, name, token } (signin); the
   app decides what to do with the device. Failures are plain sentences in
   #emailMsg, which is announced to screen readers. Escape closes the dialog.
   ============================================================================ */
const EmailAuth = (() => {
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CODE_PATTERN = /^\d{6}$/;
  const MESSAGES = {
    email_linked: 'This email is already linked to another name. Use a different email, or sign in with that name.',
    name_has_email: 'This name already has an email. Sign in with that email instead.',
    no_email_session: 'The code did not sign you in. Request a new code and try again.',
    signed_out: 'Sign in with your name and PIN first, then link your email.',
    unlinked: "This email isn't linked to a name yet. Sign in with your name and PIN, then link it in Settings.",
    rate_limited: 'Too many codes requested. Wait a minute, then try again.',
    invalid_email: 'That email address does not look right. Check it and try again.',
    bad_code: 'That code is wrong or has expired. Check it, or request a new one.',
    offline: 'Email sign-in needs the cloud. Add your Supabase key in js/config.js.',
    error: "Couldn't reach the server. Try again."
  };
  let state = null;   // { mode, name, onDone, email, busy }
  const el = (id) => document.getElementById(id);
  const say = (text) => { el('emailMsg').textContent = text || ''; };
  const showStep = (n) => {
    el('emailStep1').classList.toggle('hide', n !== 1);
    el('emailStep2').classList.toggle('hide', n !== 2);
  };
  // Buttons are reset even when the dialog closed meanwhile (state is then null).
  const setBusy = (on) => {
    if (state) state.busy = on;
    ['emailSend', 'emailVerify'].forEach(id => { el(id).disabled = on; });
    el('ov-email').setAttribute('aria-busy', on ? 'true' : 'false');
  };
  const focusLater = (id) => setTimeout(() => el(id).focus(), 50);

  function open(opts){
    state = { mode: opts.mode, name: opts.name || '', onDone: opts.onDone, email: '', busy: false };
    el('emailTitle').textContent = state.mode === 'link' ? 'LINK YOUR EMAIL' : 'SIGN IN WITH EMAIL';
    el('emailIntro').textContent = state.mode === 'link'
      ? `Link ${state.name} to an email to sign in with a code on any device. Your PIN keeps working.`
      : "We'll email you a one-time code. There's no password to remember.";
    el('inpEmail').value = ''; el('inpEmailCode').value = '';
    say(''); showStep(1);
    hideAll();                       // close any overlay underneath (profile, settings)
    show('email');
    focusLater('inpEmail');
  }
  function close(){
    el('ov-email').classList.remove('show');
    state = null;
  }
  function finish(result){
    const done = state && state.onDone;
    close();
    if (done) done(result);
  }
  function back(){
    if (state.busy) return;
    say(''); showStep(1); focusLater('inpEmail');
  }
  async function send(){
    if (!state || state.busy) return;
    const email = el('inpEmail').value.trim();
    if (!EMAIL_PATTERN.test(email)) return say(MESSAGES.invalid_email);
    setBusy(true);
    let r;
    try { r = await Cloud.sendEmailCode(email); }
    finally { setBusy(false); }
    if (!state) return;              // closed while the code was being sent
    if (!r.ok) return say(MESSAGES[r.status] || MESSAGES.error);
    state.email = email;
    showStep(2);
    say(`We sent a 6-digit code to ${email}. It can take a minute to arrive.`);
    focusLater('inpEmailCode');
  }
  async function verify(){
    if (!state || state.busy) return;
    const code = el('inpEmailCode').value.trim();
    if (!CODE_PATTERN.test(code)) return say('The code is 6 digits.');
    setBusy(true);
    try {
      const v = await Cloud.verifyEmailCode(state.email, code);
      if (!v.ok) return say(MESSAGES[v.status] || MESSAGES.error);
      if (state.mode === 'link'){
        const linked = await Cloud.linkEmail(state.name);
        if (!linked.ok) return say(MESSAGES[linked.status] || MESSAGES.error);
        return finish({ mode: 'link', name: state.name });
      }
      const signed = await Cloud.emailSignIn();
      if (!signed.ok) return say(MESSAGES[signed.status] || MESSAGES.error);
      return finish({ mode: 'signin', name: signed.name, token: signed.token });
    } finally {
      setBusy(false);
    }
  }
  function onKey(e, action){
    if (e.key === 'Enter'){ e.preventDefault(); action(); }
  }
  el('inpEmail').addEventListener('keydown', (e) => onKey(e, send));
  el('inpEmailCode').addEventListener('keydown', (e) => onKey(e, verify));
  el('ov-email').addEventListener('keydown', (e) => { if (e.key === 'Escape' && state) close(); });

  return { open, close, send, verify, back };
})();
window.EmailAuth = EmailAuth;
