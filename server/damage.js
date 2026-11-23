'use strict';
// damage.js — the exact damage formula the game uses, as one pure module so
// the swarm can FORECAST every engagement before a single stamina point is
// spent:
//
//   base_damage =
//   (
//     225
//     + (max(30, (equip_atk - monster_eq_defense)) * 20)
//     + (max(30, (pet_atk   - monster_pet_defense)) * 20)
//     + (1000 * max(30, (user_attack_stat - monster_def)) ** 0.25)
//   )
//   * stamina_cost;
//
//   elemental_damage =
//   (
//     (player_element_rate - monster_element_rate) * 1500
//   ) * stamina_cost;
//
//   if (element_1 counters element_2) then element_1_rate = element_1_rate × 2
//
// The monster half (Defense / Pet Defense / Equipment Defense / Element /
// Element Rate) comes from the battle page's own "View Monster Stats" modal
// (see monster-stats.js). The player half comes from stats.php (#stats-state
// core.attack) + the equipped PvE Attack Set (inventory.php) + the equipped
// pet team (pets.php) — see loadout.js.
//
// Two honest assumptions, both conservative:
//   · the elemental part never goes NEGATIVE (a rate deficit deals 0 extra
//     damage, never healing the mob) — the game shows no negative damage;
//   · an account with no element equipped has rate 0 — elemental damage is
//     then 0 unless the monster itself carries a rate (still floored at 0).

const ELEMENTS = ['FIRE', 'NATURE', 'FROST', 'THUNDER', 'WATER', 'VOID', 'LIGHT'];

// The game's counter chart (one line per element, exactly as the wiki shows):
//   🔥 FIRE    → 🌿 NATURE, ❄️ FROST
//   🌿 NATURE  → ✨ LIGHT,  🕳️ VOID
//   ❄️ FROST   → 💧 WATER,  ⚡ THUNDER
//   ⚡ THUNDER  → 💧 WATER,  🌿 NATURE
//   💧 WATER   → 🔥 FIRE,   ✨ LIGHT
//   🕳️ VOID    → 🔥 FIRE,   ⚡ THUNDER
//   ✨ LIGHT   → 🕳️ VOID,   ❄️ FROST
const COUNTERS = {
  FIRE: ['NATURE', 'FROST'],
  NATURE: ['LIGHT', 'VOID'],
  FROST: ['WATER', 'THUNDER'],
  THUNDER: ['WATER', 'NATURE'],
  WATER: ['FIRE', 'LIGHT'],
  VOID: ['FIRE', 'THUNDER'],
  LIGHT: ['VOID', 'FROST'],
};

function normalizeElement(el) {
  const up = String(el || '').trim().toUpperCase();
  return ELEMENTS.includes(up) ? up : null;
}

// True when `a` is strong against `b` (a's rate doubles for that part).
function counters(a, b) {
  const x = normalizeElement(a);
  const y = normalizeElement(b);
  if (!x || !y) return false;
  return (COUNTERS[x] || []).includes(y);
}

// Which elements counter `mobElement` — the equip-best preference list (wear
// gear whose element doubles the elemental part against the mob being
// swarmed). Empty array for a None/unknown mob (no preference at all).
function counterOf(mobElement) {
  const m = normalizeElement(mobElement);
  if (!m) return [];
  return Object.keys(COUNTERS).filter((e) => COUNTERS[e].includes(m));
}

function max30(n) {
  return Math.max(30, Number(n) || 0);
}

// The whole forecast in one call. `player`:
//   { equipAtk, petAtk, attackStat, element, elementRate, staminaCost }
// `monster` (monster-stats.js shape):
//   { attack, defense, petDefense, eqDefense, element, elementRate, … }
// Returns every intermediate so the panel can show WHERE the damage comes
// from (equipment wall vs pet wall vs stat wall vs element).
function predictDamage(player, monster) {
  const m = monster || {};
  const p = player || {};
  const cost = Math.max(1, Number(p.staminaCost) || 1);

  const eqDiff = max30((Number(p.equipAtk) || 0) - (Number(m.eqDefense) || 0));
  const petDiff = max30((Number(p.petAtk) || 0) - (Number(m.petDefense) || 0));
  const statDiff = max30((Number(p.attackStat) || 0) - (Number(m.defense) || 0));

  const eqPart = eqDiff * 20;
  const petPart = petDiff * 20;
  const statPart = 1000 * Math.pow(statDiff, 0.25);
  const base = Math.floor((225 + eqPart + petPart + statPart) * cost);

  // Elemental: the HIGHEST equipped rate counts; countering doubles it for
  // this part only (per the formula).
  let rate = Number(p.playerElementRate) || 0;
  const countered = counters(p.playerElement, m.element);
  if (countered) rate *= 2;
  const rawElemental = (rate - (Number(m.elementRate) || 0)) * 1500;
  const elemental = Math.max(0, Math.floor(rawElemental * cost));

  return {
    base,
    elemental,
    total: base + elemental,
    parts: { flat: 225, eqPart, petPart, statPart: Math.floor(statPart) },
    floored: {
      eq: eqDiff === 30 && (Number(p.equipAtk) || 0) - (Number(m.eqDefense) || 0) < 30,
      pet: petDiff === 30 && (Number(p.petAtk) || 0) - (Number(m.petDefense) || 0) < 30,
      stat: statDiff === 30 && (Number(p.attackStat) || 0) - (Number(m.defense) || 0) < 30,
    },
    elementRateUsed: rate,
    countered,
    staminaCost: cost,
  };
}

// Hits an account still owes to reach `quota` at `perHit` damage.
function hitsFor(quota, perHit) {
  const q = Math.max(0, Number(quota) || 0);
  const h = Math.max(1, Number(perHit) || 1);
  return Math.ceil(q / h);
}

// Average of the fleet's per-hit forecasts — the panel's "≈N hits" hint.
function avgHit(list) {
  const nums = (list || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return 0;
  return Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);
}

module.exports = {
  ELEMENTS,
  COUNTERS,
  normalizeElement,
  counters,
  counterOf,
  predictDamage,
  hitsFor,
  avgHit,
};
