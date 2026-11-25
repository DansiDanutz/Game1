/* Scores decided by the server: real migrations in an in-process Postgres. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');
const ROOT = path.join(__dirname, '..');
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'));
// PGlite takes a global window for a browser, so it only exists while the game files load.
global.window = {};
require('../js/levels.js'); require('../js/puzzle.js');
const { WORLDS, dailyGrid } = global.window.SHIKAKU_PUZZLE;
delete global.window;

async function freshDb() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text unique not null);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
  await db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  for (const sql of MIGRATIONS) await db.exec(sql);
  return db;
}
const one = async (db, sql, p) => (await db.query(sql, p)).rows[0];
const claim = async (db, name) => (await one(db, 'select public.shikaku_claim($1,$2) t', [name, '1234'])).t;
const start = (db, t, kind = 'quest', w = 0, l = 0) =>
  one(db, 'select * from public.shikaku_start_game($1,$2,$3,$4,$5)', [t, crypto.randomUUID(), kind, w, l]);
const deal = async (db, t, ticket) => (await one(db, 'select * from public.shikaku_deal_board($1,$2)', [t, ticket])).puzzle;
const finish = (db, t, ticket, name, rects, moves = rects.length, hints = 0) =>
  one(db, 'select * from public.shikaku_finish_game($1,$2,$3,$4,$5,$6)', [t, ticket, name, JSON.stringify(rects), moves, hints]);
const age = (db, sec) => db.query(`update public.shikaku_game_starts set dealt_at = dealt_at - make_interval(secs => $1)`, [sec]);
const today = async (db) => (await one(db, "select to_char(now() at time zone 'utc','YYYYMMDD')::int n")).n;

// A small exact solver, so the tests solve whatever board the server deals.
function solve(g) {
  const n = g.length, seen = Array.from({ length: n }, () => Array(n).fill(false)), out = [];
  const go = () => {
    let r = 0, c = 0;
    for (; r < n; r++) { c = seen[r].indexOf(false); if (c !== -1) break; }
    if (r === n) return true;
    for (let r1 = r; r1 < n; r1++) for (let c1 = c; c1 < n; c1++) {
      let clues = [], free = true;
      for (let i = r; i <= r1 && free; i++) for (let j = c; j <= c1; j++) { if (seen[i][j]) { free = false; break; } if (g[i][j]) clues.push(g[i][j]); }
      if (!free) break;
      if (clues.length !== 1 || clues[0] !== (r1 - r + 1) * (c1 - c + 1)) continue;
      const mark = (v) => { for (let i = r; i <= r1; i++) for (let j = c; j <= c1; j++) seen[i][j] = v; };
      mark(true); out.push({ r0: r, c0: c, r1, c1 });
      if (go()) return true;
      out.pop(); mark(false);
    }
    return false;
  };
  go();
  return out;
}
async function play(db, t, name, kind, w, l, sec = 10, moves, hints) {
  const s = await start(db, t, kind, w, l);
  const rects = solve(await deal(db, t, s.ticket));
  await age(db, sec);
  return { ticket: s.ticket, rects, ...(await finish(db, t, s.ticket, name, rects, moves ?? rects.length, hints ?? 0)) };
}

test('the server generates the same Daily Challenge as the browser, every day for two years', async () => {
  const db = await freshDb();
  for (let i = 0; i < 730; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const day = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    const sql = (await one(db, 'select public.shikaku_daily_puzzle($1) p', [day])).p;
    assert.deepEqual(sql, dailyGrid(day).g, String(day));
  }
});
test('a quest board has the size of its level and can be solved, for all 108 levels', async () => {
  const db = await freshDb();
  for (const [w, world] of WORLDS.entries()) for (const [l, lvl] of world.levels.entries()) {
    const row = await one(db, `select b.puzzle from public.shikaku_quest q join public.shikaku_boards b on b.size=q.size and b.tier=q.tier
      where q.world=$1 and q.level=$2 order by random() limit 1`, [w, l]);
    assert.equal(row.puzzle.length, lvl.size);
    const ok = await one(db, 'select public.shikaku_is_solution($1,$2) ok', [JSON.stringify(row.puzzle), JSON.stringify(solve(row.puzzle))]);
    assert.equal(ok.ok, true, `${w}-${l}`);
  }
});
test('a solved board is timed and scored by the server, with the formula the player sees', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann');
  const r = await play(db, t, 'Ann', 'quest', 2, 3, 20, undefined, 1);
  const mult = WORLDS[2].levels[3].mult;
  assert.equal(r.time_sec, 20);
  assert.equal(r.score, Math.round(500 * mult) + Math.round(220 * mult) + Math.round(150 * mult) - 40);
  const s = await one(db, 'select score, time_sec, username from public.scores');
  assert.deepEqual({ ...s }, { score: r.score, time_sec: 20, username: 'Ann' });
});
test('the score formula matches JavaScript for every multiplier', async () => {
  const db = await freshDb();
  const mults = [1.5, ...WORLDS.flatMap((w) => w.levels.map((l) => l.mult))];
  for (const m of mults) for (const [time, moves, rects, hints] of [[1, 8, 8, 0], [37, 11, 8, 1], [74, 30, 9, 9], [5000, 99, 4, 60]]) {
    const js = Math.max(100, Math.round(500 * m) + Math.round(Math.max(0, 300 - time * 4) * m)
      + Math.round(Math.max(0, 150 - (moves - rects) * 15) * m) - hints * 40);
    assert.equal((await one(db, 'select public.shikaku_score($1,$2,$3,$4,$5) s', [m, time, moves, rects, hints])).s, js);
  }
});
test('a wrong board saves nothing and the player can still finish it', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann'); const s = await start(db, t);
  const rects = solve(await deal(db, t, s.ticket));
  assert.equal((await finish(db, t, s.ticket, 'Ann', rects.slice(1))).status, 'wrong');
  assert.equal((await one(db, 'select count(*)::int n from public.scores')).n, 0);
  assert.equal((await finish(db, t, s.ticket, 'Ann', rects)).status, 'ok');
});
test('a lost reply can be sent again: the same score comes back and nothing is saved twice', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann');
  const r = await play(db, t, 'Ann', 'quest', 0, 0, 30);
  await age(db, 500);
  const again = await finish(db, t, r.ticket, 'Ann', [], 0, 0);
  assert.deepEqual([again.status, again.score, again.time_sec], ['ok', r.score, r.time_sec]);
});
test('asking for the board again gives the same board and does not restart the clock', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann'); const s = await start(db, t);
  const first = await deal(db, t, s.ticket); await age(db, 50);
  assert.deepEqual(await deal(db, t, s.ticket), first);
  assert.ok((await finish(db, t, s.ticket, 'Ann', solve(first))).time_sec >= 50);
});
test("a ticket works only for its own player and only after a board was dealt", async () => {
  const db = await freshDb(); const a = await claim(db, 'Ann'); const b = await claim(db, 'Bob');
  const s = await start(db, a);
  await assert.rejects(finish(db, a, s.ticket, 'Ann', []), /invalid ticket/);
  await assert.rejects(deal(db, b, s.ticket), /invalid ticket/);
  await assert.rejects(deal(db, 'forged', s.ticket), /not signed in/);
  const rects = solve(await deal(db, a, s.ticket));
  await assert.rejects(finish(db, b, s.ticket, 'Bob', rects), /invalid ticket/);
  await assert.rejects(finish(db, a, s.ticket, 'Bob', rects), /invalid player/);
  await assert.rejects(finish(db, a, 'nope', 'Ann', rects), /invalid ticket/);
  const e = await start(db, a, 'endless', null, null);
  await assert.rejects(deal(db, a, e.ticket), /invalid ticket/);
});
test('the Daily Challenge can only be played around today', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann'); const day = await today(db);
  assert.equal((await play(db, t, 'Ann', 'daily', day, 0, 44)).time_sec, 44);
  const used = async () => (await one(db, 'select count(*)::int n from public.shikaku_game_starts')).n;
  const before = await used();
  await assert.rejects(start(db, t, 'daily', day + 10000, 0), /invalid game/);
  await assert.rejects(start(db, t, 'quest', 50, 0), /invalid game/);
  assert.equal(await used(), before, 'a board that cannot be dealt takes no game');
});
test('a board left open for more than a day is not saved', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann');
  assert.equal((await play(db, t, 'Ann', 'quest', 0, 0, 90000)).status, 'expired');
});
test('the best score and fastest time are kept, and the total is their sum', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann');
  await db.query('select public.shikaku_save_profile($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [(await one(db, "select public.shikaku_id_for_name('Ann') i")).i, 'Ann', 'x', 'neon', null, 9999999, 99, 0, 0, t]);
  assert.equal((await one(db, 'select total_score from public.profiles')).total_score, 0, 'a total sent by the browser is ignored');
  const a = await play(db, t, 'Ann', 'quest', 0, 0, 60);
  const b = await play(db, t, 'Ann', 'quest', 0, 0, 5);
  await play(db, t, 'Ann', 'quest', 0, 0, 70);
  const c = await play(db, t, 'Ann', 'quest', 3, 0, 5);
  assert.ok(b.score > a.score);
  assert.deepEqual({ ...(await one(db, 'select score, time_sec from public.scores where world=0')) }, { score: b.score, time_sec: 5 });
  assert.deepEqual({ ...(await one(db, 'select total_score, best_world from public.profiles')) }, { total_score: b.score + c.score, best_world: 3 });
});
test('moves and hints sent by the browser cannot raise a score above a perfect game', async () => {
  const db = await freshDb(); const t = await claim(db, 'Ann');
  const r = await play(db, t, 'Ann', 'quest', 0, 0, 10, -500, -50);
  assert.equal(r.score, 500 + 260 + 150);
});
test('boards stay private and the old saves are gone', async () => {
  const db = await freshDb();
  for (const role of ['anon', 'authenticated']) for (const table of ['shikaku_boards', 'shikaku_quest', 'shikaku_game_starts'])
    assert.equal((await one(db, 'select has_table_privilege($1,$2,\'select\') p', [role, 'public.' + table])).p, false);
  assert.equal((await one(db, "select count(*)::int n from pg_proc where proname = 'shikaku_save_score'")).n, 0);
  const open = (await db.query(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')
      and proname in ('shikaku_imul','shikaku_rand','shikaku_daily_puzzle','shikaku_ticket_game','shikaku_score','shikaku_refresh_total')`)).rows;
  assert.deepEqual(open, []);
});
