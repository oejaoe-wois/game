'use strict';
// loot.js — per-mob damage caps, learned from the game's own loot tables.
//
// Every battle page (battle.php?id=…) renders the mob's drop table with a
// damage gate per item: "DMG req: 70,000". Dealing more damage than the top
// requirement buys NOTHING extra — the rest of the stamina is pure waste.
// This module is the Node port of the console loot scanner:
//
//   parseLootReqs(html)   → [{name, req}] sorted desc (cards first, then a
//                           whole-body text fallback, deduped)
//   topDamageReq(drops)   → the mob's best-loot damage threshold
//
// and it ships the measured per-mob / per-wave numbers from that scanner run
// ("each wave and gate got different numbers/values"):
//
//   Gate 1 wave 1 (gate=3&wave=3)   → 70,000
//   Gate 1 wave 2 (gate=3&wave=5)   → 3,000,000 – 3,500,000
//   Gate 1 wave 3 (gate=3&wave=8)   → 7,000,000 (generals 5,000,000,000)
//   Gate 2 wave 1 (gate=5&wave=9)   → 30,000,000 (Oceanus 6,000,000,000)
//   Olympus god gates (wave=10..17) → 100,000,000 (heralds 1–1.5e9, mains 8e9)
//
// Cap resolution order (resolveMobCap):
//   1. live battle-page loot   (authoritative, learned into the cache)
//   2. learned cache           (data/loot-caps.json — survives restarts)
//   3. KNOWN_MOB_CAPS          (the measured per-mob table, below)
//   4. KNOWN_WAVE_DEFAULTS     (per gate/wave fallback)
//   5. cfg.mobDamageCap        (explicit MOB_DAMAGE_CAP env, last resort)
//
// Zero dependencies. The cache file is best-effort: a corrupt/unwritable
// file never breaks farming.
const fs = require('fs');
const path = require('path');

// ── Parsing (port of parseBattleLoot) ────────────────────────────────────────

// Strip tags but keep the text nodes, so "Goblin Essence</strong>…DMG req:"
// becomes matchable plain text. Also unfold the entities the game uses.
function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'");
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/DMG req:.*$/i, '')
    .replace(/🎁/g, '')
    .replace(/\bPossible Loot\b|\bLoot\b/gi, '')
    .replace(/[\s\-–—:,*]+$/g, '')   // trailing separators
    .replace(/^[\s\-–—:,]+/g, '')    // leading separators
    .replace(/\s+/g, ' ')
    .trim() || 'Item';
}

// One loot entry: {name, req}. Card-scoped first (loot-card / chip /
// loot-grid children / the reward modal), whole-body text fallback second —
// exactly the scanner's two passes.
function parseLootReqs(html) {
  const text = String(html || '');
  if (!text) return [];
  const drops = [];
  const seen = new Set();
  const push = (name, req) => {
    if (!Number.isFinite(req) || req <= 0) return;
    const key = `${name}_${req}`;
    if (seen.has(key)) return;
    seen.add(key);
    drops.push({ name, req });
  };

  // Pass 1 — card chunks: cut the page at every loot-card-ish opening tag so
  // one card's "DMG req:" can never steal a neighbour's name.
  const boundary = /<(?:div|span|li|article|section|tr)[^>]*class=["'][^"']*(?:loot-card|chip|loot-row|lootitem|reward-card)[^"']*["'][^>]*>/gi;
  const chunks = [];
  let last = 0;
  let bm;
  while ((bm = boundary.exec(text)) !== null) {
    if (bm.index > last) chunks.push(text.slice(last, bm.index));
    last = bm.index;
  }
  chunks.push(text.slice(last));

  for (const chunk of chunks) {
    if (!/DMG req:/i.test(chunk)) continue;
    const plain = stripTags(chunk);
    const m = plain.match(/DMG req:\s*([\d,]+)/i);
    if (!m) continue;
    const req = parseInt(m[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(req)) continue;
    const before = plain.slice(0, m.index);
    // Name = the text run just before the requirement (strong/heading first
    // on the real cards — after tag-stripping it is simply the closest text).
    const nameCandidates = before.split('\n').map((s) => s.trim()).filter(Boolean);
    const name = cleanName(nameCandidates[nameCandidates.length - 1] || '');
    push(name, req);
  }

  // Pass 2 — the scanner's whole-body fallback ("Anything … DMG req: X").
  if (drops.length === 0) {
    const plain = stripTags(text);
    const re = /([^\n\r]+?)\s*[-–—:]?\s*DMG req:\s*([\d,]+)/gi;
    let m;
    while ((m = re.exec(plain)) !== null) {
      const req = parseInt(m[2].replace(/,/g, ''), 10);
      if (!Number.isFinite(req)) continue;
      push(cleanName(m[1]), req);
    }
  }

  drops.sort((a, b) => b.req - a.req);
  return drops;
}

// The mob's best-loot damage threshold (0 when the page shows no loot table).
function topDamageReq(drops) {
  return Array.isArray(drops) && drops.length ? drops[0].req : 0;
}

// ── Measured per-mob table (the console scanner's complete breakdown) ────────
// name (lowercase) → highest "DMG req:" seen on that mob's battle page.
const KNOWN_MOB_CAPS = {
  // Gate 1 · wave 1 (gate=3&wave=3) — 70,000 tier
  'goblin skirmisher': 70000,
  'goblin slinger': 70000,
  'orc grunt': 70000,
  'orc bonecrusher': 70000,
  'hobgoblin spearman': 70000,
  // Gate 1 · wave 2 (gate=3&wave=5) — 3,000,000 / 3,500,000 tier
  'troll ravager': 3000000,
  'lizardman flamecaster': 3000000,
  'troll brawler': 3000000,
  'lizardman shadowclaw': 3500000,
  // Gate 1 · wave 3 (gate=3&wave=8) — 7,000,000 elites / 5e9 generals
  'lizardman vanguard': 7000000,
  'lizardman warmage': 7000000,
  'lizardman dreadblade': 7000000,
  'lizardman juggernaut': 7000000,
  'lizardman bloodpriest': 7000000,
  'lizardman guardian': 7000000,
  'general skarn the radiant bastion': 5000000000,
  'general vessir the sunfang duelist': 5000000000,
  'general hrazz the dawnflame oathkeeper': 5000000000,
  'drakzareth the tyrant lizard king': 5000000000,
  // Gate 2 · wave 1 (gate=5&wave=9) — 30,000,000 tier / Oceanus 6e9
  'charybdis, living maelstrom': 30000000,
  'the crab king': 30000000,
  'dark siren': 30000000,
  'scylla, devourer of sailors': 30000000,
  'kraken': 30000000,
  'merfolk': 30000000,
  'deep sea beast': 30000000,
  'triton warrior': 30000000,
  'water nymph': 30000000,
  'oceanus the water titan': 6000000000,
  'poseidon, the sea emperor': 8000000000,
  // Hermes gate (gate=5&wave=10)
  'winged courier': 100000000,
  'gilded trickster': 100000000,
  'roadside bandit': 100000000,
  'caduceus acolyte': 100000000,
  'silver sandal runner': 100000000,
  'market shadow': 100000000,
  'pan, wild herald of hermes': 1500000000,
  'hermes, divine herald of the endless road': 8000000000,
  // Artemis gate (gate=5&wave=11)
  'moonlit huntress': 100000000,
  'silver stag guardian': 100000000,
  'lunar wolf': 100000000,
  'forest nymph archer': 100000000,
  'sacred bear': 100000000,
  'twilight tracker': 100000000,
  'orion, eternal hunter of artemis': 1000000000,
  'artemis, lunar duelist of the sacred hunt': 8000000000,
  // Poseidon gate (gate=5&wave=12)
  'abyssal hoplite': 100000000,
  'tideglass magus': 100000000,
  'coral gorgon': 100000000,
  'maelstrom cavalier': 100000000,
  'trenchborn oracle': 100000000,
  'leviathan warden': 100000000,
  'triton, herald of the deep crown': 1500000000,
  'poseidon, sovereign of the drowned steps': 8000000000,
  // Ares gate (gate=5&wave=13)
  'bronze legionnaire': 100000000,
  'blood-oath myrmidon': 100000000,
  'warhound of enyo': 100000000,
  'spearwall hoplite': 100000000,
  'ashen chariot raider': 100000000,
  'fury-touched champion': 100000000,
  'deimos, herald of panic': 1500000000,
  'ares, sovereign of the red bastion': 8000000000,
  // Apollo gate (gate=5&wave=14)
  'dawn choir acolyte': 100000000,
  'sun-lance centaur': 100000000,
  'laurel flamekeeper': 100000000,
  'golden lyrist': 100000000,
  'radiant python': 100000000,
  'basilica exorcist': 100000000,
  'asclepius, herald of golden mercy': 1500000000,
  'apollo, duelist of the sun court': 8000000000,
  // Athena gate (gate=5&wave=15)
  'owl-eyed scribe': 100000000,
  'aegis hoplite': 100000000,
  'bronze automaton': 100000000,
  'gorgon-sigil warden': 100000000,
  'strategy shade': 100000000,
  'ivory spearmaster': 100000000,
  'nike, herald of unbroken victory': 1500000000,
  'athena, sovereign of the ivory war library': 8000000000,
  // Hera gate (gate=5&wave=16)
  'peacock sentinel': 100000000,
  'oathbound judge': 100000000,
  'crowned handmaiden': 100000000,
  'vowbreaker shade': 100000000,
  'argive lion': 100000000,
  'royal scepter mage': 100000000,
  'nemesis, herald of reckoning': 1500000000,
  'hera, sovereign of the crown court': 8000000000,
  // Zeus gate (gate=5&wave=17)
  'thundercloud harpy': 100000000,
  'aetheric cyclops': 100000000,
  'storm eagle': 100000000,
  'lightning hoplite': 100000000,
  'oracle of dodona': 100000000,
  'skyfire giant': 100000000,
  'aeolus, herald of bound winds': 1500000000,
  'zeus, sovereign of the storm throne': 8000000000,
};

// Per gate/wave fallback (regular-mob tier of that page; bosses ride the
// per-mob rows / the boss-catalogue caps).
const KNOWN_WAVE_DEFAULTS = {
  'gate=3&wave=3': 70000,
  'gate=3&wave=5': 3500000,
  'gate=3&wave=8': 7000000,
  'gate=5&wave=9': 30000000,
  'gate=5&wave=10': 100000000,
  'gate=5&wave=11': 100000000,
  'gate=5&wave=12': 100000000,
  'gate=5&wave=13': 100000000,
  'gate=5&wave=14': 100000000,
  'gate=5&wave=15': 100000000,
  'gate=5&wave=16': 100000000,
  'gate=5&wave=17': 100000000,
};

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Bidirectional-include match on the measured table — wave-page data-name
// values are sometimes truncated or decorated versions of the scanner names.
function knownMobCap(name) {
  const n = normalizeName(name);
  if (!n) return null;
  if (KNOWN_MOB_CAPS[n] != null) return { name: n, req: KNOWN_MOB_CAPS[n] };
  for (const [known, req] of Object.entries(KNOWN_MOB_CAPS)) {
    if (n.includes(known) || known.includes(n)) return { name: known, req };
  }
  return null;
}

function knownWaveDefault(wavePath) {
  return KNOWN_WAVE_DEFAULTS[String(wavePath || '')] || null;
}

// ── Learned cache (data/loot-caps.json) ──────────────────────────────────────
// Populated whenever a live battle page reveals a mob's real loot gate.
// Keyed by mob NAME (battle ids are per-instance and change every wave
// reset; names survive resets and are shared across accounts).
let capsFile = null;
const learned = new Map();       // nameKey -> {req, wave, at}
let noLootMemo = new Map();      // nameKey -> ts (mob showed no loot table)

function initCapsCache(dataDir) {
  capsFile = null;
  learned.clear();
  noLootMemo = new Map();
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    capsFile = path.join(dataDir, 'loot-caps.json');
    if (fs.existsSync(capsFile)) {
      const raw = JSON.parse(fs.readFileSync(capsFile, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && Number.isFinite(v.req) && v.req > 0) {
          learned.set(String(k).toLowerCase(), { req: v.req, wave: v.wave || null, at: v.at || 0 });
        }
      }
    }
  } catch (_) {
    capsFile = null; // corrupt file → in-memory only
  }
}

function persistCaps() {
  if (!capsFile) return;
  try {
    const obj = {};
    for (const [k, v] of learned.entries()) obj[k] = v;
    const tmp = capsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, capsFile);
  } catch (_) { /* best-effort */ }
}

function learnCap(name, req, wavePath) {
  const n = normalizeName(name);
  const r = Number(req);
  if (!n || !Number.isFinite(r) || r <= 0) return false;
  learned.set(n, { req: r, wave: wavePath || null, at: Date.now() });
  persistCaps();
  return true;
}

function learnedCap(name) {
  const hit = learned.get(normalizeName(name));
  return hit ? { req: hit.req, wave: hit.wave, at: hit.at } : null;
}

function learnedCapCount() {
  return learned.size;
}

// Mobs whose battle page showed NO loot table — remember for a while so we
// do not re-view them every round (one free GET per mob per 30 min max).
const NO_LOOT_MEMO_MS = 30 * 60 * 1000;
function memoNoLoot(name) {
  noLootMemo.set(normalizeName(name), Date.now());
}
function hasNoLootMemo(name) {
  const at = noLootMemo.get(normalizeName(name));
  if (!at) return false;
  if (Date.now() - at > NO_LOOT_MEMO_MS) {
    noLootMemo.delete(normalizeName(name));
    return false;
  }
  return true;
}

// ── Resolution ───────────────────────────────────────────────────────────────
// liveHtml  : the mob's battle.php HTML when the caller already has it
// wavePath  : "gate=X&wave=Y" — scopes the wave-default fallback
// cfg       : { mobDamageCap } last-resort floor from MOB_DAMAGE_CAP
// Returns { cap, source } — cap 0 means "no cap known, fight to the death".
function resolveMobCap({ name, wavePath, liveHtml, cfg } = {}) {
  if (liveHtml) {
    const drops = parseLootReqs(liveHtml);
    const top = topDamageReq(drops);
    if (top > 0) {
      learnCap(name, top, wavePath);
      return { cap: top, source: 'live-loot', drops };
    }
  }
  const cached = learnedCap(name);
  if (cached) return { cap: cached.req, source: 'learned', at: cached.at };
  const known = knownMobCap(name);
  if (known) return { cap: known.req, source: 'known-mob' };
  const waveDef = knownWaveDefault(wavePath);
  if (waveDef) return { cap: waveDef, source: 'known-wave' };
  const cfgCap = cfg && Number(cfg.mobDamageCap);
  if (Number.isFinite(cfgCap) && cfgCap > 0) return { cap: cfgCap, source: 'config' };
  return { cap: 0, source: 'none' };
}

module.exports = {
  parseLootReqs,
  topDamageReq,
  KNOWN_MOB_CAPS,
  KNOWN_WAVE_DEFAULTS,
  knownMobCap,
  knownWaveDefault,
  initCapsCache,
  learnCap,
  learnedCap,
  learnedCapCount,
  memoNoLoot,
  hasNoLootMemo,
  resolveMobCap,
};
