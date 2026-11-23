'use strict';
// hunt.js — the quest hunt: find the guild contract's monster and drive the
// wave picker straight to it.
//
// The Adventurers Guild sell kill contracts against NAMED mobs ("Kill 5
// Lizardman Shadowclaw · min 3m dmg"). Wave farming completes those kills
// only when the round-robin happens to visit a page that hosts the mob —
// Gate 1 · wave 2 (gate=3&wave=5) for the Shadowclaw, out of 13 registry
// pages. The hunt closes that gap:
//
//   • Every wave page the engine parses feeds a persistent NAME→wave map
//     (data/hunt-map.json — keyed by mob name like the loot-cap cache,
//     battle ids rotate every reset but names survive).
//   • While a kill contract is armed (worker.questReq), pickNextWave() goes
//     straight to the remembered wave instead of round-robin.
//   • Unknown mob → the picker marks each visited wave as probed for this
//     name and keeps the round-robin order; the first page that shows the
//     mob pins the hunt. Probes are per-name session state so a second
//     contract for the same mob starts with the knowledge already banked.
//
// Hunt rounds still farm every eligible mob on the pinned page (quest mob
// first — combat sorts contract mobs to the front), so the stamina always
// buys EXP even after the contract kill count is satisfied but not yet
// turned in. QUESTS_HUNT=0 turns the steering off (plain round-robin).
//
// The map starts SEEDED from config/mobs.json (the live-scraped wave
// rosters): a diver or a contract for "troll ravager" pins gate=3&wave=5
// on the very first round instead of round-robin-discovering it. Seed rows
// only fill gaps — a live-learned row always wins — and persist() writes
// learned rows ONLY, so the seed re-applies fresh at every boot and a
// game-side mob move self-heals on the next sweep that sees it elsewhere.
const fs = require('fs');
const path = require('path');
const { logger } = require('./util');

// ── persistent map (data/hunt-map.json) ─────────────────────────────────────
let mapFile = null;
const byName = new Map(); // nameKey → { wave, at }

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function initHuntMap(dataDir) {
  mapFile = null;
  byName.clear();
  if (!dataDir) {
    seedRoster(); // tests: seed even without a data dir (in-memory mode)
    return;
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    mapFile = path.join(dataDir, 'hunt-map.json');
    if (fs.existsSync(mapFile)) {
      const raw = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && v.wave) byName.set(String(k).toLowerCase(), { wave: String(v.wave), at: Number(v.at) || 0 });
      }
    }
  } catch (_) {
    mapFile = null; // corrupt file → in-memory only
  }
  seedRoster(); // config/mobs.json fills the gaps — learned rows win
}

// Seed the map from config/mobs.json (wave → mob names, live-scraped). A
// seeded row carries seed:true and at:0; rememberWaveMobs() replaces it
// wholesale on the first live sighting (which then persists). Returns the
// number of names actually added.
function seedRoster() {
  let added = 0;
  try {
    const file = path.join(__dirname, '..', 'config', 'mobs.json');
    if (!fs.existsSync(file)) return 0;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [wavePath, names] of Object.entries(raw.rosters || {})) {
      if (!wavePath || !Array.isArray(names)) continue;
      for (const n of names) {
        const key = normalizeName(n);
        if (!key || byName.has(key)) continue; // learned rows always win
        byName.set(key, { wave: String(wavePath), at: 0, seed: true });
        added++;
      }
    }
  } catch (_) { /* malformed seed → run on whatever the map learned */ }
  return added;
}

function persist() {
  if (!mapFile) return;
  try {
    const obj = {};
    for (const [k, v] of byName.entries()) {
      if (v.seed) continue; // learned rows only — the seed re-applies at boot
      obj[k] = v;
    }
    const tmp = mapFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, mapFile);
  } catch (_) { /* best-effort */ }
}

// Record every mob name seen on one wave page (called from waveFarmRound
// with the parsed cards — dead or alive, a hosting page stays the pin).
function rememberWaveMobs(wavePath, names) {
  const p = String(wavePath || '');
  if (!p || !Array.isArray(names)) return 0;
  let added = 0;
  const now = Date.now();
  for (const n of names) {
    const key = normalizeName(n);
    if (!key) continue;
    const hit = byName.get(key);
    if (!hit || hit.wave !== p) {
      byName.set(key, { wave: p, at: now });
      added++;
    }
  }
  if (added) persist();
  return added;
}

// Where does this mob live? Exact-key first, then includes() both ways so
// "lizardman shadowclaw" (contract) matches "Lizardman Shadowclaw" (page)
// and contract shorthands like "shadowclaw" match the full name. The `seed`
// flag rides along: a seeded row is the config's guess, not a verified
// sighting — the picker probes seeded pages first but never hard-pins them
// (a wrong seed must never trap a contract on a barren page).
function findMobWave(name) {
  const key = normalizeName(name);
  if (!key) return null;
  const exact = byName.get(key);
  if (exact) return { wave: exact.wave, at: exact.at, matched: key, seed: !!exact.seed };
  for (const [k, v] of byName.entries()) {
    if (k.includes(key) || key.includes(k)) return { wave: v.wave, at: v.at, matched: k, seed: !!v.seed };
  }
  return null;
}

// DEMOTE: the engine farmed a wave the map pinned for a name and saw NO
// matching mob — the pin is stale (the game moved the mob, or the seed was
// wrong for this world). Delete every entry that points at this wave and
// matches one of the given names so the probe/rotation takes over; the next
// live sighting re-pins the mob's real page. Returns the rows removed.
function demoteWave(wavePath, names) {
  const p = String(wavePath || '');
  if (!p) return 0;
  const wanted = (names || []).map(normalizeName).filter(Boolean);
  let removed = 0;
  for (const key of [...byName.keys()]) {
    const hit = byName.get(key);
    if (!hit || hit.wave !== p) continue;
    if (wanted.length && !wanted.some((n) => key.includes(n) || n.includes(key))) continue;
    byName.delete(key);
    removed++;
  }
  if (removed) persist();
  return removed;
}

function knownMobs() {
  return byName.size;
}

module.exports = { initHuntMap, rememberWaveMobs, findMobWave, knownMobs, normalizeName, seedRoster, demoteWave };
