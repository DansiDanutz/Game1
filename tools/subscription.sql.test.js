/* Play credits, trophies and ranked matches, run against the real migrations
   in an in-process Postgres (run: node --test tools/subscription.sql.test.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');
const ANN = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const CAT = '00000000-0000-4000-8000-00000000000c';

async function freshDb() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique not null);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;`);
  await db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.sql')).sort())
    await db.exec(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const [id, name] of [[ANN, 'Ann'], [BOB, 'Bob'], [CAT, 'Cat']]) {
    await db.query('insert into auth.users values ($1,$2)', [id, name + '@example.test']);
    await as(db, id);
    const t = (await db.query('select public.shikaku_claim($1,$2) t', [name, '1234'])).rows[0].t;
    await db.query('select public.shikaku_link_email($1,$2)', [t, name]);
  }
  return db;
}
const as = (db, id) => db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [id || '']);
const call = async (db, id, fn, ...args) => {
  await as(db, id);
  const marks = args.map((_, i) => '$' + (i + 1)).join(',');
  return (await db.query(`select * from public.${fn}(${marks})`, args)).rows[0];
};
const grant = (db, id, n = 5, invoice = 'in_' + id.slice(-1)) =>
  call(db, null, 'shikaku_grant_credits', invoice, id, n);
const status = (db, id) => call(db, id, 'shikaku_play_status');
const clawBack = (db, invoice, source, cents, seen = '2026-11-25T10:00:00Z', total = 100) =>
  call(db, null, 'shikaku_set_clawback', invoice, source, cents, total, seen);

/* Any valid tiling is accepted, so a test solves the puzzle by search. */
function solve(grid) {
  const N = grid.length, owner = grid.map((r) => r.map(() => 0)), out = [];
  const fits = (r0, c0, h, w) => {
    if (r0 + h > N || c0 + w > N) return false;
    let clue = 0;
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) {
      if (owner[r][c]) return false;
      if (grid[r][c]) { if (clue) return false; clue = grid[r][c]; }
    }
    return clue === h * w;
  };
  const paint = (r0, c0, h, w, v) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) owner[r][c] = v;
  };
  const go = () => {
    const at = owner.flat().indexOf(0);
    if (at < 0) return true;
    const r0 = Math.floor(at / N), c0 = at % N;
    for (let h = 1; h <= N; h++) for (let w = 1; w <= N; w++) if (fits(r0, c0, h, w)) {
      paint(r0, c0, h, w, 1); out.push({ r0, c0, r1: r0 + h - 1, c1: c0 + w - 1 });
      if (go()) return true;
      out.pop(); paint(r0, c0, h, w, 0);
    }
    return false;
  };
  assert.ok(go(), 'the generated puzzle has a solution');
  return out;
}
async function startMatch(db, size = 6) {
  await grant(db, ANN); await grant(db, BOB);
  const m = await call(db, ANN, 'shikaku_match_create', size);
  await call(db, BOB, 'shikaku_match_join', m.code);
  return m;
}
const state = (db, id, m) => call(db, id, 'shikaku_match_state', m.match_id);

test('a paid month adds its credits once, however often Stripe reports it', async () => {
  const db = await freshDb();
  await grant(db, ANN, 100, 'in_1'); await grant(db, ANN, 100, 'in_1');
  assert.equal((await status(db, ANN)).credits, 100);
});

test('a match costs both players one credit when it starts, not before', async () => {
  const db = await freshDb();
  await grant(db, ANN); await grant(db, BOB);
  const m = await call(db, ANN, 'shikaku_match_create', 6);
  assert.equal((await status(db, ANN)).credits, 5);
  await call(db, BOB, 'shikaku_match_join', m.code);
  assert.equal((await status(db, ANN)).credits, 4);
  assert.equal((await status(db, BOB)).credits, 4);
});

test('winning never adds credits: both players only ever spend them', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  const { puzzle } = await state(db, ANN, m);
  await call(db, ANN, 'shikaku_match_finish', m.match_id, JSON.stringify(solve(puzzle)));
  assert.equal((await status(db, ANN)).credits, 4);
  assert.equal((await status(db, BOB)).credits, 4);
  const kinds = (await db.query('select distinct kind from public.shikaku_credit_ledger')).rows.map((r) => r.kind);
  assert.deepEqual(kinds.sort(), ['grant', 'spend']);
});

test('the winner gains trophies and the loser never drops below zero', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  const { puzzle } = await state(db, BOB, m);
  const r = await call(db, BOB, 'shikaku_match_finish', m.match_id, JSON.stringify(solve(puzzle)));
  assert.equal(r.status, 'won');
  assert.equal((await status(db, BOB)).trophies, 10);
  assert.equal((await status(db, ANN)).trophies, 0);
  assert.equal((await state(db, ANN, m)).result, 'lost');
});

test('the loser gives up trophies they have', async () => {
  const db = await freshDb();
  await db.query('insert into public.shikaku_trophies (user_id, trophies) values ($1, 25)', [ANN]);
  const m = await startMatch(db);
  await call(db, ANN, 'shikaku_match_leave', m.match_id);
  assert.equal((await status(db, ANN)).trophies, 15);
  assert.equal((await status(db, BOB)).trophies, 10);
});

test('only the first correct solution wins', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  const answer = JSON.stringify(solve((await state(db, ANN, m)).puzzle));
  await call(db, ANN, 'shikaku_match_finish', m.match_id, answer);
  assert.equal((await call(db, BOB, 'shikaku_match_finish', m.match_id, answer)).status, 'lost');
  assert.equal((await call(db, ANN, 'shikaku_match_finish', m.match_id, answer)).status, 'won');
  assert.equal((await status(db, ANN)).trophies, 10);
});

test('wrong, partial, overlapping and malformed solutions are refused', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  const good = solve((await state(db, ANN, m)).puzzle);
  const bad = [
    [], good.slice(1), [...good, good[0]], [{ r0: 0, c0: 0, r1: 5, c1: 5 }],
    [{ r0: -1, c0: 0, r1: 5, c1: 5 }], [{ r0: 0 }], 'x', { a: 1 }, null,
    [{ r0: 0.5, c0: 0, r1: 1, c1: 1 }], Array(1000).fill(good[0]),
  ];
  for (const b of bad)
    assert.equal((await call(db, ANN, 'shikaku_match_finish', m.match_id, JSON.stringify(b))).status, 'wrong', JSON.stringify(b).slice(0, 60));
  assert.equal((await state(db, ANN, m)).status, 'playing');
});

test('the puzzle stays hidden until the match starts, and outsiders never see it', async () => {
  const db = await freshDb();
  await grant(db, ANN);
  const m = await call(db, ANN, 'shikaku_match_create', 6);
  assert.equal((await state(db, ANN, m)).puzzle, null);
  await assert.rejects(state(db, CAT, m), /no such match/);
  await assert.rejects(call(db, CAT, 'shikaku_match_finish', m.match_id, '[]'), /no such match/);
  await assert.rejects(call(db, CAT, 'shikaku_match_leave', m.match_id), /no such match/);
});

test('generated puzzles of every size cover the board exactly', async () => {
  const db = await freshDb();
  for (const size of [5, 6, 7, 8]) for (let i = 0; i < 6; i++) {
    const g = (await db.query('select public.shikaku_new_puzzle($1) g', [size])).rows[0].g;
    assert.equal(g.length, size);
    assert.equal(g.flat().reduce((a, b) => a + b, 0), size * size);
    solve(g);
  }
});

test('credits are required on both sides and are never charged to one only', async () => {
  const db = await freshDb();
  await assert.rejects(call(db, ANN, 'shikaku_match_create', 6), /no play credits/);
  await grant(db, ANN, 1);
  const m = await call(db, ANN, 'shikaku_match_create', 6);
  await assert.rejects(call(db, BOB, 'shikaku_match_join', m.code), /no play credits/);
  await grant(db, BOB, 1);
  await clawBack(db, 'in_a', 'refund', 100);
  await assert.rejects(call(db, BOB, 'shikaku_match_join', m.code), /opponent has no play credits/);
  assert.equal((await status(db, BOB)).credits, 1);
});

test('a player cannot play against themselves or join a match twice', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  await grant(db, CAT);
  await assert.rejects(call(db, CAT, 'shikaku_match_join', m.code), /match not found/);
  const own = await call(db, CAT, 'shikaku_match_create', 6);
  await assert.rejects(call(db, CAT, 'shikaku_match_join', own.code), /match not found/);
  assert.equal((await status(db, CAT)).credits, 5);
});

test('joining again after a lost reply returns the same match without a second charge', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  const again = await call(db, BOB, 'shikaku_match_join', m.code);
  assert.equal(again.match_id, m.match_id);
  assert.equal((await status(db, BOB)).credits, 4);
});

test('a player has one match at a time', async () => {
  const db = await freshDb();
  await grant(db, ANN); await grant(db, BOB);
  const first = await call(db, ANN, 'shikaku_match_create', 6);
  const second = await call(db, ANN, 'shikaku_match_create', 6);
  await assert.rejects(call(db, BOB, 'shikaku_match_join', first.code), /match not found/);
  await call(db, BOB, 'shikaku_match_join', second.code);
  await assert.rejects(call(db, ANN, 'shikaku_match_create', 6), /already in a match/);
});

test('an open match that expires costs nothing, and an unfinished one ends as a draw', async () => {
  const db = await freshDb();
  const m = await startMatch(db);
  await db.query(`update public.shikaku_matches set started_at = now() - interval '31 minutes'`);
  assert.equal((await state(db, ANN, m)).result, 'draw');
  assert.equal((await call(db, ANN, 'shikaku_match_finish', m.match_id, '[]')).status, 'draw');
  assert.equal((await status(db, ANN)).trophies, 0);
  const open = await call(db, ANN, 'shikaku_match_create', 6);
  await db.query(`update public.shikaku_matches set created_at = now() - interval '31 minutes' where id = $1`, [open.match_id]);
  await assert.rejects(call(db, BOB, 'shikaku_match_join', open.code), /match not found/);
  assert.equal((await status(db, ANN)).credits, 4);
});

test('a refund takes back its share once, and refund plus dispute never exceed the grant', async () => {
  const db = await freshDb();
  await grant(db, ANN, 100, 'in_1');
  await clawBack(db, 'in_1', 'refund', 40); await clawBack(db, 'in_1', 'refund', 40);
  assert.equal((await status(db, ANN)).credits, 60);
  await clawBack(db, 'in_1', 'dispute', 100);
  assert.equal((await status(db, ANN)).credits, 0);
  await clawBack(db, 'in_1', 'dispute', 0, '2026-11-25T11:00:00Z');
  assert.equal((await status(db, ANN)).credits, 60);
});

test('a partial refund is rounded in the buyer\'s favour', async () => {
  const db = await freshDb();
  await grant(db, ANN, 100, 'in_1');
  await clawBack(db, 'in_1', 'refund', 250, '2026-11-25T10:00:00Z', 499);
  assert.equal((await status(db, ANN)).credits, 50);
});

test('the status names the player it belongs to', async () => {
  const db = await freshDb();
  assert.equal((await status(db, BOB)).username, 'Bob');
});

test('an older report never overrides a newer one', async () => {
  const db = await freshDb();
  await grant(db, ANN, 100, 'in_1');
  await clawBack(db, 'in_1', 'dispute', 0, '2026-11-25T11:00:00Z');
  await clawBack(db, 'in_1', 'dispute', 100, '2026-11-25T10:00:00Z');
  assert.equal((await status(db, ANN)).credits, 100);
});

test('a refund before its grant is reported as unknown so it is retried', async () => {
  const db = await freshDb();
  assert.equal((await clawBack(db, 'in_none', 'refund', 5)).shikaku_set_clawback, false);
});

test('credits taken back after they were spent block play until repaid', async () => {
  const db = await freshDb();
  await startMatch(db);
  await clawBack(db, 'in_a', 'refund', 100);
  assert.equal((await status(db, ANN)).credits, -1);
});

test('the subscription shows its newest known state', async () => {
  const db = await freshDb();
  const save = (st, cancel, seen) => call(db, null, 'shikaku_save_subscription', 'sub_1', ANN, st, cancel, '2026-12-25T00:00:00Z', seen);
  await save('active', false, '2026-11-25T10:00:00Z');
  await save('incomplete', false, '2026-11-25T09:00:00Z');
  assert.equal((await status(db, ANN)).subscription_status, 'active');
  await save('active', true, '2026-11-25T11:00:00Z');
  assert.equal((await status(db, ANN)).cancel_at_period_end, true);
  assert.equal((await status(db, BOB)).subscription_status, null);
});

test('an email that is not linked to a name, or no email at all, cannot play', async () => {
  const db = await freshDb();
  await assert.rejects(status(db, null), /not signed in/);
  const DAN = '00000000-0000-4000-8000-00000000000d';
  await db.query('insert into auth.users values ($1,$2)', [DAN, 'dan@example.test']);
  await assert.rejects(call(db, DAN, 'shikaku_match_create', 6), /not linked/);
});

test('the leaderboard shows names and trophies only', async () => {
  const db = await freshDb();
  await db.query('insert into public.shikaku_trophies (user_id, trophies, wins) values ($1, 30, 3)', [ANN]);
  const row = await call(db, null, 'shikaku_top_trophies');
  assert.deepEqual({ ...row }, { username: 'Ann', trophies: 30, wins: 3, losses: 0 });
});

test('browsers cannot call billing functions or read private tables', async () => {
  const db = await freshDb();
  const can = async (role, fn) => (await db.query('select has_function_privilege($1,$2,\'execute\') ok', [role, fn])).rows[0].ok;
  const billing = [
    'public.shikaku_grant_credits(text,uuid,integer)',
    'public.shikaku_set_clawback(text,text,integer,integer,timestamptz)',
    'public.shikaku_save_subscription(text,uuid,text,boolean,timestamptz,timestamptz)',
    'public.shikaku_billing_account(uuid)',
    'public.shikaku_save_customer(uuid,text)',
    'public.shikaku_customer_user(text)',
  ];
  const internal = ['public.shikaku_new_puzzle(integer)', 'public.shikaku_is_solution(jsonb,jsonb)'];
  for (const fn of [...billing, ...internal]) for (const role of ['anon', 'authenticated'])
    assert.equal(await can(role, fn), false, role + ' ' + fn);
  for (const fn of billing) assert.equal(await can('service_role', fn), true, fn);
  for (const fn of ['shikaku_play_status()', 'shikaku_match_create(integer)', 'shikaku_match_finish(uuid,jsonb)']) {
    assert.equal(await can('anon', 'public.' + fn), false);
    assert.equal(await can('authenticated', 'public.' + fn), true);
  }
  for (const t of ['shikaku_credit_ledger', 'shikaku_subscriptions', 'shikaku_customers', 'shikaku_matches', 'shikaku_trophies', 'shikaku_clawbacks'])
    for (const role of ['anon', 'authenticated']) for (const p of ['select', 'insert', 'update', 'delete'])
      assert.equal((await db.query('select has_table_privilege($1,$2,$3) ok', [role, 'public.' + t, p])).rows[0].ok, false, `${role} ${p} ${t}`);
});

test('resetting a forgotten PIN keeps paid credits with the email account', async () => {
  const db = await freshDb();
  await grant(db, ANN);
  await db.query(`delete from public.shikaku_accounts where name_key = 'ann'`);
  assert.equal((await db.query('select sum(delta)::int n from public.shikaku_credit_ledger')).rows[0].n, 5);
});

/* ---- extra solo games ---- */
const reqId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function soloReady(db, id, name) {
  await as(db, id);
  const token = (await db.query('select * from public.shikaku_email_sign_in()')).rows[0].token;
  for (let i = 0; i < 10; i++) await call(db, id, 'shikaku_start_game', token, reqId(i), 'endless', null, null);
  return token;
}

test('an extra solo game costs one credit, and a retried start costs no more', async () => {
  const db = await freshDb();
  await grant(db, ANN);
  const token = await soloReady(db, ANN);
  assert.equal((await call(db, ANN, 'shikaku_start_game', token, reqId(90), 'quest', 0, 1)).status, 'limit');
  const a = await call(db, ANN, 'shikaku_start_extra_game', token, reqId(91), 'quest', 0, 1);
  const b = await call(db, ANN, 'shikaku_start_extra_game', token, reqId(91), 'quest', 0, 1);
  assert.equal(a.status, 'ok'); assert.equal(a.ticket, b.ticket);
  assert.equal((await status(db, ANN)).credits, 4);
});

test('an extra game is refused while free games are left or without credits', async () => {
  const db = await freshDb();
  await grant(db, ANN);
  await as(db, ANN);
  const token = (await db.query('select * from public.shikaku_email_sign_in()')).rows[0].token;
  assert.equal((await call(db, ANN, 'shikaku_start_extra_game', token, reqId(1), 'endless', null, null)).status, 'free');
  assert.equal((await status(db, ANN)).credits, 5);
  const bob = await soloReady(db, BOB);
  assert.equal((await call(db, BOB, 'shikaku_start_extra_game', bob, reqId(200), 'endless', null, null)).status, 'no_credits');
});

test('a PIN alone, or another email, cannot spend the owner\'s credits', async () => {
  const db = await freshDb();
  await grant(db, ANN); await grant(db, BOB);
  const token = await soloReady(db, ANN);
  await assert.rejects(call(db, null, 'shikaku_start_extra_game', token, reqId(3), 'endless', null, null), /not signed in/);
  await assert.rejects(call(db, BOB, 'shikaku_start_extra_game', token, reqId(4), 'endless', null, null), /not signed in/);
  assert.equal((await status(db, ANN)).credits, 5);
  assert.equal((await status(db, BOB)).credits, 5);
});
