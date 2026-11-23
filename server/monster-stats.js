'use strict';
// monster-stats.js — the "View Monster Stats" modal, read straight off the
// battle page. Every battle.php?id={mobId} embeds #monsterStatsModal with the
// mob's full stat block (the button the game renders next to the fight):
//
//   <div id="monsterStatsModal" …>
//     <h2>Goblin Skirmisher Stats</h2>
//     <div class="monster-stats-grid">
//       <div class="monster-stat-cell"><span class="label">Attack</span><strong>0</strong></div>
//       <div class="monster-stat-cell"><span class="label">Defense</span><strong>3</strong></div>
//       <div class="monster-stat-cell"><span class="label">Pet Defense</span><strong>1</strong></div>
//       <div class="monster-stat-cell"><span class="label">Equipment Defense</span><strong>1</strong></div>
//       <div class="monster-stat-cell"><span class="label">Element</span><strong>None</strong></div>
//       <div class="monster-stat-cell"><span class="label">Element Rate</span><strong>0%</strong></div>
//       <div class="monster-stat-cell"><span class="label">Rewards Up To</span><strong>LV 300</strong></div>
//       <div class="monster-stat-cell resistance"><span class="label">Crit Rate Resistance</span><strong>0%</strong></div>
//       … Crit Damage / Final Damage / Passive Damage Resistance …
//
// No extra endpoint exists (openMonsterStatsModal() only shows the div), so
// the zero-stamina battle VIEW is the source — the same page the scout and
// the panel peek already fetch. Stats are per mob TYPE, not per instance, so
// the cache is keyed by the mob's name with a 30-minute TTL: fresh enough for
// the ~10-minute instance churn, cheap enough to consult every swarm cycle.
const { logger } = require('./util');
const { normalizeElement } = require('./damage');

const TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // normalizedName → { stats, at }

function toInt(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// "Goblin Skirmisher Stats" → "Goblin Skirmisher" (the h2 minus the suffix).
function nameFromHeading(h2) {
  return String(h2 || '').replace(/\s+Stats\s*$/i, '').trim();
}

// The label/strong pair parser — one pass over the modal's cells.
function parseMonsterStats(html) {
  const text = String(html || '');
  const start = text.indexOf('id="monsterStatsModal"');
  if (start < 0) return null;
  // The modal ends at the next top-level modal div; a bounded window is
  // enough and keeps a malformed page from blowing the regex up.
  const window = text.slice(start, start + 8000);
  const nameM = window.match(/<h2[^>]*>([^<]+)<\/h2>/i);
  const cells = {};
  const re = /<span class="label">([^<]+)<\/span>\s*<strong>([\s\S]*?)<\/strong>/gi;
  let m;
  while ((m = re.exec(window)) !== null) {
    cells[m[1].trim().toLowerCase()] = m[2].trim();
  }
  if (!Object.keys(cells).length) return null;
  const pct = (v) => toInt(String(v).replace(/%/g, ''));
  const elementRaw = String(cells.element || '').trim();
  const stats = {
    name: nameFromHeading(nameM && nameM[1]),
    attack: toInt(cells.attack),
    defense: toInt(cells.defense),                    // monster_def in the formula
    petDefense: toInt(cells['pet defense']),          // monster_pet_defense
    eqDefense: toInt(cells['equipment defense']),     // monster_eq_defense
    element: normalizeElement(elementRaw),            // null for "None"
    elementLabel: elementRaw || 'None',
    elementRate: pct(cells['element rate']),
    rewardsUpToLv: toInt(String(cells['rewards up to'] || '').replace(/lv/i, '')),
    critRateRes: pct(cells['crit rate resistance']),
    critDamageRes: pct(cells['crit damage resistance']),
    finalDamageRes: pct(cells['final damage resistance']),
    passiveDamageRes: pct(cells['passive damage resistance']),
  };
  return stats;
}

// Fetch + parse + cache. Returns { stats, cached } or null (no modal on the
// page — e.g. a boss variant). Read-only: battle VIEW costs no stamina.
async function get(game, mobId, { force = false } = {}) {
  let html = '';
  try {
    const res = await game.get(`/battle.php?id=${encodeURIComponent(String(mobId))}`, { redirect: 'manual' });
    html = res.text || '';
  } catch (e) {
    logger.debug(`monster-stats: battle view for ${mobId} failed: ${e.message}`);
    return null;
  }
  const stats = parseMonsterStats(html);
  if (!stats || !stats.name) return null;
  const key = stats.name.toLowerCase().replace(/\s+/g, ' ').trim();
  const prev = cache.get(key);
  if (!force && prev && Date.now() - prev.at < TTL_MS) return { stats: prev.stats, cached: true };
  const rec = { stats, at: Date.now() };
  cache.set(key, rec);
  return { stats, cached: false };
}

// Previously-learned stats for a mob NAME (panel decoration without a fetch).
function cachedFor(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const rec = cache.get(key);
  if (!rec || Date.now() - rec.at >= TTL_MS) return null;
  return rec.stats;
}

function forget(name) {
  if (name == null) cache.clear();
  else cache.delete(String(name).toLowerCase().replace(/\s+/g, ' ').trim());
}

// One-line chips for logs and the panel.
function describe(stats) {
  if (!stats) return 'no stats';
  return `DEF ${stats.defense} · EQ DEF ${stats.eqDefense} · PET DEF ${stats.petDefense} · ` +
    `${stats.elementLabel}${stats.elementRate ? ` ${stats.elementRate}%` : ''}` +
    (stats.rewardsUpToLv ? ` · rewards ≤ LV ${stats.rewardsUpToLv}` : '');
}

module.exports = { parseMonsterStats, get, cachedFor, forget, describe, TTL_MS };
