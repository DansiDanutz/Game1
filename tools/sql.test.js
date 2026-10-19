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
  await db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  for (const sql of MIGRATIONS) await db.exec(sql);
  return db;
}
const saveScore = (db, id, name, world, level, score, time, stars = 1) =>
  db.query('select public.shikaku_save_score($1,$2,$3,$4,$5,$6,$7,$8)', [id, name, world, level, score, stars, time, 1]);
const saveProfile = (db, id, name, total, wins = 0, losses = 0) =>
  db.query('select public.shikaku_save_profile($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, name, 'x', 'neon', null, total, 0, wins, losses]);
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

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
  await assert.rejects(saveScore(db, A, 'T', 0, 0, 1, 1), /invalid player/);
  await assert.rejects(saveScore(db, A, 'Tester', 0, 0, -5, 1), /invalid score/);
  await assert.rejects(saveProfile(db, A, 'x', 1), /invalid profile/);
  await assert.rejects(saveProfile(db, A, 'Tester', 99999999), /invalid stats/);
});

test('profile save is non-destructive: a fresh id + someone else\'s name deletes nothing', async () => {
  const db = await freshDb();
  await saveProfile(db, A, 'Victim', 500, 3, 1);
  await saveScore(db, A, 'Victim', 0, 0, 500, 30);
  await saveProfile(db, B, 'Victim', 10000000);       // the attack from the review
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
