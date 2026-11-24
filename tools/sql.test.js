/* Regression tests for the Shikaku write functions (run: node --test tools/sql.test.js).
   Executes the REAL schema.sql + supabase/migrations/*.sql in an in-process
   Postgres (PGlite), then exercises the functions exactly as the client does.
   Requires: npm i --no-save @electric-sql/pglite@0.3.16 (CI installs it). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'));

// The real idForName() from js/app.js (plus its helpers), so the server's
// port of it is checked against the shipped client code.
const APP = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const grab = (name) => APP.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}\\n'))[0];
const idCtx = vm.createContext({});
vm.runInContext(['cyrb128', 'normName', 'idForName'].map(grab).join('\n'), idCtx);
const ID = (name) => idCtx.idForName(name);
const A = ID('Tester');

const AUTH_STUB = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text unique not null);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`;

async function freshDb() {
  const db = new PGlite();
  // Supabase provides these roles; the migrations grant/revoke on them.
  await db.exec('create role anon; create role authenticated;');
  // Like Supabase: new tables and functions are granted to the public roles by
  // default, so a migration must revoke explicitly (not just "from public").
  await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated;
                 alter default privileges in schema public grant execute on functions to anon, authenticated;`);
  // Supabase Auth stub: auth.users and auth.uid() (the JWT subject). Only the
  // test database has this; the migrations never create or replace auth.uid().
  await db.exec(AUTH_STUB);
  await db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  for (const sql of MIGRATIONS) await db.exec(sql);
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
// Session tokens per name: saves sign in (claiming the name with PIN 1234) on first use.
const tokens = new WeakMap();
async function tokenFor(db, name) {
  const m = tokens.get(db) || new Map(); tokens.set(db, m);
  const k = name.trim().toLowerCase();
  if (!m.has(k)) m.set(k, (await one(db, 'select public.shikaku_claim($1,$2) t', [name, '1234'])).t);
  return m.get(k);
}
const saveScore = async (db, id, name, world, level, score, time, stars = 1, token) =>
  db.query('select public.shikaku_save_score($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, name, world, level, score, stars, time, 1, token === undefined ? await tokenFor(db, name) : token]);
const saveProfile = async (db, id, name, total, wins = 0, losses = 0, token) =>
  db.query('select public.shikaku_save_profile($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, name, 'x', 'neon', null, total, 0, wins, losses, token === undefined ? await tokenFor(db, name) : token]);
const login = (db, name, pin) => one(db, 'select * from public.shikaku_login($1,$2)', [name, pin]);

test('time_sec = 0 is "unknown": it never beats a real time, and a real time replaces it', async () => {
  const db = await freshDb();
  await saveScore(db, A, 'Tester', 0, 1, 600, 0);     // legacy fake zero
  await saveScore(db, A, 'Tester', 0, 1, 600, 25);    // real time replaces it
  await saveScore(db, A, 'Tester', 0, 1, 600, 0);     // unknown must not clobber 25
  await saveScore(db, A, 'Tester', 0, 1, 600, 40);    // slower real time ignored
  assert.equal((await one(db, 'select time_sec from public.scores where player_id=$1', [A])).time_sec, 25);
  await saveScore(db, A, 'Tester', 0, 1, 600, 12);    // faster real time wins
  assert.equal((await one(db, 'select time_sec from public.scores where player_id=$1', [A])).time_sec, 12);
});

test('scores keep the best score and stars; Daily Race slot is accepted', async () => {
  const db = await freshDb();
  await saveScore(db, A, 'Tester', 2, 3, 900, 50, 3);
  await saveScore(db, A, 'Tester', 2, 3, 400, 30, 1);
  const r = await one(db, 'select score, stars, time_sec from public.scores where player_id=$1 and world=2', [A]);
  assert.deepEqual({ ...r }, { score: 900, stars: 3, time_sec: 30 });
  await saveScore(db, A, 'Tester', 20261019, 0, 1500, 61);
  assert.equal((await one(db, 'select count(*)::int n from public.scores where world=20261019')).n, 1);
});

test('invalid input is rejected by the server', async () => {
  const db = await freshDb();
  await assert.rejects(saveScore(db, A, 'Tester', 5000, 3, 1, 1), /invalid slot/);
  await assert.rejects(saveScore(db, A, 'Tester', 20261019, 2, 1, 1), /invalid slot/);
  await assert.rejects(saveScore(db, A, 'T', 0, 0, 1, 1, 1, null), /invalid player/);
  await assert.rejects(saveScore(db, A, 'Tester', 0, 0, -5, 1), /invalid score/);
  await assert.rejects(saveProfile(db, A, 'x', 1, 0, 0, null), /invalid profile/);
  await assert.rejects(saveProfile(db, A, 'Tester', 99999999), /invalid stats/);
});

test('profile save is non-destructive: a fresh id + someone else\'s name deletes nothing', async () => {
  const db = await freshDb();
  const V = ID('Victim');
  await saveProfile(db, V, 'Victim', 500, 3, 1);
  await saveScore(db, V, 'Victim', 0, 0, 500, 30);
  // the attack from the earlier review: a fresh id + the victim's name (even signed in)
  await assert.rejects(saveProfile(db, '00000000-0000-4000-8000-00000000000b', 'Victim', 10000000), /id does not belong/);
  assert.equal((await one(db, 'select count(*)::int n from public.profiles where id=$1', [V])).n, 1);
  assert.equal((await one(db, 'select count(*)::int n from public.scores where player_id=$1', [V])).n, 1);
});

test('profile counters only go up', async () => {
  const db = await freshDb();
  await saveProfile(db, A, 'Tester', 800, 5, 2);
  await saveProfile(db, A, 'Tester', 0, 0, 0);
  const r = await one(db, 'select total_score, wins, losses from public.profiles where id=$1', [A]);
  assert.deepEqual({ ...r }, { total_score: 800, wins: 5, losses: 2 });
});

test('analytics: valid events stored, malformed ones dropped, table not readable by anon', async () => {
  const db = await freshDb();
  await db.query('select public.shikaku_track($1,$2,$3,$4)', [A, 'Tester', 'level_win', { w: 0 }]);
  await db.query('select public.shikaku_track($1,$2,$3,$4)', [A, 'Tester', 'Bad Name!', {}]);
  await db.query('select public.shikaku_track($1,$2,$3,$4)', [A, 'Tester', 'big', { s: 'x'.repeat(5000) }]);
  assert.equal((await one(db, 'select count(*)::int n from public.shikaku_events')).n, 1);
  assert.equal((await one(db, "select has_table_privilege('anon','public.shikaku_events','select') p")).p, false);
});

test('PIN: claim once, sign in with the right PIN, wrong PINs are counted and lock the name', async () => {
  const db = await freshDb();
  assert.equal((await one(db, 'select public.shikaku_account_status($1) s', ['Ann'])).s, 'new');
  assert.match((await one(db, 'select public.shikaku_claim($1,$2) t', ['Ann', '4821'])).t, /^[0-9a-f]{64}$/);
  assert.equal((await one(db, 'select public.shikaku_account_status($1) s', ['  ANN '])).s, 'claimed');
  await assert.rejects(db.query('select public.shikaku_claim($1,$2)', ['ann', '0000']), /name taken/);
  await assert.rejects(db.query('select public.shikaku_claim($1,$2)', ['Bob', '12a4']), /invalid pin/);
  assert.equal((await login(db, 'Nobody', '1234')).status, 'unknown');
  const ok = await login(db, 'ann', '4821');
  assert.equal(ok.status, 'ok'); assert.ok(ok.token);
  for (let i = 0; i < 4; i++) assert.equal((await login(db, 'Ann', '0000')).status, 'wrong');
  assert.equal((await one(db, "select failed from public.shikaku_accounts where name_key='ann'")).failed, 4,
    'wrong attempts must be committed, not rolled back');
  assert.equal((await login(db, 'Ann', '0000')).status, 'locked');
  assert.equal((await login(db, 'Ann', '4821')).status, 'locked', 'even the right PIN waits out the lock');
  assert.equal((await one(db, 'select public.shikaku_account_status($1) s', ['Ann'])).s, 'locked');
  await db.exec("update public.shikaku_accounts set locked_until = now() - interval '1 second'");
  assert.equal((await login(db, 'Ann', '4821')).status, 'ok');
});

test('PIN: saves need a token for that same name', async () => {
  const db = await freshDb();
  const ann = await tokenFor(db, 'Ann');
  const A = ID('Ann');
  await tokenFor(db, 'Eve');
  await assert.rejects(saveScore(db, A, 'Ann', 0, 0, 100, 5, 1, null), /not signed in/);
  await assert.rejects(saveScore(db, A, 'Ann', 0, 0, 100, 5, 1, 'forged'), /not signed in/);
  await assert.rejects(saveProfile(db, A, 'Ann', 100, 0, 0, await tokenFor(db, 'Eve')), /not signed in/);
  await assert.rejects(saveProfile(db, A, 'Unclaimed', 100, 0, 0, ann), /not signed in/);
  await saveProfile(db, A, ' ann ', 100, 0, 0, ann);   // same name, different spelling
  assert.equal((await one(db, 'select total_score from public.profiles where id=$1', [A])).total_score, 100);
  // old token-less signatures are gone
  await assert.rejects(db.query('select public.shikaku_save_score($1,$2,0,0,1,1,1,1)', [A, 'Ann']), /does not exist/);
});

test('ids are bound to names: a signed-in player cannot write under another name\'s id', async () => {
  const db = await freshDb();
  const A = ID('Ann');
  await saveProfile(db, A, 'Ann', 500, 3, 1);
  await saveScore(db, A, 'Ann', 0, 0, 500, 30);
  // Eve is signed in as Eve, but targets Ann's (predictable) id
  await assert.rejects(saveProfile(db, A, 'Eve', 9000, 99, 0), /id does not belong/);
  await assert.rejects(saveScore(db, A, 'Eve', 0, 0, 999999, 1, 3), /id does not belong/);
  await assert.rejects(saveScore(db, A, 'Eve', 0, 5, 999999, 1, 3), /id does not belong/, 'a slot Ann never saved');
  // ... or the id of a name that has no profile yet
  await assert.rejects(saveProfile(db, ID('Zed'), 'Eve', 1), /id does not belong/);
  assert.equal((await one(db, 'select count(*)::int n from public.profiles where id=$1', [ID('Zed')])).n, 0);
  assert.deepEqual({ ...(await one(db, 'select username, total_score, wins from public.profiles where id=$1', [A])) },
    { username: 'Ann', total_score: 500, wins: 3 });
  assert.deepEqual({ ...(await one(db, 'select username, score, time_sec from public.scores where player_id=$1', [A])) },
    { username: 'Ann', score: 500, time_sec: 30 });
  assert.equal((await one(db, 'select count(*)::int n from public.scores where player_id=$1', [A])).n, 1);
});

test('the server derives the same id as the client for any name', async () => {
  const db = await freshDb();
  const names = ['David', 'Danutz1981', 'Crissangelica', 'Sisi', '  Mixed   Case  ', 'Ana Maria', 'ștefan', 'Ärger',
    'Zoë', 'naïve café', '日本語ネーム', '😀 Gamer', 'a🎮b🚀c', 'x', 'O\'Brien', 'tab\there', '12345678901234567',
    // JS trim()/\s whitespace that Postgres' btrim()/\s don't treat the same way
    'Neon\uFEFFNinja', '\uFEFFlead', '\u00a0Pad\u3000', 'a\u2028b', 'em\u2003space', 'v\u000btab',
    'zero\u200bwidth' /* U+200B is not whitespace in JS: must be kept */];
  for (const n of names)
    assert.equal((await one(db, 'select public.shikaku_id_for_name($1)::text id', [n])).id, ID(n), JSON.stringify(n));
  // and such a name can actually save with the id the browser computes
  const n = 'Neon\uFEFFNinja';
  await saveProfile(db, ID(n), n, 42);
  await saveScore(db, ID(n), n, 0, 0, 42, 9);
  assert.equal((await one(db, 'select total_score from public.profiles where id=$1', [ID(n)])).total_score, 42);
});

test('PIN: accounts and sessions are private', async () => {
  const db = await freshDb();
  for (const t of ['shikaku_accounts', 'shikaku_sessions'])
    assert.equal((await one(db, `select has_table_privilege('anon','public.${t}','select') p`)).p, false);
  for (const f of ['shikaku_session_name(text)', 'shikaku_new_session(text)'])
    assert.equal((await one(db, `select has_function_privilege('anon','public.${f}','execute') p`)).p, false);
});

test('rank groups same-name rows (best value per name) like the leaderboard', async () => {
  const db = await freshDb();
  await saveProfile(db, ID('Alpha'), 'Alpha', 900, 1);
  await saveProfile(db, ID('Tester'), 'Tester', 500, 9);
  await saveProfile(db, ID('Bravo'), 'Bravo', 800, 4);
  await saveProfile(db, ID('Charlie'), 'Charlie', 100, 3);
  // older same-name rows under legacy random ids (from before names were the id)
  await db.exec(`insert into public.profiles (id, username, total_score, wins) values
    ('00000000-0000-4000-8000-000000000003', 'tester ', 300, 2),
    ('00000000-0000-4000-8000-000000000005', 'BRAVO', 100, 0)`);
  const q = await one(db, 'select * from public.shikaku_rank($1,$2)', ['quest', 'TESTER']);
  assert.deepEqual({ ...q }, { rank: 3, total: 4, value: 500 });
  const b = await one(db, 'select * from public.shikaku_rank($1,$2)', ['battle', 'Tester']);
  assert.deepEqual({ ...b }, { rank: 1, total: 4, value: 9 });
  assert.equal((await db.query('select * from public.shikaku_rank($1,$2)', ['quest', 'Nobody'])).rows.length, 0);
});

test('rank covers the whole board, not a truncated page (2,500 players)', async () => {
  const db = await freshDb();
  await db.exec(`insert into public.profiles (id, username, total_score)
                 select gen_random_uuid(), 'p' || g, g from generate_series(1, 2500) g`);
  const r = await one(db, 'select * from public.shikaku_rank($1,$2)', ['quest', 'p1']);
  assert.deepEqual({ ...r }, { rank: 2500, total: 2500, value: 1 });
});

// ---------------------------------------------------------------------------
// Free daily game limit (migration 20261125091000) and email sign-in
// (migration 20261125090000). Puzzles are generated in the browser, so the
// limit counts STARTED boards that can be saved (scores, Daily Race, battles).
// ---------------------------------------------------------------------------
const uuid = () => require('crypto').randomUUID();
const USER_ANN = '11111111-1111-4111-8111-111111111111';
const USER_BOB = '22222222-2222-4222-8222-222222222222';
// Start a board. kind/world/level follow the migration: quest and daily need a
// slot, endless and battle take none.
const start = (db, token, kind = 'quest', world = 0, level = 0, req = uuid()) =>
  one(db, 'select * from public.shikaku_start_game($1,$2,$3,$4,$5)', [token, req, kind, world, level]);
const quota = (db, token) => one(db, 'select * from public.shikaku_game_quota($1)', [token]);
// Save a score with a game ticket (the new 10-argument signature).
const saveT = (db, id, name, world, level, score, time, ticket, token) =>
  db.query('select public.shikaku_save_score($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [id, name, world, level, score, 1, time, 1, token, ticket]);
const asUser = (db, uid) => db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid]);
const linkEmail = (db, token, name) => db.query('select public.shikaku_link_email($1,$2)', [token, name]);
const emailSignIn = (db) => one(db, 'select * from public.shikaku_email_sign_in()');
const utcTodayNum = async (db) => (await one(db, "select to_char(now() at time zone 'utc', 'YYYYMMDD')::int n")).n;

test('free limit: the first 10 started games of the UTC day count and the 11th is refused', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  for (let i = 0; i < 10; i++) {
    const r = await start(db, t, 'quest', 0, i);
    assert.equal(r.status, 'ok');
    assert.match(r.ticket, /^[0-9a-f]{64}$/);
    assert.equal(r.games_left, 9 - i);
  }
  const refused = await start(db, t, 'quest', 0, 10);
  assert.equal(refused.status, 'limit');
  assert.equal(refused.ticket, null);
  assert.equal(refused.games_left, 0);
  const atNextUtcMidnight = await one(db,
    "select $1::timestamptz = (date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc' ok",
    [refused.reset_at]);
  assert.equal(atNextUtcMidnight.ok, true, 'reset time is the next UTC midnight');
});

test('a started game uses its slot whether it is won, lost or left (no save needed)', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await start(db, t, 'quest', 0, 0);                    // never saved
  assert.equal((await quota(db, t)).games_left, 9);
  assert.equal((await one(db, 'select count(*)::int n from public.scores')).n, 0);
});

test('reading the quota takes no slot', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await start(db, t, 'quest', 0, 0);
  await start(db, t, 'endless', null, null);            // endless counts too
  await start(db, t, 'battle', null, null);             // and battles
  const first = await quota(db, t);
  const second = await quota(db, t);
  assert.equal(first.games_left, 7);
  assert.equal(second.games_left, 7);
  assert.ok(first.reset_at, 'the reset time is returned');
});

test('UTC day rollover: games started on earlier UTC days do not count today', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await db.exec(`insert into public.shikaku_game_starts (ticket_hash, name_key, request_hash, kind, world, level, started_on)
    select 'old-ticket-' || g, 'ann', 'old-request-' || g, 'quest', 0, g,
           (now() at time zone 'utc')::date - 1
      from generate_series(1, 10) g`);
  const r = await start(db, t, 'quest', 1, 0);
  assert.equal(r.status, 'ok');
  assert.equal(r.games_left, 9);
});

test('concurrent starts from two tabs cannot exceed the limit', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => start(db, t, 'quest', 2, i)));
  assert.equal(results.filter(r => r.status === 'ok').length, 10);
  assert.equal(results.filter(r => r.status === 'limit').length, 2);
  assert.equal((await quota(db, t)).games_left, 0);
});

test('a retried start (same request id, lost reply) uses one slot and returns the same ticket', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  const req = uuid();
  const first = await start(db, t, 'quest', 0, 0, req);
  const retry = await start(db, t, 'quest', 0, 0, req);
  assert.equal(retry.status, 'ok');
  assert.equal(retry.ticket, first.ticket);
  assert.equal(retry.games_left, 9);
  assert.equal((await quota(db, t)).games_left, 9, 'the retry did not take a second slot');
});

test('a request id cannot be reused with another session or for another board', async () => {
  const db = await freshDb();
  const t1 = await tokenFor(db, 'Ann');
  const t2 = (await login(db, 'Ann', '1234')).token;   // a second session for the same name
  const req = uuid();
  await start(db, t1, 'quest', 0, 0, req);
  await assert.rejects(start(db, t2, 'quest', 0, 0, req), /request id already used/);
  await assert.rejects(start(db, t1, 'quest', 0, 1, req), /request id already used/);
});

test("another account's ticket cannot save a score", async () => {
  const db = await freshDb();
  const ta = await tokenFor(db, 'Ann');
  const tb = await tokenFor(db, 'Bob');
  const annGame = await start(db, ta, 'quest', 0, 0);
  await assert.rejects(saveT(db, ID('Bob'), 'Bob', 0, 0, 500, 20, annGame.ticket, tb), /invalid ticket/);
  // ... and Bob's attempt did not use Ann's ticket up
  await saveT(db, ID('Ann'), 'Ann', 0, 0, 500, 20, annGame.ticket, ta);
  assert.equal((await one(db, 'select score from public.scores where player_id=$1', [ID('Ann')])).score, 500);
});

test('a ticket saves once: a reused ticket is refused', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  const game = await start(db, t, 'quest', 0, 0);
  await saveT(db, ID('Ann'), 'Ann', 0, 0, 500, 20, game.ticket, t);
  await assert.rejects(saveT(db, ID('Ann'), 'Ann', 0, 0, 999, 5, game.ticket, t), /ticket already used/);
  assert.equal((await one(db, 'select score from public.scores where player_id=$1', [ID('Ann')])).score, 500);
});

test('a ticket only saves the board it was started for', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  const game = await start(db, t, 'quest', 0, 1);
  await assert.rejects(saveT(db, ID('Ann'), 'Ann', 0, 2, 500, 20, game.ticket, t), /invalid ticket/, 'another level');
  const day = await utcTodayNum(db);
  await assert.rejects(saveT(db, ID('Ann'), 'Ann', day, 0, 500, 20, game.ticket, t), /invalid ticket/, 'daily slot');
  await saveT(db, ID('Ann'), 'Ann', 0, 1, 500, 20, game.ticket, t);   // the right one still works
});

test('a daily start counts toward the limit and its result needs that ticket', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  const day = await utcTodayNum(db);
  const game = await start(db, t, 'daily', day, 0);
  assert.equal(game.games_left, 9);
  await saveT(db, ID('Ann'), 'Ann', day, 0, 900, 40, game.ticket, t);
  assert.equal((await one(db, 'select time_sec from public.scores where world=$1', [day])).time_sec, 40);
});

test('a save without a ticket is refused by the new signature', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await assert.rejects(saveT(db, ID('Ann'), 'Ann', 0, 0, 500, 20, null, t), /invalid ticket/);
});

test('starting a game and saving with a ticket both require a session', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await assert.rejects(start(db, null, 'quest', 0, 0), /not signed in/);
  await assert.rejects(start(db, 'forged', 'quest', 0, 0), /not signed in/);
  await assert.rejects(quota(db, 'forged'), /not signed in/);
  const game = await start(db, t, 'quest', 0, 0);
  await assert.rejects(saveT(db, ID('Ann'), 'Ann', 0, 0, 500, 20, game.ticket, 'forged'), /not signed in/);
});

test('malformed requests are rejected: request ids, kinds and slots', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await assert.rejects(start(db, t, 'quest', 0, 0, 'not-a-uuid'), /invalid request/);
  await assert.rejects(start(db, t, 'tournament', 0, 0), /invalid game/);
  await assert.rejects(start(db, t, 'quest', null, 0), /invalid game/);
  await assert.rejects(start(db, t, 'endless', 0, 0), /invalid game/);
  await assert.rejects(start(db, t, 'daily', 5, 0), /invalid game/);
});

test('email sign-in: a name links to one email, and that email signs in to the same account', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [USER_ANN, 'ann@example.com']);
  await asUser(db, USER_ANN);
  await linkEmail(db, t, 'Ann');
  const s = await emailSignIn(db);                      // e.g. a new device
  assert.equal(s.username, 'Ann');
  assert.match(s.token, /^[0-9a-f]{64}$/);
  assert.notEqual(s.token, t);
  await saveProfile(db, ID('Ann'), 'Ann', 300, 0, 0, s.token);  // the new token saves to Ann
  assert.equal((await one(db, 'select total_score from public.profiles where id=$1', [ID('Ann')])).total_score, 300);
});

test('email sign-in shares the daily limit with the PIN session of the same name', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [USER_ANN, 'ann@example.com']);
  for (let i = 0; i < 10; i++) await start(db, t, 'quest', 0, i);
  await asUser(db, USER_ANN);
  await linkEmail(db, t, 'Ann');
  const s = await emailSignIn(db);
  assert.equal((await start(db, s.token, 'quest', 1, 0)).status, 'limit');
});

test('email already linked: one email per name and one name per email', async () => {
  const db = await freshDb();
  const ta = await tokenFor(db, 'Ann');
  const tb = await tokenFor(db, 'Bob');
  await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)',
    [USER_ANN, 'ann@example.com', USER_BOB, 'bob@example.com']);
  await asUser(db, USER_ANN);
  await linkEmail(db, ta, 'Ann');
  await assert.rejects(linkEmail(db, tb, 'Bob'), /email already linked/, 'this email already belongs to Ann');
  await asUser(db, USER_BOB);
  await assert.rejects(linkEmail(db, ta, 'Ann'), /name already has an email/, 'Ann already has an email');
  await assert.rejects(emailSignIn(db), /email is not linked/, 'an unlinked email cannot sign in');
});

test('email linking and sign-in need an email session and the name\'s PIN session', async () => {
  const db = await freshDb();
  const ta = await tokenFor(db, 'Ann');
  const tb = await tokenFor(db, 'Bob');
  await db.query('insert into auth.users (id, email) values ($1, $2)', [USER_ANN, 'ann@example.com']);
  await asUser(db, '');                                  // no JWT: auth.uid() is null
  await assert.rejects(linkEmail(db, ta, 'Ann'), /not signed in with email/);
  await assert.rejects(emailSignIn(db), /not signed in with email/);
  await asUser(db, USER_ANN);
  await assert.rejects(linkEmail(db, tb, 'Ann'), /not signed in/, 'Bob\'s session cannot link Ann');
  await assert.rejects(linkEmail(db, 'forged', 'Ann'), /not signed in/);
});

test('email and game-limit tables are private, RLS is on, and no email is stored here', async () => {
  const db = await freshDb();
  for (const table of ['shikaku_email_links', 'shikaku_game_starts']) {
    const r = await one(db, 'select relrowsecurity rls from pg_class where relname = $1', [table]);
    assert.equal(r.rls, true, table + ' has RLS on');
    for (const role of ['anon', 'authenticated'])
      assert.equal((await one(db, `select has_table_privilege('${role}','public.${table}','select') p`)).p, false, role + ' ' + table);
  }
  const cols = await db.query("select column_name from information_schema.columns where table_name = 'shikaku_email_links'");
  assert.ok(!cols.rows.some(c => /mail/.test(c.column_name)), 'no email column outside auth.users');
});

test('email functions: only authenticated may call them; the PIN game functions stay callable by anon', async () => {
  const db = await freshDb();
  const priv = (role, sig) => one(db, `select has_function_privilege('${role}','public.${sig}','execute') p`).then(r => r.p);
  assert.equal(await priv('anon', 'shikaku_link_email(text,text)'), false);
  assert.equal(await priv('anon', 'shikaku_email_sign_in()'), false);
  assert.equal(await priv('authenticated', 'shikaku_link_email(text,text)'), true);
  assert.equal(await priv('authenticated', 'shikaku_email_sign_in()'), true);
  assert.equal(await priv('anon', 'shikaku_start_game(text,text,text,integer,integer)'), true);
  assert.equal(await priv('anon', 'shikaku_game_quota(text)'), true);
  assert.equal(await priv('anon', 'shikaku_save_score(uuid,text,integer,integer,integer,integer,integer,integer,text,text)'), true);
});

test('every function added for this feature pins search_path to an empty string', async () => {
  const db = await freshDb();
  const unpinned = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('shikaku_start_game','shikaku_game_quota','shikaku_link_email','shikaku_email_sign_in','shikaku_save_score')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')`);
  assert.deepEqual(unpinned.rows, []);
  const found = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'shikaku_%'
       and p.proname in ('shikaku_start_game','shikaku_game_quota','shikaku_link_email','shikaku_email_sign_in')`);
  assert.equal(new Set(found.rows.map(r => r.proname)).size, 4, 'all four new functions exist');
});

test('migrations are idempotent: applying them all again to a live database is harmless', async () => {
  const db = await freshDb();
  const t = await tokenFor(db, 'Ann');
  await start(db, t, 'quest', 0, 0);
  for (const sql of MIGRATIONS) await db.exec(sql);          // a second, full application
  assert.equal((await quota(db, t)).games_left, 9, 'existing counts survive');
  assert.equal((await one(db, 'select count(*)::int n from public.shikaku_game_starts')).n, 1);
});
