'use strict';
// NOTE: game logins are read from the environment — set DIVER1_EMAIL / DIVER1_PASSWORD,
// DIVER2_*, DIVER3_* before running. Never hardcode credentials in this repo.
// live-fleet-swarm-run.js — the FULL system's live dress rehearsal.
//
// Boots the real aio-farm server (index.js), adds the three game accounts
// through the panel API, arms a checkbox swarm (per-account damage quota on a
// fresh live mob), and polls /api/swarm until the queue completes. This is
// the exact path an operator drives from the Targets page — nothing here is
// a mock.
//
// Per-account quota 60,000 on one Grakthar wave-1 Goblin Skirmisher:
//   diver-2 ≈54k+/hit (crits) → 1-2 hits or sits out dry (only ~4 stamina)
//   · diver-3 ≈22k/hit → ~3 hits. diver-1 is the built-in fetcher (its
//   stamina belongs to fetching — the API refuses to double-book it).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join('/home/z/my-project', 'aio-farm-improved');
const { GameClient } = require(path.join(ROOT, 'server', 'game.js'));
const { CookieJar } = require(path.join(ROOT, 'server', 'jar.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const combat = require(path.join(ROOT, 'server', 'combat.js'));

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(ROOT, 'data-live-run');
const ENV_FILE = path.join(ROOT, 'farm.env');
const SITE = 'demonic';

const ADMIN_USER = 'live-run-admin';
const ADMIN_PASS = 'LiveRun!2026-11-22';
const SECRET = 'live-run-secret-key-0123456789abcdef0123456789abcdef';

const ACCOUNTS = [
  { email: process.env.DIVER2_EMAIL, password: process.env.DIVER2_PASSWORD, nickname: 'diver-2' },
  { email: process.env.DIVER3_EMAIL, password: process.env.DIVER3_PASSWORD, nickname: 'diver-3' },
];

const QUOTA = 60000; // per-account damage quota
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
  // 0) clean slate for the run
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.writeFileSync(ENV_FILE, [
    `ADMIN_USERNAME=${ADMIN_USER}`,
    `ADMIN_PASSWORD=${ADMIN_PASS}`,
    `AIO_SECRET_KEY=${SECRET}`,
    `DATA_DIR=${DATA_DIR}`,
    `PORT=${PORT}`,
    `GAME_BASE=https://demonicscans.org`,
    // the built-in hidden fetcher (read-only page sweeps) — concurrent game
    // sessions are verified to coexist, so it can share account 1's creds
    `ADMIN_GAME_EMAIL=${process.env.DIVER1_EMAIL}`,
    `ADMIN_GAME_PASSWORD=${process.env.DIVER1_PASSWORD}`,
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

    // 3) add the three accounts
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

    // 5) a fresh live mob id — read-only session (game sessions coexist),
    // the same wave page the fleet fights on, parsed by the engine's own
    // parser. No waiting for the scout's bus.
    const probeJar = new CookieJar();
    const probe = new GameClient({
      gameBase: 'https://demonicscans.org', jar: probeJar,
      cfg: { fastTest: false, jitterScale: 0.6, requestTimeoutMs: 30000 },
      label: 'swarm-target-probe',
    });
    await auth.login(probe, ACCOUNTS[1].email, ACCOUNTS[1].password);
    probeJar.set('hide_dead_monsters', '1', 30 * 24 * 3600);
    const waveRes = await probe.get('/active_wave.php?gate=3&wave=3', { redirect: 'manual' });
    const cards = combat.parseWaveCards(waveRes.text || '').filter((c) => !c.dead);
    if (!cards.length) throw new Error('no alive mobs on Grakthar wave 1 to swarm');
    const mob = cards.find((c) => /goblin skirmisher/i.test(c.name)) || cards[0];
    const mobId = String(mob.id);
    console.log(`[run] live mobs on Grakthar wave 1: ${cards.length}; swarm target: ${mob.name}#${mobId}`);

    // 6) arm the swarm (per-account quotas)
    const arm = await req('POST', '/api/swarm', {
      site: SITE,
      mode: 'per_account',
      autoRefill: false,
      targets: [{
        kind: 'wave',
        mobId,
        name: mob.name,
        wave: 'gate=3&wave=3',
        waveLabel: 'Grakthar · wave 1',
        quota: QUOTA,
      }],
    }, token);
    if (!arm.json || !arm.json.ok) throw new Error('swarm arm failed: ' + JSON.stringify(arm.json || arm.text));
    console.log(`[run] swarm ARMED — mode=${arm.json.mode} quota=${QUOTA.toLocaleString('en-US')}/account fleet=${arm.json.accounts ? arm.json.accounts.length : '?'} accounts`);

    // 7) poll until complete
    const t0 = Date.now();
    let final = null;
    for (let i = 0; i < 20; i++) {
      await sleep(15000);
      const st = await req('GET', `/api/swarm?site=${SITE}`, null, token);
      const s = st.json || {};
      const cur = s.currentTarget;
      const accs = (s.accounts || []).map((a) => {
        const key = cur ? cur.key : (s.targets && s.targets[0] && s.targets[0].key);
        const rec = key && a.byTarget && a.byTarget[key];
        return `${a.nickname}: ${rec ? Number(rec.damage).toLocaleString('en-US') : 0}/${QUOTA.toLocaleString('en-US')}` +
          (rec && rec.stopReason ? ` (${rec.stopReason})` : '') +
          (a.stamina ? ` ⚡${a.stamina.cur}/${a.stamina.max}` : '');
      }).join(' · ');
      console.log(`[run] ${(Math.round((Date.now() - t0) / 1000))}s status=${s.status} target=${cur ? `${cur.name || cur.mobId} quota ${Number(cur.quota).toLocaleString('en-US')}` : '—'} | ${accs}`);
      if (s.status === 'complete' || s.status === 'stopped') { final = s; break; }
    }

    // 8) verdict + stand-down
    if (final) {
      console.log('──────────────────────────────────────────────');
      console.log(`[run] SWARM ${final.status.toUpperCase()} — total damage ${Number(final.totalDamage).toLocaleString('en-US')}`);
      for (const l of (final.log || []).slice(-12)) console.log(`[run]   log: ${l.msg}`);
      const ok = final.status === 'complete'
        && (final.targets || []).every((t) => t.done || t.mobDead);
      console.log(ok ? '[run] LIVE FLEET SWARM ✓ — the checkbox swarm executed end-to-end'
                     : '[run] swarm finished with caveats — inspect the log above');
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
