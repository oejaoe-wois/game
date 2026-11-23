'use strict';
// dungeons.js — guild dungeon farming (port of DungeonCleaner 1.8.0's HTTP
// core: discovery.js + farmer.js + api.js, DOM walking replaced by regex).
//
//   GET  /guild_dungeon.php                 the hub: links to open instances
//                                           (guild_dungeon_instance.php?id=N,
//                                           guild_dungeon_enter.php?id=N);
//                                           the hub is the source of truth for
//                                           what is open right now
//   GET  /guild_dungeon_instance.php?id=N   the instance: location pins
//                                           guild_dungeon_location.php
//                                           ?instance_id=X&location_id=Y
//   GET  /guild_dungeon_location.php?…      the floor: one .mon card per
//                                           monster with a battle.php link
//                                           carrying dgmid + instance_id
//   POST /dungeon_join_battle.php           { instance_id, dgmid }
//   POST /damage.php                        { instance_id, dgmid, skill_id,
//                                             stamina_cost }  (Slash = 1)
//   POST /dungeon_loot.php                  { instance_id, dgmid, user_id }
//                                           collects a dead mob's rewards
//
// damage.php replies keep the wave shape: { status, message, hp:{value,max,
// percent}, stamina, totaldmgdealt }. The message branches are DungeonCleaner's
// exact rules: you are dead → revive/heal; already dead → move on; "not
// joined / inactivity" → re-join once and retry; "not enough stamina" → the
// caller's potion ladder.
//
// ── instance id lifecycle (live-server verified) ──────────────────────────
// guild_dungeon_enter.php?id=N / guild_dungeon_instance.php?id=N ids are
// PER-OPEN and globally monotonic (4571 → 16025 → 17110 → 17211 …): every
// time a new dungeon opens it gets a fresh id, so ids must NEVER be cached
// across cycles — the hub is re-read every run and is the only source of
// truth. Per DAY the guild can have one open dungeon of each kind; a run
// stays open until it is CLEARED or the leader/vice CLOSE it. Uncleared
// runs linger on the hub's ".grid.ended" sections as "Status: ended — Not
// looted — Awaiting leader/vice to loot" or "Status: failed — No loot",
// with their mobs locked ("view-only (ended)") — nothing a member can farm,
// so the cycle skips ended instances entirely instead of burning requests
// on them for days.
const { logger, sleep } = require('./util');

const SKILL = { id: 0, name: 'Slash', cost: 1 }; // DungeonCleaner SKILLS[0]

// ── Named dungeon rosters (the LevelUp Looter's source map) ────────────────
// guild_dungeon.php cards carry guild_dungeon_enter.php?id= links, a .h
// title and a STABLE kind link (dungeon_info.php?id=K); the title or kind
// id classifies the instance, and each dungeon has FIXED location rosters
// (mob floors + boss floors) — no per-instance pin parsing needed for the
// named ones.
const LOCATION_NAMES = {
  1: 'Brood Pits', 2: 'Plunder Warrens', 3: 'Shattered Stone Causeways', 4: 'Territory Center', 5: 'Boss Room',
  6: "The Vizier's Conspiracy Hall", 7: 'Hall of the Bloodbound', 8: 'Room of Beasts', 9: 'Room of the Dead Crown',
  10: 'The True Heir Throne', 11: 'Gate Prism', 12: 'Ash Lane', 13: 'Crown Lens', 14: 'Polyhedral Boss Room',
};
const DUNGEON_ROSTERS = {
  easy: { key: 'easy', label: 'Shadowbridge Warrens', match: /shadowbridge/i, mobLocs: [1, 2, 3, 4], bossLocs: [5] },
  hard: { key: 'hard', label: 'Castle of the Fallen Prince', match: /castle/i, mobLocs: [6, 7, 8, 9], bossLocs: [6, 7, 8, 9, 10] },
  poly: { key: 'poly', label: 'The Polyhedral Crucible', match: /polyhedral/i, mobLocs: [11, 12, 13], bossLocs: [14] },
};
// The hub cards' dungeon_info.php?id= links are the DUNGEON KIND ids —
// stable across days (the instance id churns every open, one open per kind
// daily). Kind 3 (the Polyhedral Crucible) is the "Cube Layout" dungeon:
// its instance page redirects to guild_dungeon_cube.php, so poly runs go
// through the cube node flow (fixed roster as fallback).
const DUNGEON_KIND_BY_INFO = { 1: 'easy', 2: 'hard', 3: 'poly' };
// Expected loot EXP per named dungeon boss: exp = min(your damage, dmgLimit)
// × expRatio (the LevelUp Looter's BOSS_STATS — used to loot the best bosses
// first when covering a level gap).
const BOSS_STATS = {
  'prince grixkar the hybrid': { expRatio: 0.01, dmgLimit: 3000000000 },
  'the goblin royal vizier': { expRatio: 0.01125, dmgLimit: 4800000000 },
  'vorrak the bloodbound berserker': { expRatio: 0.01125, dmgLimit: 4800000000 },
  'grimgrowl the chimera': { expRatio: 0.01125, dmgLimit: 4800000000 },
  'drazhul the broken crown': { expRatio: 0.01125, dmgLimit: 4800000000 },
  'khaal the abomination prince': { expRatio: 0.011, dmgLimit: 6000000000 },
  'the polyhedral apex': { expRatio: 0.0115, dmgLimit: 9600000000 },
};

const MSG = {
  playerDead: /(you are|you're)\s+(dead|defeated|knocked)|revive in|need to (heal|revive)/i,
  mobDead: /already (dead|defeated|killed)|monster (is )?(dead|defeated)/i,
  rejoin: /inactivity|rejoin|removed|not joined|must join|join the battle/i,
  stamina: /stamina|not enough/i,
  autoFarm: /auto farm/i,
};

// ── guild identity (who does this account fight for?) ─────────────────────
// Every guild-aware page embeds the caller's own guild right in its script:
//   `const guildId     = 32;`  (guild_dungeon.php hub, guild dashboards).
// guild_dash.php ignores any ?guild_id= param — it always answers with the
// CALLER's guild — so it is the verification source for the panel's guild
// code: its <h1> carries both the tag and the full name ("[ DA ] Dagorath
// Alliance"). Dungeon instances listed on the hub are the caller's own
// guild's runs, and the cube's weekly leaderboard scores BY guild — so a
// wrong-guild worker would farm someone else's mobs and credit their guild.
const GUILD_ID_RE = /guildId\s*=\s*(\d+)/;

function parseGuildId(html) {
  const m = String(html || '').match(GUILD_ID_RE);
  return m ? m[1] : null;
}

// guild_dash.php <h1>: "[ DA ]" + "Dagorath Alliance" → {tag: 'DA', name:
// 'Dagorath Alliance'}. Older layouts put it in one line — both shapes fold
// to the same flat string before parsing.
function parseGuildIdentity(html) {
  const h1 = String(html || '').match(/<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  if (!h1) return null;
  const flat = h1[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^\[([^\[\]]{1,12})\]\s*(.*)$/);
  if (!m) return { tag: null, name: flat || null };
  return { tag: m[1].trim(), name: (m[2] || '').trim() || null };
}

// The caller's own guild. One GET; the game forces the session's guild.
async function fetchOwnGuild(game) {
  const res = await game.get('/guild_dash.php', { redirect: 'manual' });
  if (game.looksLikeLogin(res.text)) return null;
  const id = parseGuildId(res.text);
  const identity = parseGuildIdentity(res.text);
  if (!id && !(identity && (identity.tag || identity.name))) return null;
  return { id, tag: identity ? identity.tag : null, name: identity ? identity.name : null };
}

// Does the account's guild code (the panel's optional "guild code" field)
// match the guild the game reports for this session? The code may be the id
// ("32"), the tag ("DA" or "[DA]") or the full name — all case-insensitive.
// No code / no guild detected = no opinion (the engine proceeds; the hub only
// ever lists the session's own guild runs anyway).
function guildMatches(code, guild) {
  const c = String(code || '').trim().toLowerCase().replace(/^\[+|\]+$/g, '').trim();
  if (!c || !guild) return false;
  if (guild.id != null && c === String(guild.id).toLowerCase()) return true;
  if (guild.tag && c === String(guild.tag).toLowerCase().replace(/^\[+|\]+$/g, '').trim()) return true;
  if (guild.name && c === String(guild.name).toLowerCase()) return true;
  return false;
}

// Merge a freshly scanned guild identity into the cached one. The panel
// serves accounts from DIFFERENT guilds, and people switch guilds — so when
// the game reports a DIFFERENT id than the cache holds, the cached tag/name
// are dropped (they belong to the old guild and would both mislabel the
// panel and falsely verify an old-guild code). Same id → next's values fill
// the cache's gaps. Returns a fresh flat {id, tag, name} object (or null).
function mergeGuild(prev, next) {
  const n = next && (next.id != null || next.tag || next.name)
    ? { id: next.id != null ? next.id : null, tag: next.tag || null, name: next.name || null }
    : null;
  if (!n) return prev ? { id: prev.id != null ? prev.id : null, tag: prev.tag || null, name: prev.name || null } : null;
  const switch_ = prev && prev.id != null && n.id != null && String(prev.id) !== String(n.id);
  if (!prev || switch_) return n;
  return {
    id: n.id != null ? n.id : prev.id,
    tag: n.tag || prev.tag || null,
    name: n.name || prev.name || null,
  };
}

function damageFromMessage(message) {
  const m = String(message || '').match(/([\d,]+)<\/strong>\s*damage/i)
    || String(message || '').match(/([\d,]+)\s*damage/i);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

// ── discovery ────────────────────────────────────────────────────────────────
// The named cards on the hub: .grid (active) / .grid.ended wrappers with
// .card children, each carrying a guild_dungeon_enter.php?id= link and a .h
// title. The title classifies the dungeon (shadowbridge → easy, castle →
// hard, polyhedral → poly); instances of the same key collapse to the
// HIGHEST id (the LevelUp Looter's reduceToHighest — the freshest run).
function parseDungeonCards(html) {
  const text = String(html || '');
  const grids = [];
  const gridRe = /<div[^>]*class=["'][^"']*\bgrid\b[^"']*["'][^>]*>/gi;
  let gm;
  while ((gm = gridRe.exec(text)) !== null) grids.push({ index: gm.index, ended: /\bended\b/i.test(gm[0]) });
  const out = [];
  for (let i = 0; i < grids.length; i++) {
    const segEnd = i + 1 < grids.length ? grids[i + 1].index : undefined;
    const seg = text.slice(grids[i].index, segEnd);
    // Chunk the grid at each .card opening tag; a card's chunk runs until the
    // next card (closest-card semantics — titles/links never leak across).
    const marks = [];
    const cardRe = /<div[^>]*class=["'][^"']*\bcard\b[^"']*["'][^>]*>/gi;
    let cm;
    while ((cm = cardRe.exec(seg)) !== null) marks.push(cm.index);
    for (let j = 0; j < marks.length; j++) {
      const chunk = seg.slice(marks[j], j + 1 < marks.length ? marks[j + 1] : undefined);
      const linkM = chunk.match(/guild_dungeon_enter\.php\?[^"'>]*?id=(\d+)/i);
      // No enter link = a kind card with no open run today ("Only leader/vice
      // can open.") — nothing to farm; the leader may open one later and the
      // next cycle's hub re-read picks it up with its fresh instance id.
      if (!linkM) continue;
      const titleM = chunk.match(/class=["'][^"']*\bh\b[^"']*["'][^>]*>([^<]+)</i)
        || chunk.match(/<h[1-6][^>]*>([^<]+)</i);
      const title = titleM ? titleM[1].trim().toLowerCase() : '';
      // Cube-tag like the raw-link parser does: the cube dungeon is broken on
      // the live game and dungeonCycle refuses to enter anything tagged cube.
      const type = /\bcube\b/i.test(title) ? 'cube' : /\bhard\b/i.test(title) ? 'hard' : 'normal';
      let roster = Object.values(DUNGEON_ROSTERS).find((r) => r.match.test(title));
      // Classification: title first, the card's STABLE dungeon_info.php?id=
      // kind id as fallback (survives title renames and the daily id churn).
      // Kind 3 maps to the poly roster — but a card explicitly tagged cube
      // keeps the 'cube' key: same cube node flow, distinct collapse bucket
      // from the named poly runs.
      const infoM = chunk.match(/dungeon_info\.php\?[^"'>]*?id=(\d+)/i);
      if (!roster && infoM) {
        const byKind = DUNGEON_ROSTERS[DUNGEON_KIND_BY_INFO[infoM[1]] || ''] || null;
        roster = byKind && type === 'cube' ? { key: 'cube' } : byKind;
      }
      out.push({
        id: linkM[1],
        name: titleM ? titleM[1].trim() : `Instance #${linkM[1]}`,
        dungeonKey: roster ? roster.key : null,
        kindId: infoM ? infoM[1] : null,
        type,
        ended: grids[i].ended,
      });
    }
  }
  // reduceToHighest per (key, ended)
  const best = new Map();
  for (const card of out) {
    const k = `${card.dungeonKey || 'raw'}:${card.ended ? 'e' : 'a'}`;
    const prev = best.get(k);
    if (!prev || Number(card.id) > Number(prev.id)) best.set(k, card);
  }
  return [...best.values()];
}

function parseInstances(html) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();
  // Link context: the anchor text plus its closest wrapper's early bytes.
  const linkRe = /guild_dungeon_(?:instance|enter)\.php\?[^"'\s>]*?id=(\d+)/gi;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 160), m.index + 260);
    const nameM = ctx.match(/>([^<>]{3,80})<\/a>/i);
    const inst = { id: String(m[1]), type: 'normal', name: nameM ? nameM[1].replace(/\s+/g, ' ').trim() : `Instance #${m[1]}` };
    if (/\bcube\b/i.test(ctx)) inst.type = 'cube';
    else if (/\bhard\b/i.test(ctx)) inst.type = 'hard';
    if (!seen.has(inst.id)) { seen.add(inst.id); out.push(inst); }
  }
  return out;
}

async function discoverInstances(game) {
  const res = await game.get('/guild_dungeon.php', { redirect: 'manual' });
  // Named cards first (active runs before ended runs), raw-link fallback for
  // hub layouts the card parser cannot read.
  const named = parseDungeonCards(res.text);
  if (named.length) return named;
  return parseInstances(res.text);
}

// Locations for an instance: fixed roster when the dungeon is named, else
// the instance page's own pins.
async function resolveLocations(game, instance) {
  const roster = instance.dungeonKey && DUNGEON_ROSTERS[instance.dungeonKey];
  if (roster) {
    const floors = [];
    roster.mobLocs.forEach((loc) => floors.push({ instanceId: instance.id, locationId: String(loc), name: LOCATION_NAMES[loc] || `Location ${loc}`, kind: 'mob' }));
    roster.bossLocs.forEach((loc) => floors.push({ instanceId: instance.id, locationId: String(loc), name: LOCATION_NAMES[loc] || `Location ${loc}`, kind: 'boss' }));
    return floors;
  }
  const locs = await discoverLocations(game, instance);
  return locs.map((l) => ({ ...l, kind: 'mob' }));
}

// Your total damage on a dungeon boss, from its battle page
// (battle.php?dgmid=X&instance_id=Y → #yourDamageValue).
async function fetchBossDamage(game, instanceId, dgmid) {
  try {
    const res = await game.get(
      `/battle.php?dgmid=${encodeURIComponent(String(dgmid))}&instance_id=${encodeURIComponent(String(instanceId))}`,
      { redirect: 'manual' }
    );
    const m = String(res.text || '').match(/id=["']yourDamageValue["'][^>]*>([\d,]+)/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) || 0 : 0;
  } catch (_) {
    return 0;
  }
}

// Expected loot EXP for a named boss: min(damage, dmgLimit) × ratio. The
// ratio comes from the card's own "EXP/dmg" statpill when the floor shows one
// (live values drift — 0.0113 on a card vs 0.01125 in this table), with
// BOSS_STATS as the fallback.
function expectedBossExp(name, damage, expRatio) {
  const stats = BOSS_STATS[String(name || '').toLowerCase()]
    || { expRatio: 0.01, dmgLimit: Number.MAX_SAFE_INTEGER };
  const ratio = Number.isFinite(Number(expRatio)) && Number(expRatio) > 0
    ? Number(expRatio) : stats.expRatio;
  return Math.floor(Math.min(damage || 0, stats.dmgLimit) * ratio);
}

function parseLocations(html, instanceId) {
  const text = String(html || '');
  const out = [];
  const seen = new Set();
  const re = /guild_dungeon_location\.php\?[^"'\s>]*?instance_id=(\d+)[^"'\s>]*?location_id=(\d+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const iid = m[1] || String(instanceId);
    const key = `${iid}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ctx = text.slice(Math.max(0, m.index - 120), m.index + 240);
    const titleM = ctx.match(/title=["']([^"']{3,80})["']/i) || ctx.match(/>([^<>]{3,80})<\/a>/i);
    out.push({
      instanceId: iid,
      locationId: String(m[2]),
      name: titleM ? titleM[1].replace(/\s+—.*$/, '').replace(/\s*\((boss)\)/i, '').replace(/\s+/g, ' ').trim() : `Location ${m[2]}`,
    });
  }
  return out;
}

async function discoverLocations(game, instance) {
  const res = await game.get(`/guild_dungeon_instance.php?id=${encodeURIComponent(instance.id)}`, { redirect: 'manual' });
  return parseLocations(res.text, instance.id);
}

// ── the cube (The Polyhedral Crucible) ────────────────────────────────────
// Cube instances are NOT regular instance pages: guild_dungeon_instance.php
// redirects to guild_dungeon_cube.php?instance_id=X — a JS page embedding its
// whole run state as `const STATE = {…}` (six faces, nodes, edges, leaders).
// Combat nodes carry linked_location_id pointing at the SAME
// guild_dungeon_location.php floors every other dungeon uses (11–13 mob
// rooms, 14 the Apex gate on the live server), and the server maps the
// enter_node POST to that floor: {ok:true, redirect:'guild_dungeon_location.php…',
// state:{…}}. The direct GET on the linked floor works too, so the engine
// walks available combat nodes (best-effort enter — it keeps run progress,
// unlocks and army tallies coherent server-side), then farms the floors with
// the regular loot/fight machinery.
const CUBE_STATE_RE = /const\s+STATE\s*=\s*(\{[\s\S]*?\});\s*(?:\n|<\/script>)/;

function parseCubeState(html) {
  const m = String(html || '').match(CUBE_STATE_RE);
  if (!m) return null;
  try {
    const state = JSON.parse(m[1]);
    return Array.isArray(state.nodes) ? state : null;
  } catch (_) { return null; }
}

// POST guild_dungeon_cube_action.php {action:'enter_node', instance_id,
// node_id, face_key}. Best-effort: a refused entry (hidden/locked node, army
// room, already cleared) is surfaced as {ok:false,message}, never fatal.
async function enterCubeNode(game, instanceId, node) {
  try {
    const res = await game.postForm('/guild_dungeon_cube_action.php', {
      action: 'enter_node',
      instance_id: String(instanceId),
      node_id: String(node.id),
      face_key: String(node.face_key || ''),
    });
    let json = {};
    try { json = JSON.parse(res.text); } catch (_) { /* HTML error page */ }
    return { ok: json.ok === true, redirect: json.redirect || null, message: json.message || null };
  } catch (e) {
    return { ok: false, redirect: null, message: e.message };
  }
}

// Floors for a cube instance: the cube page's available combat nodes (their
// linked_location_id), each entered once on the way in. Falls back to the
// fixed poly roster when the STATE blob cannot be read (page changed) —
// the live locations 11/12/13/14 are stable, and direct floor GETs work
// without entering.
async function resolveCubeLocations(game, instance, notes) {
  const roster = DUNGEON_ROSTERS.poly;
  try {
    const res = await game.get(
      `/guild_dungeon_cube.php?instance_id=${encodeURIComponent(instance.id)}`, { redirect: 'manual' }
    );
    const state = parseCubeState(res.text);
    if (state) {
      const entered = [];
      const floors = [];
      const seen = new Set();
      for (const node of state.nodes) {
        const locId = Number(node.linked_location_id) || 0;
        if (!locId || seen.has(locId)) continue;
        seen.add(locId);
        const available = (node.status || 'available') === 'available' && !node.is_cleared;
        if (available) {
          const r = await enterCubeNode(game, instance.id, node);
          entered.push({ node: node.id, name: node.name || node.key || '?', ok: r.ok });
          await game.pace(300, 700);
        }
        floors.push({
          instanceId: instance.id,
          locationId: String(locId),
          name: LOCATION_NAMES[locId] || `Location ${locId}`,
          kind: (node.is_boss_gate || (roster && roster.bossLocs.includes(locId))) ? 'boss' : 'mob',
          node: node.id,
        });
      }
      if (notes && entered.length) {
        notes.push(`cube ${instance.id}: entered ${entered.filter((e) => e.ok).length}/${entered.length} nodes`);
      }
      if (floors.length) return floors;
    }
    if (notes) notes.push(`cube ${instance.id}: no STATE nodes — fixed poly roster fallback`);
  } catch (e) {
    if (notes) notes.push(`cube ${instance.id}: ${e.message} — fixed poly roster fallback`);
  }
  return resolveLocations(game, { ...instance, dungeonKey: 'poly' });
}

// ── mobs on a location floor ─────────────────────────────────────────────────
// .mon cards: <div class="mon …"> … <a href="battle.php?instance_id=X&dgmid=Y">⚔ Fight</a> …
function parseDungeonMobs(html, fallbackInstanceId) {
  // Page-level chrome (the hidden loot-all modal, footers) can sit AFTER the
  // last .mon card in the markup — its classes/texts would otherwise bleed
  // into the last mob's chunk ("Loot Collected" reads like a lootable
  // corpse). Cuts only count when they come after the first mob card; the
  // potion drawer, for one, lives at the TOP of the page and must not cut
  // anything.
  const CUT_RES = [/id=["']lootAllModal["']/i, /<footer\b/i];
  const full = String(html || '');
  let text = full;
  const re0 = /<div[^>]*class=["'][^"']*\bmon\b[^"']*["'][^>]*>/i;
  const firstMon = full.search(re0);
  if (firstMon > 0) {
    const cut = Math.min(...CUT_RES.map((x) => {
      const m = full.slice(firstMon).search(x);
      return m > 0 ? firstMon + m : Infinity;
    }));
    if (Number.isFinite(cut)) text = full.slice(0, cut);
  }
  const re = /<div[^>]*class=["'][^"']*\bmon\b[^"']*["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : undefined);
    // Param order varies (instance_id first on the real floors) — try that
    // shape first, then the dgmid-first shape.
    const instFirst = chunk.match(/battle\.php\?[^"'>]*?instance_id=(\d+)[^"'>]*dgmid=(\d+)/i);
    let instanceId = fallbackInstanceId;
    let dgmid = null;
    if (instFirst) {
      instanceId = instFirst[1];
      dgmid = instFirst[2];
    } else {
      const dgFirst = chunk.match(/battle\.php\?[^"'>]*?dgmid=(\d+)/i);
      if (dgFirst) dgmid = dgFirst[1];
      const iidM = chunk.match(/instance_id=(\d+)/i);
      if (iidM) instanceId = iidM[1];
    }
    if (!dgmid || seen.has(dgmid)) continue;
    seen.add(dgmid);
    const nameM = chunk.match(/<h[1-6][^>]*>([^<+]+)</i)
      // class tokens are the mob card's own — a generic "name|title" match
      // once caught the page's loot modal ("lootall-title") on 2026-11 floors
      || chunk.match(/class=["'][^"']*\b(?:mon-name|mon-title|mon-title-row)\b[^"']*["'][^>]*>([^<+]+)</i)
      || chunk.match(/data-name=["']([^"']+)["']/i)
      // The 2026-11 floor layout: the name sits in a bold ellipsis div that
      // first wraps the state-pill row, then the name as bare text.
      || chunk.match(/font-weight:\s*700[^">]*text-overflow:\s*ellipsis[^>]*>\s*(?:<div[\s\S]*?<\/div>\s*)*([^<]{1,200}?)\s*</i);
    const dead = /data-dead=["']?1["']?/i.test(chunk) || /\bdead\b/i.test(chunk)
      || /defeated/i.test(chunk);
    // The LevelUp Looter's pill parsing: .pill chips on the card tell the
    // exact state — joined ('joined' / 'already joined' / 'in battle'),
    // looted ('looted'), and page-level 'locked' / 'view-only (ended)'. A
    // corpse is only lootable when you JOINED the fight and haven't
    // collected it yet (category DEAD_LOOTABLE).
    const pills = [...chunk.matchAll(/class=["'][^"']*pill[^"']*["'][^>]*>([^<]*)</gi)]
      .map((p) => p[1].trim().toLowerCase());
    const isJoined = pills.some((p) => p === 'joined' || p.startsWith('joined ')
      || p.includes('already joined') || p.includes('in battle'));
    const isLooted = pills.includes('looted');
    const isLocked = pills.includes('locked') || pills.includes('view-only (ended)');
    let category = 'UNKNOWN';
    if (!dead && !isJoined) category = 'ALIVE_UNJOINED';
    else if (!dead && isJoined) category = 'ALIVE_JOINED';
    else if (dead && !isJoined) category = 'DEAD_UNJOINED';
    else if (dead && isJoined && !isLooted) category = 'DEAD_LOOTABLE';
    else if (dead && isJoined && isLooted) category = 'DEAD_LOOTED';
    // Fallback for pages without pills: dead + a Loot button reads lootable.
    const lootable = (category === 'DEAD_LOOTABLE'
      || (dead && !pills.length && /\bloot\b/i.test(chunk))) && !isLocked;
    const hpM = chunk.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    // The statpill row on 2026-11 floors: Monster Attack / Monster Defense /
    // "Experience per point of damage dealt" (EXP/dmg). The EXP ratio is the
    // REAL loot rate of this exact mob — better than any hardcoded table.
    const atkM = chunk.match(/Monster Attack[\s\S]{0,200}?class=["'][^"']*\bv\b[^"']*["'][^>]*>\s*([\d,]+)/i);
    const defM = chunk.match(/Monster Defense[\s\S]{0,200}?class=["'][^"']*\bv\b[^"']*["'][^>]*>\s*([\d,]+)/i);
    const expdM = chunk.match(/EXP\/dmg[\s\S]{0,200}?class=["'][^"']*\bv\b[^"']*["'][^>]*>\s*([\d.]+)/i);
    out.push({
      instanceId: String(instanceId || fallbackInstanceId),
      dgmid: String(dgmid),
      name: nameM ? nameM[1].trim() : `mob ${dgmid}`,
      dead,
      joined: isJoined,
      looted: isLooted,
      locked: isLocked,
      category,
      lootable,
      atk: atkM ? parseInt(atkM[1].replace(/,/g, ''), 10) : null,
      def: defM ? parseInt(defM[1].replace(/,/g, ''), 10) : null,
      expPerDmg: expdM ? parseFloat(expdM[1]) : null,
      hp: hpM ? { cur: parseInt(hpM[1].replace(/,/g, ''), 10), max: parseInt(hpM[2].replace(/,/g, ''), 10) } : null,
    });
  }
  return out;
}

// The floor page's healbox: while the PLAYER is down the card shows a
// "Dead" pill, a revive countdown and a disabled Heal button
// (startReviveCountdown('healCountdown','healBtn', reviveAtMs, nowMs)).
// Fighting then would only burn joins on "you are dead" replies — the cycle
// stops and waits for the auto-revive instead.
function parsePlayerHealbox(html) {
  const t = String(html || '');
  const dead = /id=["']healCountdown["']/i.test(t) && /revive in/i.test(t);
  const atM = t.match(/reviveAtMs\s*=\s*(\d+)/i);
  return { playerDead: dead, reviveAtMs: dead && atM ? Number(atM[1]) || null : null };
}

async function scanLocation(game, loc) {
  const res = await game.get(
    `/guild_dungeon_location.php?instance_id=${encodeURIComponent(loc.instanceId)}&location_id=${encodeURIComponent(loc.locationId)}`,
    { redirect: 'manual' }
  );
  const mobs = parseDungeonMobs(res.text, loc.instanceId);
  const healbox = parsePlayerHealbox(res.text);
  return { mobs, ...healbox };
}

// ── combat ───────────────────────────────────────────────────────────────────
async function joinDungeonMob(game, mob) {
  try {
    const res = await game.postForm('/dungeon_join_battle.php', {
      instance_id: String(mob.instanceId),
      dgmid: String(mob.dgmid),
    });
    if (res.status < 200 || res.status >= 300) return false;
    const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
    if (ct.includes('application/json')) {
      try {
        const j = JSON.parse(res.text);
        if (j && j.status && j.status !== 'success') return false;
      } catch (_) { /* body lied about JSON — treat as joined */ }
    }
    await sleep(game.cfg.fastTest ? 5 : 500); // JOIN_DELAY_MS
    return true;
  } catch (_) {
    return false;
  }
}

// One Slash (skill 0, cost 1) with DungeonCleaner's message handling.
// Returns: HIT | MOB_DEAD | PLAYER_DEAD | OUT_OF_STAMINA | REJOIN_NEEDED | ERROR
async function dungeonHit(game, mob) {
  let res;
  try {
    res = await game.postForm('/damage.php', {
      instance_id: String(mob.instanceId),
      dgmid: String(mob.dgmid),
      skill_id: String(SKILL.id),
      stamina_cost: String(SKILL.cost),
    });
  } catch (e) {
    return { outcome: 'ERROR', error: e.message };
  }
  if (res.status !== 200 && res.status !== 303) {
    return { outcome: 'ERROR', error: `HTTP ${res.status}` };
  }
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { /* some replies are HTML */ }
  const message = String(json.message || '');
  const lower = message.toLowerCase();

  if (json.stamina != null) game.noteStamina(String(json.stamina).replace(/[,\s]/g, ''));
  if (MSG.autoFarm.test(message)) {
    // The in-game auto-farm is running; the engine never touches it.
    return { outcome: 'AUTO_FARM_ON', json, message };
  }
  if (MSG.playerDead.test(message)) return { outcome: 'PLAYER_DEAD', json, message };
  if (MSG.mobDead.test(message) || (json.status === 'success' && /already/i.test(lower))) {
    return { outcome: 'MOB_DEAD', json, message };
  }
  if (MSG.rejoin.test(lower)) return { outcome: 'REJOIN_NEEDED', json, message };
  if (MSG.stamina.test(lower) && json.status !== 'success') {
    const sm = message.match(/(\d[\d,]*)\s*stamina/i);
    if (sm) game.noteStamina(sm[1].replace(/,/g, ''));
    return { outcome: 'OUT_OF_STAMINA', json, message };
  }

  const hit = damageFromMessage(message);
  const myTotal = json.totaldmgdealt != null ? Number(json.totaldmgdealt) : null;
  return {
    outcome: 'HIT',
    json,
    message,
    damage: hit,
    hp: json.hp ? { cur: json.hp.value ?? null, max: json.hp.max ?? null, percent: json.hp.percent ?? null } : null,
    myTotal,
  };
}

// Fight one mob to death (or until stamina gives out). Mirror of farmer.js
// attackMob() with the rejoin-once rule. `floor` (the guild contracts'
// "min 3m dmg" rule) is reported back: dungeon fights already run to death,
// so the floor only documents whether OUR kill actually counted.
async function fightDungeonMob(game, mob, opts = {}) {
  const betweenHitsMs = opts.betweenHitsMs != null ? opts.betweenHitsMs : (game.cfg.fastTest ? 30 : 300);
  const floor = Math.max(0, Math.floor(Number(opts.floor) || 0));
  const report = { mob: mob.name, dgmid: mob.dgmid, hits: 0, damage: 0, rejoined: 0, floor, floorMet: floor === 0, outcome: null };
  if (!mob.joined) { // pill truth ("not joined" / "already joined") — never double-join
    if (!(await joinDungeonMob(game, mob))) { report.outcome = 'JOIN_FAILED'; return report; }
    mob.joined = true;
  }
  for (;;) {
    const r = await dungeonHit(game, mob);
    if (r.outcome === 'HIT') {
      report.hits++;
      report.damage += r.damage || 0;
      if (r.myTotal != null && opts.cap && r.myTotal >= opts.cap) { report.outcome = 'CAPPED'; break; }
      await sleep(betweenHitsMs);
      continue;
    }
    if (r.outcome === 'REJOIN_NEEDED' && report.rejoined < 1) {
      report.rejoined++;
      await joinDungeonMob(game, mob);
      await sleep(game.cfg.fastTest ? 5 : 200);
      const retry = await dungeonHit(game, mob);
      if (retry.outcome === 'HIT') { report.hits++; report.damage += retry.damage || 0; await sleep(betweenHitsMs); continue; }
      report.outcome = retry.outcome;
      break;
    }
    report.outcome = r.outcome;
    if (floor > 0 && report.damage >= floor) report.floorMet = true;
    if (r.outcome === 'OUT_OF_STAMINA') report.message = r.message;
    break;
  }
  // A mid-fight HIT branch can also end at the floor when the mob died there.
  if (floor > 0 && report.damage >= floor) report.floorMet = true;
  return report;
}

// Collect one dead dungeon mob's rewards. "not dead yet / already looted"
// replies are SKIPPED (stale target), not failed — the LevelUp Looter's
// normalizeLootResponse rule.
async function lootDungeonMob(game, mob, userId) {
  const res = await game.postForm('/dungeon_loot.php', {
    instance_id: String(mob.instanceId),
    dgmid: String(mob.dgmid),
    user_id: String(userId || ''),
  });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = {}; }
  const ok = json.status === 'success';
  const message = String(json.message || (ok ? 'looted' : 'no reward')).slice(0, 120);
  const skipped = !ok && /not\s+dead\s+yet|already\s+looted|already\s+collected|already\s+claimed|nothing\s+to\s+loot|not\s+lootable/i.test(message);
  const exp = ok && json.rewards ? (Number(json.rewards.exp) || 0) : 0;
  return { ok, exp, message, skipped };
}

// One dungeon cycle (the LevelUp Looter + DungeonCleaner blend):
//   hub → guild check → instances (highest id per dungeon) → floors (fixed
//   rosters for named dungeons, cube-node walk for cube-layout ones) → loot
//   DEAD_LOOTABLE corpses (bosses ordered by expected EXP = min(damage,
//   dmgLimit) × ratio) → join + Slash the live ones. Caps itself with
//   maxMobs per cycle.
// INSTANCE LIFECYCLE (live-server verified): instance ids churn every open
// (one open dungeon of each kind per day; a run persists until cleared or
// closed by the leader/vice). The cycle therefore re-reads the hub every
// run — never trusts remembered ids — and SKIPS the hub's ended runs
// ("Status: ended/failed — awaiting leader/vice to loot"): their mobs are
// locked for members, so walking them would only burn requests day after
// day (result.endedSkipped counts them).
// GUILD CODE (opts.guildCode, optional): when the panel account carries one,
// the cycle verifies the session's own guild (hub's `guildId` const; tag/name
// via one guild_dash.php probe, cached by the caller in opts.guild) BEFORE
// fighting — a mismatched account never swings at another guild's mobs.
// CUBE DUNGEONS ARE INCLUDED NOW (they were skipped as "broken" before the
// guild_dungeon_cube.php discovery — they are not): available combat nodes
// are entered, then their linked floors are farmed. The live Polyhedral
// Crucible (dungeon kind 3, "Cube Layout") IS a cube dungeon — its instance
// page redirects to the cube page — so dungeonKey 'poly' runs through the
// cube node flow too (STATE blob → enter_node → linked floors; fixed poly
// roster as fallback). opts.cubeEnabled=false restores the old skip
// (DUNGEON_CUBE=0).
// (DUNGEON_CUBE=0). opts.minDamageFor(name) → number: the per-mob damage
// floor (guild contracts' "min 3m dmg"). Mobs whose max HP is below their
// floor are skipped before any stamina is spent (the kill could never count)
// and every fight reports floorMet.
// Dungeon-mob name match — bidirectional substring on the lowercased names,
// the same semantics the dive targets use ("crucible champion" matches
// "Champion of the Crucible"). Swarm targets are typed by the user against
// the names the panel showed, so exact equality is too brittle.
function mobNameMatch(a, b) {
  const x = String(a || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const y = String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

async function dungeonCycle(game, opts = {}) {
  const maxMobs = Math.max(1, Number(opts.maxMobs) || 6);
  const userId = String(opts.userId || '');
  const guildCode = String(opts.guildCode || '').trim();
  const cubeEnabled = opts.cubeEnabled !== false;
  // SWARM FOCUS (checkbox swarm): opts.swarmTarget = { key, name, cap } —
  // the coordinator's CURRENT queue target. When set, the cycle fights ONLY
  // that mob type and caps each fight at the account's remaining quota;
  // every landed hit is reported back via opts.onSwarmHit({name, damage,
  // outcome}) so the coordinator can bank it and advance the queue.
  const swarm = opts.swarmTarget && opts.swarmTarget.name ? opts.swarmTarget : null;
  const result = { instances: 0, locations: 0, looted: 0, lootExp: 0, fights: [], stopped: null, notes: [], cubeSkipped: 0, endedSkipped: 0, flooredSkipped: 0, flooredMissed: 0, guild: null, guildOk: null, mobNames: [] };
  const mobNamesSeen = new Set();

  let instances = [];
  let hubGuildId = null;
  try {
    const hub = await game.get('/guild_dungeon.php', { redirect: 'manual' });
    if (game.looksLikeLogin(hub.text)) { result.stopped = 'HUB_ERROR'; result.notes.push('session logged out'); return result; }
    hubGuildId = parseGuildId(hub.text);
    result.guild = { id: hubGuildId };
    // Named cards first (active runs before ended runs), raw-link fallback
    // for hub layouts the card parser cannot read.
    instances = parseDungeonCards(hub.text);
    if (!instances.length) instances = parseInstances(hub.text);
  } catch (e) {
    result.stopped = 'HUB_ERROR';
    result.notes.push(e.message);
    return result;
  }

  // ── guild code verification ────────────────────────────────────────────────
  if (guildCode) {
    // Fast path: a numeric code only needs the hub's guildId const.
    let ok = guildMatches(guildCode, { id: hubGuildId });
    if (!ok) {
      // Tag/name codes: resolve the caller's guild identity once (the caller
      // caches the answer in opts.guild and hands it back next cycle).
      let guild = opts.guild || null;
      if (!guild || (!guild.tag && !guild.name)) {
        try { guild = await fetchOwnGuild(game); } catch (_) { guild = null; }
        if (guild) result.guild = { ...guild, id: guild.id || hubGuildId };
      }
      ok = guildMatches(guildCode, guild);
      if (ok && guild) result.guild = { ...guild, id: guild.id || hubGuildId };
    }
    result.guildOk = ok;
    if (!ok) {
      result.stopped = 'GUILD_MISMATCH';
      result.notes.push(
        `guild code "${guildCode}" does not match this session's guild` +
        (hubGuildId ? ` (#${hubGuildId})` : ' (unknown)') + ' — dungeon farm skipped'
      );
      return result;
    }
  }

  // Active runs only. Ended runs (cleared, closed or failed — "awaiting
  // leader/vice to loot") persist on the hub for DAYS but are locked for
  // members: nothing to loot, nothing to fight. Skipping them keeps every
  // cycle's request budget on the runs that actually pay out today.
  const ended = instances.filter((i) => i.ended);
  instances = instances.filter((i) => !i.ended);
  result.endedSkipped = ended.length;
  if (ended.length) {
    result.notes.push(
      `skipped ${ended.length} ended run(s) (awaiting leader/vice loot or failed): ` +
      ended.map((i) => `#${i.id}`).join(', ')
    );
  }
  if (!instances.length) { result.stopped = 'NO_INSTANCES'; return result; }

  for (const inst of instances) {
    if (result.fights.length >= maxMobs) break;
    // Cube layout = tagged cube, named cube, or the Polyhedral Crucible
    // (dungeon kind 3 — its instance page redirects to the cube page).
    const isCube = inst.type === 'cube' || /\bcube\b/i.test(String(inst.name || ''))
      || inst.dungeonKey === 'poly';
    if (isCube && !cubeEnabled) {
      result.cubeSkipped++;
      result.notes.push(`cube dungeon skipped (DUNGEON_CUBE=0): ${inst.name || `#${inst.id}`}`);
      continue;
    }
    result.instances++;
    let locs = [];
    try {
      locs = isCube
        ? await resolveCubeLocations(game, inst, result.notes)
        : await resolveLocations(game, inst);
    } catch (e) {
      result.notes.push(`instance ${inst.id}: ${e.message}`);
      continue;
    }
    result.locations += locs.length;
    for (const loc of locs) {
      if (result.fights.length >= maxMobs) break;
      let scan;
      try {
        scan = await scanLocation(game, loc);
      } catch (e) {
        result.notes.push(`location ${loc.locationId}: ${e.message}`);
        continue;
      }
      const mobs = scan.mobs || [];
      for (const m of mobs) {
        if (m && m.name) mobNamesSeen.add(String(m.name).slice(0, 60));
      }
      result.mobNames = [...mobNamesSeen].slice(0, 40);
      // Player down on this floor: the healbox waits for the auto-revive.
      if (scan.playerDead) {
        result.notes.push(`player dead on "${loc.name}" — waiting for the revive timer`);
        result.stopped = 'PLAYER_DEAD';
        break;
      }
      // Dead first (free rewards), then the live ones. Boss floors get their
      // lootable targets EXP-ranked first (best loot covers the level gap);
      // the card's own EXP/dmg ratio outranks the hardcoded table.
      const lootable = mobs.filter((x) => x.lootable && !x.looted);
      if (loc.kind === 'boss') {
        for (const mob of lootable) {
          mob.damageDealt = await fetchBossDamage(game, mob.instanceId, mob.dgmid);
          mob.expectedExp = expectedBossExp(mob.name, mob.damageDealt, mob.expPerDmg);
        }
        lootable.sort((a, b) => (b.expectedExp || 0) - (a.expectedExp || 0));
      }
      for (const mob of lootable) {
        if (result.looted >= maxMobs) break;
        try {
          const r = await lootDungeonMob(game, mob, userId);
          if (r.ok) { result.looted++; result.lootExp += r.exp || 0; }
          else if (!r.skipped) result.notes.push(`loot ${mob.name}: ${r.message}`);
        } catch (_) { result.notes.push(`loot ${mob.name}: network`); }
        await sleep(game.cfg.fastTest ? 5 : 150);
      }
      // Live mobs. The per-mob damage floor (the guild contracts' "min 3m
      // dmg" rule) is applied before any stamina is spent: a mob whose MAX
      // HP is below the floor can never reach it — our kill would not count,
      // so the cycle skips it and the stamina buys countable mobs instead.
      for (const mob of mobs.filter((x) => !x.dead && !x.locked)) {
        if (result.fights.length >= maxMobs) break;
        // Swarm focus first: when a dungeon target owns the queue, every
        // other live mob is skipped untouched — the stamina only ever buys
        // the mob type the user queued.
        let cap = opts.cap;
        let swarmFight = false;
        if (swarm) {
          if (!mobNameMatch(mob.name, swarm.name)) continue;
          cap = Math.max(1, Number(swarm.cap) || 0);
          swarmFight = true;
        }
        const floor = opts.minDamageFor ? opts.minDamageFor(mob.name) : 0;
        if (floor > 0 && mob.hp && mob.hp.max > 0 && mob.hp.max < floor) {
          result.flooredSkipped++;
          if (result.flooredSkipped <= 4) {
            result.notes.push(`${mob.name}: max HP ${(mob.hp.max).toLocaleString('en-US')} below the ${floor.toLocaleString('en-US')} dmg floor — skipped`);
          }
          continue;
        }
        const fight = await fightDungeonMob(game, mob, { cap, floor, betweenHitsMs: opts.betweenHitsMs });
        if (swarmFight && opts.onSwarmHit) {
          try { opts.onSwarmHit({ name: mob.name, damage: fight.damage || 0, outcome: fight.outcome }); } catch (_) { /* bookkeeping never breaks a fight */ }
        }
        if (floor > 0 && !fight.floorMet && fight.outcome === 'MOB_DEAD') {
          result.flooredMissed++;
        }
        result.fights.push(fight);
        if (fight.outcome === 'OUT_OF_STAMINA') { result.stopped = 'OUT_OF_STAMINA'; break; }
        if (fight.outcome === 'PLAYER_DEAD') { result.stopped = 'PLAYER_DEAD'; break; }
        if (fight.outcome === 'AUTO_FARM_ON') { result.stopped = 'AUTO_FARM_ON'; break; }
        await sleep(game.cfg.fastTest ? 5 : 300);
      }
      if (result.stopped) break;
      await sleep(game.cfg.fastTest ? 5 : 200);
    }
    if (result.stopped) break;
  }
  return result;
}

module.exports = {
  SKILL,
  MSG,
  mobNameMatch,
  LOCATION_NAMES,
  DUNGEON_ROSTERS,
  DUNGEON_KIND_BY_INFO,
  BOSS_STATS,
  damageFromMessage,
  parseGuildId,
  parseGuildIdentity,
  fetchOwnGuild,
  guildMatches,
  mergeGuild,
  parseCubeState,
  enterCubeNode,
  resolveCubeLocations,
  parseDungeonCards,
  parseInstances,
  discoverInstances,
  parseLocations,
  discoverLocations,
  resolveLocations,
  fetchBossDamage,
  expectedBossExp,
  parseDungeonMobs,
  parsePlayerHealbox,
  scanLocation,
  joinDungeonMob,
  dungeonHit,
  fightDungeonMob,
  lootDungeonMob,
  dungeonCycle,
};
