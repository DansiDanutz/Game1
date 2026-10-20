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
function loadCloud({ configured = true, rpcResult = () => null, profiles = [] } = {}) {
  const events = [];
  const calls = [];
  const fakeClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const out = rpcResult(fn, args);
      if (out instanceof Error) return { data: null, error: { message: out.message } };
      return { data: (out && out.data) || null, error: null };
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
  const ctx = vm.createContext({ window, CustomEvent, console: { warn() {}, log() {} } });
  vm.runInContext(SRC, ctx);
  const Cloud = window.Cloud;
  Cloud.init();
  return { Cloud, events, calls };
}

const score = (world, level, username = 'Tester') =>
  ({ player_id: '00000000-0000-4000-8000-000000000001', username, world, level, score: 100, stars: 1, time_sec: 5, moves: 1 });
const profile = (username = 'Tester') =>
  ({ id: '00000000-0000-4000-8000-000000000001', username, avatar: 'x', theme: 'neon', total_score: 1, best_world: 0, wins: 0, losses: 0 });

test('writes go through the shikaku_* RPCs, never direct table writes', async () => {
  const { Cloud, calls } = loadCloud();
  await Cloud.saveScore(score(0, 0));
  await Cloud.upsertProfile(profile());
  await Cloud.saveDaily({ player_id: profile().id, username: 'Tester', day: 20261019, time_sec: 30, score: 10 });
  assert.deepEqual(calls.map(c => c.fn), ['shikaku_save_score', 'shikaku_save_profile', 'shikaku_save_score']);
  assert.equal(calls[2].args.p_world, 20261019);
  assert.equal(calls[2].args.p_level, 0);
});

test('a failed save stays reported after an unrelated success', async () => {
  let failScore = true;
  const { Cloud, events } = loadCloud({ rpcResult: (fn) => (fn === 'shikaku_save_score' && failScore ? new Error('boom') : null) });
  assert.equal(Cloud.writeOk, true);
  assert.equal(await Cloud.saveScore(score(0, 0)), false);
  assert.equal(Cloud.writeOk, false);
  assert.equal(await Cloud.upsertProfile(profile()), true);       // unrelated success
  assert.equal(Cloud.writeOk, false, 'unrelated success must not hide the failed score');
  failScore = false;
  assert.equal(await Cloud.saveScore(score(0, 1)), true);         // different slot succeeds
  assert.equal(Cloud.writeOk, false, 'a different level slot must not clear it either');
  assert.equal(await Cloud.saveScore(score(0, 0)), true);         // retry of the same save
  assert.equal(Cloud.writeOk, true);
  assert.deepEqual(events.map(e => e.ok), [false, true], 'one failure event, one recovery event');
});

test('recovery is reported only when every failed save has succeeded', async () => {
  const failing = new Set(['0:0', '0:1']);
  const { Cloud, events } = loadCloud({ rpcResult: (fn, a) => (failing.has(a.p_world + ':' + a.p_level) ? new Error('x') : null) });
  await Cloud.saveScore(score(0, 0));
  await Cloud.saveScore(score(0, 1));
  failing.clear();
  await Cloud.saveScore(score(0, 0));
  assert.equal(Cloud.writeOk, false);
  await Cloud.saveScore(score(0, 1));
  assert.equal(Cloud.writeOk, true);
  assert.deepEqual(events.map(e => e.ok), [false, true]);
});

test('a failure under one account clears when that save succeeds after switching names', async () => {
  let fail = true;
  const { Cloud } = loadCloud({ rpcResult: () => (fail ? new Error('x') : null) });
  await Cloud.saveScore(score(0, 0, 'OldName'));
  fail = false;
  await Cloud.saveScore(score(0, 0, 'NewName'));
  assert.equal(Cloud.writeOk, true);
});

test('offline (no key): writes are no-ops and never report failure', async () => {
  const { Cloud, calls, events } = loadCloud({ configured: false });
  assert.equal(Cloud.enabled, false);
  assert.equal(await Cloud.saveScore(score(0, 0)), false);
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
