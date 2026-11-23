'use strict';
// corpses.js — the UNCLAIMED-KILLS corpse sweep (the wave page's own
// "👁️ Show unclaimed kills" button + Monster Quick Loot's loot.php core).
//
// The wave page hides/shows corpses via cookies:
//   hide_dead_monsters=0            → dead cards render (the 👁️ button's state)
//   show_dead_bosses_only=1         → 👑 Dead bosses only — hides every dead
//                                     NON-boss mob (a corpse-sweep filter,
//                                     NOT part of unclaimed kills!)
// A lootable corpse card (.monster-card) carries:
//   data-monster-id, data-dead="1", a Loot button/a (text /\bloot\b/i),
//   data-userdmg (THIS account's damage on the corpse — absent or ≤ 0 means
//   there is nothing to collect), data-expire (sec or ms epoch, optional).
// Collection is the Quick Loot request exactly:
//   POST /loot.php { monster_id, user_id, instance_id: '0' }
//   → JSON { status:'success', message, rewards:{exp,gold}, items:[…] }
// Live-verified 2026-11: killing a mob and NOT looting it leaves it on the
// hide_dead_monsters=0 page with data-userdmg>0 and a Loot button; looting
// it pays gold + equipment + exp ("+128 EXP · 16 gold · 3 items"). With
// show_dead_bosses_only=1 the SAME page hides the mob — the sweep MUST NOT
// set that cookie (the old default silently emptied the unclaimed list).
const { logger, sleep } = require('./util');
const combat = require('./combat');

const LOOT_BTN_RE = /\bloot\b/i;

// Skippable loot failures — the LevelUp Looter's list: these are "nothing to
// collect" replies, not errors (the corpse list may be a few seconds stale).
function isSkippableLootFailure(message) {
  const text = String(message || '').toLowerCase();
  return /monster\s+is\s+not\s+dead\s+yet|not\s+dead\s+yet|already\s+looted|already\s+collected|already\s+claimed|already\s+received|not\s+lootable|no\s+loot|not\s+eligible|invalid\s+monster|monster\s+dead\s+or\s+invalid|nothing\s+to\s+loot|cannot\s+loot/.test(text);
}

// Total dead-loot pages on a wave page: the game renders a
// .batch-loot-card "Dead loot page 1 / 3" counter (the LevelUp Looter's
// getWaveTotalLootPages). Waves with many corpses paginate them.
function parseDeadPages(html) {
  const card = String(html || '').match(/<div[^>]*class=["'][^"']*batch-loot-card[^"']*["'][^>]*>[\s\S]{0,400}?<\/div>/i);
  if (!card || !/Dead loot page/i.test(card[0])) return 1;
  const m = card[0].match(/\/\s*(\d+)/);
  return Math.max(1, m ? parseInt(m[1], 10) || 1 : 1);
}

// expOf — the EXP a loot gave, from every field shape the game has used.
function expOf(json) {
  if (!json) return 0;
  let e = parseInt(
    json.xp_delta ?? (json.rewards && json.rewards.exp) ?? json.exp
    ?? json.exp_gained ?? json.expGained ?? 0,
    10
  );
  if (!Number.isFinite(e)) e = 0;
  if (!e) {
    const m = String(json.message || json.msg || '').match(/([\d,]+)\s*exp/i);
    if (m) e = parseInt(m[1].replace(/,/g, ''), 10) || 0;
  }
  return e;
}

function rewardLine(json) {
  const rw = (json && json.rewards) || {};
  const items = Array.isArray(json && json.items) ? json.items.length : 0;
  return rw.exp || rw.gold || items
    ? `+${(rw.exp || 0).toLocaleString()} EXP · ${(rw.gold || 0).toLocaleString()} gold · ${items} item${items === 1 ? '' : 's'}`
    : '';
}

// Chunk the wave page at .monster-card boundaries (closest-card semantics —
// a neighbour's Loot button or damage can never leak across).
function parseCorpses(html) {
  const text = String(html || '');
  const re = /<div[^>]*class=["'][^"']*monster-card[^"']*["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : undefined);
    const idM = chunk.match(/data-monster-id=["']?(\d+)["']?/i);
    if (!idM || seen.has(idM[1])) continue;
    seen.add(idM[1]);
    const dead = /data-dead=["']?1["']?/i.test(chunk) || /defeated/i.test(chunk);
    if (!dead) continue;
    const hasLootBtn = [...chunk.matchAll(/<(?:button|a)[^>]*>([\s\S]*?)<\/(?:button|a)>/gi)]
      .some((b) => LOOT_BTN_RE.test(String(b[1] || '').replace(/<[^>]*>/g, ' ')));
    if (!hasLootBtn) continue; // already looted / nothing to collect
    const hasDmg = /data-userdmg/i.test(chunk);
    const dmg = parseInt(String((chunk.match(/data-userdmg=["']([\d,]+)["']/i) || [])[1] || '0').replace(/,/g, ''), 10) || 0;
    if (hasDmg && dmg <= 0) continue; // never damaged it → nothing to loot
    const nameM = chunk.match(/<h[1-5][^>]*>([^<]+)</i)
      || chunk.match(/data-(?:monster-)?name=["']([^"']+)["']/i)
      || chunk.match(/class=["'][^"']*(?:monster-name|card-title|name)[^"']*["'][^>]*>([^<]+)</i);
    const expireRaw = parseInt((chunk.match(/data-expire=["']?(\d+)["']?/i) || [])[1] || '0', 10);
    // The game's expiry may be seconds or milliseconds since epoch.
    let expireMs = 0;
    if (expireRaw > 1e12) expireMs = expireRaw;
    else if (expireRaw > 1e9) expireMs = expireRaw * 1000;
    out.push({
      id: idM[1],
      name: nameM ? nameM[1].trim() : `corpse ${idM[1]}`,
      damage: dmg,
      expireMs,
    });
  }
  // Oldest corpse first — those expire first (the Veyra list's order).
  return out.sort((a, b) => (a.expireMs || 9e15) - (b.expireMs || 9e15));
}

// Scan every configured wave page for lootable corpses — ALL dead-loot pages
// (the game paginates them behind ?dead_page=N). opts.bossesOnly restores the
// 👑 dead-bosses-only view (scanCorpses(game, waves, { bossesOnly: true })).
// Restores the cookie state afterwards so normal wave rounds see live
// monsters again.
async function scanCorpses(game, wavePages, opts = {}) {
  const prevHide = game.jar.get('hide_dead_monsters');
  const prevOnly = game.jar.get('show_dead_bosses_only');
  // The 👁️ Show unclaimed kills state: dead mobs visible, boss-only OFF.
  // show_dead_bosses_only=0 is set explicitly (a leftover "1" from anything
  // else would hide every dead non-boss mob from the sweep).
  game.jar.set('hide_dead_monsters', '0');
  game.jar.set('show_dead_bosses_only', opts.bossesOnly ? '1' : '0');
  const corpses = [];
  const failedWaves = [];
  try {
    for (const wave of wavePages || []) {
      try {
        const first = await game.get(`/active_wave.php?${wave.path}`, { redirect: 'manual' });
        corpses.push(...parseCorpses(first.text));
        const totalPages = parseDeadPages(first.text);
        for (let page = 2; page <= totalPages; page++) {
          const res = await game.get(`/active_wave.php?${wave.path}&dead_page=${page}`, { redirect: 'manual' });
          corpses.push(...parseCorpses(res.text));
          await sleep(game.cfg.fastTest ? 5 : 150);
        }
      } catch (e) {
        failedWaves.push(wave.label || wave.path);
      }
      await sleep(game.cfg.fastTest ? 5 : 200);
    }
  } finally {
    if (prevHide == null) game.jar.map.delete('hide_dead_monsters');
    else game.jar.set('hide_dead_monsters', prevHide);
    if (prevOnly == null) game.jar.map.delete('show_dead_bosses_only');
    else game.jar.set('show_dead_bosses_only', prevOnly);
  }
  return { corpses, failedWaves };
}

// POST /loot.php with instance_id='0' — the corpse variant of the request,
// carrying dgmid=monster_id and the battle.php Referer exactly like the
// LevelUp Looter's lootWaveTarget().
async function lootCorpse(game, userId, monsterId) {
  const res = await game.postForm('/loot.php', {
    monster_id: String(monsterId),
    user_id: String(userId || ''),
    dgmid: String(monsterId),
    instance_id: '0',
  }, { headers: { Referer: `${game.base}/battle.php?id=${encodeURIComponent(String(monsterId))}` } });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
  const ok = json.status === 'success';
  const message = ok
    ? (rewardLine(json) || 'looted')
    : String(json.message || json.status || json._raw || 'no reward').slice(0, 120);
  return { ok, exp: ok ? expOf(json) : 0, message, skipped: !ok && isSkippableLootFailure(message) };
}

// Expected EXP per corpse, from its battle page's stat blocks —
//   EXP Cap: ~1,500   ·   EXP / DMG: 0.02
// expectedExp = min(this account's damage on it, cap) × rate. Cached per mob
// name on the client (the LevelUp Looter's monsterCache). Corpses whose
// battle page lacks the blocks read as expectedExp 0 (looted last).
async function annotateExpectedExp(game, corpseList) {
  const cache = game._expMetaCache || (game._expMetaCache = new Map());
  for (const c of corpseList) {
    const key = String(c.name || '').toLowerCase();
    let meta = cache.get(key);
    if (!meta) {
      try {
        const view = await combat.viewBattle(game, c.id);
        meta = { cap: (view && view.expCap) || 0, rate: (view && view.expRate) || 0 };
      } catch (_) { meta = { cap: 0, rate: 0 }; }
      cache.set(key, meta);
    }
    c.expectedExp = Math.floor(Math.min(c.damage || 0, meta.cap || 0) * (meta.rate || 0));
  }
  // Best EXP first — fewer loots to cover the level gap (the LevelUp
  // Looter's expectedExp sort).
  corpseList.sort((a, b) => (b.expectedExp || 0) - (a.expectedExp || 0));
  return corpseList;
}

// Sweep corpses. Stop conditions:
//   maxLoot      — hard per-sweep cap
//   requiredExp  — stop once this much EXP was collected ("loot to level up");
//                  with it set, corpses are ordered by expected EXP first
async function lootCorpses(game, userId, corpseList, opts = {}) {
  const maxLoot = Math.max(1, Number(opts.maxLoot) || 25);
  const gapMs = opts.fastTest ? 5 : 450;
  const requiredExp = Number(opts.requiredExp) || 0;
  if (requiredExp > 0) await annotateExpectedExp(game, corpseList);
  const result = { looted: 0, expGained: 0, leveledUp: false, messages: [], skipped: 0 };
  for (const corpse of corpseList) {
    if (result.looted >= maxLoot) break;
    if (requiredExp > 0 && result.expGained >= requiredExp) { result.leveledUp = true; break; }
    let r;
    try {
      r = await lootCorpse(game, userId, corpse.id);
    } catch (_) {
      result.skipped++;
      continue;
    }
    if (r.ok) {
      result.looted++;
      result.expGained += r.exp;
      result.messages.push(`${corpse.name}: ${r.message}`);
    } else if (r.skipped) {
      result.skipped++; // stale corpse — nothing to collect, not an error
    } else {
      result.skipped++;
      result.messages.push(`${corpse.name}: ${r.message}`);
    }
    await sleep(gapMs);
  }
  if (requiredExp > 0 && result.expGained >= requiredExp) result.leveledUp = true;
  logger.debug(`corpses: looted ${result.looted}/${corpseList.length} (+${result.expGained} EXP)`);
  return result;
}

module.exports = {
  expOf,
  rewardLine,
  isSkippableLootFailure,
  parseDeadPages,
  parseCorpses,
  scanCorpses,
  lootCorpse,
  annotateExpectedExp,
  lootCorpses,
};
