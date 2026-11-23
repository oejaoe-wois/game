'use strict';
// bosses.js — ported boss catalogue + level-group caps from bosses_alt_auto.js.
// The wave paths below are exactly what the extension fetches on
// active_wave.php?gate=X&wave=Y. Edit config/bosses.json to add new bosses —
// the server merges this catalogue with your file at startup.
const fs = require('fs');
const path = require('path');

// Port of CORE_BOSSES (bosses_alt_auto.js lines 23-65).
const CORE_BOSSES = [
  // --- Wave 8 ---
  { id: 1, key: 'gen', name: 'general skarn the radiant bastion', wave: 'gate=3&wave=8' },
  { id: 2, key: 'gen', name: 'general vessir the sunfang duelist', wave: 'gate=3&wave=8' },
  { id: 3, key: 'gen', name: 'general hrazz the dawnflame oathkeeper', wave: 'gate=3&wave=8' },
  { id: 4, key: 'gen', name: 'drakzareth the tyrant lizard king', wave: 'gate=3&wave=8' },
  // --- Wave 9 ---
  { id: 5, key: 'oce', name: 'oceanus the water titan', wave: 'gate=5&wave=9' },
  { id: 10, key: 'pos', name: 'poseidon, the sea emperor', wave: 'gate=5&wave=9' },
  // --- Wave 10 ---
  { id: 6, key: 'pan', name: 'pan, wild herald of hermes', wave: 'gate=5&wave=10' },
  { id: 7, key: 'her', name: 'Hermes, Divine Herald of the Endless Road', wave: 'gate=5&wave=10', phase: 3 },
  // --- Wave 11 ---
  { id: 8, key: 'ori', name: 'orion, eternal hunter of artemis', wave: 'gate=5&wave=11' },
  { id: 9, key: 'art', name: 'Artemis, Lunar Duelist of the Sacred Hunt', wave: 'gate=5&wave=11', phase: 3 },
  // --- Wave 12 ---
  { id: 11, key: 'tri', name: 'triton, herald of the deep crown', wave: 'gate=5&wave=12' },
  { id: 12, key: 'psd', name: 'Poseidon, Sovereign of the Drowned Steps', wave: 'gate=5&wave=12', phase: 3 },
  // --- Wave 13 ---
  { id: 13, key: 'dei', name: 'deimos, herald of panic', wave: 'gate=5&wave=13' },
  { id: 14, key: 'are', name: 'Ares, Sovereign of the Red Bastion', wave: 'gate=5&wave=13', phase: 3 },
  // --- Wave 14 ---
  { id: 15, key: 'asc', name: 'asclepius, herald of golden mercy', wave: 'gate=5&wave=14' },
  { id: 16, key: 'apo', name: 'Apollo, Duelist of the Sun Court', wave: 'gate=5&wave=14', phase: 3 },
  // --- Wave 15 ---
  { id: 19, key: 'nike', name: 'Nike, Herald of Unbroken Victory', wave: 'gate=5&wave=15' },
  { id: 18, key: 'ath', name: 'Athena, Sovereign of the Ivory War Library', wave: 'gate=5&wave=15', phase: 3 },
  // --- Wave 16 ---
  { id: 17, key: 'nem', name: 'Nemesis, Herald of Reckoning', wave: 'gate=5&wave=16' },
  { id: 20, key: 'hera', name: 'Hera, Sovereign of the Crown Court', wave: 'gate=5&wave=16', phase: 3 },
  // --- Wave 17 ---
  { id: 21, key: 'aeo', name: 'Aeolus, Herald of Bound Winds', wave: 'gate=5&wave=17' },
  { id: 22, key: 'zeus', name: 'Zeus, Sovereign of the Storm Throne', wave: 'gate=5&wave=17', phase: 3 },
];

// Port of BOSS_CATEGORY_LIMITS (how many ids per category the scout keeps).
const BOSS_CATEGORY_LIMITS = { generals: 26, oceanus_poseidon: 7, heralds: 40, mains: 16 };

// Port of DEFAULT_CONFIG caps: c1 = lvl 1500-2999, c2 = 3000-4999, c3 = 5000+.
const DEFAULT_CAPS = {
  c1: { gen: { c: true, v: 1e9 }, oce: { c: false, v: 3e9 } },
  c2: {
    gen: { c: true, v: 1e9 }, oce: { c: true, v: 3e9 }, pos: { c: false, v: 3e9 },
    pan: { c: true, v: 3e8 }, ori: { c: true, v: 1e9 },
    tri: { c: true, v: 1e9 }, dei: { c: true, v: 1e9 }, asc: { c: true, v: 1e9 },
    nem: { c: true, v: 1e9 }, nike: { c: true, v: 1e9 }, aeo: { c: true, v: 1e9 },
  },
  c3: {
    gen: { c: true, v: 1e9 }, oce: { c: true, v: 3e9 }, pos: { c: false, v: 3e9 },
    pan: { c: true, v: 3e8 }, ori: { c: true, v: 1e9 }, her: { c: true, v: 5e9 }, art: { c: true, v: 8e9 },
    tri: { c: true, v: 1e9 }, dei: { c: true, v: 1e9 }, asc: { c: true, v: 1e9 },
    psd: { c: true, v: 4e9 }, are: { c: true, v: 4e9 }, apo: { c: true, v: 4e9 },
    nem: { c: true, v: 1e9 }, nike: { c: true, v: 1e9 }, aeo: { c: true, v: 1e9 },
    ath: { c: true, v: 4e9 }, hera: { c: true, v: 4e9 }, zeus: { c: true, v: 4e9 },
  },
};

function getBossCategory(key) {
  if (key === 'gen') return 'generals';
  if (['oce', 'pos'].includes(key)) return 'oceanus_poseidon';
  if (['pan', 'ori', 'tri', 'dei', 'asc', 'nike', 'nem', 'aeo'].includes(key)) return 'heralds';
  if (['her', 'art', 'psd', 'are', 'apo', 'ath', 'hera', 'zeus'].includes(key)) return 'mains';
  return null;
}

// Port of getGroupColumn().
function capsForLevel(level, caps) {
  if (level >= 1500 && level < 3000) return caps.c1;
  if (level >= 3000 && level < 5000) return caps.c2;
  if (level >= 5000) return caps.c3;
  return null;
}

// Merge the shipped catalogue with config/bosses.json (if the user edited it).
function loadBossList(cfg) {
  let list = CORE_BOSSES;
  try {
    const file = path.join(__dirname, '..', 'config', 'bosses.json');
    if (fs.existsSync(file)) {
      const user = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(user.bosses) && user.bosses.length) {
        list = user.bosses
          .filter((b) => b && b.key && b.name && b.wave)
          .map((b, i) => ({ id: b.id != null ? b.id : i + 1, key: b.key, name: String(b.name), wave: String(b.wave), phase: b.phase }));
      }
    }
  } catch (_) { /* fall back to catalogue */ }

  // Optional caps override from env (used by tests and fine-tuning).
  if (cfg && cfg.bossCapsJson) {
    try {
      const ov = JSON.parse(cfg.bossCapsJson);
      for (const group of ['c1', 'c2', 'c3']) {
        if (ov[group]) Object.assign(DEFAULT_CAPS[group], ov[group]);
      }
    } catch (_) { /* ignore malformed override */ }
  }

  return list;
}

module.exports = { CORE_BOSSES, BOSS_CATEGORY_LIMITS, DEFAULT_CAPS, getBossCategory, capsForLevel, loadBossList };
