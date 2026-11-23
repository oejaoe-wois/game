'use strict';
// swarm.js — the SWARM ATTACK coordinator ("checkbox swarm", Divers).
//
// The panel's live-mobs list carries checkboxes: the user ticks the mobs to
// swarm, types how much damage each account must deal to that mob TYPE, and
// starts the swarm. The coordinator holds the ORDERED queue the user built
// (by mob id for wave mobs, by mob-type name for guild-dungeon mobs) and
// drives the whole fleet through it ONE TARGET AT A TIME:
//
//   mob 1: every account joins and slashes that mob id until EACH account
//          has dealt its quota (or the instance dies — a dead mob can never
//          take more damage, so the queue moves on instead of stalling),
//   mob 2: ditto — and so on until the queue is empty ("keep attacking
//          until there is no mobs left that they didn't attack already").
//
// Per-account damage is tracked per target from the game's own replies
// (damage.php totaldmgdealt), so a restart or a fresh cycle resumes
// mid-quota instead of starting over. mode 'total' switches the quota to
// the COMBINED fleet damage ("5M total across everyone").
//
// autoRefill: wave mobs churn (each instance auto-dies after ~10 minutes
// and a NEW instance id takes its slot). When the queue runs dry and
// auto-refill is armed, the coordinator pulls FRESH live instances of the
// queued mob names off the bus (ids not already swarmed) and keeps going —
// the "attack all Troll Ravager over and over again" behaviour.
//
// Dungeon mobs ride the SAME queue: dungeonCycle() pulls the current
// target's name + remaining quota as a filter (claimDungeon) and fights
// ONLY that mob type until the account's share is banked (reportDungeon).
//
// Everything persists to data/swarm.json (per site), so a restart resumes
// the swarm where it stood.
const fs = require('fs');
const path = require('path');
const { logger } = require('./util');

const MAX_TARGETS = 60;      // paste-accident guard
const LOG_CAP = 60;          // panel log lines kept
const REFILL_CAP = 25;       // max instances auto-refill appends per pass
const GRACE_MS_DEFAULT = 5 * 60 * 1000; // never-seen roster members block the advance this long

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Panel/API payload → normalized queue rows. kind 'wave' needs a mobId;
// kind 'dungeon' needs a name. quota is a positive integer (damage units).
function normalizeTargets(list) {
  const out = [];
  for (const raw of list || []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind === 'dungeon' ? 'dungeon' : 'wave';
    const mobId = kind === 'wave' ? String(raw.mobId || '').trim() : '';
    const name = String(raw.name || '').trim().slice(0, 80);
    if (kind === 'wave' && !/^\d+$/.test(mobId)) continue;
    if (!name && kind === 'dungeon') continue;
    const quota = Math.floor(Number(raw.quota));
    if (!Number.isFinite(quota) || quota <= 0 || quota > 1e15) continue;
    out.push({
      kind,
      mobId: kind === 'wave' ? mobId : '',
      name: name || (kind === 'wave' ? '' : ''),
      wave: String(raw.wave || ''),
      waveLabel: String(raw.waveLabel || ''),
      quota,
    });
  }
  return out.slice(0, MAX_TARGETS);
}

class SwarmCoordinator {
  // dataDir=null → in-memory (tests); bus enables auto-refill; roster = the
  // site's swarming accounts (id + nickname), so a member that has not even
  // claimed yet blocks the advance during the grace window instead of being
  // silently skipped by its faster fleet-mates.
  constructor({ dataDir, fileName, bus, activeMs, graceMs } = {}) {
    this.file = dataDir ? path.join(dataDir, fileName || 'swarm.json') : null;
    this.bus = bus || null;
    // Accounts not seen for this long stop blocking a per-account quota —
    // an offline account must never stall the whole fleet's queue.
    this.activeMs = activeMs || 10 * 60 * 1000;
    // Members of the roster that never claimed anything block the advance
    // until this long after the job started (staggered logins are normal).
    this.graceMs = graceMs || GRACE_MS_DEFAULT;
    this._lastProgressSave = 0;
    this.state = {
      version: 1,
      armed: false,
      status: 'idle', // idle | running | complete | stopped
      mode: 'per_account', // per_account | total
      autoRefill: false,
      roster: [],
      targets: [],
      current: 0, // index into targets — the mob the fleet is on right now
      accounts: {}, // accountId -> { nickname, lastSeenAt, vitals: {staminaCur…}, byTarget: { key: { damage, hits, stopReason } } }
      // Per-target battle intel the workers publish (monster stats + the
      // damage-formula forecast) — pure decoration for the panel.
      intel: {},
      startedAt: null,
      finishedAt: null,
      seq: 0,
      log: [],
    };
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.targets)) {
        this.state = { ...this.state, ...raw };
        if (!this.state.intel || typeof this.state.intel !== 'object') this.state.intel = {};
        if (this.state.armed) this.state.status = 'running';
      }
    } catch (e) {
      logger.debug(`swarm: state load failed (${e.message}) — starting idle`);
    }
  }

  save() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (_) { /* best effort — the swarm survives in memory */ }
  }

  log(msg) {
    this.state.log.push({ at: Date.now(), msg: String(msg).slice(0, 160) });
    if (this.state.log.length > LOG_CAP) this.state.log.splice(0, this.state.log.length - LOG_CAP);
  }

  armed() { return !!this.state.armed; }

  currentTarget() { return this.state.targets[this.state.current] || null; }

  // Read-only view for the worker's cycle hook (dungeon vs wave routing).
  currentTargetView() {
    const t = this.currentTarget();
    return t ? { key: t.key, kind: t.kind, name: t.name, mobId: t.mobId, quota: t.quota } : null;
  }

  // Does this account still owe work on the CURRENT wave target? Read-only
  // (no claim side effects) — the workers' normal wave rounds pass this as
  // their shouldAbort hook so an armed swarm PREEMPTS a long normal fight
  // mid-hits instead of waiting up to 20 minutes for the cycle boundary.
  owesWork(id) {
    if (!this.state.armed) return false;
    const t = this.currentTarget();
    if (!t || t.kind !== 'wave') return false; // dungeon targets ride dungeonCycle
    return !this.accountDoneFor(id, t);
  }

  // ── Job control ──────────────────────────────────────────────────────────────
  start({ targets, mode = 'per_account', autoRefill = false, roster = null } = {}) {
    const rows = normalizeTargets(targets);
    if (!rows.length) return { ok: false, error: 'no valid targets — tick mobs and give each type a damage amount' };
    const wasArmed = this.state.armed;
    this.state = {
      ...this.state,
      armed: true,
      status: 'running',
      mode: mode === 'total' ? 'total' : 'per_account',
      autoRefill: !!autoRefill,
      roster: Array.isArray(roster)
        ? roster.slice(0, 100).map((r) => ({ id: String((r && r.id) || ''), nickname: String((r && r.nickname) || '') })).filter((r) => r.id)
        : [],
      targets: rows.map((t) => this.makeTarget(t)),
      current: 0,
      accounts: {},
      startedAt: Date.now(),
      finishedAt: null,
      log: [],
    };
    this.log(`${wasArmed ? 'replaced' : 'armed'} swarm: ${rows.length} target(s), ` +
      `${this.state.mode === 'total' ? 'combined' : 'per-account'} quotas` +
      `${this.state.autoRefill ? ', auto-refill ON' : ''}` +
      `${this.state.roster.length ? `, fleet of ${this.state.roster.length} account(s)` : ''}`);
    for (const t of this.state.targets) {
      this.log(`queued ${t.kind === 'dungeon' ? 'dungeon' : 'wave'} target ` +
        `${t.name || `mob ${t.mobId}`}${t.waveLabel ? ` (${t.waveLabel})` : ''} — quota ${t.quota.toLocaleString('en-US')}`);
    }
    this.save();
    logger.info(`swarm: armed with ${rows.length} target(s) (${this.state.mode}, refill ${this.state.autoRefill ? 'on' : 'off'}, fleet ${this.state.roster.length})`);
    return { ok: true, ...this.statusView() };
  }

  stop() {
    if (this.state.armed) {
      this.log('swarm stopped by the operator — queue frozen');
      logger.info('swarm: stopped by the operator');
    }
    this.state.armed = false;
    this.state.status = this.state.status === 'running' || this.state.status === 'idle' ? 'stopped' : this.state.status;
    this.state.finishedAt = Date.now();
    this.save();
    return { ok: true, ...this.statusView() };
  }

  clear() {
    this.state.armed = false;
    this.state.status = 'idle';
    this.state.targets = [];
    this.state.current = 0;
    this.state.accounts = {};
    this.state.startedAt = null;
    this.state.finishedAt = null;
    this.state.intel = {};
    this.state.log = [];
    this.save();
    return { ok: true, ...this.statusView() };
  }

  finish(status) {
    this.state.armed = false;
    this.state.status = status;
    this.state.finishedAt = Date.now();
    this.log(status === 'complete'
      ? `swarm complete — every queued target got its damage (${this.state.targets.length} target(s))`
      : `swarm ${status}`);
    logger.info(`swarm: ${status}`);
    this.save();
  }

  makeTarget({ kind, mobId, name, wave, waveLabel, quota, expiresAt, refilled }) {
    this.state.seq = (this.state.seq || 0) + 1;
    return {
      key: `${kind === 'dungeon' ? 'd' : 'w'}-${mobId || normalizeName(name).replace(/\s+/g, '-') || 'x'}-${this.state.seq}`,
      kind,
      mobId: mobId || '',
      name: name || '',
      wave: wave || '',
      waveLabel: waveLabel || '',
      quota,
      expiresAt: expiresAt || null,
      refilled: !!refilled,
      mobDead: false,
      addedAt: Date.now(),
    };
  }

  // ── Accounts & damage bookkeeping ────────────────────────────────────────────
  touchAccount(id, nickname) {
    const key = String(id || 'unknown');
    let acc = this.state.accounts[key];
    if (!acc) {
      acc = this.state.accounts[key] = { nickname: String(nickname || key), lastSeenAt: 0, byTarget: {} };
    }
    if (nickname && acc.nickname !== nickname) acc.nickname = String(nickname);
    acc.lastSeenAt = Date.now();
    return acc;
  }

  recFor(id, key) {
    const acc = this.state.accounts[String(id)];
    return (acc && acc.byTarget[key]) || null;
  }

  damageFor(id, key) {
    const rec = this.recFor(id, key);
    return rec ? Number(rec.damage) || 0 : 0;
  }

  sumDamage(key) {
    let sum = 0;
    for (const acc of Object.values(this.state.accounts)) {
      const rec = acc.byTarget[key];
      if (rec) sum += Number(rec.damage) || 0;
    }
    return sum;
  }

  // Accounts seen recently — only these can block a per-account quota.
  participants() {
    const now = Date.now();
    return Object.entries(this.state.accounts)
      .filter(([, a]) => now - (a.lastSeenAt || 0) < this.activeMs);
  }

  // Roster ids (the site's swarming accounts), falling back to whoever has
  // touched the job when no roster was given.
  rosterIds() {
    if (this.state.roster && this.state.roster.length) return this.state.roster.map((r) => r.id);
    return Object.keys(this.state.accounts);
  }

  // Does this roster member still block the advance of target t?
  //  · done (quota banked or the instance died) → never blocks;
  //  · seen within the activity window → blocks (it is online, it owes dmg);
  //  · never claimed anything → blocks during the start grace window only
  //    (staggered logins are normal; a member that shows up hours later
  //    simply joins whichever target the fleet is on);
  //  · seen but gone quiet past the window → stops blocking (offline).
  memberBlocks(id, t) {
    if (this.accountDoneFor(id, t)) return false;
    const acc = this.state.accounts[id];
    const now = Date.now();
    if (acc && acc.lastSeenAt) {
      return now - acc.lastSeenAt < this.activeMs;
    }
    return now - (this.state.startedAt || 0) < this.graceMs;
  }

  // This account's per-fight cap: its own quota left (per_account), or the
  // fleet quota minus what everyone ELSE already banked (total) so the
  // fleet lands on the combined number instead of everyone overshooting.
  capFor(id, t) {
    if (this.state.mode !== 'total') return Math.max(1, t.quota - this.damageFor(id, t.key));
    const mine = this.damageFor(id, t.key);
    return Math.max(1, t.quota - (this.sumDamage(t.key) - mine));
  }

  accountDoneFor(id, t) {
    const rec = this.recFor(id, t.key);
    if (rec && (rec.stopReason === 'SLAIN' || rec.stopReason === 'DEAD')) return true;
    if (this.state.mode === 'total') return this.sumDamage(t.key) >= t.quota;
    return !!rec && rec.damage >= t.quota;
  }

  targetComplete(t) {
    if (t.mobDead) return true;
    if (this.state.mode === 'total') return this.sumDamage(t.key) >= t.quota;
    const roster = this.rosterIds();
    if (!roster.length) return false; // nobody online — never advance blind
    // At least one member must have banked something for the target to be
    // complete on staleness alone (a fleet that never fought stays put).
    const anyBanked = roster.some((id) => (this.recFor(id, t.key) || null) && (this.recFor(id, t.key).damage > 0));
    if (!anyBanked) return false;
    return roster.every((id) => !this.memberBlocks(id, t));
  }

  // Walk the cursor past complete targets; refill or finish at the end.
  // Called before every claim and after every report.
  advanceIfNeeded() {
    if (!this.state.armed) return;
    let guard = 0;
    for (;;) {
      if (++guard > 200) {
        this.log('advance guard hit — stopping the swarm');
        this.finish('stopped');
        return;
      }
      const t = this.currentTarget();
      if (!t) {
        const added = this.state.autoRefill ? this.refillFromBus() : 0;
        if (added) {
          this.log(`auto-refill: ${added} fresh live instance(s) of the queued type(s) joined the queue`);
          continue;
        }
        this.finish('complete');
        return;
      }
      // A wave instance that auto-died on its own timer can never take the
      // remaining damage — mark it and let the fleet move on.
      if (t.kind === 'wave' && !t.mobDead && t.expiresAt && t.expiresAt < Date.now()) {
        t.mobDead = true;
        this.log(`${t.name || `mob ${t.mobId}`}: instance expired before the quota — moving on`);
        this.save();
      }
      if (!this.targetComplete(t)) return;
      const dmg = this.sumDamage(t.key);
      this.log(`${t.name || `mob ${t.mobId}`} done — ${dmg.toLocaleString('en-US')} damage banked` +
        `${t.mobDead ? ' (mob died)' : ''}`);
      this.state.current += 1;
      this.save();
    }
  }

  // ── auto-refill: fresh instances of the queued names, straight off the bus ──
  refillFromBus() {
    if (!this.bus) return 0;
    const names = [...new Set(
      this.state.targets.filter((t) => t.kind === 'wave' && t.name).map((t) => normalizeName(t.name))
    )];
    if (!names.length) return 0;
    const quotasByName = {};
    for (const t of this.state.targets) {
      if (t.kind === 'wave' && t.name) quotasByName[normalizeName(t.name)] = t.quota;
    }
    const used = new Set(this.state.targets.map((t) => String(t.mobId || '')));
    const snap = this.bus.snapshot();
    const added = [];
    for (const m of snap.mobs || []) {
      if (added.length >= REFILL_CAP) break;
      const id = String(m.id || '');
      const nm = normalizeName(m.name);
      if (!id || used.has(id) || !nm) continue;
      if (m.expiresAt && m.expiresAt < Date.now()) continue;
      const hit = names.find((n) => nm.includes(n) || n.includes(nm));
      if (!hit) continue;
      used.add(id);
      added.push(this.makeTarget({
        kind: 'wave', mobId: id, name: m.name, wave: m.wave, waveLabel: m.waveLabel,
        quota: quotasByName[hit], expiresAt: m.expiresAt, refilled: true,
      }));
    }
    if (added.length) this.state.targets.push(...added);
    return added.length;
  }

  // ── Wave swarm: claim / live progress / report ───────────────────────────────
  // The worker calls claim() at the top of every cycle. null → no swarm work
  // for this account right now (done, queue empty, or the current target is
  // a dungeon mob handled inside dungeonCycle()).
  claim(id, nickname) {
    if (!this.state.armed) return null;
    this.touchAccount(id, nickname);
    this.advanceIfNeeded();
    const t = this.currentTarget();
    if (!t || t.kind !== 'wave') return null;
    if (this.accountDoneFor(id, t)) return null;
    return {
      key: t.key,
      kind: t.kind,
      name: t.name,
      mobId: String(t.mobId),
      wave: t.wave,
      waveLabel: t.waveLabel,
      quota: t.quota,
      cap: this.capFor(id, t),
      damageSoFar: this.damageFor(id, t.key),
    };
  }

  // Live mid-fight damage (damage.php replies) — throttled persistence so a
  // long fight shows a moving progress bar without hammering the disk.
  progress(id, key, damage) {
    if (!this.state.armed) return;
    const acc = this.state.accounts[String(id)];
    if (!acc) return;
    const rec = acc.byTarget[key] || (acc.byTarget[key] = { damage: 0, hits: 0 });
    const d = Math.max(0, Number(damage) || 0);
    if (d > rec.damage) rec.damage = d;
    const now = Date.now();
    if (now - this._lastProgressSave > 2000) {
      this._lastProgressSave = now;
      this.save();
    }
  }

  // One swarm engagement ended (or aborted). result is waveCombat's verdict:
  // FINISHED = quota reached, SLAIN/DEAD = the instance can never take more
  // damage (the whole queue moves on), OUT_OF_STAMINA / AUTO_FARM_ON /
  // ERROR = transient — the account retries on a later cycle.
  report(id, { key, result, damage, name } = {}) {
    if (!key) return;
    const t = this.state.targets.find((x) => x.key === key);
    const acc = this.touchAccount(id);
    if (!t) return;
    const rec = acc.byTarget[key] || (acc.byTarget[key] = { damage: 0, hits: 0 });
    const d = Math.max(0, Number(damage) || 0);
    if (d > rec.damage) rec.damage = d; // totaldmgdealt is cumulative per instance
    rec.hits = (rec.hits || 0) + 1;
    const res = String(result || '');
    if (res === 'SLAIN' || res === 'DEAD') {
      t.mobDead = true;
      rec.stopReason = res;
      this.log(`${acc.nickname}: ${name || t.name || `mob ${t.mobId}`} ${res === 'SLAIN' ? 'slain' : 'dead'} — queue moves on`);
    } else if (res === 'FINISHED') {
      rec.stopReason = 'FINISHED';
      this.log(`${acc.nickname}: ${name || t.name || `mob ${t.mobId}`} quota met (${rec.damage.toLocaleString('en-US')}/${t.quota.toLocaleString('en-US')})`);
    } else if (res) {
      rec.lastStop = res; // OUT_OF_STAMINA / AUTO_FARM_ON / ERROR — retried next cycle
    }
    this.advanceIfNeeded();
    this.save();
  }

  // ── Battle intel + vitals (panel decoration) ─────────────────────────────────
  // A worker publishes the current target's monster stats + damage forecast
  // ("≈4,320 dmg/hit · ≈231 hits left · FIRE counters NATURE ×2") once per
  // engagement; the panel reads it straight out of statusView().
  noteIntel(key, intel) {
    if (!key || !intel || typeof intel !== 'object') return;
    if (!this.state.intel || typeof this.state.intel !== 'object') this.state.intel = {};
    this.state.intel[String(key)] = { ...intel, at: Date.now() };
    this.save();
  }

  // Per-account stamina (stats.php top bar / damage.php echoes) so the panel
  // can show WHICH account is waiting for a refill instead of a silent gap.
  noteVitals(id, vitals) {
    const acc = this.state.accounts[String(id || 'unknown')];
    if (!acc || !vitals || typeof vitals !== 'object') return;
    const cur = Math.max(0, Number(vitals.staminaCur) || 0);
    const max = Math.max(0, Number(vitals.staminaMax) || 0);
    acc.vitals = { staminaCur: cur, staminaMax: max, at: Date.now() };
  }

  intelFor(key) {
    const rec = (this.state.intel || {})[String(key)];
    return rec || null;
  }

  // ── Dungeon swarm: the same queue, fought through dungeonCycle()'s filter ────
  claimDungeon(id, nickname) {
    if (!this.state.armed) return null;
    this.touchAccount(id, nickname);
    this.advanceIfNeeded();
    const t = this.currentTarget();
    if (!t || t.kind !== 'dungeon') return null;
    if (this.accountDoneFor(id, t)) return null;
    return { key: t.key, name: t.name, quota: t.quota, cap: this.capFor(id, t) };
  }

  // One dungeon fight ended — damage ACCUMULATES across instances of the
  // same mob type (unlike a wave instance, dungeon mob ids churn per run).
  reportDungeon(id, { key, damage, outcome } = {}) {
    if (!this.state.armed) return;
    const t = key
      ? this.state.targets.find((x) => x.key === key)
      : (this.currentTarget() || null);
    if (!t || t.kind !== 'dungeon') return;
    const acc = this.touchAccount(id);
    const rec = acc.byTarget[t.key] || (acc.byTarget[t.key] = { damage: 0, hits: 0 });
    rec.damage += Math.max(0, Number(damage) || 0);
    rec.hits = (rec.hits || 0) + 1;
    const out = String(outcome || '');
    if (out === 'OUT_OF_STAMINA' || out === 'AUTO_FARM_ON' || out === 'PLAYER_DEAD') rec.lastStop = out;
    this.log(`${acc.nickname}: swarmed ${t.name} +${Number(damage) || 0} ` +
      `(${rec.damage.toLocaleString('en-US')}/${t.quota.toLocaleString('en-US')})${out ? ` · ${out}` : ''}`);
    this.advanceIfNeeded();
    this.save();
  }

  // ── Panel view ───────────────────────────────────────────────────────────────
  statusView() {
    const t = this.currentTarget();
    const now = Date.now();
    const roster = Array.isArray(this.state.roster) ? this.state.roster : [];
    const ids = [...new Set([...Object.keys(this.state.accounts), ...roster.map((r) => r.id)])];
    const accounts = ids.map((id) => {
      const a = this.state.accounts[id]
        || { nickname: (roster.find((r) => r.id === id) || {}).nickname || id, lastSeenAt: 0, byTarget: {} };
      return {
        id,
        nickname: a.nickname,
        lastSeenAt: a.lastSeenAt || 0,
        active: !!a.lastSeenAt && now - a.lastSeenAt < this.activeMs,
        stamina: a.vitals
          ? { cur: a.vitals.staminaCur, max: a.vitals.staminaMax, at: a.vitals.at }
          : null,
        byTarget: Object.fromEntries(Object.entries(a.byTarget).map(([k, r]) => [k, {
          damage: Number(r.damage) || 0,
          hits: r.hits || 0,
          stopReason: r.stopReason || null,
          lastStop: r.lastStop || null,
        }])),
      };
    });
    const targets = this.state.targets.map((x, i) => ({
      key: x.key,
      index: i,
      kind: x.kind,
      name: x.name,
      mobId: x.mobId,
      wave: x.wave,
      waveLabel: x.waveLabel,
      quota: x.quota,
      done: i < this.state.current || this.targetComplete(x),
      mobDead: !!x.mobDead,
      refilled: !!x.refilled,
      damage: this.sumDamage(x.key),
      intel: this.intelFor(x.key),
    }));
    return {
      ok: true,
      armed: this.state.armed,
      status: this.state.status,
      mode: this.state.mode,
      autoRefill: this.state.autoRefill,
      current: this.state.current,
      total: this.state.targets.length,
      currentTarget: t ? {
        key: t.key, kind: t.kind, name: t.name, mobId: t.mobId,
        wave: t.wave, waveLabel: t.waveLabel, quota: t.quota,
        mobDead: !!t.mobDead,
        intel: this.intelFor(t.key),
      } : null,
      targets,
      accounts,
      totalDamage: targets.reduce((s, x) => s + (x.damage || 0), 0),
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
      log: [...this.state.log].slice(-40),
    };
  }
}

module.exports = { SwarmCoordinator, normalizeTargets };
