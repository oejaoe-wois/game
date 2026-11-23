'use strict';
// loadout.js — the PLAYER half of the damage formula, read from the three
// pages the game already publishes (all read-only):
//
//   stats.php      → #stats-state core.attack (user_attack_stat) + the
//                    #stamina_span top bar (current / max) + the
//                    #elements-pve dialog (the PvE set's combined element
//                    and rate — "FIRE · 25%" — the formula's elemental half)
//   inventory.php  → the "Equipped Items — PvE Attack Set" section: equipped
//                    slot-boxes carry unequipItem(<slot>) and their
//                    "🔪 <span>X</span> ATK" label — equip_atk is the SUM
//   pets.php       → the equipped "PvE Attack Team" section: pet cards carry
//                    <span class="pet-atk" data-attack>X</span> — pet_atk is
//                    the SUM
//
// Cached per GameClient for a few minutes (gear changes are rare; the swarm
// re-checks stamina much more often than the whole loadout).
const { logger } = require('./util');
const { parseStatsState, normalizeState } = require('./stats');
const { normalizeElement } = require('./damage');

const LOADOUT_TTL_MS = 3 * 60 * 1000;
const STAMINA_TTL_MS = 45 * 1000;

function toInt(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// ── inventory.php — equipped PvE Attack Set ATK ──────────────────────────────
// Only slot-boxes with an unequipItem( button count (bag rows carry
// showEquipModal instead — exactly how the page separates worn from bag).
function parseEquippedAtk(html) {
  const text = String(html || '');
  // Cut at the equipped section's title; end at the next section boundary.
  const startM = text.match(/<div class="section-title">[^<]*Equipped Items[^<]*<\/div>/i);
  if (!startM) return { atk: 0, slots: 0 };
  const rest = text.slice(startM.index + startM[0].length);
  const endM = rest.match(/<div class="section["\s>]/i) || rest.match(/<div class="section-title">/i);
  const section = endM ? rest.slice(0, endM.index) : rest.slice(0, 30000);
  let atk = 0;
  let slots = 0;
  for (const chunk of section.split('class="slot-box')) {
    if (!chunk.includes('unequipItem(')) continue;
    const m = chunk.match(/🔪\s*<span[^>]*>([\d,]+)<\/span>\s*ATK/i)
      || chunk.match(/([\d,]+)\s*ATK/i);
    if (m) {
      atk += toInt(m[1]);
      slots++;
    }
  }
  return { atk, slots };
}

// ── pets.php — the equipped PvE Attack Team's combined pet ATK ───────────────
function parsePetAtk(html) {
  const text = String(html || '');
  const startM = text.match(/<div class="section-title">\s*PvE Attack Team\s*<\/div>/i);
  if (!startM) return { atk: 0, pets: 0 };
  const rest = text.slice(startM.index + startM[0].length);
  const endM = rest.match(/<div class="section["\s>]/i) || rest.match(/<div class="section-title">/i);
  const section = endM ? rest.slice(0, endM.index) : rest.slice(0, 30000);
  let atk = 0;
  let pets = 0;
  const re = /class="pet-atk[^"]*"\s+data-attack>?\s*([\d,]+)/gi;
  let m;
  while ((m = re.exec(section)) !== null) {
    atk += toInt(m[1]);
    pets++;
  }
  return { atk, pets };
}

// ── stats.php — attack stat + the live stamina bar ───────────────────────────
function parseStatsPage(html) {
  const text = String(html || '');
  const state = normalizeState(parseStatsState(text));
  const attackStat = state && state.user ? toInt(state.user.ATTACK) : 0;
  const staminaMax = state && state.user ? toInt(state.user.MAX_STAMINA) : 0;
  const bar = text.match(/id="stamina_span">\s*([\d,]+)\s*<\/span>\s*\/\s*([\d,]+)/);
  const stamina = bar
    ? { cur: toInt(bar[1]), max: Math.max(toInt(bar[2]), staminaMax), at: Date.now() }
    : (staminaMax ? { cur: staminaMax, max: staminaMax, at: Date.now() } : null);
  // The PvE set's combined element — stats.php's own aggregate, served in the
  // #elements-pve dialog ("PvE Set: elemental sources"):
  //   <p class="element-result">NONE &middot; 0%</p>   (nothing elemental worn)
  //   <p class="element-result">FIRE &middot; 25%</p>  (elemental gear worn)
  // "PvE combines contributions by element and uses the strongest combined
  // element" — exactly the playerElement / playerElementRate the damage
  // formula wants. NONE (or an unknown word) → null/0.
  let element = null;
  let elementRate = 0;
  const elM = text.match(/id="elements-pve"[\s\S]{0,1200}?class="element-result">\s*([^<]+?)\s*<\/p>/i);
  if (elM) {
    const decoded = elM[1].replace(/&middot;/gi, '\u00B7').replace(/&amp;/g, '&');
    const parts = decoded.split('\u00B7');
    if (parts.length >= 2) {
      const el = normalizeElement(parts[0]);
      if (el) element = el;
      elementRate = toInt(parts[1]);
    }
  }
  return { attackStat, stamina, element, elementRate };
}

// Cheap refresh: the stamina bar only (one stats.php GET when stale).
// game.scanVitals() already folds every HTML page's bar into lastStamina —
// this only forces a fetch when the passive value is too old.
//
// authoritative: the passive fold is a bar that RODE ALONG on whatever page
// the client fetched — it can carry a value that was true when the page was
// SERVED and wrong by the time the caller decides (the live swarm gate once
// trusted a seconds-old page bar and spent a join POST on a dry account).
// With authoritative=true only folds whose SOURCE is the game's own live
// number count as fresh: stats.php itself (stamped after the fetch below) or
// a damage.php stamina echo (noteStamina). Anything else forces one
// stats.php GET — the swarm gate's contract: stats.php is the source of truth.
async function staminaNow(game, { maxAgeMs = STAMINA_TTL_MS, authoritative = false } = {}) {
  const last = game.lastStamina;
  const fresh = last && Date.now() - last.at < maxAgeMs;
  if (fresh && (!authoritative || last.src === 'stats')) return last;
  try {
    await game.get(`/stats.php?_t=${Date.now()}`, { redirect: 'manual' });
    if (game.lastStamina) game.lastStamina.src = 'stats'; // this fold came off stats.php
  } catch (e) {
    logger.debug(`loadout: stamina refresh failed: ${e.message}`);
  }
  return game.lastStamina; // scanVitals picked it up (or the old value stands)
}

// Full loadout with per-client caching (game.lastLoadout). Any single page
// failing degrades that one field to 0 — a forecast is always better than
// aborting the swarm over a hiccup.
async function fetchLoadout(game, { force = false } = {}) {
  const prev = game.lastLoadout;
  if (!force && prev && Date.now() - prev.at < LOADOUT_TTL_MS) return prev;

  const out = {
    equipAtk: 0, petAtk: 0, attackStat: 0,
    element: null, elementRate: 0, // filled from stats.php's #elements-pve dialog
    stamina: (game.lastStamina && Date.now() - game.lastStamina.at < STAMINA_TTL_MS) ? game.lastStamina : null,
    at: Date.now(),
  };
  // Sequential with the engine's usual pacing — three pages back to back,
  // never a parallel burst (every other module walks the same way).
  const statsRes = await game.get(`/stats.php?_t=${Date.now()}`, { redirect: 'manual' }).catch(() => null);
  await game.pace(400, 900);
  const invRes = await game.get(`/inventory.php?set=attack&_t=${Date.now()}`, { redirect: 'manual' }).catch(() => null);
  await game.pace(400, 900);
  const petRes = await game.get(`/pets.php?_t=${Date.now()}`, { redirect: 'manual' }).catch(() => null);

  if (statsRes) {
    const s = parseStatsPage(statsRes.text);
    out.attackStat = s.attackStat;
    out.element = s.element;
    out.elementRate = s.elementRate;
    if (s.stamina) out.stamina = s.stamina;
  }
  if (invRes) {
    const eq = parseEquippedAtk(invRes.text);
    out.equipAtk = eq.atk;
    out.equipSlots = eq.slots;
  }
  if (petRes) {
    const pets = parsePetAtk(petRes.text);
    out.petAtk = pets.atk;
    out.petCount = pets.pets;
  }
  game.lastLoadout = out;
  return out;
}

function forget(game) {
  delete game.lastLoadout;
}

module.exports = {
  parseEquippedAtk,
  parsePetAtk,
  parseStatsPage,
  fetchLoadout,
  staminaNow,
  forget,
  LOADOUT_TTL_MS,
  STAMINA_TTL_MS,
};
