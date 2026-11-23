'use strict';
// multisite-test.js — two game sites, one farm, everything running at once.
//
// Boots TWO mock game servers (stand-ins for demonicscans.org and
// veyragame.com) plus one farm. Proves: sites start independently (Veyra only
// when it gets its first account), accounts on both sites log in and farm in
// parallel, each site has its own fetcher + target bus, the same login can
// exist on both sites as two separate accounts, and nothing about the hidden
// fetchers leaks.
//
// Run: node test/multisite-test.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MOCK_A = 8981; // "demonic"
const MOCK_B = 8982; // "veyra"
const FARM_PORT = 8983;
const DATA_DIR = path.join(ROOT, 'tmp-test-data-multi');
let token = null;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function api(method, pathName, body) {
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
    GAME_BASE: `http://127.0.0.1:${MOCK_A}`,
    VEYRA_BASE: `http://127.0.0.1:${MOCK_B}`,
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'panel-pass-12345',
    AIO_SECRET_KEY: 'test-secret-key-0123456789abcdef0123456789abcdef',
    ADMIN_GAME_EMAIL: 'fetcher@test.invalid', ADMIN_GAME_PASSWORD: 'fetcher@test.invalid',
    DATA_DIR, FAST_TEST: '1', SCOUT_INTERVAL_MS: '2500', LOGIN_STAGGER_MS: '200',
    RELOGIN_COOLDOWN_MS: '2500', MOB_DAMAGE_CAP: '1200', WAVE_MOBS_PER_ROUND: '3', LOG_LEVEL: 'info',
  };
  const mockA = spawn('node', [path.join(__dirname, 'mock-game.js'), String(MOCK_A)], { stdio: 'pipe' });
  const mockB = spawn('node', [path.join(__dirname, 'mock-game.js'), String(MOCK_B)], { stdio: 'pipe' });
  const farm = spawn('node', [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'pipe' });
  let farmLog = '';
  farm.stdout.on('data', (d) => { farmLog += d; });
  farm.stderr.on('data', (d) => { farmLog += d; });

  try {
    await waitFor(async () => (await api('GET', '/healthz').catch(() => null) || {}).status === 200, 15000, 300, 'farm up');
    const lg = await api('POST', '/api/login', { username: 'admin', password: 'panel-pass-12345' });
    token = lg.json.token;
    check('panel login works', !!token);

    // ── Veyra stays dormant until it has an account ───────────────────────
    let st = (await api('GET', '/api/status')).json;
    const siteOf = (s, k) => (s.sites || []).find((x) => x.key === k) || {};
    check('status lists both sites', (st.sites || []).map((x) => x.key).join() === 'demonic,veyra', JSON.stringify(st.sites));
    check('main site is up from boot', siteOf(st, 'demonic').active === true);
    check('Veyra is dormant until its first account (no pointless traffic)', siteOf(st, 'veyra').active === false);

    // ── One account on each site, added back to back ──────────────────────
    const a1 = await api('POST', '/api/accounts', { nickname: 'dem-one', email: 'hunter.one@example.com', password: 'hunterpass1', site: 'demonic' });
    const a2 = await api('POST', '/api/accounts', { nickname: 'vey-two', email: 'hunter.two@example.com', password: 'hunterpass2', site: 'veyra' });
    check('account added on the main site', a1.status === 200 && a1.json.account && a1.json.account.site === 'demonic', JSON.stringify(a1.json));
    check('account added on Veyra', a2.status === 200 && a2.json.account && a2.json.account.site === 'veyra', JSON.stringify(a2.json));
    const bad = await api('POST', '/api/accounts', { nickname: 'x', email: 'x@y.io', password: 'pw', site: 'nowhere' });
    check('unknown site is refused (400)', bad.status === 400, `got ${bad.status}`);

    // ── Same login on BOTH sites = two independent accounts ──────────────
    const a3 = await api('POST', '/api/accounts', { nickname: 'vey-one', email: 'hunter.one@example.com', password: 'hunterpass1', site: 'veyra' });
    check('the same email can be added on the second site as its own account',
      a3.status === 200 && a3.json.account.site === 'veyra' && a3.json.account.id !== a1.json.account.id, JSON.stringify(a3.json));

    // ── Both sites come alive and farm AT THE SAME TIME ───────────────────
    const both = await waitFor(async () => {
      const s = (await api('GET', '/api/status')).json;
      const acc = s.accounts || [];
      const dem = acc.find((a) => a.id === a1.json.account.id);
      const vey = acc.find((a) => a.id === a2.json.account.id);
      if (dem && vey && dem.status === 'running' && vey.status === 'running'
        && (dem.waveRounds > 0 || dem.bossHits > 0) && (vey.waveRounds > 0 || vey.bossHits > 0)) return { s, dem, vey };
      return null;
    }, 60000, 700, 'accounts on both sites logged in AND farming');
    check('accounts on both sites are running and have farmed (parallel)', true);
    check('Veyra is now active', siteOf(both.s, 'veyra').active === true);

    // Truly concurrent, not taking turns: both made progress within the same
    // short window, and both show a very recent action. 20s: a cycle packs
    // wave rounds + dungeon + corpse + dailies + pvp sweeps, so on a loaded
    // box one site's loop can legally pause longer than 8s between actions —
    // taking turns would show ~full-cycle waits on BOTH, not one.
    const now = Date.now();
    check('both accounts acted within the last few seconds (independent loops)',
      now - both.dem.lastActionAt < 20000 && now - both.vey.lastActionAt < 20000,
      `dem ${now - both.dem.lastActionAt}ms, vey ${now - both.vey.lastActionAt}ms`);

    // ── Each site has its own fetcher + target bus ────────────────────────
    const tD = (await api('GET', '/api/targets')).json;
    const tV = (await api('GET', '/api/targets?site=veyra')).json;
    await waitFor(async () => ((await api('GET', '/api/targets?site=veyra')).json.mobs || []).length > 0, 30000, 700, 'Veyra scout published targets');
    check('main-site targets answer for the main site', tD.site === 'demonic');
    check('Veyra has its own target bus + scout', tV.site === 'veyra' && fs.existsSync(path.join(DATA_DIR, 'targets-veyra.json')));
    check('main site keeps the legacy targets.json', fs.existsSync(path.join(DATA_DIR, 'targets.json')));
    st = (await api('GET', '/api/status')).json;
    check('each site reports its own hidden fetcher',
      siteOf(st, 'demonic').fetcher && siteOf(st, 'demonic').fetcher.hidden === true
      && siteOf(st, 'veyra').fetcher && siteOf(st, 'veyra').fetcher.hidden === true);
    check('Veyra scout has run', siteOf(st, 'veyra').scout && siteOf(st, 'veyra').scout.lastRun > 0);

    // ── Counts + hiding ───────────────────────────────────────────────────
    check('stored count = 3 user accounts (fetchers excluded)', st.storedCount === 3, `got ${st.storedCount}`);
    const blob = JSON.stringify(st) + JSON.stringify(tD) + JSON.stringify(tV);
    check('no part of any fetcher address in API output', !/fetcher@test|test\.invalid|core-fetcher/i.test(blob));
    const audit = fs.readFileSync(path.join(DATA_DIR, 'audit.log'), 'utf8');
    check('both sites seeded their own fetcher in the audit log',
      /admin_fetcher_seeded.*"site":"demonic"/.test(audit) && /admin_fetcher_seeded.*"site":"veyra"/.test(audit));
    check('audit log has no fetcher address', !/fetcher@test|test\.invalid/i.test(audit));
    check('farm log has no fetcher address', !/fetcher@test|test\.invalid/i.test(farmLog));

    // ── Removing a Veyra account leaves the main site untouched ───────────
    const del = await api('DELETE', `/api/accounts/${a3.json.account.id}`);
    check('removing one account works', del.status === 200 && del.json.removed === true);
    st = (await api('GET', '/api/status')).json;
    const demAfter = (st.accounts || []).find((a) => a.id === a1.json.account.id);
    check('...and the other accounts keep running', demAfter && demAfter.status === 'running');
  } catch (e) {
    console.log('test crashed:', e.message);
    failures++;
    console.log(farmLog.split('\n').slice(-25).join('\n'));
  } finally {
    farm.kill(); mockA.kill(); mockB.kill();
    await sleep(300);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(failures ? `\n✘ ${failures} check(s) failed` : '\n✔ multi-site checks passed — both sites run side by side');
  process.exit(failures ? 1 : 0);
}
main();
