/* Regression tests for js/cloud.js (run: node --test tools/cloud.test.js).
   Loads the real browser file into a VM with a fake Supabase client, so these
   exercise the shipped code — not a re-implementation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'cloud.js'), 'utf8');

// rpcResult(fn, args) decides each RPC outcome: return an Error to fail it, or
// { data } to return rows.
// session: the name this device is signed in as (null = signed out).
function loadCloud({ emailSession = null, configured = true, rpcResult = () => null, profiles = [], session = 'Tester',
                     otpResult = () => null, verifyResult = () => null } = {}) {
  const events = [];
  const calls = [];
  const authCalls = [];
  const authOut = (out) => (out instanceof Error ? { data: null, error: { message: out.message } } : { data: out || {}, error: null });
  const fakeClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const out = rpcResult(fn, args);
      if (out instanceof Error) return { data: null, error: { message: out.message } };
      return { data: (out && out.data) || null, error: null };
    },
    auth: {
      signInWithOtp: async (args) => { authCalls.push({ fn: 'signInWithOtp', args }); return authOut(otpResult(args)); },
      verifyOtp: async (args) => { authCalls.push({ fn: 'verifyOtp', args }); return authOut(verifyResult(args)); },
      getSession: async () => ({ data: { session: emailSession } }),
      signOut: async (opts) => { authCalls.push({ fn: 'signOut', args: opts }); return { error: null }; },
    },
    from: () => {
      // minimal query builder: select().eq().maybeSingle() / select().limit()
      const q = {
        _id: null,
        select() { return q; },
        eq(_c, v) { q._id = v; return q; },
        async maybeSingle() { return { data: profiles.find(p => p.id === q._id) || null }; },
        async limit() { return { data: profiles, error: null }; },
      };
      return q;
    },
  };
  const window = {
    SHIKAKU_CONFIG: configured ? { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' } : {},
    supabase: { createClient: () => fakeClient },
    dispatchEvent: (e) => events.push(e.detail),
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const store = new Map();
  if (session) store.set('shikaku_session', JSON.stringify({ key: session.toLowerCase(), token: 'tok-' + session }));
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const ctx = vm.createContext({ window, CustomEvent, localStorage, crypto: require('crypto').webcrypto, console: { warn() {}, log() {} } });
  vm.runInContext(SRC, ctx);
  const Cloud = window.Cloud;
  Cloud.init();
  return { Cloud, events, calls, store, authCalls };
}

const RECTS = [{ r0: 0, c0: 0, r1: 0, c1: 1, color: 'x' }];
const finished = (username = 'Tester') => ({ ticket: 'tick', username, rects: RECTS, moves: 3, hints: 1 });
const saved = { data: [{ status: 'ok', score: 910, stars: 3, time_sec: 12 }] };
const profile = (username = 'Tester') =>
  ({ id: '00000000-0000-4000-8000-000000000001', username, avatar: 'x', theme: 'neon', total_score: 1, best_world: 0, wins: 0, losses: 0 });

test('writes go through the shikaku_* RPCs, never direct table writes', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: (fn) => (fn === 'shikaku_finish_game' ? saved : null) });
  assert.deepEqual({ ...(await Cloud.finishGame(finished())) }, { status: 'ok', score: 910, stars: 3, time: 12 });
  await Cloud.upsertProfile(profile());
  assert.deepEqual(calls.map(c => c.fn), ['shikaku_finish_game', 'shikaku_save_profile']);
  assert.ok(calls.every(c => c.args.p_token === 'tok-Tester'), 'every save carries the session token');
});

test('a finished game sends the solution, never a score or a time', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: () => saved });
  await Cloud.finishGame(finished());
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { p_token: 'tok-Tester', p_ticket: 'tick', p_username: 'Tester',
    p_rects: [{ r0: 0, c0: 0, r1: 0, c1: 1 }], p_moves: 3, p_hints: 1 });
});

test('a lost reply is asked for again, and a refusal is not', async () => {
  let n = 0;
  const lost = loadCloud({ rpcResult: () => (++n < 3 ? new Error('fetch failed') : saved) });
  assert.equal((await lost.Cloud.finishGame(finished())).score, 910);
  assert.equal(lost.calls.length, 3);
  const no = loadCloud({ rpcResult: () => new Error('shikaku: invalid ticket') });
  assert.equal(await no.Cloud.finishGame(finished()), null);
  assert.equal(no.calls.length, 1);
  assert.deepEqual(no.events.map(e => e.ok), [false], 'the player is told the score was not saved');
});

test('the board for a ticket comes from the server', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: () => ({ data: [{ puzzle: [[2, 0], [2, 0]] }] }) });
  assert.deepEqual(JSON.parse(JSON.stringify(await Cloud.dealBoard('tick'))), [[2, 0], [2, 0]]);
  assert.deepEqual({ ...calls[0].args }, { p_token: 'tok-Tester', p_ticket: 'tick' });
  assert.equal(await Cloud.dealBoard(null), null);
});

test('a failed save stays reported until that save succeeds', async () => {
  let fail = true;
  const { Cloud, events } = loadCloud({ rpcResult: () => (fail ? new Error('boom') : null) });
  assert.equal(await Cloud.upsertProfile(profile()), false);
  assert.equal(Cloud.writeOk, false);
  fail = false;
  assert.equal(await Cloud.upsertProfile(profile()), true);
  assert.equal(Cloud.writeOk, true);
  assert.deepEqual(events.map(e => e.ok), [false, true], 'one failure event, one recovery event');
});

test('without a session for that name, saves are skipped (not sent, not failures)', async () => {
  const signedOut = loadCloud({ session: null });
  assert.equal(await signedOut.Cloud.finishGame(finished()), null);
  assert.equal(await signedOut.Cloud.upsertProfile(profile()), false);
  const other = loadCloud({ session: 'Someone' });
  assert.equal(await other.Cloud.finishGame(finished()), null);
  for (const { calls, events, Cloud } of [signedOut, other]) {
    assert.equal(calls.length, 0);
    assert.equal(events.length, 0);
    assert.equal(Cloud.writeOk, true);
  }
});

test('claim and login return a token but only useSession() signs the device in', async () => {
  const { Cloud, store } = loadCloud({ session: null, rpcResult: (fn, a) => {
    if (fn === 'shikaku_claim') return a.p_username === 'Taken' ? new Error('shikaku: name taken') : { data: 'tok-new' };
    if (fn === 'shikaku_login') return { data: [a.p_pin === '4821' ? { token: 'tok-in', status: 'ok' } : { token: null, status: 'wrong' }] };
  } });
  assert.deepEqual({ ...(await Cloud.claim('Taken', '1111')) }, { ok: false, status: 'taken' });
  assert.deepEqual({ ...(await Cloud.login(' ann ', '0000')) }, { ok: false, status: 'wrong' });
  const r = await Cloud.login('Ann', '4821');
  assert.deepEqual({ ...r }, { ok: true, status: 'ok', token: 'tok-in' });
  assert.equal(Cloud.signedInAs('Ann'), false, 'a login the player backed out of must not sign in');
  assert.equal(store.has('shikaku_session'), false);
  Cloud.useSession('Ann', r.token);
  assert.equal(Cloud.signedInAs('ANN'), true, 'names match case-insensitively');
  assert.equal(JSON.parse(store.get('shikaku_session')).token, 'tok-in');
  Cloud.useSession('Bob', (await Cloud.claim('Bob', '1234')).token);
  assert.equal(Cloud.signedInAs('Ann'), false, 'one session per device');
  Cloud.signOut();
  assert.equal(Cloud.signedInAs('Bob'), false);
  assert.equal(store.has('shikaku_session'), false);
});

test('a rejected token signs the device out and asks to sign in', async () => {
  for (const call of [(c) => c.upsertProfile(profile()), (c) => c.dealBoard('tick')]) {
    const { Cloud, events } = loadCloud({ rpcResult: () => new Error('shikaku: not signed in') });
    await call(Cloud);
    assert.equal(Cloud.signedInAs('Tester'), false);
    assert.equal(Cloud.writeOk, true);
    assert.deepEqual(events.map(e => ({ ok: e.ok, auth: e.auth })), [{ ok: false, auth: true }]);
  }
});

test('offline (no key): writes are no-ops and never report failure', async () => {
  const { Cloud, calls, events } = loadCloud({ configured: false });
  assert.equal(Cloud.enabled, false);
  assert.equal(await Cloud.finishGame(finished()), null);
  assert.equal(calls.length, 0);
  assert.equal(Cloud.writeOk, true);
  assert.equal(events.length, 0);
});

test('win-screen rank comes from the server-side grouped query for this player\'s name', async () => {
  const rows = [{ id: 't1', username: 'Tester', total_score: 500 }];
  const seen = [];
  const { Cloud } = loadCloud({
    profiles: rows,
    rpcResult: (fn, a) => { seen.push({ fn, a }); return fn === 'shikaku_rank' ? { data: [{ rank: 3, total: 4, value: 500 }] } : null; },
  });
  assert.deepEqual({ ...(await Cloud.myRank('quest', 't1')) }, { rank: 3, total: 4, value: 500 });
  await Cloud.myRank('battle', 't1');
  assert.deepEqual(seen.map(x => ({ ...x.a })), [
    { p_board: 'quest', p_username: 'Tester' }, { p_board: 'battle', p_username: 'Tester' }]);
});

test('rank is null when the player has no row or the query fails', async () => {
  const empty = loadCloud({ profiles: [{ id: 't1', username: 'Tester' }], rpcResult: () => ({ data: [] }) });
  assert.equal(await empty.Cloud.myRank('quest', 't1'), null);
  const failing = loadCloud({ profiles: [{ id: 't1', username: 'Tester' }], rpcResult: () => new Error('x') });
  assert.equal(await failing.Cloud.myRank('quest', 't1'), null);
  const noProfile = loadCloud({ profiles: [] });
  assert.equal(await noProfile.Cloud.myRank('quest', 't1'), null);
});

// ---- Free daily games (shikaku_start_game / shikaku_game_quota) ------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const startRow = (status, extra = {}) => ({ data: [Object.assign({ status, ticket: null, games_left: 0, reset_at: '2026-11-26T00:00:00+00:00' }, extra)] });

test('starting a board sends the session token, kind and slot, and returns its ticket', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: (fn) => (fn === 'shikaku_start_game'
    ? startRow('ok', { ticket: 'abc', games_left: 9 }) : null) });
  const r = await Cloud.startGame('quest', 0, 3);
  assert.deepEqual({ ...r }, { status: 'ok', ticket: 'abc', gamesLeft: 9, resetAt: '2026-11-26T00:00:00+00:00' });
  const c = calls.find(x => x.fn === 'shikaku_start_game');
  assert.equal(c.args.p_token, 'tok-Tester');
  assert.equal(c.args.p_kind, 'quest');
  assert.equal(c.args.p_world, 0);
  assert.equal(c.args.p_level, 3);
  assert.match(c.args.p_request_id, UUID);
});

test('the 11th board of the day comes back as a limit with the reset time, not an error', async () => {
  const { Cloud } = loadCloud({ rpcResult: () => startRow('limit') });
  assert.deepEqual({ ...(await Cloud.startGame('endless', null, null)) },
    { status: 'limit', ticket: null, gamesLeft: 0, resetAt: '2026-11-26T00:00:00+00:00' });
});

test('a lost reply is retried with the same request id, so the server counts one board', async () => {
  let attempts = 0;
  const { Cloud, calls } = loadCloud({ rpcResult: (fn) => {
    if (fn !== 'shikaku_start_game') return null;
    attempts++;
    return attempts === 1 ? new Error('TypeError: Failed to fetch') : startRow('ok', { ticket: 'retry-ticket', games_left: 8 });
  } });
  const r = await Cloud.startGame('daily', 20261125, 0);
  assert.equal(r.status, 'ok');
  assert.equal(r.ticket, 'retry-ticket');
  const ids = calls.filter(c => c.fn === 'shikaku_start_game').map(c => c.args.p_request_id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'both attempts carry the same request id');
});

test('a refusal from the server is not retried, and a rejected session signs the device out', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: () => new Error('shikaku: not signed in') });
  const r = await Cloud.startGame('quest', 0, 0);
  assert.equal(r.status, 'signed_out');
  assert.equal(calls.filter(c => c.fn === 'shikaku_start_game').length, 1);
  assert.equal(Cloud.signedInAs('Tester'), false);
});

test('signed out: no request is sent; offline (no key): the board is simply local', async () => {
  const signedOut = loadCloud({ session: null });
  assert.equal((await signedOut.Cloud.startGame('quest', 0, 0)).status, 'signed_out');
  assert.equal(signedOut.calls.length, 0);
  const offline = loadCloud({ configured: false });
  assert.equal((await offline.Cloud.startGame('quest', 0, 0)).status, 'local');
  assert.equal(offline.calls.length, 0);
});

test('a board that cannot be started (server unreachable every time) reports an error', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: () => new Error('TypeError: Failed to fetch') });
  assert.equal((await Cloud.startGame('quest', 0, 0)).status, 'error');
  assert.equal(calls.length, 3, 'three attempts, all with the same request id');
  assert.equal(new Set(calls.map(c => c.args.p_request_id)).size, 1);
});

test('the quota read returns games left and the reset time', async () => {
  const { Cloud } = loadCloud({ rpcResult: (fn) => (fn === 'shikaku_game_quota'
    ? { data: [{ games_left: 4, reset_at: '2026-11-26T00:00:00+00:00' }] } : null) });
  assert.deepEqual({ ...(await Cloud.gameQuota()) }, { gamesLeft: 4, resetAt: '2026-11-26T00:00:00+00:00' });
});

// ---- Email sign-in (Supabase Auth one-time code) ---------------------------
test('email: a one-time code is requested without storing the address on the device', async () => {
  const { Cloud, authCalls, store } = loadCloud({ session: null });
  assert.deepEqual({ ...(await Cloud.sendEmailCode('Ann@Example.com')) }, { ok: true, status: 'sent' });
  assert.deepEqual(JSON.parse(JSON.stringify(authCalls[0])), { fn: 'signInWithOtp', args: { email: 'ann@example.com', options: { shouldCreateUser: true } } });
  assert.ok(![...store.values()].some(v => /example\.com/.test(v)), 'the address is never stored locally');
});

test('email: Supabase rate limiting and bad addresses are reported as their own statuses', async () => {
  const limited = loadCloud({ otpResult: () => new Error('For security purposes, you can only request this after 60 seconds.') });
  assert.equal((await limited.Cloud.sendEmailCode('ann@example.com')).status, 'rate_limited');
  const bad = loadCloud({ otpResult: () => new Error('Unable to validate email address: invalid format') });
  assert.equal((await bad.Cloud.sendEmailCode('nope')).status, 'invalid_email');
});

test('email: a wrong or expired code is reported as bad_code and signs nothing in', async () => {
  const { Cloud, store } = loadCloud({ session: null, verifyResult: () => new Error('Token has expired or is invalid') });
  assert.deepEqual({ ...(await Cloud.verifyEmailCode('ann@example.com', '123456')) }, { ok: false, status: 'bad_code' });
  assert.equal(store.has('shikaku_session'), false);
});

test('email: a verified email can link the signed-in name once, and stays signed in for paid features', async () => {
  const seen = [];
  const { Cloud, authCalls } = loadCloud({ rpcResult: (fn, a) => { seen.push({ fn, a }); return { data: null }; } });
  assert.equal((await Cloud.verifyEmailCode('ann@example.com', '123456')).ok, true);
  assert.deepEqual({ ...(await Cloud.linkEmail('Tester')) }, { ok: true, status: 'linked' });
  const link = seen.find(x => x.fn === 'shikaku_link_email');
  assert.deepEqual({ ...link.a }, { p_token: 'tok-Tester', p_username: 'Tester' });
  assert.equal(authCalls.filter(c => c.fn === 'signOut').length, 0);
});

test('email: link errors come back as friendly statuses', async () => {
  const cases = [
    ['shikaku: email already linked', 'email_linked'],
    ['shikaku: name already has an email', 'name_has_email'],
    ['shikaku: not signed in with email', 'no_email_session'],
    ['shikaku: not signed in', 'signed_out'],
  ];
  for (const [message, status] of cases) {
    const { Cloud } = loadCloud({ rpcResult: () => new Error(message) });
    assert.equal((await Cloud.linkEmail('Tester')).status, status, message);
  }
});

test('email: sign-in returns the linked name and a session token; unlinked emails are refused', async () => {
  const linked = loadCloud({ session: null, rpcResult: (fn) => (fn === 'shikaku_email_sign_in'
    ? { data: [{ username: 'Ann', token: 'tok-email' }] } : null) });
  assert.deepEqual({ ...(await linked.Cloud.emailSignIn()) }, { ok: true, status: 'ok', name: 'Ann', token: 'tok-email' });
  assert.equal(linked.authCalls.length, 0, 'the email session stays, so credits can be used');
  const unlinked = loadCloud({ session: null, rpcResult: () => new Error('shikaku: email is not linked to a name') });
  assert.equal((await unlinked.Cloud.emailSignIn()).status, 'unlinked');
  assert.deepEqual(unlinked.authCalls.map(c => c.fn), ['signOut'], 'an email that cannot be used is signed out');
});

// ---- Shikaku Plus ----------------------------------------------------------
test('plus: signing out of the game also signs the email out', async () => {
  const { Cloud, authCalls } = loadCloud({});
  Cloud.signOut();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(authCalls.map(c => c.args))), [{ scope: 'local' }]);
});
test('plus: server reasons come back plainly, and everything else is offline', async () => {
  const no = loadCloud({ rpcResult: () => new Error('shikaku: no play credits') });
  assert.deepEqual({ ...(await no.Cloud.plus('shikaku_match_create', { p_size: 6 })) }, { error: 'no play credits' });
  const down = loadCloud({ rpcResult: () => new Error('fetch failed') });
  assert.deepEqual({ ...(await down.Cloud.plus('shikaku_play_status')) }, { error: 'offline' });
});
test('plus: an extra game sends the request id it is given, so a retry costs nothing more', async () => {
  const { Cloud, calls } = loadCloud({ rpcResult: () => ({ data: [{ status: 'ok', ticket: 't', credits: 4 }] }) });
  await Cloud.startExtraGame('quest', 0, 1, 'same-id'); await Cloud.startExtraGame('quest', 0, 1, 'same-id');
  assert.deepEqual(calls.filter(c => c.fn === 'shikaku_start_extra_game').map(c => c.args.p_request_id), ['same-id', 'same-id']);
});
test('plus: the email session is recognised', async () => {
  assert.equal(await loadCloud({ emailSession: { user: {} } }).Cloud.hasEmailSession(), true);
  assert.equal(await loadCloud({}).Cloud.hasEmailSession(), false);
});
