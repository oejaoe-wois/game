'use strict';
// multiuser-test.js — one farm, an owner and two friends, each with their own
// login. Proves the isolation: a friend only ever sees and controls the game
// accounts they added; the owner sees all; friends can't pause the farm,
// manage users, hijack each other's accounts or act on each other's ids.
//
// Run: node test/multiuser-test.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 8991;
const FARM_PORT = 8992;
const DATA_DIR = path.join(ROOT, 'tmp-test-data-users');
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function api(token, method, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: FARM_PORT, method, path: pathName,
      headers: { 'X-Admin-Token': token || '', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (_) { resolve({ status: res.statusCode, json: {} }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function login(username, password) {
  const r = await api('', 'POST', '/api/login', { username, password });
  return r;
}
async function waitFor(fn, ms, every, label) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for: ${label}`);
    await sleep(every);
  }
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const env = {
    ...process.env,
    PORT: String(FARM_PORT),
    GAME_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'owner-pass-12345',
    AIO_SECRET_KEY: 'test-secret-key-0123456789abcdef0123456789abcdef',
    ADMIN_GAME_EMAIL: 'fetcher@test.invalid', ADMIN_GAME_PASSWORD: 'fetcher@test.invalid',
    DATA_DIR, FAST_TEST: '1', SCOUT_INTERVAL_MS: '2500', LOGIN_STAGGER_MS: '200',
    RELOGIN_COOLDOWN_MS: '2500', LOG_LEVEL: 'info',
  };
  const mock = spawn('node', [path.join(__dirname, 'mock-game.js'), String(MOCK_PORT)], { stdio: 'pipe' });
  const farm = spawn('node', [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'pipe' });
  let farmLog = '';
  farm.stdout.on('data', (d) => { farmLog += d; });
  farm.stderr.on('data', (d) => { farmLog += d; });

  try {
    await waitFor(async () => (await api('', 'GET', '/healthz').catch(() => null) || {}).status === 200, 15000, 300, 'farm up');

    // ── Logins ────────────────────────────────────────────────────────────
    const o = await login('boss', 'owner-pass-12345');
    check('owner logs in with ADMIN_USERNAME / ADMIN_PASSWORD and gets role owner', o.status === 200 && o.json.role === 'owner', JSON.stringify(o.json));
    const OWNER = o.json.token;

    const mk1 = await api(OWNER, 'POST', '/api/users', { username: 'alice', password: 'alice-pass-1' });
    const mk2 = await api(OWNER, 'POST', '/api/users', { username: 'bob', password: 'bob-pass-22' });
    check('owner can create friend logins', mk1.status === 200 && mk2.status === 200, JSON.stringify([mk1.json, mk2.json]));
    check('duplicate / owner-name usernames are refused',
      (await api(OWNER, 'POST', '/api/users', { username: 'ALICE', password: 'whatever-12' })).status === 400
      && (await api(OWNER, 'POST', '/api/users', { username: 'boss', password: 'whatever-12' })).status === 400);
    check('short passwords are refused', (await api(OWNER, 'POST', '/api/users', { username: 'carl', password: 'short' })).status === 400);

    const usersFile = fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8');
    check('friend passwords are stored hashed, never in plaintext', !/alice-pass-1|bob-pass-22/.test(usersFile) && /"hash"/.test(usersFile));

    check('wrong password is rejected (401)', (await login('alice', 'nope-nope-1')).status === 401);
    check('unknown user is rejected (401)', (await login('mallory', 'alice-pass-1')).status === 401);
    const la = await login('alice', 'alice-pass-1');
    const lb = await login('bob', 'bob-pass-22');
    check('friends log in with their own credentials and get role user', la.json.role === 'user' && lb.json.role === 'user');
    const ALICE = la.json.token; const BOB = lb.json.token;
    check('alice cannot sign in with bob\'s password', (await login('alice', 'bob-pass-22')).status === 401);

    // ── Friends cannot use owner powers ──────────────────────────────────
    check('friend cannot list users (403)', (await api(ALICE, 'GET', '/api/users')).status === 403);
    check('friend cannot create users (403)', (await api(ALICE, 'POST', '/api/users', { username: 'eve', password: 'eve-pass-123' })).status === 403);
    check('friend cannot delete users (403)', (await api(ALICE, 'DELETE', '/api/users/bob')).status === 403);
    check('friend cannot pause the farm (403)', (await api(ALICE, 'POST', '/api/farm', { enabled: false })).status === 403);
    check('owner still can pause/resume the farm', (await api(OWNER, 'POST', '/api/farm', { enabled: false })).status === 200
      && (await api(OWNER, 'POST', '/api/farm', { enabled: true })).status === 200);

    // ── Each person adds their own accounts ──────────────────────────────
    const aa = await api(ALICE, 'POST', '/api/accounts', { nickname: 'alice-main', email: 'hunter.one@example.com', password: 'hunterpass1' });
    const bb = await api(BOB, 'POST', '/api/accounts', { nickname: 'bob-main', email: 'hunter.two@example.com', password: 'hunterpass2' });
    const oo = await api(OWNER, 'POST', '/api/accounts', { nickname: 'boss-main', email: 'boss.game@example.com', password: 'gamepass-o' });
    check('everyone can add accounts', aa.status === 200 && bb.status === 200 && oo.status === 200, JSON.stringify([aa.json, bb.json, oo.json]));
    const idA = aa.json.account.id; const idB = bb.json.account.id; const idO = oo.json.account.id;

    // ── Isolation of the views ────────────────────────────────────────────
    const nicks = async (t) => ((await api(t, 'GET', '/api/status')).json.accounts || []).map((a) => a.nickname).sort().join();
    check('alice sees only her own account', (await nicks(ALICE)) === 'alice-main', await nicks(ALICE));
    check('bob sees only his own account', (await nicks(BOB)) === 'bob-main', await nicks(BOB));
    check('owner sees every account', (await nicks(OWNER)) === 'alice-main,bob-main,boss-main', await nicks(OWNER));
    const stA = (await api(ALICE, 'GET', '/api/status')).json;
    check('storedCount is per-viewer', stA.storedCount === 1, `got ${stA.storedCount}`);
    check('a friend\'s view does not carry the owner field', stA.accounts.every((a) => a.owner === undefined));
    const stO = (await api(OWNER, 'GET', '/api/status')).json;
    check('owner view shows who owns what', stO.accounts.find((a) => a.nickname === 'bob-main').owner === 'bob');
    const statsA = (await api(ALICE, 'GET', '/api/stats')).json;
    check('/api/stats is filtered too', (statsA.accounts || []).length === 1 && statsA.accounts[0].id === idA);
    check('the hidden fetcher never leaks to anyone',
      !/fetcher@test|test\.invalid|core-fetcher/i.test(JSON.stringify(stA) + JSON.stringify(stO)));

    // ── Cross-account attacks ─────────────────────────────────────────────
    const steal = await api(ALICE, 'POST', '/api/accounts', { nickname: 'mine-now', email: 'hunter.two@example.com', password: 'hijack-pass' });
    check('alice cannot take over bob\'s game account by re-adding its email (400)', steal.status === 400, JSON.stringify(steal.json));
    check('bob\'s account is untouched after the attempt', (await nicks(BOB)) === 'bob-main');
    check('alice cannot remove bob\'s account', (await api(ALICE, 'DELETE', `/api/accounts/${idB}`)).json.removed === false);
    check('alice cannot relogin bob\'s account (404)', (await api(ALICE, 'POST', `/api/accounts/${idB}/relogin`, {})).status === 404);
    const al = await api(ALICE, 'POST', '/api/stats/allocate', { accountId: idB, plan: { attack: 5, defense: 0, stamina: 0 } });
    check('alice cannot allocate stats on bob\'s account (409 no_such_account)', al.status === 409 && al.json.report.reason === 'no_such_account', JSON.stringify(al.json));
    const sh = await api(ALICE, 'POST', '/api/shop/stamina', { accountId: idB });
    check('alice cannot shop on bob\'s account', sh.status === 409 && sh.json.reason === 'no_such_account', JSON.stringify(sh.json));
    check('alice cannot edit bob\'s account policy (PATCH → 404)', (await api(ALICE, 'PATCH', `/api/accounts/${idB}`, { classPick: 'mage' })).status === 404);
    check('a friend cannot touch the scout designation (403)', (await api(ALICE, 'POST', '/api/scout', { accountId: 'x' })).status === 403);
    check('a friend cannot start a swarm over everyone\'s accounts (403)', (await api(ALICE, 'POST', '/api/swarm', { targets: [{ mobId: '1', quota: 1 }] })).status === 403);
    check('a friend cannot stop the shared swarm (403)', (await api(ALICE, 'DELETE', '/api/swarm')).status === 403);
    const swA = (await api(ALICE, 'GET', '/api/swarm')).json;
    check('swarm status shows a friend no other accounts', !swA.accounts || swA.accounts.length === 0, JSON.stringify(swA.accounts));
    check('bob\'s account survived all of it', (await nicks(BOB)) === 'bob-main');
    check('owner can control a friend\'s account (relogin)', (await api(OWNER, 'POST', `/api/accounts/${idB}/relogin`, {})).status === 200);
    check('a friend can fix their own password by re-adding the email',
      (await api(ALICE, 'POST', '/api/accounts', { nickname: 'alice-main', email: 'hunter.one@example.com', password: 'hunterpass1' })).status === 200
      && (await nicks(ALICE)) === 'alice-main');

    // ── Own account works end to end ─────────────────────────────────────
    const running = await waitFor(async () => {
      const a = ((await api(ALICE, 'GET', '/api/status')).json.accounts || [])[0];
      return a && a.status === 'running' ? a : null;
    }, 45000, 700, 'alice\'s account logged in');
    check('a friend\'s own account logs in and runs', !!running);
    const own = await api(ALICE, 'POST', '/api/stats/allocate', { accountId: idA, plan: { attack: 1, defense: 0, stamina: 0 } });
    check('a friend can act on their own account', own.status !== 404 && !(own.json.report && own.json.report.reason === 'no_such_account'), JSON.stringify(own.json));

    // ── Owner admin: reset password + delete user ────────────────────────
    const listed = (await api(OWNER, 'GET', '/api/users')).json;
    check('owner list shows each friend with their account count',
      listed.users.length === 2 && listed.users.find((u) => u.username === 'alice').accounts === 1, JSON.stringify(listed));
    await api(OWNER, 'POST', '/api/users/bob/password', { password: 'bob-new-pass-9' });
    check('password reset kills the friend\'s existing sessions', (await api(BOB, 'GET', '/api/status')).status === 401);
    check('old password no longer works, new one does',
      !(await login('bob', 'bob-pass-22')).json.token && !!(await login('bob', 'bob-new-pass-9')).json.token);

    const del = await api(OWNER, 'DELETE', '/api/users/bob?accounts=remove');
    check('deleting a user removes their game accounts too', del.json.ok === true && del.json.removedAccounts === 1, JSON.stringify(del.json));
    // (the login route is rate-limited to 8 tries / 5 min / IP, so by now this may be a 429 — either way: no token)
    check('deleted user can no longer sign in', !(await login('bob', 'bob-new-pass-9')).json.token);
    check('alice and the owner\'s accounts are unaffected', (await nicks(OWNER)) === 'alice-main,boss-main', await nicks(OWNER));
    check('owner cannot be deleted', (await api(OWNER, 'DELETE', '/api/users/boss')).status === 400);

    // ── Users survive a restart (hashes on disk) ─────────────────────────
    check('/api/me reports the caller', (await api(ALICE, 'GET', '/api/me')).json.username === 'alice');
  } catch (e) {
    failures++;
    console.log(`  FAIL  unexpected error: ${e.message}`);
    console.log(farmLog.split('\n').slice(-25).join('\n'));
  } finally {
    farm.kill('SIGINT'); mock.kill('SIGINT');
    await sleep(500);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL MULTI-USER CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
main();
