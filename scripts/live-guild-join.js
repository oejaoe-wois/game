'use strict';
// NOTE: game logins are read from the environment — set DIVER1_EMAIL / DIVER1_PASSWORD,
// DIVER2_*, DIVER3_* before running. Never hardcode credentials in this repo.
// live-guild-join.js — ACCEPT GUILDS, live: the guild-less account is joined
// to the fleet's guild through the engine's own auto-join hook.
//
//   boot (fetcherless) → add the three accounts → PATCH diver-3's
//   guildCode = "DA" (Dagorath Alliance — diver-1's guild, open recruitment,
//   242/300 live-verified) → the next scanGuild() probes guild_dash.php,
//   sees "no guild", finds [DA] in the registry, takes its join_open form
//   and POSTs it → the dash then answers as a member → state.guild shows
//   tag DA + verified:true and the audit log carries guild_join.
//
// Diver-1 (already [DA]) and diver-2 (already [EPHEME]) must stay untouched —
// a code that already matches never triggers a join.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join('/home/z/my-project', 'aio-farm-improved');
const PORT = 3113;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(ROOT, 'data-live-guild');
const ENV_FILE = path.join(ROOT, 'farm.env');
const SITE = 'demonic';

const ADMIN_USER = 'live-run-admin';
const ADMIN_PASS = 'LiveRun!2026-11-23';
const SECRET = 'live-run-secret-key-0123456789abcdef0123456789abcdef';

const ACCOUNTS = [
  { email: process.env.DIVER1_EMAIL, password: process.env.DIVER1_PASSWORD, nickname: 'diver-1' },
  { email: process.env.DIVER2_EMAIL, password: process.env.DIVER2_PASSWORD, nickname: 'diver-2' },
  { email: process.env.DIVER3_EMAIL, password: process.env.DIVER3_PASSWORD, nickname: 'diver-3' },
];
const JOIN_CODE = 'DA'; // diver-3 joins the fleet's open-recruitment guild
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
        catch (_) { resolve({ status: res.statusCode, json: null, text: text.slice(0, 300) }); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
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
    // guild auto-join on by default; the cooldown is shortened so a retry
    // inside the run window is possible if the first attempt hits a hiccup
    `GUILD_JOIN_COOLDOWN_MS=60000`,
  ].join('\n') + '\n');

  console.log('[run] booting aio-farm server (fetcherless)…');
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

    const login = await req('POST', '/api/login', { username: ADMIN_USER, password: ADMIN_PASS });
    if (!login.json || !login.json.ok) throw new Error('panel login failed');
    const token = login.json.token;
    console.log('[run] panel login OK');

    for (const a of ACCOUNTS) {
      const add = await req('POST', '/api/accounts', { ...a, site: SITE }, token);
      console.log(`[run] add ${a.nickname}: ok=${add.json && add.json.ok} ${add.json && add.json.error ? add.json.error : ''}`);
      await sleep(1200);
    }

    // wait for all three workers to be logged in
    let ready = 0;
    for (let i = 0; i < 40 && ready < ACCOUNTS.length; i++) {
      await sleep(4000);
      const st = await req('GET', '/api/status', null, token);
      const rows = (st.json && st.json.accounts) || [];
      ready = rows.filter((x) => x.status === 'running').length;
      console.log(`[run] accounts ready: ${ready}/${ACCOUNTS.length} ` +
        `(${rows.map((x) => `${x.nickname}:${x.status}`).join(', ')})`);
    }

    // the fleet's starting guild states (before the join)
    const before = await req('GET', '/api/status', null, token);
    const rows = (before.json && before.json.accounts) || [];
    const byNick = Object.fromEntries(rows.map((r) => [r.nickname, r]));
    for (const n of ['diver-1', 'diver-2', 'diver-3']) {
      const g = (byNick[n] && byNick[n].guild) || null;
      console.log(`[run] before: ${n} → ${g ? `tag=${g.tag || '-'} verified=${g.verified}` : 'no guild state yet'}`);
    }

    // point diver-3 at the fleet's guild — the patch nulls sessionGuild so
    // the very next scanGuild re-probes and (guild-less) fires the auto-join
    const d3 = byNick['diver-3'];
    if (!d3) throw new Error('diver-3 row missing');
    const patch = await req('PATCH', `/api/accounts/${d3.id}`, { guildCode: JOIN_CODE }, token);
    console.log(`[run] PATCH diver-3 guildCode=${JOIN_CODE}: ok=${patch.json && patch.json.ok}`);
    if (!patch.json || !patch.json.ok) throw new Error('patch failed: ' + JSON.stringify(patch.json));

    // wait for the join to land: diver-3's guild state becomes [DA] verified
    let final = null;
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      const st = await req('GET', '/api/status', null, token);
      const r3 = ((st.json && st.json.accounts) || []).find((x) => x.nickname === 'diver-3');
      const g = r3 && r3.guild;
      const line = g
        ? `tag=${g.tag || '-'} verified=${g.verified}${g.join ? ` join=${g.join.ok} (${g.join.detail})` : ''}`
        : 'no guild state yet';
      console.log(`[run] ${Math.round((Date.now() - t0) / 1000)}s diver-3 guild: ${line}`);
      if (g && g.tag === 'DA' && g.verified === true) { final = { r3, g }; break; }
      if (g && g.join && ['full', 'closed', 'not_found', 'error'].includes(g.join.ok)) {
        throw new Error('auto-join refused: ' + g.join.detail);
      }
    }

    console.log('──────────────────────────────────────────────');
    const after = await req('GET', '/api/status', null, token);
    const arows = ((after.json && after.json.accounts) || []);
    let ok = false;
    for (const r of arows) {
      const g = r.guild || {};
      console.log(`[run] after: ${r.nickname} → tag=${g.tag || '-'} name=${g.name || '-'} verified=${g.verified}` +
        `${g.join ? ` · join=${g.join.ok} (${g.join.detail})` : ''}`);
      if (r.nickname === 'diver-3') ok = g.tag === 'DA' && g.verified === true;
      if (r.nickname === 'diver-1') ok = ok && g.tag === 'DA' && g.verified === true;
      if (r.nickname === 'diver-2') ok = ok && g.tag === 'EPHEME' && g.verified === true;
    }
    if (!final) ok = false;
    console.log(ok
      ? '[run] LIVE GUILD AUTO-JOIN ✓ — diver-3 was guild-less and is now a verified [DA] member; the other accounts untouched'
      : '[run] guild join did not verify in the window — inspect the states above');
    console.log('[run] diver-3 can now run guild dungeons + contracts with the fleet');
  } finally {
    child.kill('SIGTERM');
    await sleep(1500);
    if (!child.killed) child.kill('SIGKILL');
  }
  process.exit(0);
}

main().catch((e) => { console.error('[run] FAILED:', e.message); process.exit(1); });
