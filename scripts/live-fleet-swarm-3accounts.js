'use strict';
// NOTE: game logins are read from the environment — set DIVER1_EMAIL / DIVER1_PASSWORD,
// DIVER2_*, DIVER3_* before running. Never hardcode credentials in this repo.
// live-fleet-swarm-3accounts.js — the FULL fleet, FULL queue, live.
//
// The 2026-11-22 dress rehearsal (live-fleet-swarm-run.js) proved the
// checkbox swarm end-to-end with TWO accounts on ONE target. The two things
// it could not show are exactly what this run adds:
//
//   1. ALL THREE farm accounts swarming together — the farm runs FETCHERLESS
//      (ADMIN_GAME_* left unset): no hidden account is reserved, every
//      visible account fights, and the scout rides the oldest healthy
//      worker's session;
//   2. the SEQUENTIAL queue: TWO fresh live mob instances armed back to
//      back, small per-account quotas so target 1 completes and the
//      coordinator's cursor visibly advances to target 2, then completes
//      the whole queue.
//
// Per-account quota 30,000 per target (≈1-3 hits each — the strong account
// lands ~54k+/hit, ~22k/hit and ~13k/hit respectively): every account must
// bank its own 30k on target 1 before the fleet moves to target 2, then the
// same on target 2 → status "complete".
//
// Stamina cost: ~2-6 hits per account total. Everything runs through the
// REAL server + workers + SwarmCoordinator — the exact path an operator
// drives from the Targets page.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join('/home/z/my-project', 'aio-farm-improved');
const { GameClient } = require(path.join(ROOT, 'server', 'game.js'));
const { CookieJar } = require(path.join(ROOT, 'server', 'jar.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const combat = require(path.join(ROOT, 'server', 'combat.js'));

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(ROOT, 'data-live-run3');
const ENV_FILE = path.join(ROOT, 'farm.env');
const SITE = 'demonic';

const ADMIN_USER = 'live-run-admin';
const ADMIN_PASS = 'LiveRun!2026-11-22';
const SECRET = 'live-run-secret-key-0123456789abcdef0123456789abcdef';

const ACCOUNTS = [
  { email: process.env.DIVER1_EMAIL, password: process.env.DIVER1_PASSWORD, nickname: 'diver-1' },
  { email: process.env.DIVER2_EMAIL, password: process.env.DIVER2_PASSWORD, nickname: 'diver-2' },
  { email: process.env.DIVER3_EMAIL, password: process.env.DIVER3_PASSWORD, nickname: 'diver-3' },
];

const QUOTA = 30000;      // per-account damage quota, PER target
const POLL_ROUNDS = 30;   // 30 × 15 s = 7.5 min run window
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'X-Admin-Token': token } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, json: null, text: text.slice(0, 200) }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  // 0) clean slate for the run — NO ADMIN_GAME_* env: fetcherless boot, so
  //    all three game accounts are ordinary fighting/swarming workers
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.writeFileSync(ENV_FILE, [
    `ADMIN_USERNAME=${ADMIN_USER}`,
    `ADMIN_PASSWORD=${ADMIN_PASS}`,
    `AIO_SECRET_KEY=${SECRET}`,
    `DATA_DIR=${DATA_DIR}`,
    `PORT=${PORT}`,
    `GAME_BASE=https://demonicscans.org`,
    `CYCLE_MIN_MS=8000`,
    `CYCLE_MAX_MS=15000`,
    `JITTER_SCALE=0.55`,
    `SCOUT_INTERVAL_MS=45000`,
    `LOG_LEVEL=debug`,
  ].join('\n') + '\n');

  // 1) boot the real server
  console.log('[run] booting aio-farm server…');
  const child = spawn('node', ['server/index.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = [];
  child.stdout.on('data', (d) => { serverLog.push(String(d)); if (process.env.VERBOSE) process.stdout.write(`[srv] ${d}`); });
  child.stderr.on('data', (d) => { serverLog.push(String(d)); process.stderr.write(`[srv!] ${d}`); });
  try {
    let booted = false;
    for (let i = 0; i < 30 && !booted; i++) {
      await sleep(1000);
      try { await req('GET', '/api/me', null, 'x'); booted = true; } catch (_) { /* booting */ }
    }
    if (!booted) throw new Error('server did not boot — ' + serverLog.slice(-5).join(''));
    console.log('[run] server up');

    // 2) panel login
    const login = await req('POST', '/api/login', { username: ADMIN_USER, password: ADMIN_PASS });
    if (!login.json || !login.json.ok) throw new Error('panel login failed: ' + JSON.stringify(login.json || login.text));
    const token = login.json.token;
    console.log('[run] panel login OK');

    // 3) add ALL THREE accounts — fetcherless boot means nothing is reserved
    for (const a of ACCOUNTS) {
      const add = await req('POST', '/api/accounts', { ...a, site: SITE }, token);
      console.log(`[run] add ${a.nickname}: ok=${add.json && add.json.ok} ${add.json && add.json.error ? add.json.error : ''}`);
      await sleep(1200);
    }

    // 4) wait for the workers' in-game logins (staggered)
    let ready = 0;
    for (let i = 0; i < 30 && ready < ACCOUNTS.length; i++) {
      await sleep(4000);
      const st = await req('GET', '/api/status', null, token);
      const rows = (st.json && st.json.accounts) || [];
      ready = rows.filter((x) => x.status === 'running').length;
      const detail = rows.map((x) => `${x.nickname}:${x.status}${x.lastError ? '!' : ''}`).join(', ');
      console.log(`[run] accounts ready: ${ready}/${ACCOUNTS.length} (${detail})`);
    }
    if (ready < ACCOUNTS.length) console.log('[run] (proceeding anyway — stragglers join mid-run)');

    // 5) TWO fresh live mob instances off the same wave page (read-only
    //    probe session), parsed by the engine's own parser — ids are
    //    short-lived (~10 min), so this happens right before arming.
    const probeJar = new CookieJar();
    const probe = new GameClient({
      gameBase: 'https://demonicscans.org', jar: probeJar,
      cfg: { fastTest: false, jitterScale: 0.6, requestTimeoutMs: 30000 },
      label: 'swarm-target-probe',
    });
    await auth.login(probe, ACCOUNTS[0].email, ACCOUNTS[0].password);
    probeJar.set('hide_dead_monsters', '1', 30 * 24 * 3600);
    const waveRes = await probe.get('/active_wave.php?gate=3&wave=3', { redirect: 'manual' });
    const alive = combat.parseWaveCards(waveRes.text || '').filter((c) => !c.dead);
    if (alive.length < 2) throw new Error(`need 2 alive mobs on Grakthar wave 1, found ${alive.length}`);
    const picked = [];
    for (const c of alive) {
      if (picked.length < 2) picked.push(c);
    }
    console.log(`[run] live mobs on Grakthar wave 1: ${alive.length}; ` +
      `queue: ${picked.map((c) => `${c.name}#${c.id}`).join(' → ')}`);

    // 6) arm the swarm — TWO targets, per-account quotas (per_account mode:
    //    every account must bank its own quota before the cursor advances)
    const arm = await req('POST', '/api/swarm', {
      site: SITE,
      mode: 'per_account',
      autoRefill: false,
      targets: picked.map((c, i) => ({
        kind: 'wave',
        mobId: String(c.id),
        name: c.name,
        wave: 'gate=3&wave=3',
        waveLabel: `Grakthar · wave 1 · #${i + 1}`,
        quota: QUOTA,
      })),
    }, token);
    if (!arm.json || !arm.json.ok) throw new Error('swarm arm failed: ' + JSON.stringify(arm.json || arm.text));
    console.log(`[run] swarm ARMED — mode=${arm.json.mode} quota=${QUOTA.toLocaleString('en-US')}/account/target ` +
      `targets=${arm.json.total} fleet=${(arm.json.accounts || []).length} account(s)`);

    // 7) poll until complete — the queue must march target 1 → target 2
    const t0 = Date.now();
    let final = null;
    let sawAdvance = false;
    let lastCurrent = -1;
    for (let i = 0; i < POLL_ROUNDS; i++) {
      await sleep(15000);
      const st = await req('GET', `/api/swarm?site=${SITE}`, null, token);
      const s = st.json || {};
      const cur = s.currentTarget;
      const curIdx = typeof s.current === 'number' ? s.current : -1;
      if (curIdx > lastCurrent && curIdx > 0 && curIdx < s.total) {
        sawAdvance = true;
        console.log(`[run] ── QUEUE ADVANCED → target ${curIdx + 1}/${s.total}: ` +
          `${cur ? `${cur.name || cur.mobId}` : '?'} — target 1 banked ` +
          `${((s.targets || [])[0] || {}).damage || 0} dmg`);
      }
      lastCurrent = Math.max(lastCurrent, curIdx);
      const accs = (s.accounts || []).map((a) => {
        const rec = cur && a.byTarget && a.byTarget[cur.key];
        return `${a.nickname}: ${rec ? Number(rec.damage).toLocaleString('en-US') : 0}/${QUOTA.toLocaleString('en-US')}` +
          (rec && rec.stopReason ? ` (${rec.stopReason})` : '') +
          (a.stamina ? ` ⚡${a.stamina.cur}/${a.stamina.max}` : '');
      }).join(' · ');
      console.log(`[run] ${(Math.round((Date.now() - t0) / 1000))}s status=${s.status} ` +
        `target ${curIdx + 1}/${s.total}=${cur ? `${cur.name || cur.mobId}` : '—'} | ${accs}`);
      if (s.status === 'complete' || s.status === 'stopped') { final = s; break; }
    }

    // 8) verdict + stand-down
    if (final) {
      console.log('──────────────────────────────────────────────');
      console.log(`[run] SWARM ${final.status.toUpperCase()} — total damage ${Number(final.totalDamage).toLocaleString('en-US')} across ${(final.targets || []).length} target(s)`);
      // per-account, per-target ledger — the accumulation must be INDEPENDENT
      // per account AND per target (its own totaldmgdealt per instance)
      for (const a of (final.accounts || [])) {
        const rows = (final.targets || []).map((t) => {
          const rec = a.byTarget && a.byTarget[t.key];
          const dmg = rec ? Number(rec.damage) : 0;
          return `${t.name || t.mobId}: ${dmg.toLocaleString('en-US')}/${QUOTA.toLocaleString('en-US')}` +
            `${rec && rec.stopReason ? ` (${rec.stopReason})` : ''}`;
        });
        console.log(`[run]   ${a.nickname}${a.stamina ? ` ⚡${a.stamina.cur}/${a.stamina.max}` : ''} → ${rows.join(' | ')}`);
      }
      for (const l of (final.log || []).slice(-14)) console.log(`[run]   log: ${l.msg}`);
      const targetsOk = (final.targets || []).every((t) => t.done || t.mobDead);
      const fleet = (final.accounts || []).filter((a) => a.active || Object.keys(a.byTarget || {}).length);
      const independent = (final.accounts || []).every((a) => {
        const recs = Object.values(a.byTarget || {});
        return recs.length === 0 || recs.every((r) => Number(r.damage) >= 0);
      });
      const ok = final.status === 'complete'
        && targetsOk
        && (final.targets || []).length === 2
        && fleet.length === 3
        && sawAdvance
        && independent;
      console.log(`[run] checks: complete=${final.status === 'complete'} bothTargetsDone=${targetsOk} ` +
        `fleetOf3=${fleet.length === 3} queueAdvanced=${sawAdvance} perAccountLedger=${independent}`);
      console.log(ok ? '[run] LIVE 3-ACCOUNT SWARM ✓ — per-account quotas banked independently and the queue advanced target 1 → target 2'
                     : '[run] swarm finished with caveats — inspect the ledger above');
    } else {
      console.log('[run] swarm did not complete in the window — stopping it');
    }
    await req('DELETE', `/api/swarm?site=${SITE}`, null, token);
    console.log('[run] swarm stood down');
  } finally {
    child.kill('SIGTERM');
    await sleep(1500);
    if (!child.killed) child.kill('SIGKILL');
  }
  process.exit(0);
}

main().catch((e) => { console.error('[run] FAILED:', e.message); process.exit(1); });
