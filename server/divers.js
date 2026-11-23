'use strict';
// divers.js — "Divers", the engine's own hunting system (as opposed to the
// game's built-in auto-farmer, which is PAUSED on every account so hunting
// works at all).
//
// A diver is a farm account that DIVES into a wave/event page, finds the
// mobs the user picked for that account and hunts exactly those — live mob
// ids are never cached because every mob auto-dies after ~10 minutes and a
// NEW instance id takes its slot.
//
// Two halves live here:
//
//   1. Dive targets (per account): a comma-separated keyword list ("goblin
//      skirmisher, troll ravager") stored on the account row. A diver with
//      targets attacks those mobs FIRST on every page it sweeps; with
//      DIVE_ONLY=1 it attacks NOTHING else (pure target hunting — stamina
//      only ever buys the mobs the user named).
//
//   2. Event waves (dynamic registry): the four fixed pillars (gates,
//      battle pass, PvP, events) share one wave registry. Event pages
//      (event_page.php?event=N) rotate, so a diver discovers their wave
//      links at sweep time — dashboard event cards → event pages →
//      active_wave.php?event=N&wave=M — and the discovered waves join the
//      round-robin and the scout sweep alongside config/waves.json. The
//      discovery persists to data/event-waves.json so restarts keep hunting
//      an event that is still live without re-probing first.
const fs = require('fs');
const path = require('path');
const { logger } = require('./util');

// ── 1) Dive targets ──────────────────────────────────────────────────────────

// "Goblin Skirmisher, troll ravager;  Orc Grunt" → lowercased keyword list.
// Empty pieces are dropped; everything is matched as a substring against the
// mob card's name (the same bidirectional semantics as boss matching).
function parseDiveTargets(raw) {
  return [...new Set(
    String(raw || '')
      .split(/[,;\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 32); // 32 keywords is plenty; guards against paste accidents
}

// Does a mob card name match ANY of the account's dive targets?
function matchDive(mobName, targets) {
  const name = String(mobName || '').toLowerCase();
  if (!name || !Array.isArray(targets)) return false;
  return targets.some((t) => name.includes(t) || t.includes(name));
}

// ── 2) Event waves (dynamic registry half) ──────────────────────────────────

const EVENT_WAVES_FILE = 'event-waves.json';

class EventWaveStore {
  constructor(dataDir) {
    this.file = path.join(dataDir || '.', EVENT_WAVES_FILE);
    this.map = new Map(); // path -> { path, label, foundAt }
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const w of raw.waves || []) {
          if (w && w.path) this.map.set(w.path, { path: w.path, label: w.label || w.path, foundAt: w.foundAt || Date.now() });
        }
      }
    } catch (_) { /* corrupt file → start empty */ }
  }

  save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        waves: [...this.map.values()].sort((a, b) => (a.foundAt || 0) - (b.foundAt || 0)),
      }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      logger.debug(`divers: event-wave save failed: ${e.message}`);
    }
  }

  add(waves) {
    let added = 0;
    for (const w of waves || []) {
      if (!w || !w.path || this.map.has(w.path)) continue;
      this.map.set(w.path, { path: w.path, label: w.label || w.path, foundAt: Date.now() });
      added++;
    }
    if (added) this.save();
    return added;
  }

  list() {
    return [...this.map.values()];
  }
}

let eventStore = null;

// Init with the farm's data dir (config.js calls this at boot).
function initEventWaves(dataDir) {
  if (!eventStore) eventStore = new EventWaveStore(dataDir);
  return eventStore;
}

// Event ids from any dashboard-ish page (same pattern events.js uses).
function parseEventIds(html) {
  const ids = [];
  for (const m of String(html || '').matchAll(/event_page\.php\?event=(\d+)/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// Wave links on one event page — the game renders them as
// "active_wave.php?event=13\u0026wave=116" (JSON-escaped &), so BOTH
// spellings are normalized here.
function parseEventWaveLinks(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/active_wave\.php\?event=(\d+)(?:\\u0026|&amp;|&)wave=(\d+)/gi)) {
    const wavePath = `event=${m[1]}&wave=${m[2]}`;
    if (seen.has(wavePath)) continue;
    seen.add(wavePath);
    out.push({ path: wavePath, label: `Event ${m[1]} · wave ${m[2]}` });
  }
  return out;
}

// Discover live event waves: dashboard event cards, then each event page's
// wave links. Every discovered path lands in the persistent store; the return
// value is the FULL merged list (old + new) so callers can just append it.
async function discoverEventWaves(game) {
  if (!eventStore) return [];
  const found = [];
  try {
    const dash = await game.get('/game_dash.php', { redirect: 'manual' });
    const ids = parseEventIds(dash.text);
    await game.pace(700, 1500);
    for (const id of ids.slice(0, 6)) { // events rotate; cap the probe fan-out
      const res = await game.get(`/event_page.php?event=${id}`, { redirect: 'manual' });
      found.push(...parseEventWaveLinks(res.text));
      await game.pace(700, 1500);
    }
  } catch (e) {
    logger.debug(`divers: event discovery failed: ${e.message}`);
    return eventStore.list();
  }
  const added = eventStore.add(found);
  if (added) logger.info(`divers: ${added} event wave(s) discovered and added to the registry`);
  return eventStore.list();
}

// Cached discovery for callers that run every sweep: refresh at most every
// refreshMs (default 15 min), otherwise return the persisted list instantly.
let lastDiscoveryAt = 0;
let lastDiscovery = [];
async function eventWaves(game, refreshMs = 15 * 60 * 1000) {
  if (!eventStore) return [];
  if (Date.now() - lastDiscoveryAt < refreshMs) return lastDiscovery.length ? lastDiscovery : eventStore.list();
  lastDiscoveryAt = Date.now();
  lastDiscovery = await discoverEventWaves(game);
  return lastDiscovery;
}

// Read-only view of the persisted event waves — the worker picker uses this
// (no network): the scout keeps the store fresh with its own discovery.
function storedEventWaves() {
  return eventStore ? eventStore.list() : [];
}

// Merge a base registry with discovered event waves — base entries win on
// path collisions (their labels/rewardCapLv come from config), event waves
// that are already in the base are skipped.
function mergeWaves(base, eventWaves) {
  const seen = new Set((base || []).map((w) => w.path));
  const extra = (eventWaves || []).filter((w) => w && w.path && !seen.has(w.path));
  return [...(base || []), ...extra.map((w) => ({ path: w.path, label: w.label }))];
}

// Reward-level cap steering: the game's wave banners read "Rewards Up To LV
// 300" — past that level the wave still drops gear and items but NO exp and
// gold. Waves whose cap is known and BELOW the account's level sink to the
// back of the rotation (gear-hunting divers can still be pointed at them via
// dive targets; steering never removes a wave outright).
function orderWavesByRewardCap(waves, level) {
  if (!Array.isArray(waves) || !Number.isFinite(level) || level <= 0) return waves;
  const rank = (w) => (w && w.rewardCapLv > 0 && level > w.rewardCapLv ? 1 : 0);
  return [...waves].sort((a, b) => rank(a) - rank(b)); // stable — registry order kept inside each bucket
}

module.exports = {
  parseDiveTargets,
  matchDive,
  initEventWaves,
  discoverEventWaves,
  eventWaves,
  storedEventWaves,
  parseEventIds,
  parseEventWaveLinks,
  mergeWaves,
  orderWavesByRewardCap,
};
