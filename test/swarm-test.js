'use strict';
// swarm-test.js — the checkbox swarm ("attack mob 1 until every account
// banked its damage, then mob 2, …").
//
//   Part A — coordinator unit tests (pure, no network): queue sequencing,
//            per-account vs combined quotas, mob-dead / expired instances,
//            auto-refill off the bus, dungeon targets on the same queue,
//            stop/clear and the persistence roundtrip.
//   Part B — integration: two accounts on the mock game swarm moss golem
//            (8001) then rot fiend (8002) by mob id — the swarm state must
//            show BOTH accounts over quota on BOTH targets, in order — then
//            a guild-dungeon swarm on lizardman shadowclaw, then stop().
//
// Run: node test/swarm-test.js
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 8995;
const FARM_PORT = 8996;
const DATA_DIR = path.join(ROOT, 'tmp-test-data-swarm');
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// ── Part A: coordinator unit tests ─────────────────────────────────────────────
async function unitTests() {
  console.log('\n── Part A: swarm coordinator (unit) ──');
  const { SwarmCoordinator, normalizeTargets } = require('../server/swarm');

  const norm = normalizeTargets([
    { kind: 'wave', mobId: '8001', name: 'moss golem', quota: 1000 },
    { kind: 'dungeon', name: 'crucible champion', quota: 500 },
    { kind: 'wave', mobId: 'abc', quota: 10 }, // bad id
    { kind: 'wave', mobId: '8002', quota: 0 }, // bad quota
    { kind: 'dungeon', quota: 5 },             // no name
    null,
  ]);
  check('normalizeTargets keeps only valid rows and caps the fields',
    norm.length === 2 && norm[0].mobId === '8001' && norm[1].kind === 'dungeon'
    && norm[1].name === 'crucible champion',
    JSON.stringify(norm));

  // A2 — per_account sequencing: both accounts do mob 1 before anyone does mob 2
  {
    const c = new SwarmCoordinator({});
    const st = c.start({
      roster: [{ id: 'a1', nickname: 'alpha' }, { id: 'a2', nickname: 'beta' }],
      targets: [
        { kind: 'wave', mobId: '8001', name: 'moss golem', quota: 1000 },
        { kind: 'wave', mobId: '8002', name: 'rot fiend', quota: 2000 },
      ],
    });
    check('start() arms the job on target 1 with the full fleet roster',
      st.ok && st.armed && st.currentTarget.mobId === '8001' && st.accounts.length === 2,
      JSON.stringify({ cur: st.currentTarget, accounts: st.accounts }));

    let w = c.claim('a1', 'alpha');
    check('claim returns the current wave target with its cap',
      w && w.mobId === '8001' && w.cap === 1000 && w.damageSoFar === 0);
    c.report('a1', { key: w.key, damage: 400 });
    w = c.claim('a1', 'alpha');
    check('a fresh claim resumes mid-quota (damage banked, cap = remainder)',
      w && w.mobId === '8001' && w.damageSoFar === 400 && w.cap === 600);
    c.report('a1', { key: w.key, result: 'FINISHED', damage: 1000 });
    check('a1 is done with target 1 → no more wave work for a1 while a2 lags',
      c.claim('a1', 'alpha') === null);
    w = c.claim('a2', 'beta');
    check('a2 still gets target 1 until ITS quota is banked (the queue never skips an account)',
      w && w.mobId === '8001');
    c.report('a2', { key: w.key, result: 'FINISHED', damage: 1000 });
    w = c.claim('a1', 'alpha');
    check('both accounts done → the fleet advanced to mob 2 (8002)',
      w && w.mobId === '8002' && w.quota === 2000);
    c.report('a1', { key: w.key, result: 'FINISHED', damage: 2000 });
    w = c.claim('a2', 'beta');
    check('a2 joins mob 2 too', w && w.mobId === '8002');
    c.report('a2', { key: w.key, result: 'FINISHED', damage: 2000 });
    const done = c.claim('a1', 'alpha');
    check('queue exhausted → status complete, no more claims',
      done === null && c.statusView().status === 'complete' && c.statusView().current === 2);
  }

  // A3 — a slain/dead instance moves the whole queue (a dead mob can never
  // take the remaining damage; nobody stalls on it).
  {
    const c = new SwarmCoordinator({});
    c.start({ targets: [{ kind: 'wave', mobId: '8499', name: 'fleet drone', quota: 1000000 }] });
    c.claim('a1', 'alpha');
    c.claim('a2', 'beta');
    c.report('a1', { key: c.currentTarget().key, result: 'SLAIN', damage: 1500 });
    const w = c.claim('a2', 'beta');
    check('a SLAIN report marks the instance dead → queue advances past it for everyone',
      w === null && c.statusView().status === 'complete' && c.statusView().targets[0].mobDead);
  }

  // A4 — combined mode: the fleet quota, not each account's.
  {
    const c = new SwarmCoordinator({});
    c.start({ mode: 'total', targets: [{ kind: 'wave', mobId: '8003', name: 'tide wisp', quota: 1500 }] });
    const w1 = c.claim('a1', 'alpha');
    check('combined mode: the first claimer carries the full fleet quota as its cap',
      w1 && w1.cap === 1500 && w1.quota === 1500);
    c.report('a1', { key: w1.key, result: 'FINISHED', damage: 1500 });
    check('combined quota reached → everyone stands down and the target completes',
      c.claim('a2', 'beta') === null && c.statusView().status === 'complete');
  }

  // A5 — an instance that auto-died before its quota never stalls the fleet.
  {
    const c = new SwarmCoordinator({});
    c.start({ targets: [{ kind: 'wave', mobId: '8001', name: 'moss golem', quota: 999999 }] });
    c.state.targets[0].expiresAt = Date.now() - 10; // instance gone
    const w = c.claim('a1', 'alpha');
    check('an expired instance is skipped (mobDead) and the queue completes',
      w === null && c.statusView().status === 'complete'
      && c.statusView().log.some((l) => /expired/.test(l.msg)));
  }

  // A6 — auto-refill: fresh instances of the queued types come off the bus.
  {
    const bus = {
      snapshot: () => ({
        mobs: [
          { id: '9001', name: 'Troll Ravager', wave: 'gate=3&wave=5', waveLabel: 'Wave 5', expiresAt: Date.now() + 600000 },
          { id: '9002', name: 'troll ravager elite', wave: 'gate=3&wave=5', waveLabel: 'Wave 5', expiresAt: Date.now() + 600000 },
          { id: '9003', name: 'goblin skirmisher', wave: 'gate=3&wave=3', waveLabel: 'Wave 3', expiresAt: Date.now() + 600000 },
          { id: '9001', name: 'Troll Ravager', expiresAt: Date.now() + 600000 }, // dupe id — filtered
        ],
      }),
    };
    const c = new SwarmCoordinator({ bus });
    c.start({ autoRefill: true, targets: [{ kind: 'wave', mobId: '8000', name: 'troll ravager', quota: 500 }] });
    const w0 = c.claim('a1', 'alpha');
    c.report('a1', { key: w0.key, result: 'FINISHED', damage: 500 });
    check('original queue drained → auto-refill pulled fresh instances of the queued type',
      c.statusView().status === 'running' && c.statusView().targets.length === 3
      && c.statusView().targets.slice(1).every((t) => t.refilled),
      JSON.stringify(c.statusView().targets.map((t) => [t.mobId, t.refilled])));
    const w1 = c.claim('a1', 'alpha');
    check('the refill targets carry the same name-quota and skip already-swarmed ids',
      w1 && ['9001', '9002'].includes(w1.mobId) && w1.quota === 500 && w1.name.toLowerCase().includes('troll'));
    c.report('a1', { key: w1.key, result: 'FINISHED', damage: 500 });
    const w2 = c.claim('a1', 'alpha');
    c.report('a1', { key: w2.key, result: 'FINISHED', damage: 500 });
    check('refill exhausted (ids already swarmed) → complete',
      c.statusView().status === 'complete' && !c.statusView().log.some((l) => /goblin/.test(l.msg)));
  }

  // A7 — dungeon targets ride the same queue between wave targets.
  {
    const c = new SwarmCoordinator({});
    c.start({
      targets: [
        { kind: 'wave', mobId: '8001', name: 'moss golem', quota: 500 },
        { kind: 'dungeon', name: 'crucible champion', quota: 400 },
        { kind: 'wave', mobId: '8002', name: 'rot fiend', quota: 500 },
      ],
    });
    const w = c.claim('a1', 'alpha');
    c.report('a1', { key: w.key, result: 'FINISHED', damage: 500 });
    const d1 = c.claimDungeon('a1', 'alpha');
    check('the current dungeon target comes through claimDungeon (full remaining quota)',
      d1 && d1.name === 'crucible champion' && d1.cap === 400);
    c.reportDungeon('a1', { key: d1.key, damage: 250, outcome: 'HIT' });
    const d2 = c.claimDungeon('a1', 'alpha');
    check('dungeon damage accumulates across instances — cap shrinks to the remainder',
      d2 && d2.cap === 150, JSON.stringify(d2));
    c.reportDungeon('a1', { key: d2.key, damage: 200, outcome: 'CAPPED' });
    const w2 = c.claim('a1', 'alpha');
    check('dungeon share banked → the queue moves to the next wave target',
      w2 && w2.mobId === '8002');
    check('claimDungeon returns null once the current target is a wave mob',
      c.claimDungeon('a1', 'alpha') === null);
  }

  // A8 — stop freezes, clear resets.
  {
    const c = new SwarmCoordinator({});
    c.start({ targets: [{ kind: 'wave', mobId: '8001', name: 'moss golem', quota: 1000 }] });
    const stopped = c.stop();
    check('stop() disarms the job and claims return null',
      stopped.ok && !c.armed() && c.statusView().status === 'stopped' && c.claim('a1', 'alpha') === null);
    const cleared = c.clear();
    check('clear() resets to an empty idle job',
      cleared.ok && c.statusView().status === 'idle' && c.statusView().targets.length === 0);
  }

  // A9 — persistence: a restart resumes the job (armed, cursor, banked damage).
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-test-'));
    try {
      const c1 = new SwarmCoordinator({ dataDir: dir, fileName: 'swarm.json' });
      c1.start({ targets: [
        { kind: 'wave', mobId: '8001', name: 'moss golem', quota: 1000 },
        { kind: 'wave', mobId: '8002', name: 'rot fiend', quota: 1000 },
      ] });
      const w = c1.claim('a1', 'alpha');
      c1.report('a1', { key: w.key, result: 'FINISHED', damage: 1000 });
      const c2 = new SwarmCoordinator({ dataDir: dir, fileName: 'swarm.json' });
      const v = c2.statusView();
      const a1 = (v.accounts || []).find((x) => x.id === 'a1');
      check('a rebooted coordinator reloads the queue, the cursor and the banked damage',
        c2.armed() && v.current === 1 && a1 && a1.byTarget[v.targets[0].key]
        && a1.byTarget[v.targets[0].key].damage === 1000
        && v.targets[0].done === true,
        JSON.stringify(v));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // A10 — an account that goes offline stops blocking a per-account quota
  // (a stalled account must never freeze the whole fleet's queue).
  {
    const c = new SwarmCoordinator({ activeMs: 80 });
    c.start({ targets: [{ kind: 'wave', mobId: '8001', name: 'moss golem', quota: 1000 }] });
    c.claim('a1', 'alpha');
    c.claim('a2', 'beta');
    const w = c.claim('a1', 'alpha');
    c.report('a1', { key: w.key, result: 'FINISHED', damage: 1000 });
    check('while a2 is fresh it blocks the advance', c.statusView().current === 0);
    await sleep(120);
    c.claim('a1', 'alpha'); // touches a1 only — a2 went quiet past activeMs
    const v = c.statusView();
    check('a2 offline past the activity window → a1 alone can complete the target',
      v.current === 1 && v.status === 'complete', JSON.stringify({ current: v.current, status: v.status }));
  }

  // A11 — battle intel + vitals ride the status view (the panel's forecast
  // chips and stamina bars are pure views over these records).
  {
    const c = new SwarmCoordinator({});
    c.start({ targets: [{ kind: 'wave', mobId: '8001', name: 'moss golem', quota: 1000 }] });
    const w = c.claim('a1', 'alpha');
    c.noteIntel(w.key, {
      mobName: 'moss golem', defense: 40, eqDefense: 20, petDefense: 10,
      element: 'NATURE', elementRate: 15, avgHit: 4320, hitsLeft: 5,
      countered: false, rewardsUpToLv: 300,
    });
    c.noteVitals('a1', { staminaCur: 512, staminaMax: 1370 });
    const v = c.statusView();
    const a1 = v.accounts.find((x) => x.id === 'a1');
    check('noteIntel publishes the forecast on the target row',
      v.targets[0].intel && v.targets[0].intel.avgHit === 4320 && v.targets[0].intel.defense === 40,
      JSON.stringify(v.targets[0].intel));
    check('noteVitals publishes the stamina bar on the account row',
      a1 && a1.stamina && a1.stamina.cur === 512 && a1.stamina.max === 1370,
      JSON.stringify(a1 && a1.stamina));
    check('the current-target view carries the same intel',
      v.currentTarget && v.currentTarget.intel && v.currentTarget.intel.hitsLeft === 5,
      JSON.stringify(v.currentTarget && v.currentTarget.intel));
    c.clear();
    check('clear() wipes the intel map', !c.intelFor(v.targets[0].key), JSON.stringify(c.intelFor(v.targets[0].key)));
  }
}

// ── Part B: integration on the mock game ───────────────────────────────────────
async function integrationTests() {
  console.log('\n── Part B: swarm end-to-end on the mock game ──');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const env = {
    ...process.env,
    PORT: String(FARM_PORT),
    GAME_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'owner-pass-12345',
    AIO_SECRET_KEY: 'test-secret-key-0123456789abcdef0123456789abcdef',
    ADMIN_GAME_EMAIL: 'fetcher@test.invalid', ADMIN_GAME_PASSWORD: 'fetcher@test.invalid',
    DATA_DIR, FAST_TEST: '1', SCOUT_INTERVAL_MS: '2000', LOGIN_STAGGER_MS: '150',
    RELOGIN_COOLDOWN_MS: '2000', LOG_LEVEL: 'debug',
    // The normal wave farm must NOT chew the swarm targets down while the
    // test waits: FIXED cap mode pins every regular mob to 600 damage (the
    // known loot tables would otherwise let it grind moss golem for ~45
    // minutes), so only the swarm's own slashes land free.
    MOB_CAP_MODE: 'fixed',
    MOB_DAMAGE_CAP: '600',
  };
  const mock = spawn('node', [path.join(__dirname, 'mock-game.js'), String(MOCK_PORT)], { stdio: 'pipe' });
  const farm = spawn('node', [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'pipe' });
  let farmLog = '';
  farm.stdout.on('data', (d) => { farmLog += d; });
  farm.stderr.on('data', (d) => { farmLog += d; });

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
  async function waitFor(fn, ms, every, label) {
    const end = Date.now() + ms;
    let last = null;
    for (;;) {
      try { last = await fn(); } catch (_) { last = null; }
      if (last) return last;
      if (Date.now() > end) throw new Error(`timeout waiting for: ${label}`);
      await sleep(every);
    }
  }
  // Mock introspection: POST flips engine-test state, GET dumps it.
  function mockPost(payload) {
    return new Promise((resolve) => {
      const data = JSON.stringify(payload);
      const req = http.request({
        host: '127.0.0.1', port: MOCK_PORT, method: 'POST', path: '/__mock/state',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (r) => { r.resume(); r.on('end', resolve); });
      req.on('error', resolve); req.write(data); req.end();
    });
  }
  function mockGet() {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${MOCK_PORT}/__mock/state`, (r) => {
        let b = ''; r.on('data', (c) => { b += c; });
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({}); } });
      }).on('error', () => resolve({}));
    });
  }

  try {
    await waitFor(async () => (await api('', 'GET', '/healthz').catch(() => null) || {}).status === 200, 15000, 300, 'farm up');
    const o = await api('', 'POST', '/api/login', { username: 'boss', password: 'owner-pass-12345' });
    const OWNER = o.json.token;

    const aa = await api(OWNER, 'POST', '/api/accounts', { nickname: 'swarm-alpha', email: 'hunter.one@example.com', password: 'hunterpass1' });
    const bb = await api(OWNER, 'POST', '/api/accounts', { nickname: 'swarm-beta', email: 'hunter.two@example.com', password: 'hunterpass2' });
    check('two swarm accounts added', aa.status === 200 && bb.status === 200, JSON.stringify([aa.json, bb.json]));

    await waitFor(async () => {
      const s = (await api(OWNER, 'GET', '/api/status')).json;
      const accs = s.accounts || [];
      return accs.length >= 2 && accs.every((a) => a.status === 'running');
    }, 60000, 700, 'both accounts running');

    // The scout must be publishing before mobs can be ticked: wait for the
    // wave-8 roster (moss golem 8001) to hit the bus.
    await waitFor(async () => {
      const t = (await api(OWNER, 'GET', '/api/targets')).json;
      return (t.mobs || []).some((m) => String(m.id) === '8001');
    }, 60000, 700, 'scout publishes moss golem 8001');

    // Clear the long boss fights (skarn/oceanus grind for minutes at 1-stam
    // tiers): dead bosses leave the bus, so every worker's NEXT cycle reaches
    // the swarm hook instead of staying stuck mid-boss-fight.
    await mockPost({ killMob: [9001, 9005] });

    check('empty swarm start is refused (400)', (await api(OWNER, 'POST', '/api/swarm', { targets: [] })).status === 400);

    // ── Wave swarm: moss golem (8001) then rot fiend (8002), 1000 dmg each
    //    account per type (mock hits land 150 → ~7 hits per account per mob).
    const arm = await api(OWNER, 'POST', '/api/swarm', {
      mode: 'per_account',
      autoRefill: false,
      targets: [
        { kind: 'wave', mobId: '8001', name: 'moss golem', wave: 'gate=3&wave=8', waveLabel: 'Gate 2 · wave 8', quota: 1000 },
        { kind: 'wave', mobId: '8002', name: 'rot fiend', wave: 'gate=3&wave=8', waveLabel: 'Gate 2 · wave 8', quota: 1000 },
      ],
    });
    check('POST /api/swarm arms the two-mob queue', arm.status === 200 && arm.json.ok
      && arm.json.currentTarget && arm.json.currentTarget.mobId === '8001', JSON.stringify(arm.json.currentTarget || arm.json));

    const finished = await waitFor(async () => {
      const st = (await api(OWNER, 'GET', '/api/swarm')).json;
      return st.status === 'complete' ? st : null;
    }, 120000, 800, 'wave swarm complete');
    check('the swarm ran to completion (every account over quota on every queued mob)', !!finished,
      JSON.stringify(finished && { status: finished.status, current: finished.current, log: (finished.log || []).slice(-6) }));

    const accounts = (finished && finished.accounts) || [];
    const golemKey = ((finished && finished.targets) || []).map((t) => t).find((t) => t.mobId === '8001');
    const fiendKey = ((finished && finished.targets) || []).map((t) => t).find((t) => t.mobId === '8002');
    check('both accounts banked their moss golem quota (per-account semantics)',
      accounts.length >= 2 && accounts.every((a) => a.byTarget[golemKey.key] && a.byTarget[golemKey.key].damage >= 1000),
      JSON.stringify(accounts.map((a) => [a.nickname, a.byTarget])));
    check('both accounts banked their rot fiend quota AFTER mob 1 was done',
      accounts.length >= 2 && accounts.every((a) => a.byTarget[fiendKey.key] && a.byTarget[fiendKey.key].damage >= 1000),
      JSON.stringify(accounts.map((a) => a.byTarget && a.byTarget[fiendKey.key])));
    const golemDoneIdx = (finished.log || []).findIndex((l) => /moss golem done/.test(l.msg));
    const fiendJoinIdx = (finished.log || []).findIndex((l) => /rot fiend quota met/.test(l.msg));
    check('strict order: mob 1 was declared done before any mob 2 quota was met',
      golemDoneIdx >= 0 && fiendJoinIdx > golemDoneIdx,
      JSON.stringify((finished.log || []).map((l) => l.msg)));

    // The mock's join log is timestamped ground truth: both accounts joined
    // BOTH mob ids through user_join_battle.php.
    const mockRaw = await mockGet();
    const joins = mockRaw.joinLog || [];
    const joinedIds = new Set(joins.map((j) => String(j.monster_id)));
    check('the fleet joined the queued mob ids directly (join battle proof)',
      joinedIds.has('8001') && joinedIds.has('8002'),
      JSON.stringify({ joined: [...joinedIds] }));

    // ── Monster stats + the damage forecast (the "View Monster Stats" modal) ──
    const golemRow = (finished.targets || []).find((t) => t.mobId === '8001');
    check('the swarm published mob-type battle intel (monster stats + forecast)',
      golemRow && golemRow.intel && golemRow.intel.mobName === 'moss golem'
      && golemRow.intel.defense === 40 && golemRow.intel.eqDefense === 20
      && golemRow.intel.petDefense === 10 && golemRow.intel.element === 'NATURE'
      && Number(golemRow.intel.avgHit) > 0 && Number(golemRow.intel.hitsLeft) > 0,
      JSON.stringify(golemRow && golemRow.intel));
    const mstats = await api(OWNER, 'GET', '/api/monster-stats?site=demonic&mobId=8001');
    check('GET /api/monster-stats serves the modal stats + the fleet-average forecast',
      mstats.status === 200 && mstats.json.ok && mstats.json.stats
      && mstats.json.stats.name === 'moss golem' && mstats.json.stats.element === 'NATURE'
      && mstats.json.stats.rewardsUpToLv === 300
      && mstats.json.forecast && Number(mstats.json.forecast.avgHit) > 0,
      JSON.stringify(mstats.json));
    const badStats = await api(OWNER, 'GET', '/api/monster-stats?site=demonic&mobId=abc');
    check('GET /api/monster-stats refuses a non-numeric mob id', badStats.status === 400, JSON.stringify(badStats.json));

    // ── Dungeon swarm: lizardman shadowclaw in the guild dungeon (bigHit
    //    250k/hit → quota 500000 = two slashes per account). The mock's
    //    dungeon state is PER-ACCOUNT — the normal dungeon farm killed each
    //    account's own shadowclaw pre-arm, so reset the runs first.
    await mockPost({ resetDungeon: true });
    const darm = await api(OWNER, 'POST', '/api/swarm', {
      mode: 'per_account',
      targets: [{ kind: 'dungeon', name: 'lizardman shadowclaw', quota: 500000 }],
    });
    check('a dungeon mob type arms on the same queue', darm.status === 200 && darm.json.ok
      && darm.json.currentTarget && darm.json.currentTarget.kind === 'dungeon'
      && darm.json.currentTarget.name === 'lizardman shadowclaw', JSON.stringify(darm.json.currentTarget || darm.json));

    const dfinal = await waitFor(async () => {
      const st = (await api(OWNER, 'GET', '/api/swarm')).json;
      return st.status === 'complete' ? st : null;
    }, 150000, 900, 'dungeon swarm complete');
    check('the dungeon swarm completed', !!dfinal,
      JSON.stringify(dfinal && { status: dfinal.status, log: (dfinal.log || []).slice(-6) }));
    check('both accounts banked their dungeon quota (fights only the queued type)',
      ((dfinal && dfinal.accounts) || []).length >= 2
      && (dfinal.accounts).every((a) => Object.values(a.byTarget).some((r) => r.damage >= 500000)),
      JSON.stringify((dfinal && dfinal.accounts || []).map((a) => a.byTarget)));

    // ── Stamina gate: a dry account with an empty potion ladder SITS OUT
    //    (no join POSTs, "out of stamina" on its row) while the fleet fights
    //    on — then rejoins the moment its bar is back.
    await mockPost({ potionFail: '101' });           // alpha's ladder is dry
    await mockPost({ uid: '101', stamina: 0 });      // alpha's bar is empty
    const sarm = await api(OWNER, 'POST', '/api/swarm', {
      targets: [{ kind: 'wave', mobId: '8400', name: 'gate flunk', quota: 1000000000 }],
    });
    check('a fresh swarm arms (gate flunk, huge quota)', sarm.status === 200 && sarm.json.ok);
    const gateView = await waitFor(async () => {
      const st = (await api(OWNER, 'GET', '/api/swarm')).json;
      const al = (st.accounts || []).find((a) => a.nickname === 'swarm-alpha');
      const key = st.currentTarget && st.currentTarget.key;
      const rec = al && key && al.byTarget[key];
      return (al && al.stamina && Number(al.stamina.cur) === 0 && rec && rec.lastStop === 'OUT_OF_STAMINA') ? st : null;
    }, 40000, 800, 'alpha sits out on a dry bar');
    const alGate = (gateView.accounts || []).find((a) => a.nickname === 'swarm-alpha');
    const beGate = (gateView.accounts || []).find((a) => a.nickname === 'swarm-beta');
    check('the dry account publishes its empty stamina bar (stats.php vitals)',
      alGate && alGate.stamina && Number(alGate.stamina.cur) === 0 && Number(alGate.stamina.max) > 0,
      JSON.stringify(alGate && alGate.stamina));
    const gateMock = await mockGet();
    check('the dry account made NO join attempt on the swarm target (no wasted stamina POSTs)',
      String(((gateMock.lastJoin || {})['101'] || {}).monster_id || '') !== '8400',
      JSON.stringify((gateMock.lastJoin || {})['101']));
    // Beta's banking is independent of alpha's gate timing (its engagement
    // may still be mid-flight when alpha sits out) — wait for its own first
    // banked damage. The flunk is a 1e12-HP wall so this never SLAINs the
    // queue into a complete-before-DELETE race.
    const betaBanked = await waitFor(async () => {
      const st = (await api(OWNER, 'GET', '/api/swarm')).json;
      const be = (st.accounts || []).find((a) => a.nickname === 'swarm-beta');
      const key = st.currentTarget && st.currentTarget.key;
      return (be && key && be.byTarget[key] && be.byTarget[key].damage > 0) ? st : null;
    }, 40000, 800, 'beta banks flunk damage');
    check('the fleet fights on without the dry account (beta banks flunk damage)',
      !!(betaBanked && betaBanked.currentTarget), JSON.stringify(
        (betaBanked && (betaBanked.accounts || []).find((a) => a.nickname === 'swarm-beta') || {}).byTarget));
    // Refill: bar back + a working ladder → alpha rejoins within a few cycles.
    await mockPost({ potionFail: null });
    await mockPost({ uid: '101', stamina: 7190 });
    await waitFor(async () => {
      const m = await mockGet();
      return String(((m.lastJoin || {})['101'] || {}).monster_id || '') === '8400';
    }, 40000, 800, 'alpha rejoins after the refill');
    check('the refilled account rejoined the swarm target', true);

    // ── Stop: an armed job freezes on DELETE and workers stop swarming.
    const stopped = await api(OWNER, 'DELETE', '/api/swarm');
    const sview = (await api(OWNER, 'GET', '/api/swarm')).json;
    check('DELETE /api/swarm freezes the queue',
      stopped.status === 200 && stopped.json.ok && sview.status === 'stopped' && sview.armed === false,
      JSON.stringify({ status: sview.status, armed: sview.armed }));
    check('GET /api/swarm exposes the dungeon quick-pick chips',
      Array.isArray(sview.dungeonMobNames), JSON.stringify(sview.dungeonMobNames));
  } catch (e) {
    failures++;
    console.log(`  FAIL  unexpected error: ${e.message}`);
    console.log(farmLog.split('\n').slice(-160).join('\n'));
  } finally {
    farm.kill('SIGINT');
    mock.kill('SIGINT');
    await sleep(500);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

async function main() {
  await unitTests();
  await integrationTests();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL SWARM CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
