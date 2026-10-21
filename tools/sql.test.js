/* Regression tests for the Shikaku write functions (run: node --test tools/sql.test.js).
   Executes the REAL schema.sql + supabase/migrations/*.sql in an in-process
   Postgres (PGlite), then exercises the functions exactly as the client does.
   Requires: npm i --no-save @electric-sql/pglite@0.3.16 (CI installs it). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const ROOT = path.join(__dirname, '..');
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'));

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

async function freshDb() {
  const db = new PGlite();
  // Supabase provides these roles; the migrations grant/revoke on them.
  await db.exec('create role anon; create role authenticated;');
  // Like Supabase: new tables and functions are granted to the public roles by
  // default, so a migration must revoke explicitly (not just "from public").
  await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated;
                 alter default privileges in schema public grant execute on functions to anon, authenticated;`);
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
  await saveProfile(db, A, 'Victim', 500, 3, 1);
  await saveScore(db, A, 'Victim', 0, 0, 500, 30);
  await saveProfile(db, B, 'Victim', 10000000);       // the attack from the review (even signed in)
  assert.equal((await one(db, 'select count(*)::int n from public.profiles where id=$1', [A])).n, 1);
  assert.equal((await one(db, 'select count(*)::int n from public.scores where player_id=$1', [A])).n, 1);
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

test('PIN: a signed-in player cannot overwrite another name\'s row by reusing its id', async () => {
  const db = await freshDb();
  await saveProfile(db, A, 'Ann', 500, 3, 1);
  await saveScore(db, A, 'Ann', 0, 0, 500, 30);
  await saveProfile(db, A, 'Eve', 9000, 99, 0);        // Eve signed in, but targets Ann's id
  await saveScore(db, A, 'Eve', 0, 0, 999999, 1, 3);
  assert.deepEqual({ ...(await one(db, 'select username, total_score, wins from public.profiles where id=$1', [A])) },
    { username: 'Ann', total_score: 500, wins: 3 });
  assert.deepEqual({ ...(await one(db, 'select username, score, time_sec from public.scores where player_id=$1', [A])) },
    { username: 'Ann', score: 500, time_sec: 30 });
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
  const ids = ['01', '02', '03', '04', '05', '06'].map(n => `00000000-0000-4000-8000-0000000000${n}`);
  await saveProfile(db, ids[0], 'Alpha', 900, 1);
  await saveProfile(db, ids[1], 'Tester', 500, 9);
  await saveProfile(db, ids[2], 'tester ', 300, 2);  // retained older same-name row
  await saveProfile(db, ids[3], 'Bravo', 800, 4);
  await saveProfile(db, ids[4], 'BRAVO', 100, 0);    // duplicate of Bravo
  await saveProfile(db, ids[5], 'Charlie', 100, 3);
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
