'use strict';
// run-test.js — end-to-end test of the aio-farm engine against the mock game.
//
// Covers: API auth (token gate), account add (encrypted at rest, masked out),
// worker login + scout bus publishing + boss combat (FINISHED + DEAD paths),
// precision wave farming across the gate/wave registry (per-mob loot-gate
// caps, "You:" resume, cooldown retry, stamina gate + potion refill), revoke.
// Point it at the real game only when this passes.
//
// Run: node test/run-test.js

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 8971;
const FARM_PORT = 8972;
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'panel-pass-12345';
let sessionToken = null; // issued by POST /api/login
const SECRET = 'test-secret-key-0123456789abcdef0123456789abcdef';
const DATA_DIR = path.join(ROOT, 'tmp-test-data');

const env = {
  ...process.env,
  PORT: String(FARM_PORT),
  GAME_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  // Panel login = username + password (no secret key). ADMIN_TOKEN stays
  // unset in this run to prove username+password is the only way in.
  ADMIN_USERNAME: ADMIN_USER,
  ADMIN_PASSWORD: ADMIN_PASS,
  AIO_SECRET_KEY: SECRET,
  ADMIN_GAME_EMAIL: 'fetcher@test.invalid',
  ADMIN_GAME_PASSWORD: 'fetcher@test.invalid',
  DATA_DIR: DATA_DIR,
  FAST_TEST: '1',
  SCOUT_INTERVAL_MS: '2500',
  LOGIN_STAGGER_MS: '200',
  RELOGIN_COOLDOWN_MS: '2500',
  // Small caps so the FINISHED (cap reached) path triggers quickly — for
  // BOTH cap groups the test accounts can reach (c1 = levels 1500-2999 e.g.
  // the level-2500 warrior account, c3 = level 5000+). Without the c1 cap
  // the warrior grinds the mock boss to DEATH (and the fight runs for
  // minutes), which kills the later boss-alive view checks.
  BOSS_CAPS_JSON: JSON.stringify({
    c1: { gen: { c: true, v: 900 }, oce: { c: true, v: 900 } },
    c3: { gen: { c: true, v: 900 }, oce: { c: true, v: 900 } },
  }),
  // Precision wave farming: a small strict per-mob stop so the wave rounds
  // hit their FINISHED path fast, and a small per-round budget.
  MOB_DAMAGE_CAP: '1200',
  WAVE_MOBS_PER_ROUND: '3',
  // Stat allocation: workers auto-run this plan once per session when their
  // EXP poll sees enough banked points (defense only, so the top-bar stamina
  // max stays 7190 for the vitals assertion).
  STAT_PLAN: 'defense=444',
  STAT_AUTO_ALLOCATE: '1',
  LOG_LEVEL: 'debug',
};

function api(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: FARM_PORT,
      method,
      path: pathName,
      headers: {
        'X-Admin-Token': sessionToken || '',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, everyMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let val;
    try { val = await fn(); } catch (_) { val = null; }
    if (val) return val;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await sleep(everyMs);
  }
}

let failures = 0;
let farmLog = ''; // hoisted so the crash handler can print the engine side
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  // 1) Boot mock game + farm server.
  const mock = spawn('node', [path.join(__dirname, 'mock-game.js'), String(MOCK_PORT)], { stdio: 'pipe' });
  const farm = spawn('node', [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'pipe' });
  farm.stdout.on('data', (d) => { farmLog += d.toString(); });
  farm.stderr.on('data', (d) => { farmLog += d.toString(); });

  try {
    await waitFor(async () => {
      const r = await api('GET', '/healthz').catch(() => null);
      return r && r.status === 200;
    }, 15000, 300, 'farm server /healthz');
    console.log('· farm server is up');

    // 2) Panel login: username + password → session token (no secret key).
    const noTok = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: FARM_PORT, path: '/api/status', method: 'GET' }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.end();
    });
    check('API rejects requests without a session (401, not signed in)', noTok.status === 401, `got ${noTok.status}`);
    const badLogin = await api('POST', '/api/login', { username: ADMIN_USER, password: 'nope-nope' });
    check('login rejects a wrong password (401)', badLogin.status === 401, JSON.stringify(badLogin.json));
    const wrongUser = await api('POST', '/api/login', { username: 'root', password: ADMIN_PASS });
    check('login rejects a wrong username (401)', wrongUser.status === 401, JSON.stringify(wrongUser.json));
    const loginRes = await api('POST', '/api/login', { username: ADMIN_USER, password: ADMIN_PASS });
    check('login issues a session token for the right username+password (no secret key involved)',
      loginRes.status === 200 && loginRes.json.ok && /^[0-9a-f]{64}$/.test(loginRes.json.token || '')
        && loginRes.json.username === ADMIN_USER,
      JSON.stringify({ ...loginRes.json, token: (loginRes.json.token || '').slice(0, 8) + '…' }));
    sessionToken = loginRes.json.token;
    const authedSt = await api('GET', '/api/status');
    check('session token authenticates /api/status', authedSt.status === 200 && authedSt.json.ok === true, `got ${authedSt.status}`);
    // Logout kills the session; sign straight back in for the rest of the run.
    await api('POST', '/api/logout', {});
    const afterLogout = await api('GET', '/api/status');
    check('logout revokes the session token', afterLogout.status === 401, `got ${afterLogout.status}`);
    const relogin = await api('POST', '/api/login', { username: ADMIN_USER, password: ADMIN_PASS });
    sessionToken = relogin.json.token;
    check('re-login after logout works', relogin.status === 200 && !!sessionToken, `got ${relogin.status}`);

    // 3) Add account 1 (with a wrong password first to test rejection path).
    const bad = await api('POST', '/api/accounts', { nickname: 'bad', email: 'hunter.one@example.com', password: 'WRONG' });
    check('API accepts account add (login happens async)', bad.status === 200, JSON.stringify(bad.json));
    await sleep(3500); // let the worker fail login once

    // Fix the password via re-add (same email → updates row) — and set the
    // account's guild code at the same time (tag form, brackets optional).
    const good = await api('POST', '/api/accounts', { nickname: 'hunter-one', email: 'hunter.one@example.com', password: 'hunterpass1', guildCode: '[MOCK]' });
    check('API accepts corrected account add (with guild code)', good.status === 200, JSON.stringify(good.json));
    check('API echoes the stored guild code', good.json.account && good.json.account.guildCode === '[MOCK]', JSON.stringify(good.json.account));

    // 4) Encryption at rest: plaintext password must not appear in the store.
    await sleep(500);
    const encFile = fs.readFileSync(path.join(DATA_DIR, 'accounts.enc'), 'utf8');
    check('password never stored in plaintext', !encFile.includes('hunterpass1'));
    check('store is GCM-ciphertext (iv+tag+ct)', encFile.includes('"iv"') && encFile.includes('"tag"') && encFile.includes('"ct"'));
    const status0 = await api('GET', '/api/status');
    const acc0 = (status0.json.accounts || []).find((a) => a.nickname === 'hunter-one');
    check('status masks the email', acc0 && /^[a-z]\*\*\*.*@/.test(acc0.emailMasked), JSON.stringify(acc0));
    check('status carries the account\u2019s guild code (re-add fix path)', acc0 && acc0.guildCode === '[MOCK]', JSON.stringify(acc0));

    // 5) Wait for login + first boss FINISHED (cap 900 < hp 100000).
    const fin = await waitFor(async () => {
      const s = await api('GET', '/api/status');
      const a = (s.json.accounts || []).find((x) => x.nickname === 'hunter-one');
      return a && a.bossHits >= 1;
    }, 45000, 500, 'first boss combat run');
    check('worker logged in and completed a boss run', !!fin);
    const st1 = await api('GET', '/api/status');
    const acc1 = (st1.json.accounts || []).find((a) => a.nickname === 'hunter-one');
    check('worker reached running status', acc1 && acc1.status === 'running', JSON.stringify(acc1));
    check('worker resolved level (5001)', acc1 && acc1.level === 5001);

    // 6) Bus has scout targets (skarn alive 9001 matched; 9002 dead-filtered).
    const tg = await api('GET', '/api/targets');
    const gen = tg.json.bosses && tg.json.bosses.gen;
    check('scout published the live boss target (gen → mob 9001)', gen && gen.monsterId === '9001', JSON.stringify(tg.json.bosses));
    const mobIds = (tg.json.mobs || []).map((m) => String(m.id));
    check('scout filtered the dead row (no 9002 in mobs)', !mobIds.includes('9002'), JSON.stringify(mobIds));
    check('scout collected generic mobs', mobIds.includes('8001') && mobIds.includes('8003'));

    // 7) Parallel worker 2 + revoke. classPick 'off' from birth — the game's
    //    class choice is permanent, so off must mean off from the start.
    const acc2 = await api('POST', '/api/accounts', { nickname: 'hunter-two', email: 'hunter.two@example.com', password: 'hunterpass2', classPick: 'off' });
    check('second account added (parallel worker, classPick off echoed)', acc2.status === 200 && acc2.json.account && acc2.json.account.classPick === 'off', JSON.stringify(acc2.json));
    const acc2Id = acc2.json.account && acc2.json.account.id;
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      const a = (s.json.accounts || []).find((x) => x.nickname === 'hunter-two');
      return a && a.status === 'running';
    }, 30000, 500, 'second worker running');

    // 8) Farm healthy: workers keep cycling (waves + dungeons + side farms).
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => a.lastError === null && a.status === 'running');
    }, 10000, 500, 'farm healthy');

    // 8b) Visibility: EXP proof-of-life + last-action age reach the API.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      const a = (s.json.accounts || []).find((x) => x.nickname === 'hunter-one');
      return a && a.exp && a.exp.percent != null;
    }, 20000, 500, 'EXP poll reaching /api/status');
    const st3 = await api('GET', '/api/status');
    const acc3 = (st3.json.accounts || []).find((x) => x.nickname === 'hunter-one');
    check('status exposes lastActionAt + EXP percent (90%)',
      acc3 && typeof acc3.lastActionAt === 'number' && acc3.lastActionAt > 0
        && acc3.exp && acc3.exp.percent === 90,
      JSON.stringify(acc3));

    // 8b-class) Class system: the account was classless at level 5001, so the
    // auto-picker binds the OPTIMAL farming class (Mage — Fireball 4m PvE
    // damage per 200-stamina cast). hunter-two was added with classPick 'off'
    // (permanent choice — off is respected); warr.tester forces 'warrior';
    // low.lvl is level 150 → the picker must WAIT, not pick.
    await sleep(2500); // one cycle → postCycleHooks → the class round
    let mockCls = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
      }).on('error', () => resolve(null));
    });
    check('class auto-pick: the classless level-5001 account bound Mage (choose_class_id=2 POSTed)',
      mockCls && mockCls.classes && mockCls.classes['101'] === 'Mage'
        && mockCls.lastClassPost && mockCls.lastClassPost['101'] && mockCls.lastClassPost['101'].classId === 2,
      JSON.stringify({ classes: mockCls && mockCls.classes, post: mockCls && mockCls.lastClassPost }));
    check('status exposes the bound class (currentClass Mage, action picked)',
      acc3 && acc3.classInfo && acc3.classInfo.currentClass === 'Mage' && acc3.classInfo.action === 'picked',
      JSON.stringify(acc3 && acc3.classInfo));
    check('the built-in fetcher never picks a class (lean by design)',
      mockCls && mockCls.classes && !mockCls.classes['100'], JSON.stringify(mockCls && mockCls.classes));
    check('classPick off → hunter-two bound NOTHING (no choose POST, no mock class)',
      mockCls && mockCls.classes && !mockCls.classes['102']
        && mockCls.lastClassPost && !mockCls.lastClassPost['102'],
      JSON.stringify({ classes: mockCls && mockCls.classes, post: mockCls && mockCls.lastClassPost }));

    // Explicit optimal override: warrior for this dedicated account.
    const accWar = await api('POST', '/api/accounts', { nickname: 'unit-warr', email: 'warr.tester@example.com', password: 'warrpass1', classPick: 'warrior' });
    check('API accepts an explicit classPick (warrior, echoed)',
      accWar.status === 200 && accWar.json.account && accWar.json.account.classPick === 'warrior',
      JSON.stringify(accWar.json.account));
    const accBad = await api('POST', '/api/accounts', { nickname: 'bad-pick', email: 'low.lvl@example.com', password: 'lowpass1', classPick: 'paladin' });
    check('API rejects an unknown classPick (400)',
      accBad.status === 400, `got ${accBad.status}`);
    const accLow = await api('POST', '/api/accounts', { nickname: 'low-lvl', email: 'low.lvl@example.com', password: 'lowpass1' });
    check('low-level account added (level 150, classless)',
      accLow.status === 200, JSON.stringify(accLow.json));
    // Wait until the mock world shows BOTH new accounts resolved their class
    // policy (107 Warrior bound · 106 still classless), then read status once.
    await waitFor(async () => {
      const s = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
          let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
        }).on('error', () => resolve(null));
      });
      return s && s.classes && s.classes['107'] === 'Warrior' && !s.classes['106'];
    }, 75000, 500, 'warrior pick + low-level wait');
    // 106's round runs right after its own login — wait for the status row.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      const a = (s.json.accounts || []).find((x) => x.nickname === 'low-lvl');
      return a && a.classInfo && a.classInfo.action === 'low-level';
    }, 30000, 500, 'low-level status row');
    const stCls = await api('GET', '/api/status');
    const lowAcc = (stCls.json.accounts || []).find((x) => x.nickname === 'low-lvl');
    check('class picker WAITS for low-level accounts (action low-level, level 150, no class bound)',
      lowAcc && lowAcc.classInfo && lowAcc.classInfo.action === 'low-level'
        && lowAcc.classInfo.level === 150 && !lowAcc.classInfo.currentClass,
      JSON.stringify(lowAcc && lowAcc.classInfo));
    const warrAcc = (stCls.json.accounts || []).find((x) => x.nickname === 'unit-warr');
    check('the warrior override actually bound Warrior in the mock (choose_class_id=1)',
      warrAcc && warrAcc.classInfo && warrAcc.classInfo.currentClass === 'Warrior',
      JSON.stringify(warrAcc && warrAcc.classInfo));
    mockCls = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
      }).on('error', () => resolve(null));
    });
    check('final mock class world: 101 Mage · 103 untouched · 102 off · 106 waiting · 107 Warrior',
      mockCls && mockCls.classes && mockCls.classes['101'] === 'Mage'
        && !mockCls.classes['102'] && !mockCls.classes['103'] && !mockCls.classes['106']
        && mockCls.classes['107'] === 'Warrior',
      JSON.stringify(mockCls && mockCls.classes));
    const offAcc = (stCls.json.accounts || []).find((x) => x.nickname === 'hunter-two');
    check('classPick off → no class round ran at all (classInfo null)',
      offAcc && offAcc.classInfo === null, JSON.stringify(offAcc && offAcc.classInfo));

    // 8b-tree) Class skill tree: the bound accounts unlocked their FREE
    // first skill (Mage Fireball / Warrior Ironclad Strike) — the engine
    // spends Adv. Points damage-first. Classless/off accounts never touch
    // the tree (no tree page). The PATCH endpoint re-points the policy.
    await waitFor(async () => {
      const m = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
          let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
        }).on('error', () => resolve(null));
      });
      return m && m.trees && m.trees['101'] && m.trees['101'].owned && m.trees['101'].owned['4']
        && m.trees['107'] && m.trees['107'].owned && m.trees['107'].owned['6'];
    }, 75000, 1000, 'skill tree unlocks reaching the mock world');
    const stTree = await api('GET', '/api/status');
    const treeAcc = (stTree.json.accounts || []).find((x) => x.nickname === 'hunter-one');
    check('skill tree round: the Mage account unlocked Fireball free (+1 skill, class reported)',
      treeAcc && treeAcc.skillTree && treeAcc.skillTree.unlocked >= 1
        && treeAcc.skillTree.className === 'Mage',
      JSON.stringify(treeAcc && treeAcc.skillTree));
    mockCls = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
      }).on('error', () => resolve(null));
    });
    check('mock tree world: 101 owns Fireball (id 4), 107 owns Ironclad Strike (id 6), classless 102/106 never unlocked a skill',
      mockCls && mockCls.trees && mockCls.trees['101'] && mockCls.trees['101'].owned
        && mockCls.trees['101'].owned['4'] && mockCls.trees['101'].owned['4'].level === 1
        && mockCls.trees['107'] && mockCls.trees['107'].owned && mockCls.trees['107'].owned['6']
        && (!mockCls.trees['102'] || Object.keys(mockCls.trees['102'].owned).length === 0)
        && (!mockCls.trees['106'] || Object.keys(mockCls.trees['106'].owned).length === 0),
      JSON.stringify(mockCls && mockCls.trees));
    // PATCH /api/accounts/<id> — the per-account policy switch.
    const patchBad = await api('PATCH', `/api/accounts/${offAcc.id}`, { classPick: 'paladin' });
    check('PATCH rejects an unknown classPick (400)',
      patchBad.status === 400, `got ${patchBad.status}`);
    const patchOk = await api('PATCH', `/api/accounts/${offAcc.id}`, { classPick: 'hunter' });
    check('PATCH re-points the per-account class policy (echoed)',
      patchOk.status === 200 && patchOk.json.account && patchOk.json.account.classPick === 'hunter',
      JSON.stringify(patchOk.json.account));
    const patchBack = await api('PATCH', `/api/accounts/${offAcc.id}`, { classPick: 'off' });
    check('PATCH back to off (the permanent-choice guard stays)',
      patchBack.status === 200 && patchBack.json.account.classPick === 'off',
      JSON.stringify(patchBack.json.account));

    // 8c) Global pause switch actually reaches status (workers honour it too).
    const off = await api('POST', '/api/farm', { enabled: false });
    check('farm pause accepted', off.status === 200 && off.json.farmEnabled === false, JSON.stringify(off.json));
    const stOff = await api('GET', '/api/status');
    check('status reports farm paused', stOff.json.farmEnabled === false, JSON.stringify(stOff.json.farmEnabled));
    const on = await api('POST', '/api/farm', { enabled: true });
    check('farm resume accepted', on.status === 200 && on.json.farmEnabled === true, JSON.stringify(on.json));

    // 8d) The fetcher is FIXED to the built-in admin account ("grab ids with
    //     THIS one" — it fetches for every account added, and nothing users
    //     do can move that job).
    const sc1 = await api('POST', '/api/scout', { accountId: acc1.id });
    check('re-pointing the fetcher to a user account is refused (403, fixed to the built-in admin)',
      sc1.status === 403, `got ${sc1.status}`);
    const badSc = await api('POST', '/api/scout', { accountId: 'acc_nope' });
    check('unknown fetcher rejected (403)', badSc.status === 403, `got ${badSc.status}`);
    const clr = await api('POST', '/api/scout', {});
    check('fetcher designation cannot be cleared (403)', clr.status === 403, `got ${clr.status}`);
    const farmJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'farm.json'), 'utf8'));
    check('fetcher setting persisted to farm.json (the built-in admin\u2019s id)',
      !!farmJson.scoutAccountId, JSON.stringify(farmJson));
    const scSelf = await api('POST', '/api/scout', { accountId: farmJson.scoutAccountId });
    check('re-affirming the built-in fetcher is a no-op that answers ok',
      scSelf.status === 200 && scSelf.json.ok && scSelf.json.scoutAccount && scSelf.json.scoutAccount.hidden === true,
      JSON.stringify(scSelf.json));

    // 8e) The built-in admin fetcher: hidden from users, protected, and it
    //     joins the battles it broadcasts about.
    const adminEmail = 'fetcher@test.invalid';
    const adminNick = 'core-fetcher';
    const reserved = await api('POST', '/api/accounts', { nickname: 'sneaky', email: adminEmail, password: 'whatever123' });
    check('adding an account with the fetcher\u2019s email is refused (generic message, 400)',
      reserved.status === 400 && /cannot be added/i.test(reserved.json.error || ''), JSON.stringify(reserved.json));
    const stHid = await api('GET', '/api/status');
    const hidAccounts = stHid.json.accounts || [];
    check('the built-in fetcher is INVISIBLE in /api/status (no nickname, no email hint, counts match)',
      !hidAccounts.some((a) => a.nickname === adminNick || /fetcher@test/i.test(JSON.stringify(a)))
        && stHid.json.storedCount === hidAccounts.length
        && stHid.json.fetcherFixed === true,
      JSON.stringify({ storedCount: stHid.json.storedCount, names: hidAccounts.map((a) => a.nickname) }));
    check('status shows the fetcher only as an anonymous "built-in fetcher"',
      stHid.json.scoutAccount && stHid.json.scoutAccount.hidden === true
        && stHid.json.scoutAccount.id === null
        && stHid.json.scoutAccount.nickname === 'built-in fetcher',
      JSON.stringify(stHid.json.scoutAccount));
    const delAdmin = await api('DELETE', `/api/accounts/${farmJson.scoutAccountId}`);
    check('the built-in fetcher account cannot be removed (403)', delAdmin.status === 403, `got ${delAdmin.status}`);
    const statsHid = await api('GET', '/api/stats');
    check('GET /api/stats hides the fetcher too',
      !(statsHid.json.accounts || []).some((a) => a.nickname === adminNick),
      JSON.stringify((statsHid.json.accounts || []).map((a) => a.nickname)));
    const adminMask = 'built-in fetcher'; // the fetcher's audit label — no part of its address
    const auditNow = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
    check('audit records the fetcher being seeded', auditNow.includes('"action":"admin_fetcher_seeded"'), '');
    await waitFor(async () => {
      const log = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
      return log.split('\n').some((line) => line.includes('"action":"wave_round"') && line.includes(adminMask));
    }, 60000, 1000, 'the built-in fetcher joining battles (its own wave_round audits)');
    check('the built-in fetcher JOINS the battles it broadcasts (its own wave_round audits)', true);

    // 9) Audit log exists and never contains passwords.
    const audit = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
    check('audit log written', audit.includes('"action":"login_ok"'));
    check('audit log has no passwords', !audit.includes('hunterpass'));
    check('audit log never contains any part of the fetcher\u2019s address (local part or domain)',
      !/fetcher@test|f\*\*\*r@|test\.invalid/i.test(audit), '');

    // 10) Relogin + revoke.
    const rl = await api('POST', `/api/accounts/${acc1.id}/relogin`);
    check('relogin accepted', rl.status === 200);
    const rm = await api('DELETE', `/api/accounts/${acc2Id}`);
    check('revoke accepted', rm.status === 200 && rm.json.removed === true, JSON.stringify(rm.json));
    await sleep(400);
    const st2 = await api('GET', '/api/status');
    check('revoked account gone from farm', !(st2.json.accounts || []).some((a) => a.nickname === 'hunter-two'));

    // 11) Protocol fidelity — the engine speaks the EXACT endpoints the game
    //     shows in live traffic: damage.php, user_join_battle.php (used by the
    //     combat run above), use_item.php with the captured `inv_id`-only
    //     body, ids read from the battleDrawer (per-account data-inv), and
    //     the view-only battle.php?id={id} link with HP + vitals parsing.
    const { GameClient } = require(path.join(ROOT, 'server', 'game'));
    const { CookieJar } = require(path.join(ROOT, 'server', 'jar'));
    const auth = require(path.join(ROOT, 'server', 'auth'));
    const combat = require(path.join(ROOT, 'server', 'combat'));
    const unitGame = new GameClient({
      gameBase: `http://127.0.0.1:${MOCK_PORT}`,
      jar: new CookieJar(),
      cfg: { requestTimeoutMs: 5000, jitterScale: 1, fastTest: true },
      label: 'unit',
    });
    await auth.login(unitGame, 'hunter.one@example.com', 'hunterpass1');

    const fetchLastUse = () => new Promise((resolve) => {
      http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/last_use_item`, (r) => {
        let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
      }).on('error', () => resolve(null));
    });

    // Stamina ladder before any battle view → drawer empty → inventory.php
    // slot-box fallback finds the Large Stamina Potion slot (inv 777).
    const drank = await combat.drinkStaminaPotion(unitGame);
    let lastUse = await fetchLastUse();
    check('stamina ladder falls back to inventory scan + POSTs use_item.php', drank === true, JSON.stringify(lastUse));
    check('use_item.php body is inv_id ONLY (the captured live format)',
      lastUse && lastUse.last && lastUse.last.inv_id === '777'
        && lastUse.last.item_id === null && lastUse.last.qty === null,
      JSON.stringify(lastUse));

    // View the live battle: parses monster state + YOUR hp + the drawer.
    const viewAlive = await combat.viewBattle(unitGame, '9001');
    const viewDead = await combat.viewBattle(unitGame, '9002');
    check('battle.php?id= view: live mob reads alive', viewAlive && viewAlive.found && !viewAlive.dead, JSON.stringify(viewAlive));
    check('battle.php?id= view: dead mob reads dead', viewDead && viewDead.found && viewDead.dead, JSON.stringify(viewDead));
    // REGRESSION (live 2026-11-22): the real battle page embeds an error-message
    // catalog in its JavaScript ("Monster is already dead.", …). A raw substring
    // test flagged EVERY alive mob dead and starved every wave round. The
    // parser must only match VISIBLE page text.
    const catalogPage = `<div class="battle-card" data-monster-id="9001">…</div>
      <script>
        var ERRORS = ["Monster is already dead.", "Slow down — wait for the cooldown.", "Invalid monster."];
        if (state === 'dead') el.setAttribute('data-dead', '1');
      </script>
      <div id="pHpText">💚 376,500 / 358,250 HP</div>`;
    const viewCatalog = combat.parseBattleView(catalogPage, '9001');
    check('an alive mob whose page embeds the JS error catalog does NOT read dead',
      viewCatalog && viewCatalog.found && viewCatalog.dead === false, JSON.stringify({ dead: viewCatalog && viewCatalog.dead }));
    check('battle.php?id= view parses player HP (#pHpText)',
      viewAlive && viewAlive.hp && viewAlive.hp.cur === 376500 && viewAlive.hp.max === 358250,
      JSON.stringify(viewAlive && viewAlive.hp));
    check('battle.php?id= view parses the battleDrawer potion cards',
      viewAlive && Array.isArray(viewAlive.potions) && viewAlive.potions.length === 5
        && viewAlive.potions[0].invId === '303210560' && viewAlive.potions[0].itemId === '30'
        && viewAlive.potions[0].qty === 1723,
      JSON.stringify(viewAlive && viewAlive.potions));

    // Ladder picks by name, drawer cards carry per-account inv ids.
    const healCard = combat.choosePotion(viewAlive.potions, ['full hp potion']);
    check('HP potion ladder picks Full Hp Potion (data-inv 396373)',
      healCard && healCard.invId === '396373', JSON.stringify(healCard));
    const hpDrank = healCard ? await combat.usePotionCard(unitGame, healCard) : false;
    lastUse = await fetchLastUse();
    check('heal potion POSTs use_item.php inv_id=396373',
      hpDrank === true && lastUse && lastUse.last && lastUse.last.inv_id === '396373',
      JSON.stringify(lastUse));

    const stamCard = combat.choosePotion(viewAlive.potions, ['small stamina potion', 'large stamina potion', 'full stamina potion']);
    check('stamina ladder picks Small first (per-account inv 303210560)',
      stamCard && stamCard.invId === '303210560', JSON.stringify(stamCard));

    const skipZero = combat.choosePotion(
      [{ invId: '1', itemId: '30', name: 'Small Stamina Potion', qty: 0 },
       { invId: '2', itemId: '251', name: 'Large Stamina Potion', qty: 3 }],
      ['small stamina potion', 'large stamina potion']
    );
    check('ladder skips empty slots (qty 0)', skipZero && skipZero.invId === '2', JSON.stringify(skipZero));

    const noDrink = await combat.drinkStaminaPotion(unitGame, [{ invId: '9', itemId: '30', name: 'Unrelated Elixir', qty: 9 }]);
    check('no matching card → nothing drunk (no inventory fallback when cards given)', noDrink === false);

    // ── 11b) Per-mob loot caps — the "DMG req:" scanner port. Each wave and
    //         gate got different numbers; the mob's own battle page states
    //         its best-loot damage gate and the engine learns exactly that.
    const loot = require(path.join(ROOT, 'server', 'loot'));
    const cardHtml = '<div class="loot-grid">' +
      '<div class="loot-card"><strong>Goblin Essence</strong><span>DMG req: 70,000</span></div>' +
      '<div class="loot-card"><strong>Goblin Ear</strong><span>DMG req: 10,000</span></div></div>';
    const drops = loot.parseLootReqs(cardHtml);
    check('parseLootReqs reads loot cards, dedupes and sorts desc (top 70,000)',
      drops.length === 2 && drops[0].req === 70000 && drops[0].name === 'Goblin Essence'
        && drops[1].req === 10000,
      JSON.stringify(drops));
    const fb = loot.parseLootReqs('<p>nothing here</p>\nWorn Leather Boots - DMG req: 15,000');
    check('parseLootReqs body-text fallback (Worn Leather Boots → 15,000)',
      fb.length === 1 && fb[0].req === 15000 && fb[0].name === 'Worn Leather Boots',
      JSON.stringify(fb));
    check('measured mob table: Goblin Skirmisher 70,000 · Zeus 8,000,000,000',
      loot.knownMobCap('Goblin Skirmisher').req === 70000
        && loot.knownMobCap('zeus, sovereign of the storm throne').req === 8000000000,
      JSON.stringify({ g: loot.knownMobCap('Goblin Skirmisher'), z: loot.knownMobCap('zeus, sovereign of the storm throne') }));
    check('measured wave defaults: gate=3&wave=3 → 70,000 · Hermes gate → 100,000,000',
      loot.knownWaveDefault('gate=3&wave=3') === 70000
        && loot.knownWaveDefault('gate=5&wave=10') === 100000000,
      JSON.stringify({ g13: loot.knownWaveDefault('gate=3&wave=3'), g510: loot.knownWaveDefault('gate=5&wave=10') }));
    const live = loot.resolveMobCap({ name: 'probe mob', wavePath: 'gate=9&wave=91',
      liveHtml: '<div class="loot-card"><strong>Probe Shard</strong><span>DMG req: 12,500</span></div>',
      cfg: { mobDamageCap: 1200 } });
    check('resolveMobCap: the live loot gate wins and is learned (12,500)',
      live.cap === 12500 && live.source === 'live-loot', JSON.stringify(live));
    check('resolveMobCap: learned cache beats the tables on the next ask',
      loot.resolveMobCap({ name: 'probe mob', cfg: { mobDamageCap: 1200 } }).source === 'learned', '');
    check('resolveMobCap: known mob → known wave → config fallback chain',
      loot.resolveMobCap({ name: 'Goblin Skirmisher', cfg: {} }).source === 'known-mob'
        && loot.resolveMobCap({ name: 'some unknown critter', wavePath: 'gate=5&wave=10', cfg: {} }).source === 'known-wave'
        && loot.resolveMobCap({ name: 'some unknown critter', cfg: { mobDamageCap: 1200 } }).source === 'config',
      '');
    const viewLoot = await combat.viewBattle(unitGame, '8301');
    check('battle.php view exposes the mob\u2019s loot table + maxDamageReq (1,200)',
      viewLoot && viewLoot.maxDamageReq === 1200 && Array.isArray(viewLoot.loot)
        && viewLoot.loot.length === 1 && viewLoot.loot[0].name === 'Gate Warden Sigil',
      JSON.stringify(viewLoot && viewLoot.loot));

    // The peek borrows a logged-in worker — wait one out if a relogin/revoke
    // from the previous section left the roster momentarily unhealthy.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => a.status === 'running');
    }, 20000, 500, 'a healthy worker for the battle peek');

    const peek1 = await api('GET', '/api/battle/9001');
    const peek2 = await api('GET', '/api/battle/9002');
    check('GET /api/battle/:id peeks via the scout client (alive + hp)',
      peek1.status === 200 && peek1.json.ok && peek1.json.dead === false && peek1.json.hp && peek1.json.hp.cur === 376500,
      JSON.stringify(peek1.json));
    check('GET /api/battle/:id peeks via the scout client (dead)', peek2.status === 200 && peek2.json.dead === true, JSON.stringify(peek2.json));

    const stVitals = await api('GET', '/api/status');
    const vitAcc = (stVitals.json.accounts || []).find((a) => a.vitals && a.vitals.stamina);
    check('status exposes per-account stamina vitals (live top bar, max 7190)',
      vitAcc && vitAcc.vitals.stamina
        && vitAcc.vitals.stamina.max === 7190
        && typeof vitAcc.vitals.stamina.cur === 'number',
      JSON.stringify(vitAcc && vitAcc.vitals));

    const tg2 = await api('GET', '/api/targets');
    const gen2 = tg2.json.bosses && tg2.json.bosses.gen;
    const mobWithUrl = (tg2.json.mobs || []).find((m) => m.battleUrl);
    check('published boss carries battle.php?id= view link',
      gen2 && /\/battle\.php\?id=9001$/.test(gen2.battleUrl || ''), JSON.stringify(gen2));
    check('published mobs carry battle.php?id= view links', !!mobWithUrl, JSON.stringify((tg2.json.mobs || [])[0]));

    // ── 12) Gates & precision wave farming — the runPrecisionWaveCombat port,
    //        driven over the full gate/wave registry (Gate 1 + Olympus).
    const wavesApi = await api('GET', '/api/waves');
    check('GET /api/waves exposes the registry (auto loot caps, no farm mode knob)',
      wavesApi.status === 200 && wavesApi.json.ok && wavesApi.json.mode === undefined
        && wavesApi.json.capMode === 'auto' && wavesApi.json.mobDamageCap === 1200
        && typeof wavesApi.json.learnedCaps === 'number' && Array.isArray(wavesApi.json.waves)
        && wavesApi.json.waves.length === 13,
      JSON.stringify(wavesApi.json));
    const w0 = (wavesApi.json.waves || [])[0];
    const wLast = (wavesApi.json.waves || [])[12];
    check('registry starts at Grakthar wave 1 (gate=3&wave=3)',
      w0 && w0.path === 'gate=3&wave=3' && w0.label === 'Grakthar · wave 1', JSON.stringify(w0));
    check('registry ends with the LevelUp Looter\u2019s event wave (event=13&wave=116)',
      wLast && wLast.path === 'event=13&wave=116' && /Dragon/i.test(wLast.label), JSON.stringify(wLast));

    // The gate hub pages exist and list every wave (direct client, own login).
    const unit2 = new GameClient({
      gameBase: `http://127.0.0.1:${MOCK_PORT}`,
      jar: new CookieJar(),
      cfg: { requestTimeoutMs: 5000, jitterScale: 1, fastTest: true, waveHitDelayMs: 40, paceMinMs: 10, paceMaxMs: 30 },
      label: 'unit-waves',
    });
    await auth.login(unit2, 'unit.tester@example.com', 'unitpass1'); // uid 103 — races no worker

    const gatesRes = await unit2.get('/gates.php', { redirect: 'manual' });
    check('gates.php lists Gate 1 waves (active_wave.php?gate=3&wave=3 … 5/8)',
      /active_wave\.php\?gate=3&(?:amp;)?wave=3/.test(gatesRes.text)
        && /active_wave\.php\?gate=3&(?:amp;)?wave=8/.test(gatesRes.text),
      gatesRes.text.slice(0, 200));
    check('gates.php links the Olympus hub + named god gates (…wave=17)',
      /olympus\.php/.test(gatesRes.text) && /active_wave\.php\?gate=5&(?:amp;)?wave=17/.test(gatesRes.text), '');
    const olympusRes = await unit2.get('/olympus.php', { redirect: 'manual' });
    check('olympus.php lists Hermes … Zeus gates (gate=5 waves 10-17)',
      /gate=5&(?:amp;)?wave=10/.test(olympusRes.text) && /gate=5&(?:amp;)?wave=17/.test(olympusRes.text), '');

    // Card parsing: boss-card rows are excluded, dead rows flagged, You: read.
    const wave8Cards = combat.parseWaveCards((await unit2.get('/active_wave.php?gate=3&wave=8', { redirect: 'manual' })).text);
    check('parseWaveCards skips .boss-card rows (no 9001/9002) and keeps generic mobs (8001/8002)',
      !wave8Cards.some((c) => c.id === '9001' || c.id === '9002')
        && wave8Cards.some((c) => c.id === '8001') && wave8Cards.some((c) => c.id === '8002'),
      JSON.stringify(wave8Cards));
    const wave91Cards = combat.parseWaveCards((await unit2.get('/active_wave.php?gate=9&wave=91', { redirect: 'manual' })).text);
    const deadCard = wave91Cards.find((c) => c.id === '8090');
    check('parseWaveCards flags dead rows (8090 dead:true) and names cards (h3)',
      wave91Cards.length === 4 && deadCard && deadCard.dead === true
        && wave91Cards.some((c) => c.name === 'practice dummy'),
      JSON.stringify(wave91Cards));

    const mockState = async (setBody) => {
      if (setBody) {
        await new Promise((resolve) => {
          const data = JSON.stringify(setBody);
          const rq = http.request({
            host: '127.0.0.1', port: MOCK_PORT, path: '/__mock/state', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          }, (r) => { r.resume(); r.on('end', resolve); });
          rq.on('error', resolve);
          rq.write(data); rq.end();
        });
      }
      return new Promise((resolve) => {
        http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
          let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => resolve(JSON.parse(b)));
        }).on('error', () => resolve(null));
      });
    };

    // SLAIN path: 1500 HP dummy dies after 10 one-stamina Slashes. The mock
    // bounces the first hit after each join ("too quickly — cooldown"), so a
    // finish here also proves the retry handling.
    const slain = await combat.waveCombat({ game: unit2, userId: '103', monsterId: '8010', cap: 5000, startDamage: 0 });
    let st = await mockState();
    check('waveCombat slays a small mob (hp 0 → SLAIN) despite the first-hit cooldown',
      slain === 'SLAIN' && st.damage['103:8010'] === 1500, JSON.stringify({ slain, d: st.damage }));
    check('wave join speaks the live 3-field body (id, monster_id, user_id)',
      st.lastJoin && st.lastJoin['103'] && st.lastJoin['103'].id === '8010'
        && st.lastJoin['103'].monster_id === '8010' && st.lastJoin['103'].user_id === '103',
      JSON.stringify(st.lastJoin));
    check('wave slashes are skill_id=0 / stamina_cost=1 (the 1-stamina Slash)',
      st.lastDamage && st.lastDamage['103'] && st.lastDamage['103'].skill_id === '0'
        && st.lastDamage['103'].stamina_cost === '1',
      JSON.stringify(st.lastDamage));

    // Strict stop: cap 1200 on a 60000 HP titan → FINISHED at exactly 1200.
    const capped = await combat.waveCombat({ game: unit2, userId: '103', monsterId: '8011', cap: 1200, startDamage: 0 });
    st = await mockState();
    check('waveCombat stops at the strict damage cap (FINISHED, exactly 1200 — not 1350)',
      capped === 'FINISHED' && st.damage['103:8011'] === 1200, JSON.stringify({ capped, d: st.damage }));

    // DEAD path: joining a dead mob bails immediately.
    const deadRun = await combat.waveCombat({ game: unit2, userId: '103', monsterId: '8090', cap: 5000, startDamage: 0 });
    check('waveCombat refuses dead mobs (join says already dead → DEAD)', deadRun === 'DEAD', String(deadRun));

    // Stamina gate: pin the bar to 2 → the third slash bounces → OUT_OF_STAMINA,
    // then the potion ladder (inventory scan → use_item inv_id=777) refills it.
    await mockState({ uid: '103', stamina: 2 });
    const starved = await combat.waveCombat({ game: unit2, userId: '103', monsterId: '8012', cap: 5000, startDamage: 0 });
    check('waveCombat halts on empty stamina (OUT_OF_STAMINA)', starved === 'OUT_OF_STAMINA', String(starved));
    const refilled = await combat.drinkStaminaPotion(unit2);
    st = await mockState();
    check('out-of-stamina → potion ladder drinks use_item.php and refills the bar',
      refilled === true && st.stamina['103'] === 7190, JSON.stringify({ refilled, stamina: st.stamina }));

    // AUTO cap mode (the loot scanner port): the siege titan's battle page
    // carries "Siege Core — DMG req: 450"; the round must stop there even
    // though MOB_DAMAGE_CAP is 1200 (no stamina wasted past the loot gate).
    const autoRound = await combat.waveFarmRound({
      game: unit2, userId: '103',
      cfg: { mobDamageCap: 1200, mobCapMode: 'auto', waveMobsPerRound: 4, paceMinMs: 10, paceMaxMs: 30, waveHitDelayMs: 40 },
      wave: { path: 'gate=9&wave=91', label: 'unit test page' },
    });
    st = await mockState();
    check('auto cap: the live "DMG req:" loot gate stops the siege titan at exactly 450 (< config 1200)',
      autoRound.eligible === 1 && autoRound.attacked === 1 && autoRound.capped === 1
        && st.damage['103:8012'] === 450
        && autoRound.caps['siege titan'] && autoRound.caps['siege titan'].cap === 450
        && autoRound.caps['siege titan'].source === 'live-loot',
      JSON.stringify({ autoRound, d: st.damage }));

    // FIXED cap mode: MOB_DAMAGE_CAP is the law — the titan resumes from
    // "You: 450" to exactly 1200; dead (8090) and capped (8011, You: 1200)
    // mobs are skipped.
    const round = await combat.waveFarmRound({
      game: unit2, userId: '103',
      cfg: { mobDamageCap: 1200, mobCapMode: 'fixed', waveMobsPerRound: 4, paceMinMs: 10, paceMaxMs: 30, waveHitDelayMs: 40 },
      wave: { path: 'gate=9&wave=91', label: 'unit test page' },
    });
    st = await mockState();
    check('fixed cap: waveFarmRound resumes from "You:" and skips dead/capped mobs',
      round.eligible === 1 && round.attacked === 1 && round.capped === 1
        && st.damage['103:8012'] === 1200,
      JSON.stringify({ round, d: st.damage }));

    // CONTRACT FLOOR (the guild contracts' "min 3m dmg" rule): the active
    // kill contract's monster is fought PAST its loot gate (1200) all the
    // way to the kill with our damage ≥ 3m — a capped-and-alive mob can
    // never count. The floor rides the cfg copy the worker passes
    // (cfg.questReq), exactly like the battle-pass keywords do.
    const floorRound = await combat.waveFarmRound({
      game: unit2, userId: '103',
      cfg: {
        mobDamageCap: 1200, mobCapMode: 'auto', waveMobsPerRound: 4,
        paceMinMs: 10, paceMaxMs: 30, waveHitDelayMs: 40,
        questReq: { kind: 'kill', monster: 'lizardman shadowclaw', minDamage: 3000000, kills: 5, title: 'Shadowclaw Swarm' },
      },
      wave: { path: 'gate=9&wave=92', label: 'contract floor page' },
    });
    st = await mockState();
    check('contract floor: the shadowclaw is fought past its 1200 loot gate to the 3m+ kill (SLAIN, floored=1); the runt still farms normally',
      floorRound.attacked === 2 && floorRound.slain === 2 && floorRound.floored === 1
        && floorRound.matched >= 1
        && (st.damage['103:8020'] || 0) >= 3000000
        && st.damage['103:8021'] === 300,
      JSON.stringify({ round: floorRound, d: { c: st.damage['103:8020'], r: st.damage['103:8021'] } }));

    // Worker-level precision farming: rounds ran, the game's own auto-farm
    // stayed OFF (damage.php rejects while it is on), and the strict cap held.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => (a.waveRounds || 0) >= 1 && (a.waveHits || 0) >= 1);
    }, 60000, 1000, 'a worker running precision wave rounds');
    const stW = await api('GET', '/api/status');
    const wAcc = (stW.json.accounts || []).find((a) => (a.waveHits || 0) >= 1);
    check('status exposes waveRounds/waveHits per account (precision farming live)',
      !!wAcc && typeof wAcc.waveRounds === 'number', JSON.stringify(wAcc && { waveRounds: wAcc.waveRounds, waveHits: wAcc.waveHits }));
    // The game's own auto-farm blocks EVERY manual hit (damage.php answers
    // "your auto farm is on"). Flip it ON as hunter-one's game user (uid 101
    // — mid capping-run, so its next damage POST really happens) and watch
    // the engine pause it itself: auto_farm_status.php read → action=toggle
    // enabled=0 → verified → audited. Arming HERE (while mobs are alive and
    // being attacked) is the point — after the caps complete no round would
    // reach damage.php and the fix could never trip.
    const afClient = new GameClient({
      gameBase: `http://127.0.0.1:${MOCK_PORT}`,
      jar: new CookieJar(),
      cfg: { requestTimeoutMs: 5000, jitterScale: 1, fastTest: true },
      label: 'unit-autofarm',
    });
    await auth.login(afClient, 'hunter.one@example.com', 'hunterpass1');
    await afClient.postForm('/auto_farm_actions.php', { action: 'toggle', enabled: '1' });
    const afOn = await combat.readAutoFarmStatus(afClient);
    check('auto_farm_status.php reads IS_ENABLED (mock auto-farm armed ON for uid 101)',
      afOn.ok === true && afOn.enabled === true, JSON.stringify(afOn));
    // hunter-one rotates the registry (worker index 1 → it reaches
    // gate=3&wave=3 a few rounds in) and caps BOTH mobs at exactly their live
    // loot gate (1200). The built-in fetcher (uid 100, index 0) caps them
    // first — hp 60000 leaves room for every account to reach its own cap.
    // The armed auto-farm gets paused by the worker mid-run (its next damage
    // POST 400s → AUTO_FARM_ON → toggle off) and the capping finishes anyway.
    // hunter-one rotates the registry (worker index 1 → it reaches
    // gate=3&wave=3 a few rounds in). A full rotation is ~13 waves × a
    // multi-step cycle each, so the window must cover a whole loop.
    await waitFor(async () => {
      const s = await mockState();
      return s.damage['101:8301'] === 1200 && s.damage['101:8302'] === 1200;
    }, 240000, 1500, 'hunter-one capping 8301 & 8302 at the live loot gate');
    st = await mockState();
    check('worker wave rounds stop at the mobs\u2019 LIVE loot gate (8301 & 8302 at exactly 1200)',
      st.damage['101:8301'] === 1200 && st.damage['101:8302'] === 1200,
      JSON.stringify(st.damage));
    const capsFile = path.join(DATA_DIR, 'loot-caps.json');
    check('learned loot caps persisted to data/loot-caps.json',
      fs.existsSync(capsFile) && fs.readFileSync(capsFile, 'utf8').includes('gate warden'),
      String(fs.existsSync(capsFile)));
    // The worker already fixed the armed auto-farm above — assert the whole
    // chain here: state off, audited, and nothing left ON anywhere.
    await waitFor(async () => (await combat.readAutoFarmStatus(afClient)).enabled === false,
      60000, 1500, 'the engine pausing the game auto-farm on its own');
    const afOff = await combat.readAutoFarmStatus(afClient);
    check('the engine PAUSES a leftover auto-farm (toggle off, verified via status)',
      afOff.enabled === false, JSON.stringify(afOff));
    const auditAf = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
    check('auto_farm_disabled audited (the fix is visible, not silent)',
      auditAf.includes('"action":"auto_farm_disabled"'), '');
    st = await mockState();
    check('no game auto-farm is left ON anywhere on the mock (every entry disabled)',
      st.autoFarm && Object.values(st.autoFarm).every((s) => !s.enabled), JSON.stringify(st.autoFarm));

    // The scout sweeps the whole registry and publishes only what is ALIVE:
    // Grakthar wave 1's 60k-HP wardens survive the whole run (every account
    // caps at 1200), so their labelled rows stay on the bus. A wave whose
    // mobs were slain (Zeus domain's low-HP votary) correctly publishes
    // NOTHING — the freshness fix means the bus never advertises dead ids.
    await waitFor(async () => {
      const t = await api('GET', '/api/targets');
      const mobs = t.json.mobs || [];
      return mobs.some((m) => m.wave === 'gate=3&wave=3' && m.waveLabel === 'Grakthar · wave 1');
    }, 45000, 1000, 'scout publishing labelled live mobs from the registry');
    const tg3 = await api('GET', '/api/targets');
    const labelledMob = (tg3.json.mobs || []).find((m) => m.wave === 'gate=3&wave=3');
    check('published mobs carry the wave label (Grakthar · wave 1)',
      !!labelledMob && labelledMob.waveLabel === 'Grakthar · wave 1', JSON.stringify(labelledMob));
    check('published mobs carry the instance auto-die timer (expiresAt ms)',
      !!labelledMob && Number.isFinite(labelledMob.expiresAt) && labelledMob.expiresAt > Date.now(),
      JSON.stringify(labelledMob && labelledMob.expiresAt));
    check('published mobs list ONLY live instances (no slain mob ids on the bus)',
      !(tg3.json.mobs || []).some((m) => m.wave === 'gate=5&wave=17'), JSON.stringify(
        (tg3.json.mobs || []).filter((m) => m.wave === 'gate=5&wave=17')));
    const wavesLabel = await api('GET', '/api/waves');
    const zeusDomain = (wavesLabel.json.waves || []).find((w) => w.path === 'gate=5&wave=17');
    check('the registry carries the game’s own domain names (Olympus · Zeus domain)',
      !!zeusDomain && zeusDomain.label === 'Olympus · Zeus domain', JSON.stringify(zeusDomain));
    const auditLog2 = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
    check('audit log records wave_round events', auditLog2.includes('"action":"wave_round"'), '');

    // ── 12b) PvP season ladder (Divers pillar 3): the round reads the board,
    //         matchmakes ONCE (open season in the mock) and follows the
    //         redirect to the battle page. Closed seasons (the live game's
    //         state) are a clean no-op — covered by the unit suite.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => a.pvp && a.pvp.checkedAt > 0);
    }, 60000, 1000, 'a worker reading the pvp board');
    const pvpSt = await api('GET', '/api/status');
    const pvpAcc = (pvpSt.json.accounts || []).find((a) => a.pvp && a.pvp.checkedAt > 0);
    check('status exposes the pvp board state (season/tier/tokens/rank)',
      !!pvpAcc && pvpAcc.pvp.season === 'The Total Eclipse PvP Season'
        && pvpAcc.pvp.tier === 'Novice' && pvpAcc.pvp.tokens === 30 && pvpAcc.pvp.rank === 3262,
      JSON.stringify(pvpAcc && pvpAcc.pvp));
    const pvpMatched = (pvpSt.json.accounts || []).find((a) => a.pvp && a.pvp.matches >= 1);
    check('an account matchmade + followed the redirect (battle page detected)',
      !!pvpMatched && pvpMatched.pvp.lastBattle === 'PvP Battle · The Total Eclipse Season',
      JSON.stringify(pvpMatched && pvpMatched.pvp));
    const auditPvp = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
    check('pvp_match audited (the pillar is visible, not silent)', auditPvp.includes('"action":"pvp_match"'), '');

    // ── 13) Stat allocation engine — the allocatePlan port. stats.php
    //        embeds #stats-state; stats_ajax.php only accepts chunks of
    //        [100, 50, 5, 1]; a stale csrf/view bounces 409 and the engine
    //        re-syncs fresh tokens from stats.php and retries the chunk.
    const statsEngine = require(path.join(ROOT, 'server', 'stats'));

    const parsedState = statsEngine.parseStatsState(
      '<div id="stats-state" hidden>{"csrf":"abc123","view":4,' +
      '"user":{"ATTACK":10,"DEFENSE":20,"MAX_STAMINA":7190,"STAT_POINTS":9000}}</div>'
    );
    check('parseStatsState reads csrf/view/user out of #stats-state',
      parsedState && parsedState.csrf === 'abc123' && parsedState.view === 4
        && parsedState.user.STAT_POINTS === 9000,
      JSON.stringify(parsedState));

    const dec = statsEngine.decompose(444);
    check('decompose breaks 444 into [100,50,5,1] (4×100 + 8×5 + 4×1 = 16 chunks)',
      dec.length === 16 && dec.filter((c) => c === 100).length === 4
        && dec.filter((c) => c === 50).length === 0
        && dec.filter((c) => c === 5).length === 8
        && dec.filter((c) => c === 1).length === 4,
      JSON.stringify(dec));
    check('decompose sums to the requested amount (44444 → 456 chunks)',
      statsEngine.decompose(44444).reduce((a, b) => a + b, 0) === 44444
        && statsEngine.decompose(44444).length === 456, '');

    const liveState = await statsEngine.fetchStatsState(unit2);
    check('fetchStatsState reads the live mock #stats-state (10,000 points banked)',
      liveState && liveState.user && liveState.user.STAT_POINTS === 10000
        && liveState.user.MAX_STAMINA === 7190,
      JSON.stringify(liveState && liveState.user));

    const allocCount = async () => (await mockState()).allocateCount;
    const beforeEmpty = await allocCount();
    const empty = await statsEngine.allocatePlan(unit2, { attack: 0, defense: 0, stamina: 0 }, { fastTest: true });
    check('empty plan refused with zero stats_ajax POSTs',
      empty.ok === false && empty.reason === 'empty_plan' && (await allocCount()) === beforeEmpty,
      JSON.stringify(empty));

    const greedy = await statsEngine.allocatePlan(unit2, { stamina: 99999 }, { fastTest: true });
    check('plan over the banked points refused with zero POSTs (insufficient_points)',
      greedy.ok === false && greedy.reason === 'insufficient_points'
        && greedy.availablePoints === 10000 && (await allocCount()) === beforeEmpty,
      JSON.stringify(greedy));

    // 409 self-heal: arm a one-shot bounce → chunk 1 dies → the engine pulls
    // fresh csrf/view from stats.php → retries the SAME chunk → succeeds.
    await mockState({ armStats409: '103' });
    const healed = await statsEngine.allocatePlan(unit2, { stamina: 105 }, { fastTest: true });
    st = await mockState();
    check('409 mid-plan → re-sync from stats.php → chunk retried and applied (stamina +105)',
      healed.ok === true && healed.applied === 105
        && healed.perStat[0].resyncs === 1 && healed.perStat[0].posts === 3
        && st.stats['103'].user.MAX_STAMINA === 7295 && st.stats['103'].user.STAT_POINTS === 9895,
      JSON.stringify({ healed, s103: st.stats && st.stats['103'] }));

    // Wire-level chunk decomposition: stamina=444 → exactly 16 whitelisted
    // POSTs (4×100 + 8×5 + 4×1), points drained, MAX_STAMINA grown.
    const before444 = await allocCount();
    const wired = await statsEngine.allocatePlan(unit2, { stamina: 444 }, { fastTest: true });
    st = await mockState();
    check('allocatePlan decomposes 444 into exactly 16 whitelisted chunks over the wire',
      wired.ok === true && wired.applied === 444
        && (await allocCount()) - before444 === 16
        && wired.perStat[0].chunks['100'] === 4 && wired.perStat[0].chunks['5'] === 8
        && wired.perStat[0].chunks['1'] === 4,
      JSON.stringify(wired));
    check('allocated stamina grows MAX_STAMINA (7190+105+444=7739) and drains points',
      st.stats['103'].user.MAX_STAMINA === 7739 && st.stats['103'].user.STAT_POINTS === 9451,
      JSON.stringify(st.stats && st.stats['103']));
    check('every stats_ajax POST carries action/stat/amount/csrf/view/request_id',
      st.lastAllocate && st.lastAllocate.action === 'allocate' && st.lastAllocate.stat === 'stamina'
        && ['100', '50', '5', '1'].includes(st.lastAllocate.amount)
        && !!st.lastAllocate.csrf && st.lastAllocate.view != null
        && /^[0-9a-f]{24}$/.test(st.lastAllocate.request_id || ''),
      JSON.stringify(st.lastAllocate));

    // Worker-level auto allocation (STAT_AUTO_ALLOCATE=1, STAT_PLAN=defense=444):
    // each worker runs the plan once its EXP poll sees enough banked points.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => a.stats && a.stats.allocations >= 1);
    }, 30000, 500, 'a worker auto-running the stat plan');
    const stA = await api('GET', '/api/status');
    const autoAcc = (stA.json.accounts || []).find((a) => a.stats && a.stats.allocations >= 1);
    check('auto-allocate ran the STAT_PLAN once per session (defense 10 → 454, points 9556)',
      autoAcc && autoAcc.stats.allocations === 1
        && autoAcc.stats.defense === 454 && autoAcc.stats.points === 9556,
      JSON.stringify(autoAcc && autoAcc.stats));

    // API-driven allocation on demand, targeting a specific account.
    const allocApi = await api('POST', '/api/stats/allocate', { accountId: acc1.id, plan: { attack: 105 } });
    check('POST /api/stats/allocate runs the plan on the chosen account (attack 10 → 115)',
      allocApi.status === 200 && allocApi.json.ok && allocApi.json.report.applied === 105
        && allocApi.json.report.attributes.attack === 115,
      JSON.stringify(allocApi.json));
    const statsApi = await api('GET', '/api/stats');
    const statsRow = (statsApi.json.accounts || []).find((a) => a.id === acc1.id);
    check('GET /api/stats exposes per-account points/attributes',
      statsApi.status === 200 && statsRow && statsRow.stats && statsRow.stats.attack === 115
        && statsRow.stats.points === 9451,
      JSON.stringify(statsRow));
    check('audit log records stat_allocation events',
      fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8').includes('"action":"stat_allocation"'), '');

    // ── 14) Boss spawn timers (Boss Tracker port): auto-summon cards,
    //        AUTO_DIE_CFG nextDieMs, phase math, phase gate + /api/spawns.
    const spawnEngine = require(path.join(ROOT, 'server', 'spawns'));
    const viewBattle = combat.viewBattle;
    const wave8Html = (await unit2.get('/active_wave.php?gate=3&wave=8', { redirect: 'manual' })).text;
    const summonCards = spawnEngine.parseAutoSummons(wave8Html);
    check('parseAutoSummons reads alive/next-ts/name/dieSec off the boss wave',
      summonCards.length === 2
        && summonCards[0].alive === true && summonCards[0].nextTs > 0
        && summonCards[0].dieSec === 48 * 3600
        && summonCards[0].monsterId === '9001'
        && summonCards[1].alive === false,
      JSON.stringify(summonCards));

    const skarnView = await viewBattle(unit2, '9001');
    const oceanusView = await viewBattle(unit2, '9005');
    check('battle.php embeds AUTO_DIE_CFG.nextDieMs (skarn 5h left → phase 2, oceanus 40h → phase 1)',
      skarnView.nextDieMs != null && skarnView.nextDieMs - Date.now() <= 6 * 3600 * 1000
        && oceanusView.nextDieMs != null && oceanusView.nextDieMs - Date.now() >= 39 * 3600 * 1000,
      JSON.stringify({ skarn: skarnView.nextDieMs, oceanus: oceanusView.nextDieMs }));
    check('phaseFromRemainingMs follows the tracker rule (24h threshold)',
      spawnEngine.phaseFromRemainingMs(5 * 3600 * 1000, 24) === 2
        && spawnEngine.phaseFromRemainingMs(40 * 3600 * 1000, 24) === 1
        && spawnEngine.phaseFromRemainingMs(0, 24) === 0, '');

    // The scout folded the peek views into its auto-summon scan → /api/spawns.
    await waitFor(async () => {
      const r = await api('GET', '/api/spawns');
      return r.status === 200 && (r.json.cards || []).length >= 3;
    }, 30000, 400, 'scout /api/spawns scan');
    const spawnsApi = await api('GET', '/api/spawns');
    const skarnRow = (spawnsApi.json.cards || []).find((c) => c.monsterId === '9001');
    const oceanusRow = (spawnsApi.json.cards || []).find((c) => c.monsterId === '9005');
    const drakRow = (spawnsApi.json.cards || []).find((c) => c.alive === false);
    check('GET /api/spawns exposes phase-annotated auto-summon cards (skarn 2 · oceanus 1 · a dead card)',
      spawnsApi.json.phaseGate === true
        && skarnRow && skarnRow.phase === 2
        && oceanusRow && oceanusRow.phase === 1
        && !!drakRow,
      JSON.stringify(spawnsApi.json.cards));

    // The published boss target carries the phase → the worker gate skips
    // phase-1 bosses (Boss Tracker's "phase 1 is exempt" rule).
    await waitFor(async () => {
      const r = await api('GET', '/api/targets');
      return r.json.bosses && r.json.bosses.gen && r.json.bosses.gen.spawnPhase != null;
    }, 30000, 400, 'published boss carries spawnPhase');
    const tgPhase = await api('GET', '/api/targets');
    check('published boss target carries spawnPhase (gen → 2)',
      tgPhase.json.bosses.gen && tgPhase.json.bosses.gen.spawnPhase === 2,
      JSON.stringify(tgPhase.json.bosses.gen));
    const { AccountWorker } = require(path.join(ROOT, 'server', 'workers'));
    const fakeWorker = Object.create(AccountWorker.prototype);
    fakeWorker.state = { level: 5001 };
    fakeWorker.cfg = { bossPhaseGate: true };
    fakeWorker.caps = { c3: { gen: { c: true, v: 900 } } };
    fakeWorker.bosses = [];
    fakeWorker.doneBossKeysThisCycle = new Set();
    const phase1Snap = { bosses: { gen: { monsterId: '9001', foundAt: Date.now(), spawnPhase: 1 } } };
    const phase2Snap = { bosses: { gen: { monsterId: '9001', foundAt: Date.now(), spawnPhase: 2 } } };
    check('pickBossTarget skips phase-1 bosses and takes phase-2 (Boss Tracker gate)',
      fakeWorker.pickBossTarget(phase1Snap) === null
        && fakeWorker.pickBossTarget(phase2Snap) !== null
        && (fakeWorker.cfg = { bossPhaseGate: false }, fakeWorker.pickBossTarget(phase1Snap) !== null),
      '');

    // ── 15) Reaction stamina farm (postreaction.php contract): discovery,
    //        csrf handshake, 'added', reacted_chap cookies, batch caps.
    const reactionEngine = require(path.join(ROOT, 'server', 'reactions'));
    const mangas = await reactionEngine.listMangas(unit2);
    check('reaction farm discovers the manga list (/ + /lastupdates.php)',
      mangas.length === 2 && mangas.every((m) => m.startsWith('/manga/')),
      JSON.stringify(mangas));
    const chapters = await reactionEngine.listChapters(unit2, mangas[0]);
    check('listChapters walks /manga/… and returns oldest chapter FIRST',
      chapters.length === 6 && /chapter=1$/.test(chapters[0]) && /chapter=6$/.test(chapters[5]),
      JSON.stringify(chapters));
    await mockState({ resetReactions: '103' });
    const firstReact = await reactionEngine.reactChapter(unit2, chapters[0], '1');
    check('reactChapter: comments_api csrf → POST postreaction.php → "added"',
      firstReact === 'added', JSON.stringify(firstReact));
    check('reactChapter persists reacted_chap_<id> in the account jar (restart-safe)',
      unit2.jar.get('reacted_chap_101') === '1', ''); // manga 1 · chapter 1 → id 101
    const repeatReact = await reactionEngine.reactChapter(unit2, chapters[0], '1');
    check('reactChapter skips the chapter the cookie already marks → "already"',
      repeatReact === 'already', JSON.stringify(repeatReact));
    const batch1 = await reactionEngine.staminaFarmBatch(unit2, { reaction: '1', batch: 4, counters: undefined, checkEvery: 5 });
    check('staminaFarmBatch lands exactly `batch` new reactions (4 added)',
      batch1.added === 4 && batch1.reacted >= 5, JSON.stringify(batch1));
    let stR = await mockState();
    check('postreaction.php carried chapterid/reaction/useruid/csrf (recorded by the mock)',
      stR.lastReaction && stR.lastReaction.chapterid != null && stR.lastReaction.reaction === '1'
        && !!stR.lastReaction.useruid && !!stR.lastReaction.csrf,
      JSON.stringify(stR.lastReaction));

    // ── 16) Potion shop buy-all (Veyra stamina buy-all): merchant → guild →
    //        Damon, gold budget shared in the extension's order. The merchant
    //        sweep is multi-kind (stamina/hp/mana — the ladders' stock); the
    //        legacy stamina-only mode is exercised first, then the full sweep.
    const shopEngine = require(path.join(ROOT, 'server', 'shop'));
    await mockState({ resetShops: '103' });
    const merchScanNarrow = await shopEngine.scanMerchant(unit2, 'stamina');
    check('scanMerchant kinds=stamina plans the gold budget (10× Small @100 = 1000 of 5000 gold)',
      merchScanNarrow.gold === 5000 && merchScanNarrow.lines.length === 1
        && merchScanNarrow.lines[0].qty === 10 && merchScanNarrow.lines[0].price === 100
        && merchScanNarrow.notes.some((n) => /gems/i.test(n)),
      JSON.stringify(merchScanNarrow));
    const merchScan = await shopEngine.scanMerchant(unit2);
    check('scanMerchant default kinds = stamina+hp+mana (the ladders\' stock; egg/gem rows skipped)',
      merchScan.lines.length === 3
        && merchScan.lines[0].kind === 'stamina' && merchScan.lines[0].qty === 10
        && merchScan.lines[1].kind === 'hp' && merchScan.lines[1].qty === 1
        && merchScan.lines[2].kind === 'mana' && merchScan.lines[2].qty === 10
        && shopEngine.kindOf('Fenrir Egg') === null && shopEngine.kindOf('Full Hp Potion') === 'hp',
      JSON.stringify(merchScan));
    const buyAll = await shopEngine.buyAllStaminaPotions(unit2, { fastTest: true, kinds: 'stamina' });
    check('buyAllStaminaPotions (stamina only) sweeps merchant (10) → guild (5) → Damon (16 within leftover gold)',
      buyAll.merchant.bought === 10 && buyAll.guild.bought === 5 && buyAll.damon.bought === 16
        && buyAll.bought === 31 && buyAll.spent === 1000 + 750 + 16 * 250,
      JSON.stringify(buyAll));
    stR = await mockState();
    check('merchant_buy.php wire: merch_id=301 qty=10 (the game\'s own purchase request)',
      stR.lastMerchantBuy && stR.lastMerchantBuy.merch_id === '301' && stR.lastMerchantBuy.qty === '10',
      JSON.stringify(stR.lastMerchantBuy));
    check('adventurers_shop_buy.php bought 5 one-per-request (status ok, points 2000→1250)',
      stR.guildBought['103'] === 5 && stR.lastGuildBuy.shop_item_id === '501'
        && stR.guildPoints['103'] === 1250,
      JSON.stringify({ last: stR.lastGuildBuy, pts: stR.guildPoints }));
    check('olympus_damon_buy.php POST offer/qty=16 and Damon state shows 16/20 bought',
      stR.lastDamonBuy && stR.lastDamonBuy.offer === 'damon-lsp' && stR.lastDamonBuy.qty === '16'
        && stR.damonBought['103'] === 16 && stR.gold['103'] === 5000 - 1000 - 16 * 250,
      JSON.stringify({ last: stR.lastDamonBuy, gold: stR.gold }));
    // Multi-kind sweep with real gold: stamina drains first, then the HP and
    // mana rows are re-aimed at the RUNNING budget (the page snapshot goes
    // stale), the egg row is never bought.
    await mockState({ resetShops: '103' });
    await mockState({ uid: '103', gold: 40000 });
    const buyMulti = await shopEngine.buyAllStaminaPotions(unit2, { fastTest: true });
    check('multi-kind sweep: stamina 10×100 + hp 7×5000 + mana 8×500 within 40000 gold (egg untouched)',
      buyMulti.merchant.bought === 10 + 7 + 8 && buyMulti.merchant.spent === 40000,
      JSON.stringify(buyMulti));
    stR = await mockState();
    check('multi-kind sweep wire: the last merchant POST is the mana row (303 × 8)',
      stR.lastMerchantBuy && stR.lastMerchantBuy.merch_id === '303' && stR.lastMerchantBuy.qty === '8',
      JSON.stringify(stR.lastMerchantBuy));
    check('multi-kind gold math: 40000 − 1000 − 35000 − 4000 = 0 left',
      stR.gold['103'] === 0, JSON.stringify(stR.gold));
    const buyApi = await api('POST', '/api/shop/stamina', { accountId: acc1.id });
    check('POST /api/shop/stamina runs the multi-kind buy-all on the chosen account (uid 101 shops)',
      buyApi.status === 200 && buyApi.json.ok && buyApi.json.bought === 10 + 8 + 5,
      JSON.stringify(buyApi.json));
    const buyStatus = await api('GET', '/api/status');
    const buyAcc = (buyStatus.json.accounts || []).find((a) => a.id === acc1.id);
    check('status exposes purchases/potionsBought after the API buy-all',
      buyAcc && buyAcc.purchases >= 1 && buyAcc.potionsBought >= 23,
      JSON.stringify(buyAcc && { p: buyAcc.purchases, b: buyAcc.potionsBought }));

    // ── 17) Dead-boss corpse sweep (LevelUp Looter + Veyra dead bosses +
    //        Quick Loot): show_dead_bosses_only view, dead_page pagination,
    //        data-userdmg gate, loot.php {monster_id, dgmid, instance_id:'0'},
    //        EXP Cap/EXP-DMG ordering, skippable failures, stop-at-level.
    const corpseEngine = require(path.join(ROOT, 'server', 'corpses'));
    const pagerHtml = (await unit2.get('/active_wave.php?gate=3&wave=5', { redirect: 'manual' })).text;
    check('parseDeadPages reads the batch-loot-card pager (Dead loot page 1 / 2)',
      corpseEngine.parseDeadPages(pagerHtml) === 2, (pagerHtml.match(/batch-loot-card[^<]*/i) || [''])[0]);
    unit2.jar.set('show_dead_bosses_only', '1');
    const corpseHtml = (await unit2.get('/active_wave.php?gate=3&wave=5', { redirect: 'manual' })).text;
    const page2Html = (await unit2.get('/active_wave.php?gate=3&wave=5&dead_page=2', { redirect: 'manual' })).text;
    unit2.jar.map.delete('show_dead_bosses_only');
    const corpseList = corpseEngine.parseCorpses(corpseHtml);
    check('parseCorpses reads lootable dead rows (bone shooter, damage 12,000)',
      corpseList.some((c) => c.id === '8305' && c.damage === 12000),
      JSON.stringify(corpseList));
    const corpseList2 = corpseEngine.parseCorpses(page2Html);
    check('dead_page=2 serves the SECOND corpse page (dust archer, damage 8,000)',
      corpseList2.length === 1 && corpseList2[0].id === '8325' && corpseList2[0].damage === 8000,
      JSON.stringify(corpseList2));
    const oneLoot = await corpseEngine.lootCorpse(unit2, '103', '8305');
    check('lootCorpse POSTs loot.php {monster_id, dgmid, user_id, instance_id:0} → rewards.exp',
      oneLoot.ok === true && oneLoot.exp === 500 && /500 EXP/.test(oneLoot.message),
      JSON.stringify(oneLoot));
    // EXP ordering: shade husk (cap 5000 → 100 EXP) sorts before bone shooter
    // (cap 1500 → 30 EXP); the sweep stops once the 120-EXP gap is covered.
    const ordered = [
      { id: '8305', name: 'bone shooter', damage: 12000 },
      { id: '8511', name: 'shade husk', damage: 9000 },
    ];
    await corpseEngine.annotateExpectedExp(unit2, ordered);
    check('annotateExpectedExp reads EXP Cap × EXP/DMG off the battle pages (min(dmg,cap)×rate)',
      ordered[0].id === '8511' && ordered[0].expectedExp === 100 && ordered[1].expectedExp === 30,
      JSON.stringify(ordered));
    const sweepRes = await corpseEngine.lootCorpses(unit2, '103', ordered, {
      maxLoot: 10, requiredExp: 120, fastTest: true,
    });
    check('lootCorpses loots BEST-EXP FIRST and stops once the EXP gap is covered',
      sweepRes.looted === 1 && sweepRes.expGained >= 120 && sweepRes.leveledUp === true,
      JSON.stringify(sweepRes));
    // Worker level: the mock's EXP bar reads 90% (≥ CORPSE_EXP_NEAR_PCT 80)
    // → every healthy worker sweeps corpses every cycle.
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => a.corpseSweeps >= 1 && a.corpsesLooted >= 1);
    }, 40000, 500, 'a worker corpse sweep');
    const sweepStatus = await api('GET', '/api/status');
    const sweepAcc = (sweepStatus.json.accounts || []).find((a) => a.corpseSweeps >= 1);
    check('workers sweep corpses near level-up (status corpseSweeps/corpsesLooted)',
      sweepAcc && sweepAcc.corpsesLooted >= 1, JSON.stringify({ s: sweepAcc.corpseSweeps, l: sweepAcc.corpsesLooted }));
    check('audit log records corpse_sweep events',
      fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8').includes('"action":"corpse_sweep"'), '');

    // ── 18) Guild dungeon farm (DungeonCleaner + LevelUp Looter): named hub
    //        cards → FIXED rosters → .mon pill parsing (joined/looted) →
    //        loot DEAD_LOOTABLE corpses (bosses EXP-ranked) → join → Slash.
    const dungeonEngine = require(path.join(ROOT, 'server', 'dungeons'));
    const instances = await dungeonEngine.discoverInstances(unit2);
    check('discoverInstances reads the NAMED hub cards (301 easy · 302 hard · 303 poly active, 205 ended easy) + the cube card, kind ids captured',
      instances.length === 5
        && instances.some((i) => i.id === '301' && i.dungeonKey === 'easy' && !i.ended && i.kindId === '1')
        && instances.some((i) => i.id === '302' && i.dungeonKey === 'hard' && i.kindId === '2')
        && instances.some((i) => i.id === '303' && i.dungeonKey === 'poly' && i.kindId === '3')
        && instances.some((i) => i.id === '205' && i.ended === true && i.kindId === '1')
        && instances.some((i) => i.id === '310' && i.type === 'cube' && /cube/i.test(i.name)),
      JSON.stringify(instances));
    const easyInst = instances.find((i) => i.id === '301');
    const locs = await dungeonEngine.resolveLocations(unit2, easyInst);
    check('named rosters give the fixed floors (easy: mob locs 1-4 + boss room 5)',
      locs.length === 5 && locs[0].locationId === '1' && locs[4].locationId === '5' && locs[4].kind === 'boss',
      JSON.stringify(locs));
    const scan1 = await dungeonEngine.scanLocation(unit2, locs[0]);
    const floorMobs = scan1.mobs;
    check('pill parsing: 701 ALIVE_UNJOINED · 702 DEAD_LOOTABLE · 703 DEAD_LOOTED (skipped)',
      floorMobs.length === 3
        && floorMobs[0].category === 'ALIVE_UNJOINED'
        && floorMobs[1].dgmid === '702' && floorMobs[1].category === 'DEAD_LOOTABLE' && floorMobs[1].lootable
        && floorMobs[2].dgmid === '703' && floorMobs[2].category === 'DEAD_LOOTED' && !floorMobs[2].lootable,
      JSON.stringify(floorMobs.map((m) => ({ dgmid: m.dgmid, cat: m.category }))));
    const bossScan = await dungeonEngine.scanLocation(unit2, locs[4]);
    const bossFloor = bossScan.mobs;
    check('boss floor: prince grixkar the hybrid reads DEAD_LOOTABLE (damage available)',
      bossFloor.length === 1 && bossFloor[0].dgmid === '710' && bossFloor[0].category === 'DEAD_LOOTABLE'
        && bossFloor[0].name === 'prince grixkar the hybrid',
      JSON.stringify(bossFloor));
    const bossDmg = await dungeonEngine.fetchBossDamage(unit2, '301', '710');
    check('fetchBossDamage reads #yourDamageValue off battle.php?dgmid= (50,000)',
      bossDmg === 50000, String(bossDmg));
    check('expectedBossExp = min(damage, dmgLimit) × ratio (grixkar 0.01 → 500; card EXP/dmg overrides)',
      dungeonEngine.expectedBossExp('prince grixkar the hybrid', 50000) === 500
        && dungeonEngine.expectedBossExp('unknown boss', 50000) === 500
        && dungeonEngine.expectedBossExp('unknown boss', 50000, 0.0113) === 565,
      '');
    // ── guild code verification (the panel's guild code field) ──────────
    // Own client + own uid (104) so the runs below never consume unit2's
    // dungeon world (mock dungeon state is per-session, like the live game).
    const unitG = new GameClient({
      gameBase: `http://127.0.0.1:${MOCK_PORT}`,
      jar: new CookieJar(),
      cfg: { requestTimeoutMs: 5000, jitterScale: 1, fastTest: true, waveHitDelayMs: 40, paceMinMs: 10, paceMaxMs: 30 },
      label: 'unit-guild',
    });
    await auth.login(unitG, 'guild.tester@example.com', 'guildpass1');
    const hubText = (await unitG.get('/guild_dungeon.php', { redirect: 'manual' })).text;
    check('the dungeon hub embeds the caller\'s guild (guildId = 32) — parsed off the page we already fetched',
      dungeonEngine.parseGuildId(hubText) === '32', String(dungeonEngine.parseGuildId(hubText)));
    const ownGuild = await dungeonEngine.fetchOwnGuild(unitG);
    check('fetchOwnGuild reads tag + name off guild_dash.php ([ MOCK ] Mock Guild)',
      ownGuild && ownGuild.id === '32' && ownGuild.tag === 'MOCK' && ownGuild.name === 'Mock Guild',
      JSON.stringify(ownGuild));
    const okById = await dungeonEngine.dungeonCycle(unitG, { userId: '104', maxMobs: 6, guildCode: '32' });
    check('guild code "32" (id, numeric fast path) verifies off the hub and the cycle runs',
      okById.guildOk === true && okById.stopped !== 'GUILD_MISMATCH' && okById.instances >= 1,
      JSON.stringify({ ok: okById.guildOk, stopped: okById.stopped, inst: okById.instances }));
    const okByTag = await dungeonEngine.dungeonCycle(unitG, { userId: '104', maxMobs: 6, guildCode: '[MOCK]', guild: ownGuild });
    check('guild code "[MOCK]" (tag, cached identity) verifies and runs',
      okByTag.guildOk === true && okByTag.stopped !== 'GUILD_MISMATCH',
      JSON.stringify({ ok: okByTag.guildOk, stopped: okByTag.stopped }));
    const wrongGuild = await dungeonEngine.dungeonCycle(unitG, { userId: '104', maxMobs: 6, guildCode: 'WRONG' });
    check('guild code "WRONG" refuses: GUILD_MISMATCH, zero instances, zero fights — no other guild\'s mobs are touched',
      wrongGuild.stopped === 'GUILD_MISMATCH' && wrongGuild.guildOk === false
        && wrongGuild.instances === 0 && wrongGuild.fights.length === 0
        && wrongGuild.notes.some((n) => /does not match/.test(n)),
      JSON.stringify(wrongGuild));
    // ── multi-guild: friends on OTHER guilds get the same treatment ──────
    // A second account whose session belongs to Veyra Vanguard (#41): the
    // engine scans THEIR guild off the same pages, verifies THEIR code and
    // farms their own guild's dungeon world — never anyone else's.
    const friendG = new GameClient({
      gameBase: `http://127.0.0.1:${MOCK_PORT}`,
      jar: new CookieJar(),
      cfg: { requestTimeoutMs: 5000, jitterScale: 1, fastTest: true, waveHitDelayMs: 40, paceMinMs: 10, paceMaxMs: 30 },
      label: 'unit-friend',
    });
    await auth.login(friendG, 'friend.tester@example.com', 'friendpass1');
    const friendGuild = await dungeonEngine.fetchOwnGuild(friendG);
    check('fetchOwnGuild scans a DIFFERENT-guild account (Veyra Vanguard #41) off the same pages',
      friendGuild && friendGuild.id === '41' && friendGuild.tag === 'VEYRA' && friendGuild.name === 'Veyra Vanguard',
      JSON.stringify(friendGuild));
    const friendOk = await dungeonEngine.dungeonCycle(friendG, { userId: '105', maxMobs: 6, guildCode: 'Veyra Vanguard' });
    check('the friend\'s own guild code ("Veyra Vanguard") verifies and the cycle runs on their session',
      friendOk.guildOk === true && friendOk.instances >= 1 && friendOk.stopped !== 'GUILD_MISMATCH',
      JSON.stringify({ ok: friendOk.guildOk, stopped: friendOk.stopped, inst: friendOk.instances }));
    const friendWrong = await dungeonEngine.dungeonCycle(friendG, { userId: '105', maxMobs: 6, guildCode: '32' });
    check('a code for ANOTHER guild ("32") refuses on the friend\'s session: GUILD_MISMATCH, zero fights',
      friendWrong.stopped === 'GUILD_MISMATCH' && friendWrong.guildOk === false && friendWrong.fights.length === 0,
      JSON.stringify({ stopped: friendWrong.stopped, ok: friendWrong.guildOk, fights: friendWrong.fights.length }));
    const friendNoCode = await dungeonEngine.dungeonCycle(friendG, { userId: '105', maxMobs: 6 });
    check('NO guild code at all: the friend still farms their own guild (the hub only lists their guild\'s runs)',
      friendNoCode.stopped !== 'GUILD_MISMATCH' && friendNoCode.instances >= 1,
      JSON.stringify({ stopped: friendNoCode.stopped, inst: friendNoCode.instances }));
    const joined = await dungeonEngine.joinDungeonMob(unit2, floorMobs[0]);
    check('joinDungeonMob POSTs dungeon_join_battle.php {instance_id, dgmid}',
      joined === true, '');
    const hit1 = await dungeonEngine.dungeonHit(unit2, floorMobs[0]);
    const hit2 = await dungeonEngine.dungeonHit(unit2, floorMobs[0]);
    const hit3 = await dungeonEngine.dungeonHit(unit2, floorMobs[0]);
    check('dungeonHit Slashes cost 1 stamina and the 300 HP mob dies on hit 3 (MOB_DEAD)',
      hit1.outcome === 'HIT' && hit1.damage === 150 && hit3.outcome === 'MOB_DEAD',
      JSON.stringify([hit1.outcome, hit2.outcome, hit3.outcome]));
    stR = await mockState();
    check('dungeon damage.php wire: instance_id/dgmid/skill_id=0/stamina_cost=1',
      stR.lastDungeonDamage['103'] && stR.lastDungeonDamage['103'].dgmid === '701'
        && stR.lastDungeonDamage['103'].skill_id === '0'
        && stR.lastDungeonDamage['103'].stamina_cost === '1',
      JSON.stringify(stR.lastDungeonDamage));
    // ── per-mob damage floor (the guild contracts' "min 3m dmg" rule) ────
    // A kill only counts when the mob died with ≥ the floor of OUR damage.
    // The cycle takes minDamageFor(name): mobs whose MAX HP can never reach
    // the floor are skipped BEFORE any stamina is spent (the kill could not
    // count), and every fight reports floorMet. A GLOBAL 3m floor (like
    // MOB_MIN_DAMAGE=3000000): the 8M HP shadowclaw is farmed to death, the
    // 300/450 HP mobs on every later floor are skipped without a hit.
    const floorCycle = await dungeonEngine.dungeonCycle(unit2, {
      userId: '103', maxMobs: 3, fastTest: true,
      minDamageFor: () => 3000000,
    });
    check('per-mob floor: the 8M HP shadowclaw is fought to death WITH floorMet (8,000,000 dmg); every below-floor mob is SKIPPED before any stamina (runt 706, vizier 711 on both its mob+boss passes, sentry 712, warden 730)',
      floorCycle.flooredSkipped === 5
        && floorCycle.fights.length === 1
        && floorCycle.fights[0].dgmid === '705' && floorCycle.fights[0].outcome === 'MOB_DEAD'
        && floorCycle.fights[0].floorMet === true && floorCycle.fights[0].damage >= 3000000
        && floorCycle.notes.some((n) => /lizardman runt/.test(n) && /below the 3,000,000 dmg floor/.test(n))
        && floorCycle.notes.some((n) => /the goblin royal vizier/.test(n)),
      JSON.stringify({ skipped: floorCycle.flooredSkipped, fights: floorCycle.fights, notes: floorCycle.notes }));
    const dCycle = await dungeonEngine.dungeonCycle(unit2, { userId: '103', maxMobs: 4, fastTest: true });
    check('dungeonCycle sweeps named dungeons + the CUBE: 21 floors visited — the floor call only killed 705, so the runt 706 · vizier 711 · sentry 712 · cube warden 730 are all fought now',
      dCycle.instances === 4 && dCycle.locations === 21
        && dCycle.fights.length === 4 && dCycle.fights.every((f) => f.outcome === 'MOB_DEAD')
        && dCycle.fights.some((f) => f.dgmid === '706') && dCycle.fights.some((f) => f.dgmid === '711')
        && dCycle.fights.some((f) => f.dgmid === '712') && dCycle.fights.some((f) => f.dgmid === '730')
        && dCycle.cubeSkipped === 0,
      JSON.stringify(dCycle));
    check('dungeonCycle SKIPS ended runs (205 "awaiting leader/vice to loot" — locked for members): endedSkipped=1, never walked',
      dCycle.endedSkipped === 1 && dCycle.notes.some((n) => /skipped 1 ended run/.test(n) && /#205/.test(n)),
      JSON.stringify({ skipped: dCycle.endedSkipped, notes: dCycle.notes }));
    stR = await mockState();
    check('the cube dungeon was farmed through the REAL flow: enter_node POSTed for node 2 (front face) before its floor was touched',
      stR.lastCubeAction && stR.lastCubeAction['103']
        && stR.lastCubeAction['103'].instance_id === '310'
        && stR.lastCubeAction['103'].node_id === '2'
        && stR.lastCubeAction['103'].face_key === 'front',
      JSON.stringify(stR.lastCubeAction));
    check('the cube warden (dgmid 730, instance 310) was joined, slashed and killed — cube tripwire fires',
      stR.cubeTouched === true
        && stR.lastDungeonDamage['103'] && stR.lastDungeonDamage['103'].dgmid === '730'
        && stR.lastDungeonDamage['103'].instance_id === '310',
      JSON.stringify({ touched: stR.cubeTouched, dmg: stR.lastDungeonDamage && stR.lastDungeonDamage['103'] }));
    check('dungeon_loot.php wire: {instance_id, dgmid, user_id} (per-uid record — workers loot concurrently)',
      stR.lastDungeonLoot && stR.lastDungeonLoot['103'] && stR.lastDungeonLoot['103'].user_id === '103'
        && ['701', '702', '710', '705'].includes(stR.lastDungeonLoot['103'].dgmid)
        && stR.lastDungeonLoot['103'].instance_id === '301',
      JSON.stringify(stR.lastDungeonLoot));
    await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).some((a) => a.dungeonRounds >= 1);
    }, 40000, 500, 'a worker dungeon round');
    const dStatus = await api('GET', '/api/status');
    const dAcc = (dStatus.json.accounts || []).find((a) => a.dungeonRounds >= 1);
    check('workers farm dungeons alongside the waves (status dungeonRounds)',
      dAcc && dAcc.dungeonRounds >= 1, JSON.stringify({ r: dAcc.dungeonRounds }));
    const gAcc = (dStatus.json.accounts || []).find((a) => a.guildCode === '[MOCK]');
    check('the guild-coded worker verified its guild in-game (status.guild: [MOCK] Mock Guild #32, verified ✓)',
      gAcc && gAcc.guild && gAcc.guild.tag === 'MOCK' && gAcc.guild.id === '32' && gAcc.guild.verified === true,
      JSON.stringify(gAcc && gAcc.guild));
    check('audit log records dungeon_round events',
      fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8').includes('"action":"dungeon_round"'), '');

    // ── 19) Mana vitals + the Veyra targets allocator.
    check('scanVitals reads #pManaText off the battle page (200/1200)',
      unit2.lastMana && unit2.lastMana.cur === 200 && unit2.lastMana.max === 1200,
      JSON.stringify(unit2.lastMana));
    const manaCard = combat.choosePotion(skarnView.potions, ['mana potion s']);
    const manaDrank = await combat.drinkManaPotion(unit2, skarnView.potions);
    stR = await mockState();
    check('drinkManaPotion picks Mana Potion S from the drawer (inv 22313874)',
      manaCard && manaCard.invId === '22313874' && manaDrank === true
        && stR.useItemByInv && stR.useItemByInv['22313874']
        && stR.useItemByInv['22313874'].inv_id === '22313874',
      JSON.stringify(stR.useItemByInv));
    check('normalizeState maps the Veyra core shape onto the user shape',
      (() => {
        const s = statsEngine.normalizeState({ core: { points: '500', attack: '11', defense: '12', stamina: '7,000' } });
        return s.user.STAT_POINTS === 500 && s.user.ATTACK === 11 && s.user.MAX_STAMINA === 7000;
      })(), '');
    // unit2 (uid 103) still has ATTACK 10 — target 110 lands as ONE 100-chunk.
    const targetsReport = await statsEngine.allocateTargets(unit2, { attack: 110 }, { fastTest: true });
    stR = await mockState();
    check('allocateTargets spends banked points up to the target (attack 10 → 110 in one 100-chunk)',
      targetsReport.ok === true && targetsReport.reason === 'targets_reached'
        && targetsReport.applied === 100 && targetsReport.attributes.attack === 110
        && targetsReport.posts === 1,
      JSON.stringify(targetsReport));
    const drainedReport = await statsEngine.allocateTargets(unit2, { stamina: 999999 }, { fastTest: true });
    check('allocateTargets drains the banked points and stops cleanly (points_drained)',
      drainedReport.ok === true && drainedReport.reason === 'points_drained'
        && drainedReport.pointsLeft === 0,
      JSON.stringify({ reason: drainedReport.reason, left: drainedReport.pointsLeft }));
    const targetsApi = await api('POST', '/api/stats/allocate', { accountId: acc1.id, targets: { attack: 116 } });
    check('POST /api/stats/allocate {targets} runs the targets allocator on the account',
      targetsApi.status === 200 && targetsApi.json.ok && targetsApi.json.report.mode === 'targets'
        && targetsApi.json.report.attributes.attack === 116,
      JSON.stringify(targetsApi.json));

    // ── 20) LevelUp Looter extras: EXP stat blocks on battle pages and the
    //        auto-battle potion-cap raise (Max Large/Full Stamina Potions).
    check('parseBattleView reads the EXP stat blocks (cap 1,500 · rate 0.02)',
      skarnView.expCap === 1500 && skarnView.expRate === 0.02,
      JSON.stringify({ cap: skarnView.expCap, rate: skarnView.expRate }));
    const raiseLsp = await shopEngine.raiseAutoBattlePotionCap(unit2, 'lsp', 5, 'gate=3&wave=8');
    stR = await mockState();
    check('raiseAutoBattlePotionCap bumps Max Large Stamina Potions 50 → 55 via the wave-page form',
      raiseLsp.ok === true && raiseLsp.from === 50 && raiseLsp.to === 55
        && stR.lastPotionSetting && stR.lastPotionSetting.max_lsp === '55'
        && stR.lastPotionSetting.af_nonce === 'w1',
      JSON.stringify({ raise: raiseLsp, saved: stR.lastPotionSetting }));
    const raiseFsp = await shopEngine.raiseAutoBattlePotionCap(unit2, 'fsp', 5, 'gate=3&wave=8');
    stR = await mockState();
    check('raiseAutoBattlePotionCap targets the FSP row independently (20 → 25)',
      raiseFsp.ok === true && raiseFsp.from === 20 && raiseFsp.to === 25
        && stR.lastPotionSetting && stR.lastPotionSetting.max_fsp === '25',
      JSON.stringify({ raise: raiseFsp, saved: stR.lastPotionSetting }));

    // ── 21) Divers: fleet hunt ("attack all X") + gear keep-up (equip-best
    //        + blacksmith). POST /api/hunt arms EVERY account with the same
    //        dive targets, live — the workers then bus-dive the matching
    //        live mob ids the scout broadcasts (join + slash), keep hunting
    //        them on their pinned waves, and the gear rounds wear upgrades
    //        and forge craftable recipes. The target is the FLEET DRONE on
    //        wave 8 — it RESPAWNS with a new instance id after every kill
    //        (the real game's mob churn), so the dive volley always has a
    //        live target no matter which wave round killed the last one.
    await mockState({ resetMobs: true });
    const armedAt = Date.now();
    const huntGo = await api('POST', '/api/hunt', { mob: 'fleet drone' });
    check('POST /api/hunt arms every account with the fleet target ("attack all fleet drone")',
      huntGo.status === 200 && huntGo.json.ok && huntGo.json.updated >= 2 && huntGo.json.mob === 'fleet drone',
      JSON.stringify(huntGo.json));
    const huntView = await api('GET', '/api/hunt');
    check('GET /api/hunt shows the unified fleet target + per-account rows',
      huntView.status === 200 && huntView.json.mob === 'fleet drone'
        && (huntView.json.perAccount || []).length >= 2
        && huntView.json.perAccount.every((a) => a.diveTargets === 'fleet drone'),
      JSON.stringify(huntView.json));
    // The next worker cycles bus-dive the drone ids the scout publishes: at
    // least one account fires a volley, and a live drone instance is joined.
    const dived = await waitFor(async () => {
      const s = await api('GET', '/api/status');
      return (s.json.accounts || []).find((a) => a.diveBus && a.diveBus.attacked >= 1);
    }, 45000, 500, 'fleet bus dive');
    check('a worker bus-dived the fleet target (telemetry shows the volley)',
      !!dived, JSON.stringify(dived && dived.diveBus));
    check('the bus dive volley carried the fleet drone',
      !!(dived && dived.diveBus.lastTargets && dived.diveBus.lastTargets.join(' ').includes('fleet drone')),
      JSON.stringify(dived && dived.diveBus.lastTargets));
    await waitFor(async () => {
      const s = await mockState();
      return (s.fleetJoins || []).some((j) => j.at >= armedAt - 1500);
    }, 45000, 500, 'fleet join of a live drone instance');
    stR = await mockState();
    const fleetJoin = (stR.fleetJoins || []).filter((j) => j.at >= armedAt - 1500);
    check('the fleet joined live drone instances through user_join_battle.php (timestamped proof)',
      fleetJoin.length >= 1, JSON.stringify({ joins: fleetJoin.length, last: fleetJoin.slice(-3) }));
    const huntStop = await api('DELETE', '/api/hunt');
    check('DELETE /api/hunt stands the fleet down (targets cleared live)',
      huntStop.status === 200 && huntStop.json.ok && huntStop.json.mob === null && huntStop.json.updated >= 2,
      JSON.stringify(huntStop.json));
    const huntView2 = await api('GET', '/api/hunt');
    check('GET /api/hunt after the clear shows no fleet target', huntView2.json.mob === null, JSON.stringify(huntView2.json));

    // ── Gear keep-up: equip-best + blacksmith at MODULE level on the
    //    dedicated test client (uid 103 — the farm's own workers run the
    //    same rounds on their accounts in the background, so API assertions
    //    stay smoke-level below). The mock bag carries Mock Steel Sword
    //    (atk 40) over the worn Mock Rusty Sword (atk 5), plus boots + ring
    //    with empty slots.
    const equipEngine = require(path.join(ROOT, 'server', 'equip'));
    const blacksmithEngine = require(path.join(ROOT, 'server', 'blacksmith'));
    await mockState({ resetGear: '103' });
    const gearRun1 = await equipEngine.equipBest(unit2, { set: 'attack' });
    check('equipBest wears every strictly-better bag item (weapon + boots + ring)',
      gearRun1.ok && gearRun1.equipped === 3
        && gearRun1.improved.some((i) => i.slot === 'weapon' && /Mock Steel Sword/.test(i.to))
        && gearRun1.improved.some((i) => i.slot === 'boots') && gearRun1.improved.some((i) => i.slot === 'ring'),
      JSON.stringify(gearRun1));
    stR = await mockState();
    check('inventory_ajax.php wire: equip_item inv_id + slot_id=0 + set=attack → OK',
      stR.lastEquipPost && stR.lastEquipPost.uid === '103' && stR.lastEquipPost.action === 'equip_item'
        && stR.lastEquipPost.slot_id === '0' && stR.lastEquipPost.set === 'attack',
      JSON.stringify(stR.lastEquipPost));
    check('the weapon slot now wears Mock Steel Sword (mock state)',
      stR.equipped['103'] && stR.equipped['103']['1'] === 'Mock Steel Sword',
      JSON.stringify(stR.equipped['103']));
    const gearRun2 = await equipEngine.equipBest(unit2, { set: 'attack' });
    check('equipBest is idempotent (the worn set is already the best → zero equips)',
      gearRun2.ok && gearRun2.equipped === 0, JSON.stringify(gearRun2));

    // blacksmith: recipe 601 (Mock Ember Blade atk 77) is craftable, 602 has
    // its Forge disabled (materials missing), 603 is craftable-but-weak —
    // the crafter forges both craftable ones, strongest first.
    const smithRun = await blacksmithEngine.blacksmithRound(unit2, { maxCrafts: 4 });
    check('blacksmithRound forges the craftable recipes, strongest first (disabled 602 never POSTed)',
      smithRun.scanned >= 3 && smithRun.craftable === 2 && smithRun.crafted.length === 2
        && smithRun.crafted[0].name === 'Mock Ember Blade' && smithRun.crafted[1].name === 'Mock Ember Band',
      JSON.stringify({ scanned: smithRun.scanned, craftable: smithRun.craftable, crafted: smithRun.crafted }));
    stR = await mockState();
    check('craft_item.php wire: recipe_id POSTed per craft; the Forge-disabled 602 never touched',
      stR.lastCraftPost && stR.lastCraftPost.uid === '103'
        && (stR.crafts['103'] || []).length === 2
        && (stR.crafts['103'] || []).every((c) => c.id !== '602'),
      JSON.stringify(stR.lastCraftPost));
    // The forged blades joined the bag → the next equip-best wears the 77-atk one.
    const gearRun3 = await equipEngine.equipBest(unit2, { set: 'attack' });
    check('the forged Mock Ember Blade (atk 77) is worn by the next equip-best',
      gearRun3.ok && gearRun3.equipped >= 1
        && gearRun3.improved.some((i) => i.slot === 'weapon' && /Mock Ember Blade/.test(i.to)),
      JSON.stringify(gearRun3));

    // API smoke: the panel endpoints run the same rounds on demand (the
    // workers may already have equipped/forged, so only shape is asserted).
    const equipApi = await api('POST', '/api/equip', { accountId: acc1.id });
    check('POST /api/equip runs equip-best on the chosen account (ok, attack set)',
      equipApi.status === 200 && equipApi.json.ok && equipApi.json.set === 'attack',
      JSON.stringify(equipApi.json));
    const craftApi = await api('POST', '/api/blacksmith/craft', { accountId: acc1.id });
    check('POST /api/blacksmith/craft sweeps the gates on the chosen account (scanned ≥ 3)',
      craftApi.status === 200 && craftApi.json.scanned >= 3, JSON.stringify(craftApi.json));
  } finally {
    farm.kill('SIGTERM');
    mock.kill('SIGTERM');
    await sleep(300);
    farm.kill('SIGKILL');
    mock.kill('SIGKILL');
  }

  console.log('─'.repeat(60));
  if (failures) {
    console.log(`✖ ${failures} check(s) failed — farm log tail:`);
    console.log(farmLog.split('\n').slice(-25).join('\n'));
    process.exit(1);
  } else {
    console.log('✔ all checks passed — engine speaks the game protocol end-to-end');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('test crashed:', e);
  console.error('farm log tail:');
  console.error(farmLog.split('\n').slice(-400).join('\n'));
  process.exit(1);
});
