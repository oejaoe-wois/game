'use strict';
// mock-game.js — a tiny stand-in for demonicscans.org used ONLY by tests.
// Implements the same request contract the engine expects:
//   CSRF login flow, session cookies (PHPSESSID + demon), gates.php /
//   olympus.php / active_wave.php?gate=X&wave=Y pages (data-monster-id rows +
//   battle.php?id= cards with "You:" damage + HP/dead state),
//   user_join_battle.php (id/monster_id/user_id), damage.php (skill_id /
//   stamina_cost / stamina / totaldmgdealt / hp{value,max,percent},
//   once-per-join "too quickly — cooldown" rate limit), user_heal_potion.php,
//   loot.php, stats.php (live stamina top bar + #stats-state), stats_ajax.php
//   (chunk [100,50,5,1] allocation with csrf/view/request_id validation and
//   409s on stale tokens), inventory.php (slot-boxes
//   with useItem() buttons), use_item.php (records the exact body; a stamina
//   potion refills the bar), battle.php?id=, auto_farm_actions.php,
//   pvp_style_state.php / pvp_style_action.php.
//
// Run: node test/mock-game.js [port]   (default 8971)

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8971);

// Mock users: email -> {password, uid, level}. uid 103 is reserved for the
// direct engine tests so they never race the farm's workers (101/102).
// uid 100 is the built-in admin fetcher's game account — the farm seeds it
// at boot from config (ADMIN_GAME_EMAIL / ADMIN_GAME_PASSWORD), so the mock
// must accept its login exactly like the real server would.
const USERS = {
  'fetcher@test.invalid': { password: 'fetcher@test.invalid', uid: '100', level: 5001 },
  'hunter.one@example.com': { password: 'hunterpass1', uid: '101', level: 5001 },
  'hunter.two@example.com': { password: 'hunterpass2', uid: '102', level: 5001 },
  'unit.tester@example.com': { password: 'unitpass1', uid: '103', level: 5001 },
  'guild.tester@example.com': { password: 'guildpass1', uid: '104', level: 5001 },
  // A friend's account in a DIFFERENT guild — the multi-guild checks prove
  // the engine scans, verifies and farms per account, never cross-guild.
  'friend.tester@example.com': {
    password: 'friendpass1', uid: '105', level: 5001,
    guildId: 41, guildTag: 'VEYRA', guildName: 'Veyra Vanguard',
  },
  // A classless LOW-LEVEL account — the class picker must WAIT (level 150
  // is under the level-200 requirement of every base class) while every
  // other feature still runs.
  'low.lvl@example.com': { password: 'lowpass1', uid: '106', level: 150 },
  // A dedicated class-pick account (uid 107 is used by NO other check —
  // its worker's wave/dungeon/stat activity stays isolated from the
  // direct-client fixtures below).
  'warr.tester@example.com': { password: 'warrpass1', uid: '107', level: 2500 },
};

// The session's own guild, the way the live game answers it: guild_dash.php
// and every guild-aware page report the CALLER's guild (accounts from other
// guilds see their own — never one shared global).
function guildOf(uid) {
  const u = Object.values(USERS).find((x) => String(x.uid) === String(uid));
  return {
    id: (u && u.guildId) || 32,
    tag: (u && u.guildTag) || 'MOCK',
    name: (u && u.guildName) || 'Mock Guild',
  };
}
// The session account's character level (getPlayerLevel reads the inventory
// page's LV badge; the tree page gates Mana Shield-class unlocks on it).
function userLevel(uid) {
  const u = Object.values(USERS).find((x) => String(x.uid) === String(uid));
  return (u && u.level) || 1;
}

const STAMINA_MAX = 7190;

// Monsters on wave pages. name is lowercase like the game's data-name attrs;
// boss:true renders the row as .boss-card (the wave script skips those —
// they belong to the boss combat loop).
const WAVE_MONSTERS = {
  // Gate 1 (gates.php) — every gate/wave pair carries different mobs.
  // loot = the battle page's loot card ("DMG req: X") — the per-mob damage
  // gate the engine learns in auto cap mode.
  'gate=3&wave=3': [
    // hp 60000: several workers (incl. the built-in fetcher) each cap these
    // mobs at their own 1200 loot gate — a low hp would let the first capper
    // SLAIN the mob out from under the others.
    { id: 8301, name: 'gate warden', hp: 60000, dead: false, loot: { name: 'Gate Warden Sigil', req: 1200 } },
    { id: 8302, name: 'marsh crawler', hp: 60000, dead: false, loot: { name: 'Marsh Pearl', req: 1200 } },
  ],
  'gate=3&wave=5': [
    { id: 8303, name: 'cinder hound', hp: 1500, dead: false },
    { id: 8305, name: 'bone shooter', hp: 1500, dead: true, corpseDmg: 12000, deadPage: 1, expCap: 1500 },
    { id: 8325, name: 'dust archer', hp: 1500, dead: true, corpseDmg: 8000, deadPage: 2, expCap: 1500 },
    { id: 8304, name: 'mire stalker', hp: 1500, dead: false },
  ],
  'gate=3&wave=8': [
    { id: 9001, name: 'general skarn the radiant bastion', hp: 100000, dead: false, boss: true, nextDieHours: 5 },
    { id: 9002, name: 'general vessir the sunfang duelist', hp: 100000, dead: true, boss: true },
    // hp 60000 like the wave-1 mobs: the scout must see these generic mobs
    // alive on EVERY sweep (the bus replaces its set each sweep — a slain
    // mob leaves the bus), so a low hp would race the step-6 assertion.
    { id: 8001, name: 'moss golem', hp: 60000, dead: false,
      // mstats — the battle page's "View Monster Stats" modal values (the
      // swarm's damage forecast reads these through monster-stats.js).
      mstats: { atk: 60, def: 40, petDef: 10, eqDef: 20, element: 'NATURE', elementRate: 15, rewardsLv: 300 } },
    { id: 8002, name: 'rot fiend', hp: 60000, dead: false,
      mstats: { atk: 45, def: 25, petDef: 5, eqDef: 10, element: 'VOID', elementRate: 0, rewardsLv: 300 } },
    // The fleet-drone: RESPAWNS with a NEW instance id ~2.5s after every
    // kill, exactly like the real game's mob churn ("each mob auto-dies and
    // a new instance id takes its slot"). The fleet-hunt test dives it over
    // and over regardless of which wave round happened to kill it first.
    { id: 8499, name: 'fleet drone', hp: 1500, dead: false, respawn: true },
  ],
  // Battle-pass waves (battlepass.js tests): a LIZARD page and a SEA page.
  // The season's damage quest steers the wave picker toward these while it
  // is open. Brand-new paths — no other suite ever visits them. Each page
  // keeps one non-matching mob so the within-page attack-order test can
  // prove quest mobs are engaged first.
  'gate=3&wave=6': [
    { id: 8306, name: 'lizardman shadowclaw', hp: 1500, dead: false, loot: { name: 'Lizard Fang', req: 1200 } },
    { id: 8309, name: 'gate sentry', hp: 1500, dead: false, loot: { name: 'Sentry Badge', req: 1200 } },
  ],
  'gate=3&wave=7': [
    { id: 8310, name: 'sea serpent spawn', hp: 1500, dead: false, loot: { name: 'Sea Scale', req: 1200 } },
    { id: 8311, name: 'reef crab', hp: 1500, dead: false, loot: { name: 'Crab Claw', req: 1200 } },
  ],
  // Gate 2 — Olympus (olympus.php): base wave + the named god gates. The god
  // heralds/mains read DEAD so the scout filters them (their real caps are
  // billions — a live one would own the whole test); each gate keeps one
  // cheap generic mob for precision wave farming.
  'gate=5&wave=9': [
    { id: 9005, name: 'oceanus the water titan', hp: 120000, dead: false, boss: true, nextDieHours: 40 },
    { id: 9100, name: 'poseidon, the sea emperor', hp: 120000, dead: true, boss: true },
    { id: 8003, name: 'tide wisp', hp: 60000, dead: false,
      mstats: { atk: 30, def: 12, petDef: 3, eqDef: 8, element: 'WATER', elementRate: 20, rewardsLv: 300 } }, // durable — see the wave-8 note
  ],
  // The swarm stamina-gate wave — deliberately OUTSIDE every sweep registry:
  // no scout/fetcher/worker ever visits it, so ONLY a swarm armed by raw mob
  // id can reach the flunk. A 1e12-HP wall with a tight loot gate (req 1,200
  // for any normal farm that somehow lands there) — the swarm's 1e9 quota can
  // never finish and the mob can never be SLAIN, making the gate window
  // deterministic (no SLAIN→complete race against the DELETE check).
  'gate=9&wave=98': [
    { id: 8400, name: 'gate flunk', hp: 999999999999, dead: false,
      mstats: { atk: 30, def: 12, petDef: 3, eqDef: 8, element: 'WATER', elementRate: 20, rewardsLv: 300 },
      loot: { name: 'Flunk Badge', req: 1200 } },
  ],
  'gate=5&wave=10': [
    { id: 9101, name: 'pan, wild herald of hermes', hp: 90000, dead: true, boss: true },
    { id: 9102, name: 'Hermes, Divine Herald of the Endless Road', hp: 150000, dead: true, boss: true },
    { id: 8501, name: 'crossroad shade', hp: 1500, dead: false },
    { id: 8511, name: 'shade husk', hp: 1500, dead: true, corpseDmg: 9000, deadPage: 1, expCap: 5000 },
    { id: 8512, name: 'veil husk', hp: 1500, dead: true, corpseDmg: 7000, deadPage: 2, expCap: 1500 },
  ],
  // Event wave (the LevelUp Looter's "Event: The Dragon Realm" source —
  // active_wave.php?event=13&wave=116).
  'event=13&wave=116': [
    { id: 8616, name: 'dragon realm whelp', hp: 900, dead: false },
    { id: 8617, name: 'dragon realm bonepile', hp: 900, dead: true, corpseDmg: 5000, deadPage: 1, expCap: 1500 },
  ],
  'gate=5&wave=11': [
    { id: 9103, name: 'orion, eternal hunter of artemis', hp: 90000, dead: true, boss: true },
    { id: 9104, name: 'Artemis, Lunar Duelist of the Sacred Hunt', hp: 150000, dead: true, boss: true },
    { id: 8502, name: 'moonlit stag', hp: 1500, dead: false },
  ],
  'gate=5&wave=12': [
    { id: 9105, name: 'triton, herald of the deep crown', hp: 90000, dead: true, boss: true },
    { id: 9106, name: 'Poseidon, Sovereign of the Drowned Steps', hp: 150000, dead: true, boss: true },
    { id: 8503, name: 'reef sentinel', hp: 1500, dead: false },
  ],
  'gate=5&wave=13': [
    { id: 9107, name: 'deimos, herald of panic', hp: 90000, dead: true, boss: true },
    { id: 9108, name: 'Ares, Sovereign of the Red Bastion', hp: 150000, dead: true, boss: true },
    { id: 8504, name: 'blood squire', hp: 1500, dead: false },
  ],
  'gate=5&wave=14': [
    { id: 9109, name: 'asclepius, herald of golden mercy', hp: 90000, dead: true, boss: true },
    { id: 9110, name: 'Apollo, Duelist of the Sun Court', hp: 150000, dead: true, boss: true },
    { id: 8505, name: 'sun courtier', hp: 1500, dead: false },
  ],
  'gate=5&wave=15': [
    { id: 9111, name: 'Nike, Herald of Unbroken Victory', hp: 90000, dead: true, boss: true },
    { id: 9112, name: 'Athena, Sovereign of the Ivory War Library', hp: 150000, dead: true, boss: true },
    { id: 8506, name: 'ivory acolyte', hp: 1500, dead: false },
  ],
  'gate=5&wave=16': [
    { id: 9113, name: 'Nemesis, Herald of Reckoning', hp: 90000, dead: true, boss: true },
    { id: 9114, name: 'Hera, Sovereign of the Crown Court', hp: 150000, dead: true, boss: true },
    { id: 8507, name: 'crown guard', hp: 1500, dead: false },
  ],
  'gate=5&wave=17': [
    { id: 9115, name: 'Aeolus, Herald of Bound Winds', hp: 90000, dead: true, boss: true },
    { id: 9116, name: 'Zeus, Sovereign of the Storm Throne', hp: 150000, dead: true, boss: true },
    { id: 8508, name: 'storm votary', hp: 1500, dead: false },
  ],
  // Direct engine-test page — NOT in the wave registry, so neither the scout
  // nor the workers ever touch it and unit tests race no one. The siege
  // titan's loot gate (450) is deliberately BELOW the env MOB_DAMAGE_CAP
  // (1200) to prove the live loot cap wins and saves stamina.
  'gate=9&wave=91': [
    { id: 8010, name: 'practice dummy', hp: 1500, dead: false },
    { id: 8011, name: 'warden titan', hp: 60000, dead: false },
    { id: 8012, name: 'siege titan', hp: 60000, dead: false, loot: { name: 'Siege Core', req: 450 } },
    { id: 8090, name: 'fallen reaper', hp: 1500, dead: true },
  ],
  // Contract-floor page — also engine-test only. A big lizardman shadowclaw
  // (the guild contract's monster, "min 3m dmg"): its loot gate is 1200, the
  // floor is 3m, so the fight must continue PAST the loot gate and kill it.
  // bigHit makes each slash land 250,000 — the floor is reachable in a test.
  'gate=9&wave=92': [
    { id: 8020, name: 'lizardman shadowclaw', hp: 8000000, dead: false, bigHit: true, loot: { name: 'Shadowclaw Fang', req: 1200 } },
    { id: 8021, name: 'warren runt', hp: 300, dead: false },
  ],
};

// Normalize: remember max HP, zero out the dead.
for (const list of Object.values(WAVE_MONSTERS)) {
  for (const m of list) {
    m.maxHp = m.hp;
    if (m.dead) m.hp = 0;
  }
}

// Respawning mobs (the fleet drone) re-instance with fresh ids on death —
// this sequence feeds those new ids (mirrors the real game's mob churn).
let mockMobIdSeq = 99000;

// The gate map as gates.php / olympus.php present it.
const GATES = [
  {
    name: 'Gate 1',
    hub: null,
    waves: [
      { gate: 3, wave: 3, label: 'Gate 1 wave 1' },
      { gate: 3, wave: 5, label: 'Gate 1 wave 2' },
      { gate: 3, wave: 8, label: 'Gate 1 wave 3' },
    ],
  },
  {
    name: 'Gate 2 — Olympus',
    hub: '/olympus.php',
    waves: [
      { gate: 5, wave: 9, label: 'Olympus wave 1' },
      { gate: 5, wave: 10, label: 'Hermes gate' },
      { gate: 5, wave: 11, label: 'Artemis gate' },
      { gate: 5, wave: 12, label: 'Poseidon gate' },
      { gate: 5, wave: 13, label: 'Ares gate' },
      { gate: 5, wave: 14, label: 'Apollo gate' },
      { gate: 5, wave: 15, label: 'Athena gate' },
      { gate: 5, wave: 16, label: 'Hera gate' },
      { gate: 5, wave: 17, label: 'Zeus gate' },
    ],
  },
];

// Server-side auto-farm state per uid.
const autoFarm = new Map(); // uid -> {enabled, targets:[], settings:{}}
const pvpMatches = new Map(); // uid -> matches made this mock-season
// Every monster instance carries the game's server-side auto-die epoch
// (data-expire, seconds). Frozen per boot so all pages agree; ~2h out.
const WAVE_EXPIRE_SEC = Math.floor(Date.now() / 1000) + 2 * 3600 + 1740;

// sessions: sid -> uid
const sessions = new Map();
const csrfTokens = new Set();

// Live per-account combat state.
const staminaByUid = new Map();  // uid -> stamina left
const damageByUid = new Map();   // 'uid:mobId' -> cumulative damage this account dealt
const cooldownSeen = new Set();  // 'uid:mobId' — the game rate-limits the first hit after a join

function staminaOf(uid) {
  if (!staminaByUid.has(uid)) staminaByUid.set(uid, STAMINA_MAX);
  return staminaByUid.get(uid);
}

// Per-uid stat state — what stats.php embeds as #stats-state and what
// stats_ajax.php validates allocations against (csrf token, optimistic
// `view` version, the [100,50,5,1] chunk whitelist, request_id dedupe).
const statsByUid = new Map();          // uid -> {csrf, view, user:{…}}
const statsSeenRequests = new Map();   // uid -> Set(request_id) dedupe
const statsArmed409 = new Set();       // uids armed for a one-shot 409 (test hook)
let lastAllocate = null;               // last stats_ajax.php body
let allocateCount = 0;

function statsOf(uid) {
  if (!statsByUid.has(uid)) {
    statsByUid.set(uid, {
      csrf: crypto.randomBytes(8).toString('hex'),
      view: 1,
      user: { ATTACK: 10, DEFENSE: 10, MAX_STAMINA: STAMINA_MAX, STAT_POINTS: 10000 },
    });
  }
  return statsByUid.get(uid);
}

// use_item.php inv ids → potion kind (data-item is the stable type).
const POTION_KIND = {
  '555': 'hp',
  '396373': 'hp',
  '777': 'stamina',
  '303210560': 'stamina',
  '1037434583': 'stamina',
  '1158290406': 'stamina',
  '22313874': 'mana',
};

// ── Reaction farm world (manga / chapters / reactions) ───────────────────
// / and /lastupdates.php list the slugs; each manga page lists its chapters
// (oldest FIRST after the engine's reverse, like the real site).
const MANGAS = ['solo-leveling', 'omniscient-reader'];
const MANGA_IDS = { 'solo-leveling': 1, 'omniscient-reader': 2 };
const CHAPTERS = {
  1: ['1', '2', '3', '4', '5', '6'],
  2: ['10', '11', '12', '13'],
};
// chapterid = manga*100 + chapter index — stable per chapter.
function chapterIdOf(mangaId, chapterSlug) {
  const idx = CHAPTERS[mangaId].indexOf(chapterSlug);
  return mangaId * 100 + idx + 1;
}
const reactionsByUid = new Map(); // uid -> Map(chapterid -> reaction)
let lastReaction = null;
let reactionCount = 0;

// ── Shops (merchant / guild / Damon) ─────────────────────────────────────
const goldByUid = new Map();      // uid -> gold
const guildPointsByUid = new Map(); // uid -> adventurer points
const merchantStockByUid = new Map(); // uid -> { boughtSmall }
const guildBoughtByUid = new Map();   // uid -> bought count
const damonByUid = new Map();         // uid -> { bought }
let lastMerchantBuy = null;
let lastGuildBuy = null;
let lastDamonBuy = null;
let lastPotionSetting = null;
const MERCHANT = { id: '301', name: 'Small Stamina Potion', price: 100, maxq: 10 };
const GUILD_ITEM = { id: '501', name: 'Adventurer Stamina Potion', price: 150, limit: 5 };
const DAMON_OFFER = { key: 'damon-lsp', name: 'Large Stamina Potion', price: 250, weekly: 20 };
// Merchant stock mirrors the LIVE page's kinds: the stamina row the ladders
// drink, plus the Full HP Potion and Mana Potion S rows the multi-kind sweep
// buys (POTION_BUY_KINDS stamina,hp,mana) — eggs/treats are never bought.
const MERCHANT_HP = { id: '302', name: 'Full Hp Potion', price: 5000, maxq: 25 };
const MERCHANT_MANA = { id: '303', name: 'Mana Potion S', price: 500, maxq: 20 };
const MERCHANT_EGG = { id: '304', name: 'Fenrir Egg', price: 1000, maxq: 1 };
function shopSeed(uid) {
  if (!goldByUid.has(uid)) goldByUid.set(uid, 5000);
  if (!guildPointsByUid.has(uid)) guildPointsByUid.set(uid, 2000);
  if (!merchantStockByUid.has(uid)) merchantStockByUid.set(uid, { bought: 0 });
  if (!guildBoughtByUid.has(uid)) guildBoughtByUid.set(uid, 0);
  if (!damonByUid.has(uid)) damonByUid.set(uid, { bought: 0 });
}

// ── Gear (equip-best) ─────────────────────────────────────────────────────
// Per-session inventory: equipped slots (the set's natural slot ids) + bag
// items. inventory_ajax.php equip_item moves a bag item into its family slot
// and answers "OK" — the exact wire the live game speaks.
const gearByUid = new Map(); // uid -> { equipped: Map(slotId -> item), bag: [item] }
function gearOf(uid) {
  if (!gearByUid.has(uid)) {
    gearByUid.set(uid, {
      equipped: new Map([
        [1, { invId: '8810001', type: 'weapon', name: 'Mock Rusty Sword', atk: 5, def: 0 }],
      ]),
      bag: [
        { invId: '8820001', type: 'weapon', name: 'Mock Steel Sword', atk: 40, def: 2, qty: 1 },
        { invId: '8820002', type: 'weapon', name: 'Mock Cracked Dagger', atk: 3, def: 0, qty: 1 },
        { invId: '8820003', type: 'boots', name: 'Mock Swift Boots', atk: 7, def: 4, qty: 1 },
        { invId: '8820004', type: 'ring', name: 'Mock Band', atk: 2, def: 2, qty: 1 },
      ],
    });
  }
  return gearByUid.get(uid);
}
// family → equipped slot id (the game's set layout)
const GEAR_SLOT = { weapon: 1, helmet: 2, armor: 3, boots: 4, gloves: 5, ring: 6, amulet: 7 };
let lastEquipPost = null;
let equipPostCount = 0;

// ── Blacksmith (craft_item.php) ────────────────────────────────────────────
// Recipe 601 is fully stocked (craftable), 602 misses materials (Forge
// disabled — the engine must never POST it). 603 is craftable but weak: the
// engine crafts the strongest recipe first, so with BLACKSMITH_MAX_CRAFTS=1
// only 601 lands.
const RECIPES = [
  { id: '601', name: 'Mock Ember Blade', atk: 77, def: 4, reqs: [{ name: 'Mock Scale', have: 50, need: 50, ok: true }, { name: 'Mock Ember', have: 5, need: 5, ok: true }], craftable: true },
  { id: '602', name: 'Mock Ember Ring', atk: 10, def: 10, reqs: [{ name: 'Mock Ember', have: 2, need: 5, ok: false }], craftable: false },
  { id: '603', name: 'Mock Ember Band', atk: 8, def: 1, reqs: [{ name: 'Mock Scale', have: 9, need: 9, ok: true }], craftable: true },
];
let lastCraftPost = null;
const craftsByUid = new Map(); // uid -> [{id, name, at}]

// ── Dailies: achievements / collections / guild quests / event board ──
// Everything is per-session uid, exactly like the game's per-account state.
const claimsStateByUid = new Map(); // uid -> { ach:Set(claimed ids), col:Set }
const questStateByUid = new Map();  // uid -> { accepted, progress, finished, donated }
const eventStateByUid = new Map();  // uid -> { dispatch:Set('quest|day'), enrolled }
const pageCsrfByUid = new Map();    // uid -> stable page csrf hex
let lastLootPost = null;            // every /loot.php POST (kill-loot hook)
// ── Classes (classes.php) ─────────────────────────────────────────────
// uid -> 'Warrior' | 'Mage' | 'Hunter' | 'Cleric'. Every mock user starts
// CLASSLESS (the live state the classless scout captured): the picker
// binds one when the account is level ≥ 200 and allowed to.
const classByUid = new Map();
const lastClassPostByUid = new Map(); // uid -> the choose_class_id POST for tests
const CLASS_NAMES = { 1: 'Warrior', 2: 'Mage', 3: 'Hunter', 4: 'Cleric' };

// ── Class skill tree (class_skill_tree.php) ──────────────────────────────
// Per-session tree state: the Adv. Point wallet + what is owned/leveled.
// AP is EARNED by Adventurers Guild contracts (finish pays the reward's
// "100 AP") and SPENT by the tree's unlock/level-up POSTs — the same loop
// the live game runs.
const treeByUid = new Map(); // uid -> { ap, owned: Map(id -> {level, usedTimes}) }
function treeOf(uid) {
  if (!treeByUid.has(uid)) treeByUid.set(uid, { ap: 0, owned: new Map() });
  return treeByUid.get(uid);
}
const lastTreePostByUid = new Map(); // uid -> latest tree POST record (tests)
// The tree catalog — Mage entries mirror the LIVE page byte-for-value
// (2026-11 scout: Fireball id 4 free unlock / 2000 AP to lv 2, Arcane
// Sacrifice id 5 @ 500 AP, Mana Shield id 16 @ 2000 AP · char level 200);
// the other classes follow the same shape with their own ids/names
// (Cleric's four mirror the Cleric scout snapshot).
const TREE_BY_CLASS = {
  Mage: [
    { id: 4, name: 'Fireball', unlock_level: 1, adv_points_req: 0, mana_cost: 30, stamina_cost: 200, flat_stam_dmg: 20000, max_level: 2, nextAP: 2000 },
    { id: 5, name: 'Arcane Sacrifice', unlock_level: 1, adv_points_req: 500, mana_cost: 30, stamina_cost: 0, flat_stam_dmg: 0, max_level: 2, nextAP: 2000 },
    { id: 16, name: 'Mana Shield', unlock_level: 200, adv_points_req: 2000, mana_cost: 0, stamina_cost: 0, flat_stam_dmg: 0, max_level: 1, nextAP: null },
  ],
  Warrior: [
    { id: 6, name: 'Ironclad Strike', unlock_level: 1, adv_points_req: 0, mana_cost: 20, stamina_cost: 200, flat_stam_dmg: 12000, max_level: 2, nextAP: 2000 },
    { id: 7, name: 'Bulwark Oath', unlock_level: 1, adv_points_req: 500, mana_cost: 25, stamina_cost: 0, flat_stam_dmg: 0, max_level: 2, nextAP: 2000 },
    { id: 17, name: 'Colossus Guard', unlock_level: 200, adv_points_req: 2000, mana_cost: 0, stamina_cost: 0, flat_stam_dmg: 0, max_level: 1, nextAP: null },
  ],
  Hunter: [
    { id: 10, name: 'Back Stab', unlock_level: 1, adv_points_req: 0, mana_cost: 25, stamina_cost: 200, flat_stam_dmg: 16000, max_level: 2, nextAP: 2000 },
    { id: 11, name: 'Predator Focus', unlock_level: 1, adv_points_req: 500, mana_cost: 20, stamina_cost: 0, flat_stam_dmg: 0, max_level: 2, nextAP: 2000 },
    { id: 19, name: 'Shadowstep Veil', unlock_level: 200, adv_points_req: 2000, mana_cost: 0, stamina_cost: 0, flat_stam_dmg: 0, max_level: 1, nextAP: null },
  ],
  Cleric: [
    { id: 8, name: 'Heal', unlock_level: 1, adv_points_req: 0, mana_cost: 30, stamina_cost: 0, flat_stam_dmg: 0, max_level: 2, nextAP: 2000 },
    { id: 9, name: 'Judgment Seal', unlock_level: 1, adv_points_req: 500, mana_cost: 20, stamina_cost: 0, flat_stam_dmg: 0, max_level: 2, nextAP: 2000 },
    { id: 18, name: 'Sanctified Breach', unlock_level: 200, adv_points_req: 2000, mana_cost: 0, stamina_cost: 0, flat_stam_dmg: 0, max_level: 1, nextAP: null },
    { id: 21, name: 'Revive', unlock_level: 500, adv_points_req: 5000, mana_cost: 0, stamina_cost: 0, flat_stam_dmg: 0, max_level: 1, nextAP: null },
  ],
};
// The page's JSON skill rows, with owned/level/used_times folded in from the
// session state — the same fields window.SkillTreeData carries live.
function treeRowsFor(uid) {
  const cls = classByUid.get(uid) || 'Mage';
  const st = treeOf(uid);
  const rows = [];
  for (const s of TREE_BY_CLASS[cls] || TREE_BY_CLASS.Mage) {
    const own = st.owned.get(String(s.id));
    const level = own ? own.level : 0;
    rows.push({
      id: s.id, name: s.name, branch: 1, position: rows.length + 1,
      unlock_level: s.unlock_level, adv_points_req: s.adv_points_req,
      min_rank_id: 1, min_rank_name: 'F',
      mana_cost: s.mana_cost, stamina_cost: s.stamina_cost,
      flat_stam_dmg: s.flat_stam_dmg,
      effects: { effect1_id: 3, effect1_rate: 0.1, effect1_desc: 'Skill details.', effect2_id: 0, effect2_rate: 0, effect2_desc: null },
      owned: !!own, level, used_times: own ? own.usedTimes : 0,
      max_level: s.max_level,
      level_rules: s.nextAP && s.max_level > 1
        ? [{ level: 2, times_used: 0, adv_points: s.nextAP, min_rank_id: 2, min_rank_name: 'E', mana_cost: s.mana_cost, stamina_cost: s.stamina_cost, flat_damage_stamina: s.flat_stam_dmg, effect1_rate: 0.11, effect2_rate: 0 }]
        : [],
      next_rule: own && level < s.max_level && s.nextAP
        ? { level: level + 1, times_used: 0, adv_points: s.nextAP, min_rank_id: 2, min_rank_name: 'E', mana_cost: s.mana_cost, stamina_cost: s.stamina_cost, flat_damage_stamina: s.flat_stam_dmg, effect1_rate: 0.11, effect2_rate: 0 }
        : null,
    });
  }
  return rows;
}
const CLASS_PASSIVES = {
  Mage: '-50% def +25% attack',
  Warrior: '+30% HP',
  Hunter: '+20% crit damage, -30% defense',
  Cleric: 'auto-heal on stamina spent',
};
function claimsOf(uid) {
  if (!claimsStateByUid.has(uid)) claimsStateByUid.set(uid, { ach: new Set(), col: new Set() });
  return claimsStateByUid.get(uid);
}
function questOf(uid) {
  if (!questStateByUid.has(uid)) questStateByUid.set(uid, { accepted: null, progress: 0, finished: [], donated: 0 });
  return questStateByUid.get(uid);
}
function eventOf(uid) {
  if (!eventStateByUid.has(uid)) eventStateByUid.set(uid, { dispatch: new Set(), enrolled: false });
  return eventStateByUid.get(uid);
}
function pageCsrf(uid) {
  if (!pageCsrfByUid.has(uid)) pageCsrfByUid.set(uid, crypto.randomBytes(16).toString('hex'));
  return pageCsrfByUid.get(uid);
}
// ── Battle Pass (battle_pass.php) ──────────────────────────────────────
// Per-session season state, exactly like the game's per-account progress:
// stamina spent today + damage dealt to the season's mob family + the
// claimed reward ids. bpSeasonOn mirrors TODAY's live state (the real
// battle_pass.php currently answers "No Battle Pass season available.");
// the test flips it on via the __mock/state control.
const bpStateByUid = new Map(); // uid -> { stamina, damage, claimed:Set }
let bpSeasonOn = false;
function bpOf(uid) {
  if (!bpStateByUid.has(uid)) bpStateByUid.set(uid, { stamina: 0, damage: 0, claimed: new Set() });
  return bpStateByUid.get(uid);
}
// The season's two dailies (player intel on the real cycle): spend stamina
// (fills from normal farming) + a mob-family damage quest. The family
// rotates per season — the mock uses Lizard like the last one. Plus one
// already-reached tier reward to prove the generic claim sweep.
const BP_QUESTS = [
  { id: 101, title: 'Daily: Burn Stamina', objective: 'Spend 500 Stamina today', kind: 'stamina', goal: 500 },
  { id: 102, title: 'Daily: Lizard Damage', objective: 'Deal 300,000 damage to Lizard mobs', kind: 'damage', goal: 300000 },
];
const BP_TIER = { id: 201, title: 'Tier 2 Reward', objective: 'Reach Tier 2 · 100 BP XP' };
function bpQuestProgress(uid, q) {
  const bp = bpOf(uid);
  const v = q.kind === 'stamina' ? bp.stamina : bp.damage;
  return Math.min(v, q.goal);
}
// The Adventurers Guild quest catalogue — ids mirror the real page the
// scout captured (3 = kill contract, 4 = gather, 5 = skill).
const GUILD_QUESTS = {
  3: {
    id: 3, title: 'Shadowclaw Swarm',
    objective: 'Kill 5 monster(s) · Monster: lizardman shadowclaw · min 3m dmg',
    // The live description carries the monster + the "at least 3m damage" rule
    // — the ACTIVE row's rewritten objective drops the monster, and the
    // restart-mid-contract case recovers it from here.
    desc: 'Huge numbers of Lizardman Shadowclaws are pouring out of the gate. Kill 5 Lizardman Shadowclaws while dealing at least 3m damage to each',
    reward: '100 AP • 10,000 Gold • 0 Stat Points', rank: 'F – E', kind: 'kill', goal: 5,
  },
  4: { id: 4, title: 'Essence of the Goblinkin', objective: 'Gather 2x item(s) · Item: Goblin Essence', reward: '150 AP • 20,000 Gold • 0 Stat Points', rank: 'F – E', kind: 'gather', goal: 2 },
  5: { title: 'Skill Warm Up', id: 5, objective: 'Use 20 skills against monsters.', reward: '120 AP • 12,000 Gold • 0 Stat Points', rank: 'F – E', kind: 'kill', goal: 20 },
};
// Event daily board contract ids (the dispatch quest the real board offers).
const EVENT_DISPATCH_QUEST = 2304;

// ── Guild dungeon world ─────────────────────────────────────────────────
const DUNGEON_INSTANCES = [
  { id: 301, name: 'Shadowbridge Warrens', dungeonKey: 'easy', type: 'normal', ended: false, kindId: 1 },
  { id: 302, name: 'Castle of the Fallen Prince', dungeonKey: 'hard', type: 'hard', ended: false, kindId: 2 },
  { id: 303, name: 'The Polyhedral Crucible', dungeonKey: 'poly', type: 'poly', ended: false, kindId: 3 },
  // The cube dungeon — farmed like the live game now: the instance page
  // redirects to guild_dungeon_cube.php, whose STATE blob lists the combat
  // nodes (linked_location_id floors) the engine enters then fights.
  // A WRONG touch still leaves evidence: direct join/hit/loot without the
  // cube flow is fine (the live floors work directly too) — the dedicated
  // lastCubeAction record proves the enter_node POSTs happened.
  { id: 310, name: 'Cube Prison Depths', dungeonKey: 'cube', type: 'cube', ended: false, kindId: 3 },
  { id: 205, name: 'Shadowbridge Warrens', dungeonKey: 'easy', type: 'normal', ended: true, kindId: 1 },
];
const DUNGEON_TEMPLATE = {
  // easy · mob floors (loc 1 has content; 2-4 empty) + boss room (loc 5)
  '301:1': [
    { dgmid: 701, name: 'orc stone-rend', hp: 300, dead: false },
    { dgmid: 702, name: 'vorga ash-shaman', hp: 300, dead: true, joined: true },
    { dgmid: 703, name: 'krak one-horn', hp: 300, dead: true, joined: true, looted: true },
  ],
  // loc 2 — the contract-floor floor: a big lizardman shadowclaw (the mock
  // quest 3's contract monster with "min 3m dmg") + a runt whose max HP can
  // never reach the floor (the cycle must skip it BEFORE spending stamina).
  '301:2': [
    { dgmid: 705, name: 'lizardman shadowclaw', hp: 8000000, dead: false, bigHit: true },
    { dgmid: 706, name: 'lizardman runt', hp: 300, dead: false },
  ],
  '301:5': [
    { dgmid: 710, name: 'prince grixkar the hybrid', hp: 0, maxHp: 900, dead: true, joined: true, bossDamage: 50000 },
  ],
  // hard · first mob floor
  '302:6': [
    { dgmid: 711, name: 'the goblin royal vizier', hp: 450, dead: false },
  ],
  // poly · first mob floor
  '303:11': [
    { dgmid: 712, name: 'polyhedral sentry', hp: 300, dead: false },
  ],
  // ended easy run: one corpse left to collect
  '205:1': [
    { dgmid: 704, name: 'old brood husk', hp: 0, maxHp: 300, dead: true, joined: true },
  ],
  // the cube dungeon's floors — reached through the cube node flow
  '310:11': [
    { dgmid: 730, name: 'cube warden', hp: 250, dead: false },
  ],
  '310:14': [
    { dgmid: 740, name: 'the polyhedral apex', hp: 0, maxHp: 900, dead: true, joined: true, bossDamage: 10000 },
  ],
};
// Dungeon progress is PER-SESSION (a guild instance is private) — one deep
// copy per uid, so the farm's workers and the unit tests never race.
const dungeonByUid = new Map();
function dungeonOf(uid) {
  if (!dungeonByUid.has(uid)) {
    const copy = {};
    for (const [k, list] of Object.entries(DUNGEON_TEMPLATE)) {
      copy[k] = list.map((m) => ({
        ...m,
        maxHp: m.maxHp != null ? m.maxHp : m.hp,
        hp: m.dead ? 0 : m.hp,
      }));
    }
    dungeonByUid.set(uid, copy);
  }
  return dungeonByUid.get(uid);
}
function findDungeonMob(uid, dgmid) {
  const world = dungeonOf(uid);
  for (const list of Object.values(world)) {
    const m = list.find((x) => String(x.dgmid) === String(dgmid));
    if (m) return m;
  }
  return null;
}
const lastDungeonJoinByUid = new Map();
const lastDungeonDamageByUid = new Map();
const lastDungeonLootByUid = new Map(); // uid -> latest loot POST (workers loot concurrently)
let dungeonLootCount = 0;
// Cube-dungeon tripwire: flips true if ANY dungeon join / hit / loot ever
// targets the cube instance (id 310) or its wardens (dgmid 730/740). The
// engine farms the cube through guild_dungeon_cube.php's node flow, so this
// being true is EXPECTED — the dedicated lastCubeAction record proves the
// enter_node POSTs happened (the live protocol), not blind floor hits.
let cubeTouched = false;
const lastCubeActionByUid = new Map(); // uid -> latest enter_node POST body
function noteCubeTouch(body) {
  if (String(body.instance_id || '') === '310' || ['730', '740'].includes(String(body.dgmid || ''))) {
    cubeTouched = true;
  }
}

// The cube's run state (guild_dungeon_cube.php `const STATE = {…}`), shaped
// like the live page: six faces, nodes with linked_location_id floors,
// statuses available/cleared. Node 2 → floor 11 (warden), node 3 → floor 12
// (already cleared), node 4 → floor 14 (Apex gate, boss).
function cubeStateFor(uid) {
  const world = dungeonOf(uid);
  const warden = (world['310:11'] || [])[0] || {};
  const apex = (world['310:14'] || [])[0] || {};
  return {
    faces: [
      { ID: 1, DUNGEON_ID: 3, FACE_KEY: 'front', DISPLAY_NAME: 'Vanguard Breach', SUBTITLE: 'Forward extermination lane', DISPLAY_ORDER: 1, THEME_COLOR: '#70d6ff' },
      { ID: 2, DUNGEON_ID: 3, FACE_KEY: 'top', DISPLAY_NAME: 'Crown of Calibration', SUBTITLE: 'Convergence and boss seal', DISPLAY_ORDER: 2, THEME_COLOR: '#c1b3ff' },
    ],
    nodes: [
      { id: 1, face_key: 'front', key: 'arrival_gate', name: 'Arrival Gate', type: 'arrival', enter_label: 'Survey', status: 'available', is_revealed: 1, is_cleared: 0, is_boss_gate: 0, linked_location_id: 0 },
      { id: 2, face_key: 'front', key: 'extermination_1', name: 'Extermination I', type: 'combat', enter_label: 'Enter Extermination', status: warden.dead ? 'cleared' : 'available', is_revealed: 1, is_cleared: warden.dead ? 1 : 0, is_boss_gate: 0, linked_location_id: 11 },
      { id: 3, face_key: 'front', key: 'extermination_2', name: 'Extermination II', type: 'combat', enter_label: 'Enter Extermination', status: 'cleared', is_revealed: 1, is_cleared: 1, is_boss_gate: 0, linked_location_id: 12 },
      { id: 4, face_key: 'top', key: 'apex', name: 'Apex', type: 'boss', enter_label: 'Enter Apex', status: apex.dead ? 'cleared' : 'available', is_revealed: 1, is_cleared: apex.dead ? 1 : 0, is_boss_gate: 1, linked_location_id: 14 },
    ],
    edges: [],
    selected_node_id: null,
    current_face_key: 'front',
    total_clears: 2,
    entry_node_id: 1,
    intro_seen: 1,
    run_leaders: [],
    weekly_leaderboard: [],
    week_key: 'test',
    instance_closed: false,
  };
}

// ── Auto-summon cards (Boss Tracker world) ───────────────────────────────
// Rendered on the boss waves; the live ones' battle pages embed AUTO_DIE_CFG
// with the remaining life (nextDieHours → phase 2 ≤ 24h, phase 1 > 24h).
function autoSummonCards(waveKey) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cards = {
    'gate=3&wave=8': `
      <div class="auto-summon-card" data-alive="1" data-next-ts="${nowSec + 7200}">
        <div class="auto-summon-name">general skarn the radiant bastion</div>
        <div class="auto-summon-sub">Auto-die: 48h · phase 2</div>
        <a class="auto-join-btn" href="battle.php?id=9001">Join</a>
        <div class="auto-damage">🩸 You: 0</div>
      </div>
      <div class="auto-summon-card" data-alive="0" data-next-ts="${nowSec + 7200}">
        <div class="auto-summon-name">drakzareth the tyrant lizard king</div>
        <div class="auto-summon-sub">Auto-die: 48h · next spawn in 2h</div>
        <div class="auto-damage"></div>
      </div>`,
    'gate=5&wave=9': `
      <div class="auto-summon-card" data-alive="1" data-next-ts="${nowSec + 7200}">
        <div class="auto-summon-name">oceanus the water titan</div>
        <div class="auto-summon-sub">Auto-die: 48h · phase 1</div>
        <a class="auto-join-btn" href="battle.php?id=9005">Join</a>
        <div class="auto-damage">🩸 You: 0</div>
      </div>`,
  };
  return cards[waveKey] || '';
}

// corpseDmg: "You:" damage the game shows on DEAD rows (the corpse sweep's
// lootable signal, rendered only with the dead-boss cookies on).
const CORPSE_MOB_IDS = new Set([8305, 8511]);

// Test introspection.
let lastUseItem = null;
let useItemCount = 0;
const useItemByInv = {}; // inv_id -> latest use_item.php body (race-free)
const lastJoinByUid = new Map();    // uid -> latest join body (per-uid: unit tests race no workers)
const reqLog = [];                  // method/path/timestamp ring — timing forensics
function noteReq(m, p) {
  reqLog.push({ m, p, at: Date.now() });
  if (reqLog.length > 300) reqLog.splice(0, reqLog.length - 300);
}
const joinLog = [];                 // recent join bodies (timestamped, capped) — fleet-hunt proof
const fleetJoins = [];              // joins whose target was a live fleet-drone instance
const lastDamageByUid = new Map();  // uid -> latest damage.php body
const potionFailUid = new Set();    // uids whose use_item.php FAILS (stamina-gate tests)

function page(header, body) {
  return `<!doctype html><html><head><title>mock</title></head><body>${header || ''}${body || ''}</body></html>`;
}

function csrfInput(token) {
  return `<input type="hidden" name="csrf_token" value="${token}">`;
}

// The top bar every game page carries — live per-session stamina like the
// real #stamina_span / #stamina_timer. The max tracks the account's
// MAX_STAMINA (stat allocations grow it).
function topBar(uid) {
  const sta = staminaOf(uid);
  const max = uid ? statsOf(uid).user.MAX_STAMINA : STAMINA_MAX;
  return `<div class="gtb-stat"><span class="gtb-icon">💪</span>` +
    `<span class="gtb-label">Stamina</span><span class="gtb-value">` +
    `<span id="stamina_span">${sta.toLocaleString('en-US')}</span> / ${max.toLocaleString('en-US')}  </span>` +
    `<span id="stamina_timer" class="gtb-timer">⏳ 31:35</span></div>`;
}

function monsterRows(list, uid, corpseView) {
  return list.map((m) => {
    const you = uid ? (damageByUid.get(`${uid}:${m.id}`) || 0) : 0;
    const hpLeft = m.dead ? 0 : m.hp;
    // Dead-boss view (the corpse sweep's cookies): dead rows carry the
    // game's data-userdmg + a Loot button — the lootable-corpse signal.
    const corpseBits = (corpseView && m.dead)
      ? ` data-userdmg="${(m.corpseDmg || you || 0).toLocaleString('en-US')}"` +
        `<button class="loot-btn" data-loot="${m.id}">Loot</button>`
      : '';
    return `<div class="mon-row ${m.boss ? 'boss-card' : 'monster-card'}" data-monster-id="${m.id}" data-name="${m.name}" data-expire="${WAVE_EXPIRE_SEC}"${m.dead ? ' data-dead="1"' : ''}${corpseBits}>` +
      `<h3 class="name">${m.name}</h3>` +
      `<div class="hp-text">HP ${hpLeft.toLocaleString('en-US')} / ${m.maxHp.toLocaleString('en-US')}</div>` +
      `<span class="you-dmg">${you > 0 ? `You: ${you.toLocaleString('en-US')}` : 'You: 0'}</span>` +
      `<a class="btn join-btn" href="battle.php?id=${m.id}">Join Battle</a>` +
      (m.dead ? '<span class="defeated-tag">Defeated</span>' : '') +
      // Real wave rows are dense (avatar, buttons, HP bars...). Pad so the
      // engine's ±500-char dead-check window stays inside ONE row, like the
      // real page — otherwise the next row's data-dead leaks into this one.
      `<div class="mon-actions"><button class="attack-btn" data-mon="${m.id}">Attack</button>` +
      `<span class="hp-bar"><i style="width:${m.dead ? 0 : 87}%"></i></span>` +
      `<img src="/effect-icons/none.png" alt="" class="eff"><span class="loot-tier">T3</span>` +
      `<div class="party-badge">party slot</div><span class="respawn-timer">--:--</span>` +
      `<div class="extra-a">loot table loot table loot table loot table</div>` +
      `<div class="extra-b">drop rates drop rates drop rates drop rates drop rates</div>` +
      `<div class="extra-c">aggro range aggro range aggro range aggro range aggro</div></div></div>`;
  }).join('\n');
}

function gatesPage() {
  const sections = GATES.map((g) => {
    const hub = g.hub ? `<a href="${g.hub}">${g.name} hub</a> — ` : `<strong>${g.name}</strong> — `;
    const links = g.waves
      .map((w) => `<a href="active_wave.php?gate=${w.gate}&wave=${w.wave}">${w.label}</a>`)
      .join(' · ');
    return `<section class="gate">${hub}${links}</section>`;
  }).join('\n');
  return page(topBar(null), `<h1>Gates</h1>${sections}`);
}

function olympusPage() {
  const g = GATES.find((x) => x.hub);
  const links = g.waves
    .map((w) => `<a href="active_wave.php?gate=${w.gate}&wave=${w.wave}">${w.label}</a>`)
    .join(' · ');
  return page(topBar(null), `<h1>Gate 2 — Olympus</h1><section class="gate">${links}</section>`);
}

function parseBody(raw) {
  const out = {};
  for (const pair of String(raw || '').split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

function getCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

const json = (res, status, obj, extraHeaders = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(obj));
};
const html = (res, status, text, extraHeaders = {}) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(text);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  noteReq(req.method, path + (url.search || ''));
  const cookies = getCookies(req);
  const sid = cookies.PHPSESSID;
  const uid = sid && sessions.has(sid) ? sessions.get(sid) : null;

  let rawBody = '';
  req.on('data', (c) => { rawBody += c; });
  req.on('end', () => {
    const body = parseBody(rawBody);

    // ── Login flow ─────────────────────────────────────────────────────────
    if (path === '/game_login.php') {
      if (req.method === 'GET') {
        if (uid) return html(res, 303, '', { Location: '/dashboard.php' }); // signed in
        const token = crypto.randomBytes(8).toString('hex');
        csrfTokens.add(token);
        return html(res, 200, page(`<form>${csrfInput(token)}<input name="email"><input name="password"></form>`, 'login page'));
      }
      if (req.method === 'POST') {
        const token = body.csrf_token;
        const user = USERS[(body.email || '').toLowerCase()];
        if (csrfTokens.has(token) && user && user.password === body.password) {
          csrfTokens.delete(token);
          const newSid = crypto.randomBytes(8).toString('hex');
          sessions.set(newSid, user.uid);
          return html(res, 303, '', {
            Location: '/dashboard.php',
            'Set-Cookie': [
              `PHPSESSID=${newSid}; Path=/; Max-Age=86400`,
              `demon=${user.uid}; Path=/; Max-Age=86400`,
            ],
          });
        }
        csrfTokens.delete(token); // consumed either way, like real CSRF
        return html(res, 303, '', { Location: '/game_login.php?error=1' });
      }
    }

    if (path === '/game_logout.php') {
      if (req.method === 'GET') {
        const token = crypto.randomBytes(8).toString('hex');
        csrfTokens.add(token);
        return html(res, 200, page(`<form>${csrfInput(token)}</form>`));
      }
      if (req.method === 'POST' && csrfTokens.has(body.csrf_token)) {
        csrfTokens.delete(body.csrf_token);
        if (sid) sessions.delete(sid);
        return html(res, 303, '', {
          Location: '/game_login.php',
          'Set-Cookie': 'PHPSESSID=; Path=/; Max-Age=0',
        });
      }
    }

    // Test introspection (no session needed).
    if (path === '/__mock/last_use_item') {
      return json(res, 200, { last: lastUseItem, count: useItemCount });
    }
    if (path === '/__mock/state') {
      if (req.method === 'POST') {
        // Test backdoor: {uid, stamina} pins an account's stamina bar;
        // {uid, statPoints} re-seeds the banked stat points;
        // {rotateStatsCsrf: uid} rotates the stats csrf (next allocate with
        // the old token → 409, exercising the engine's self-heal);
        // {armStats409: uid} makes the NEXT allocation bounce 409 once.
        // Accept both JSON and urlencoded bodies (parseBody is urlencoded).
        let payload = body;
        try { payload = JSON.parse(rawBody); } catch (_) { /* keep form body */ }
        if (payload && payload.uid && payload.stamina != null) {
          staminaByUid.set(String(payload.uid), Number(payload.stamina));
        }
        if (payload && payload.uid && payload.statPoints != null) {
          statsOf(String(payload.uid)).user.STAT_POINTS = Number(payload.statPoints);
        }
        if (payload && payload.rotateStatsCsrf != null) {
          statsOf(String(payload.rotateStatsCsrf)).csrf = crypto.randomBytes(8).toString('hex');
        }
        if (payload && payload.armStats409 != null) {
          statsArmed409.add(String(payload.armStats409));
        }
        if (payload && payload.resetShops != null) {
          const u = String(payload.resetShops);
          goldByUid.set(u, 5000); guildPointsByUid.set(u, 2000);
          merchantStockByUid.set(u, { bought: 0 });
          guildBoughtByUid.set(u, 0); damonByUid.set(u, { bought: 0 });
        }
        if (payload && payload.uid && payload.gold != null) {
          shopSeed(String(payload.uid));
          goldByUid.set(String(payload.uid), Number(payload.gold));
        }
        if (payload && payload.resetGear != null) {
          gearByUid.delete(String(payload.resetGear));
        }
        if (payload && payload.resetDungeon != null) {
          // Fresh guild-dungeon runs for every account (per-uid state) — the
          // swarm test needs live dungeon mobs after the normal dungeon farm
          // cleared them pre-arm.
          dungeonByUid.clear();
        }
        if (payload && payload.killMob != null) {
          // Kill specific wave mobs by id (the swarm test clears the long
          // boss fights so workers reach their next cycle — and the swarm
          // hook — immediately).
          const ids = Array.isArray(payload.killMob) ? payload.killMob : [payload.killMob];
          for (const id of ids) {
            for (const list of Object.values(WAVE_MONSTERS)) {
              const m = list.find((x) => String(x.id) === String(id));
              if (m) { m.dead = true; m.hp = 0; }
            }
          }
        }
        if (payload && payload.resetMobs != null) {
          // Revive every wave mob farm-wide (the mock's mob death is GLOBAL —
          // `mon.dead = true` — so a fleet-hunt test needs live targets again
          // after the wave rounds farmed them dead).
          for (const list of Object.values(WAVE_MONSTERS)) {
            for (const m of list) { m.dead = false; m.hp = m.maxHp; }
          }
          damageByUid.clear();
        }
        if (payload && payload.resetReactions != null) {
          const u = String(payload.resetReactions);
          reactionsByUid.delete(`re:${u}`);
          reactionsByUid.delete(`csrf:${u}`);
        }
        if (payload && payload.resetDailies != null) {
          const u = String(payload.resetDailies);
          claimsStateByUid.delete(u);
          questStateByUid.delete(u);
          eventStateByUid.delete(u);
          bpStateByUid.delete(u);
          pageCsrfByUid.delete(u);
          treeByUid.delete(u);
          lastTreePostByUid.delete(u);
        }
        if (payload && payload.setQuest != null) {
          // Direct quest-state control for tests: {uid, accepted, progress}.
          const u = String(payload.setQuest.uid || payload.setQuest.id || '');
          const q = questOf(u);
          q.accepted = payload.setQuest.accepted ?? null;
          q.progress = payload.setQuest.progress ?? 0;
        }
        if (payload && payload.bpSeason != null) {
          // Battle-pass season switch: mirrors the real game's rotation.
          bpSeasonOn = !!payload.bpSeason;
        }
        if (payload && payload.resetClasses != null) {
          // Class-state reset (the game's choice is permanent — only the
          // mock can undo it): {uid} or {all: true}.
          if (payload.resetClasses.all) classByUid.clear();
          else classByUid.delete(String(payload.resetClasses.uid));
        }
        if (payload && payload.setBp != null) {
          // Direct battle-pass control for tests: {uid, stamina, damage, claimed}.
          const u = String(payload.setBp.uid);
          const bp = bpOf(u);
          if (payload.setBp.stamina != null) bp.stamina = payload.setBp.stamina;
          if (payload.setBp.damage != null) bp.damage = payload.setBp.damage;
          if (payload.setBp.claimed) bp.claimed = new Set(payload.setBp.claimed.map(String));
        }
        if (payload && payload.setTree != null) {
          // Direct tree-wallet control for tests: {uid, ap} — owned skills
          // stay untouched (resetTree clears them).
          const u = String(payload.setTree.uid);
          if (payload.setTree.ap != null) treeOf(u).ap = Number(payload.setTree.ap) || 0;
        }
        if (payload && payload.resetTree != null) {
          // Tree reset ({uid} or {all: true}) — fresh wallet, nothing owned.
          if (payload.resetTree.all) treeByUid.clear();
          else treeByUid.delete(String(payload.resetTree.uid));
        }
        if (payload && payload.potionFail != null) {
          // The stamina gate's sit-out branch: use_item.php FAILS for this
          // uid (the ladder is dry) so a dry account cannot drink its way
          // back into the fight.
          if (payload.potionFail) potionFailUid.add(String(payload.potionFail));
          else potionFailUid.clear();
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 200, {
        stamina: Object.fromEntries(staminaByUid),
        autoFarm: Object.fromEntries(
          [...autoFarm.entries()].map(([u, s]) => [u, { enabled: s.enabled, targets: s.targets.length }])
        ),
        damage: Object.fromEntries(damageByUid),
        lastJoin: Object.fromEntries(lastJoinByUid),
        reqLog: reqLog.slice(-80),
        joinLog: [...joinLog],
        fleetJoins: [...fleetJoins],
        lastDamage: Object.fromEntries(lastDamageByUid),
        lastUseItem,
        useItemByInv,
        lastAllocate,
        allocateCount,
        stats: Object.fromEntries(
          [...statsByUid.entries()].map(([u, s]) => [u, { view: s.view, user: { ...s.user } }])
        ),
        cooldowns: cooldownSeen.size,
        // reaction farm
        lastReaction,
        reactionCount,
        // shops
        lastMerchantBuy,
        lastGuildBuy,
        lastDamonBuy,
        gold: Object.fromEntries(goldByUid),
        guildPoints: Object.fromEntries(guildPointsByUid),
        merchantBought: Object.fromEntries(
          [...merchantStockByUid.entries()].map(([u, s]) => [u, s.bought])
        ),
        // gear: equip-best + blacksmith
        lastEquipPost,
        equipPostCount,
        lastCraftPost,
        crafts: Object.fromEntries(craftsByUid),
        equipped: Object.fromEntries(
          [...gearByUid.entries()].map(([u, g]) => [u, Object.fromEntries([...g.equipped.entries()].map(([slot, it]) => [slot, it.name]))])
        ),
        guildBought: Object.fromEntries(guildBoughtByUid),
        damonBought: Object.fromEntries([...damonByUid.entries()].map(([u, s]) => [u, s.bought])),
        // dungeon
        lastDungeonJoin: Object.fromEntries(lastDungeonJoinByUid),
        lastDungeonDamage: Object.fromEntries(lastDungeonDamageByUid),
        lastDungeonLoot: Object.fromEntries(lastDungeonLootByUid),
        dungeonLootCount,
        cubeTouched,
        lastCubeAction: Object.fromEntries(lastCubeActionByUid),
        // wave-page potion-limit form
        lastPotionSetting,
        // dailies: claims / guild quests / event contracts / kill-loot hook
        lastLootPost,
        claims: Object.fromEntries(
          [...claimsStateByUid.entries()].map(([u, s]) => [u, { ach: [...s.ach], col: [...s.col] }])
        ),
        quests: Object.fromEntries(
          [...questStateByUid.entries()].map(([u, s]) => [u, { accepted: s.accepted, progress: s.progress, finished: [...s.finished], donated: s.donated }])
        ),
        events: Object.fromEntries(
          [...eventStateByUid.entries()].map(([u, s]) => [u, { dispatch: [...s.dispatch], enrolled: s.enrolled }])
        ),
        // battle pass
        bpSeasonOn,
        battlePass: Object.fromEntries(
          [...bpStateByUid.entries()].map(([u, s]) => [u, { stamina: s.stamina, damage: s.damage, claimed: [...s.claimed] }])
        ),
        // classes
        classes: Object.fromEntries(classByUid),
        lastClassPost: Object.fromEntries(lastClassPostByUid),
        // class skill trees (AP wallet + owned skills per session)
        trees: Object.fromEntries(
          [...treeByUid.entries()].map(([u, s]) => [u, { ap: s.ap, owned: Object.fromEntries([...s.owned.entries()].map(([k, v]) => [k, v])) }])
        ),
        lastTreePost: Object.fromEntries(lastTreePostByUid),
      });
    }

    // Everything below requires a session; otherwise bounce to login.
    if (!uid) {
      return html(res, 303, '', { Location: '/game_login.php' });
    }

    // ── Player pages ───────────────────────────────────────────────────────
    if (path === '/inventory.php') {
      const user = Object.values(USERS).find((u) => u.uid === uid);
      // slot-boxes mirror the real inventory page: a decoy HP potion the
      // engine must skip, and the Large Stamina Potion it should drink
      // (useItem(invId, itemId) like the game's onclick handler).
      const slots = [
        `<div class="slot-box"><span class="slot-name">Small HP Potion</span>` +
          `<button onclick="useItem(555, 101)">use</button></div>`,
        `<div class="slot-box"><span class="slot-name">Large Stamina Potion</span>` +
          `<button onclick="useItem(777, 143)">use</button></div>`,
      ].join('\n');
      // Gear sections mirror the LIVE inventory page's wire format:
      // equipped rows carry unequipItem(<slotId>) + the ATK/DEF spans in the
      // label; bag rows carry data-equip/data-inv-id/data-typee/data-atk/
      // data-def. equip.js reads exactly these.
      const gear = gearOf(uid);
      const SLOT_NAMES = { 1: 'weapon', 2: 'helmet', 3: 'armor', 4: 'boots', 5: 'gloves', 6: 'ring', 7: 'amulet' };
      const equippedHtml = [...gear.equipped.entries()].map(([slotId, it]) =>
        `<div class="slot-box"><div class="item-container"><img src="images/items/x.webp" alt="${it.name}"></div>` +
        `<div class="label">\n    ${SLOT_NAMES[slotId] || it.type}<br>\n` +
        `    🔪 <span class="">${it.atk}</span> ATK\n    ·\n    🛡️ <span class="">${it.def}</span> DEF\n</div>` +
        `<button class="btn" onclick="unequipItem(${slotId})">Unequip</button></div>`
      ).join('\n');
      const bagHtml = gear.bag.map((it) =>
        `<div class="slot-box " id="equip-${it.invId}" data-equip="1" data-order="0" ` +
        `data-inv-id="${it.invId}" data-typee="${it.type}" data-item-type="${it.type}" data-item-group="${it.type}" ` +
        `data-atk="${it.atk}"\ndata-def="${it.def}">` +
        `<div class="equipment-type-badge">${it.type}</div>` +
        `<img src="images/items/y.webp" alt="${it.name}">` +
        `<div class="equipment-item-name">${it.name}</div>` +
        `<div class="label">🔪 <span class="">${it.atk}</span> ATK · 🛡️ <span class="">${it.def}</span> DEF<br>` +
        `<button class="btn" onclick="showEquipModal(24, '${it.type}', '${it.invId}')">Equip</button>` +
        `<div style="margin-top:6px; font-size:13px; color:#aaa;">x${it.qty || 1}    </div></div></div>`
      ).join('\n');
      return html(res, 200, page(
        `<div class="gtb-level">LV ${user.level}</div><a href="profile.php?id=${uid}">profile</a><script>const USER_ID = '${uid}';</script>`,
        slots +
        `<div class="section"><div class="section-title">🛡️ Equipped Items — PvE Attack Set</div><div class="grid">${equippedHtml}</div></div>` +
        `<div class="section"><div class="section-title">⚔️ Equipment</div><div class="grid">${bagHtml}</div></div>` +
        monsterRows([])
      ));
    }

    // inventory_ajax.php — the game's own equip/unequip wire ("OK" on success).
    if (path === '/inventory_ajax.php' && req.method === 'POST') {
      const gear = gearOf(uid);
      lastEquipPost = { action: body.action, inv_id: body.inv_id, slot_id: body.slot_id, set: body.set, uid, at: Date.now() };
      equipPostCount++;
      if (body.action === 'equip_item') {
        const idx = gear.bag.findIndex((b) => String(b.invId) === String(body.inv_id));
        if (idx < 0) return html(res, 200, 'ERR: no such bag item');
        const item = gear.bag.splice(idx, 1)[0];
        const slotId = GEAR_SLOT[item.type] || 1;
        const previous = gear.equipped.get(slotId);
        if (previous) gear.bag.push(previous); // the worn item goes back to the bag
        gear.equipped.set(slotId, item);
        return html(res, 200, 'OK');
      }
      if (body.action === 'unequip_item') {
        const slotId = Number(body.slot_id) || 1;
        const previous = gear.equipped.get(slotId);
        if (!previous) return html(res, 200, 'ERR: empty slot');
        gear.equipped.delete(slotId);
        gear.bag.push(previous);
        return html(res, 200, 'OK');
      }
      return html(res, 200, 'ERR: unknown action');
    }

    // ── Blacksmith (recipes + craft) ────────────────────────────────────────
    if (path === '/blacksmith.php') {
      const gate = String((url.searchParams.get('gate') || '3'));
      const cards = gate === '3'
        ? RECIPES.map((r) => `<div class="card ">
            <div class="hover-wrap">
              <img src="images/items/r${r.id}.webp" alt="Item" class="result-img ">
              <button type="button" class="info-btn"
                data-name="${r.name}"
                data-desc="A mock recipe."
                data-attack="${r.atk}"
                data-defense="${r.def}"
                data-element="NONE">i</button>
            </div>
            <div class="result-name">${r.name}</div>
            <div class="result-attack">🔪 Attack: ${r.atk}</div>
            <div class="result-defense">🛡️ Defense: ${r.def}</div>
            <div class="reqs">
              ${r.reqs.map((q) => `<div class="req hover-wrap" title="${q.name}"><img src="images/items/m.webp"><div class="qty ${q.ok ? 'good' : 'bad'}">${q.have}/${q.need}</div></div>`).join('\n')}
            </div>
            <div class="forge">
              <form method="POST" action="craft_item.php">
                <input type="hidden" name="recipe_id" value="${r.id}">
                <button class="forge-btn"${r.craftable ? '' : ' disabled'}>Forge</button>
              </form>
            </div>
          </div>`).join('\n')
        : '<div class="recipe-grid"></div>';
      return html(res, 200, page(topBar(uid),
        `<nav class="gate-menu"><a class="gate-tab active" href="blacksmith.php?gate=3"><span>Grakthar</span><span class="gate-count">${RECIPES.length}</span></a></nav>` +
        `<div class="gate-selection">recipes gate ${gate}</div><div class="recipe-grid">${cards}</div>`
      ));
    }
    if (path === '/craft_item.php' && req.method === 'POST') {
      const recipe = RECIPES.find((r) => String(r.id) === String(body.recipe_id));
      lastCraftPost = { recipe_id: body.recipe_id, uid, at: Date.now() };
      if (!recipe) return html(res, 200, 'Error: unknown recipe');
      if (!recipe.craftable) return html(res, 200, `Error: not enough materials for ${recipe.name}`);
      if (!craftsByUid.has(uid)) craftsByUid.set(uid, []);
      craftsByUid.get(uid).push({ id: recipe.id, name: recipe.name, at: Date.now() });
      // The crafted item joins the bag — the equip-best round wears it.
      gearOf(uid).bag.push({ invId: `88600${recipe.id.slice(-2)}`, type: 'weapon', name: recipe.name, atk: recipe.atk, def: recipe.def, qty: 1 });
      return html(res, 200, `Success! You have successfully forged ${recipe.name}.`);
    }

    if (path === '/stats.php') {
      // The EXP span the engine polls + the #stats-state element the stat
      // allocator reads (csrf / view / user attributes), like the real page.
      const s = statsOf(uid);
      return html(res, 200, page(topBar(uid),
        '<span>EXP&nbsp;</span><span>45,000,000 / 50,000,000</span>' +
        `<div id="stats-state" hidden>${JSON.stringify(s)}</div>`
      ));
    }

    if (path === '/stats_ajax.php' && req.method === 'POST') {
      const s = statsOf(uid);
      lastAllocate = {
        action: body.action != null ? body.action : null,
        stat: body.stat != null ? body.stat : null,
        amount: body.amount != null ? body.amount : null,
        csrf: body.csrf != null ? body.csrf : null,
        view: body.view != null ? body.view : null,
        request_id: body.request_id != null ? body.request_id : null,
        uid,
        at: Date.now(),
      };
      allocateCount++;
      // Test hook: a one-shot 409 BEFORE any validation — simulates the
      // server expiring the token mid-plan so the engine must re-sync.
      if (statsArmed409.has(uid)) {
        statsArmed409.delete(uid);
        return json(res, 409, { ok: false, error: 'csrf token expired' });
      }
      if (body.action !== 'allocate') return json(res, 200, { ok: false, error: 'unknown action' });
      if (!['attack', 'defense', 'stamina'].includes(String(body.stat))) {
        return json(res, 200, { ok: false, error: 'unknown stat' });
      }
      // The chunk whitelist — anything outside [100, 50, 5, 1] is rejected.
      if (!['100', '50', '5', '1'].includes(String(body.amount))) {
        return json(res, 400, { ok: false, error: 'invalid chunk amount' });
      }
      if (String(body.csrf) !== s.csrf) return json(res, 409, { ok: false, error: 'csrf token expired' });
      if (String(body.view) !== String(s.view)) return json(res, 409, { ok: false, error: 'stale stats view' });
      const seen = statsSeenRequests.get(uid) || new Set();
      if (seen.has(String(body.request_id))) {
        return json(res, 409, { ok: false, error: 'duplicate request_id' });
      }
      seen.add(String(body.request_id));
      statsSeenRequests.set(uid, seen);
      const amount = Number(body.amount);
      if (s.user.STAT_POINTS < amount) return json(res, 200, { ok: false, error: 'not enough stat points' });
      s.user.STAT_POINTS -= amount;
      if (body.stat === 'attack') s.user.ATTACK += amount;
      if (body.stat === 'defense') s.user.DEFENSE += amount;
      if (body.stat === 'stamina') s.user.MAX_STAMINA += amount;
      s.view++;
      return json(res, 200, { ok: true, user: { ...s.user }, view: s.view });
    }

    if (path === '/dashboard.php') {
      return html(res, 200, page(topBar(uid), `<a href="profile.php?id=${uid}">me</a>`));
    }

    // ── Gate hub pages ─────────────────────────────────────────────────────
    if (path === '/gates.php') {
      return html(res, 200, gatesPage());
    }
    if (path === '/olympus.php') {
      return html(res, 200, olympusPage());
    }

    // ── Wave pages ─────────────────────────────────────────────────────────
    if (path === '/active_wave.php' && req.method === 'POST') {
      // The wave page's potion-limit form (Max Large/Full Stamina Potions to
      // use — the auto-battle's budget). The engine raises it after a level-up.
      lastPotionSetting = { ...body, uid, at: Date.now() };
      return html(res, 200, page(topBar(uid), 'settings saved'));
    }
    if (path === '/active_wave.php') {
      const kind = url.searchParams.get('gate') != null ? 'gate' : 'event';
      const waveKey = `${kind}=${url.searchParams.get(kind)}&wave=${url.searchParams.get('wave')}`;
      const deadPage = url.searchParams.get('dead_page');
      let list = WAVE_MONSTERS[waveKey] || [];
      // dead_page=N → the game's paginated dead-loot view: ONLY that page's
      // corpses render (with the loot affordances on).
      if (deadPage != null) {
        list = list.filter((m) => m.dead && String(m.deadPage || 1) === String(deadPage));
      }
      const targets = autoFarm.get(uid);
      const targetHtml = (targets && targets.enabled)
        ? targets.targets.map((t, i) =>
            `<div class="af-row" data-target-id="${i + 1}">` +
            `<input class="afTEnabled" value="1"><input class="afTMonster" value="${t.MONSTER_ID}">` +
            `<input class="afTMode" value="1"><input class="afTMin" value="0"><input class="afTStack" value="10"></div>`)
          .join('\n')
        : '';
      const corpseView = cookies.show_dead_bosses_only === '1' && cookies.hide_dead_monsters !== '1';
      // The dead-loot pager (the LevelUp Looter's getWaveTotalLootPages source).
      const pages = Math.max(1, ...list.map((m) => m.deadPage || 1));
      const pager = list.some((m) => m.dead)
        ? `<div class="batch-loot-card">Dead loot page 1 / ${pages}</div>` : '';
      // The auto-battle potion-limit form (raised after level-ups).
      const potionForm = `<form class="batch-loot-card potion-limits" method="post" action="/active_wave.php">` +
        `<input type="hidden" name="af_nonce" value="w1">` +
        `<div class="lim-row">Max Large Stamina Potions to use <span class="pill">Used: 3</span>` +
        `<input type="number" name="max_lsp" value="50"></div>` +
        `<div class="lim-row">Max Full Stamina Potions to use <span class="pill">Used: 1</span>` +
        `<input type="number" name="max_fsp" value="20"></div>` +
        `<button type="submit">Save</button></form>`;
      return html(res, 200, page(topBar(uid), autoSummonCards(waveKey) + pager + potionForm + monsterRows(list, uid, corpseView || deadPage != null) + targetHtml));
    }

    // ── Combat ─────────────────────────────────────────────────────────────
    if (path === '/user_join_battle.php' && req.method === 'POST') {
      // Record the exact join body — the live wave client sends all three
      // fields (id, monster_id, user_id). joinLog keeps the recent history
      // (timestamped) so tests can prove WHO joined WHAT and WHEN — a
      // "last join per uid" map is too racy for fleet-hunt assertions.
      const joinBody = {
        id: body.id != null ? body.id : null,
        monster_id: body.monster_id != null ? body.monster_id : null,
        user_id: body.user_id != null ? body.user_id : null,
        uid,
        at: Date.now(),
      };
      lastJoinByUid.set(uid, joinBody);
      joinLog.push(joinBody);
      if (joinLog.length > 500) joinLog.shift();
      const mon = findMonster(body.monster_id);
      // Fleet-drone join proof: a join whose target IS (right now) a fleet
      // drone instance — stale (already respawned) ids resolve to nothing.
      if (mon && mon.name === 'fleet drone') {
        fleetJoins.push({ uid, monster_id: body.monster_id, at: Date.now() });
        if (fleetJoins.length > 200) fleetJoins.shift();
      }
      if (!mon) return html(res, 200, 'monster not found');
      if (mon.dead) return html(res, 200, 'this monster is already dead');
      // A fresh join re-arms the rate limit, like the real server.
      cooldownSeen.delete(`${uid}:${mon.id}`);
      return html(res, 200, `JOINED battle with ${mon.name}`);
    }

    if (path === '/damage.php' && req.method === 'POST') {
      // Dungeon branch (DungeonCleaner contract): instance_id + dgmid instead
      // of monster_id. Same reply shape, mob state kept per dgmid.
      if (body.instance_id != null && body.dgmid != null) {
        noteCubeTouch(body);
        const dmon = findDungeonMob(uid, body.dgmid);
        if (!dmon) return json(res, 200, { status: 'error', message: 'monster not found' });
        if (dmon.dead) return json(res, 200, { status: 'error', message: 'this monster is already dead' });
        const dcost = Number(body.stamina_cost || 1) || 1;
        const dsta = staminaOf(uid);
        if (dsta < dcost) return json(res, 200, { status: 'error', message: 'Not enough stamina' });
        staminaByUid.set(uid, dsta - dcost);
        lastDungeonDamageByUid.set(uid, {
          instance_id: body.instance_id,
          dgmid: body.dgmid,
          skill_id: body.skill_id != null ? body.skill_id : null,
          stamina_cost: body.stamina_cost != null ? body.stamina_cost : null,
          uid,
          at: Date.now(),
        });
        const ddmg = dmon.bigHit ? 250000 : 150;
        dmon.hp -= ddmg;
        if (dmon.hp <= 0) { dmon.dead = true; dmon.hp = 0; }
        const dkey = `${uid}:${dmon.dgmid}`;
        const dtotal = (damageByUid.get(dkey) || 0) + ddmg;
        damageByUid.set(dkey, dtotal);
        return json(res, 200, {
          status: 'success',
          message: `You dealt <strong>${ddmg.toLocaleString('en-US')}</strong> damage.`,
          totaldmgdealt: dtotal,
          stamina: staminaByUid.get(uid),
          hp: { value: dmon.hp, max: dmon.maxHp, percent: dmon.maxHp > 0 ? Math.max(0, Math.round((dmon.hp / dmon.maxHp) * 100)) : 0 },
        });
      }
      const mon = findMonster(body.monster_id);
      if (!mon) return json(res, 200, { status: 'error', message: 'monster not found' });
      if (mon.dead) return json(res, 200, { status: 'error', message: 'this monster is already dead' });
      if (autoFarm.get(uid) && autoFarm.get(uid).enabled) {
        return json(res, 200, { status: 'error', message: 'your auto farm is on' });
      }
      // Stamina gate: the skill's cost is charged like the real server.
      const cost = Number(body.stamina_cost || 1) || 1;
      const sta = staminaOf(uid);
      if (sta < cost) {
        return json(res, 200, { status: 'error', message: 'Not enough stamina' });
      }
      staminaByUid.set(uid, sta - cost);
      // Rate limit: the first hit after a join bounces with a cooldown hint.
      const key = `${uid}:${mon.id}`;
      if (!cooldownSeen.has(key)) {
        cooldownSeen.add(key);
        return json(res, 200, { status: 'error', message: 'you are attacking too quickly — cooldown active' });
      }
      lastDamageByUid.set(uid, {
        monster_id: body.monster_id != null ? body.monster_id : null,
        skill_id: body.skill_id != null ? body.skill_id : null,
        stamina_cost: body.stamina_cost != null ? body.stamina_cost : null,
        uid,
        at: Date.now(),
      });
      // Kill/skill Adventurers Guild contracts progress on manual hits —
      // the wave farm IS the manual hit source (the real game counts these).
      const gq = questOf(uid);
      if (gq.accepted && GUILD_QUESTS[gq.accepted] && GUILD_QUESTS[gq.accepted].kind === 'kill') {
        gq.progress = Math.min(GUILD_QUESTS[gq.accepted].goal, gq.progress + 1);
      }
      const dmg = mon.bigHit ? 250000 : 150; // deterministic probe base like the extension expects
      // Battle-pass dailies: stamina spent + damage to the season's mob
      // family (the mock's families are Lizard and Sea, like the last
      // seasons). Capped at the quest goals like the real progress bars.
      if (bpSeasonOn) {
        const bp = bpOf(uid);
        bp.stamina = Math.min(500, bp.stamina + cost);
        if (/lizard|sea|serpent|reef/i.test(mon.name)) {
          bp.damage = Math.min(300000, bp.damage + dmg);
        }
      }
      mon.hp -= dmg;
      const total = (damageByUid.get(key) || 0) + dmg;
      damageByUid.set(key, total);
      if (mon.hp <= 0) {
        mon.dead = true;
        mon.hp = 0;
        // respawning mobs come back as a NEW instance id on the same wave —
        // the game's own churn semantics (the old id is gone forever).
        if (mon.respawn) {
          setTimeout(() => {
            mon.id = ++mockMobIdSeq;
            mon.dead = false;
            mon.hp = mon.maxHp;
          }, 2500).unref();
        }
      }
      return json(res, 200, {
        status: 'success',
        message: `You dealt <strong>${dmg.toLocaleString('en-US')}</strong> damage.`,
        totaldmgdealt: total,
        stamina: staminaByUid.get(uid),
        hp: {
          value: mon.hp,
          max: mon.maxHp,
          percent: mon.maxHp > 0 ? Math.max(0, Math.round((mon.hp / mon.maxHp) * 100)) : 0,
        },
        phase: { current: 3 },
      });
    }

    if (path === '/user_heal_potion.php' && req.method === 'POST') {
      return html(res, 200, 'success — healed');
    }

    // /pets.php — the equipped "PvE Attack Team" (loadout.js sums the
    // pet-atk data-attack spans for the damage forecast's pet_atk).
    if (path === '/pets.php') {
      const pets = [
        { inv: 7001, atk: 120, lvl: 7 },
        { inv: 7002, atk: 95, lvl: 4 },
      ];
      const cards = pets.map((p) =>
        `<div class="slot-box pet-card" data-pet-inv-id="${p.inv}">` +
        `<div class="label"> 🧪 Lv. <span class="pet-level">${p.lvl}</span> &nbsp;|&nbsp; 🔪 ` +
        `<span class="pet-atk " data-attack>${p.atk}</span> ATK &nbsp;|&nbsp; ` +
        `<span class="pet-def " data-defense>0</span> DEF</div></div>`).join('');
      return html(res, 200, page(topBar(uid),
        `<div class="container"><h1>🐾 Pets Inventory</h1>` +
        `<div class="section"><div class="section-title"> PvE Attack Team </div><div class="grid">${cards}</div></div></div>`));
    }

    if (path === '/use_item.php' && req.method === 'POST') {
      // Test backdoor: {potionFail: uid} makes the ladder FAIL for that uid
      // (the swarm's stamina gate must then sit the account out).
      if (potionFailUid.has(String(uid))) return html(res, 500, 'ERR: none left');
      // Record every received field (null when absent) so tests can assert
      // the exact wire format: the game's own drawer sends inv_id only.
      lastUseItem = {
        inv_id: body.inv_id != null ? body.inv_id : null,
        item_id: body.item_id != null ? body.item_id : null,
        qty: body.qty != null ? body.qty : (body.quantity != null ? body.quantity : null),
        at: Date.now(),
      };
      useItemCount++;
      // Latest use per inv id — race-free introspection when several accounts
      // drink at once (the global lastUseItem only remembers the final POST).
      useItemByInv[String(body.inv_id || '')] = { ...lastUseItem };
      // A stamina potion actually refills the bar (Full/Large/Small alike)
      // — to the account's CURRENT max (allocations grow MAX_STAMINA).
      if (POTION_KIND[String(body.inv_id || '')] === 'stamina') {
        staminaByUid.set(uid, statsOf(uid).user.MAX_STAMINA);
      }
      return html(res, 200, 'consumed successfully');
    }

    // View-only battle page (battle.php?id={id}, no damage). Mirrors the real
    // page: player HP card (#pHpText), the battleDrawer potion cards
    // (data-inv is per-account, data-item stable), the monster state and —
    // for mobs that have one — the loot table with its DMG req gate.
    if (path === '/battle.php' && req.method === 'GET') {
      // Dungeon boss variant: battle.php?dgmid=X&instance_id=Y → your damage.
      const dgmid = url.searchParams.get('dgmid');
      if (dgmid) {
        const dmon = findDungeonMob(uid, dgmid);
        const dmg = dmon && dmon.bossDamage ? dmon.bossDamage : 0;
        return html(res, 200, page(topBar(uid),
          `<div class="battle-card"><div class="stat-block"><span class="label">Your Damage</span>` +
          `<div id="yourDamageValue">${dmg.toLocaleString('en-US')}</div></div></div>`));
      }
      const mon = findMonster(url.searchParams.get('id'));
      if (!mon) return html(res, 200, page('', 'monster not found'));
      const cards = [
        { inv: 303210560, item: 30, name: 'Small Stamina Potion', qty: 1723 },
        { inv: 1037434583, item: 35, name: 'Full Stamina Potion', qty: 458 },
        { inv: 1158290406, item: 251, name: 'Large Stamina Potion', qty: 139 },
        { inv: 22313874, item: 162, name: 'Mana Potion S', qty: 11343 },
        { inv: 396373, item: 108, name: 'Full Hp Potion', qty: 10948 },
      ].map((p) =>
        `<div class="potion-card" data-inv-id="${p.inv}" data-item-id="${p.item}">` +
        `<button class="potion-use-btn" data-inv="${p.inv}" data-item="${p.item}" ` +
        `data-name="${p.name}" data-max="${p.qty}" type="button">Use</button></div>`
      ).join('\n');
      const lootHtml = mon.loot && mon.loot.req
        ? `<div class="panel"><h4>Possible Loot</h4><div class="loot-grid">` +
          `<div class="loot-card"><strong>${mon.loot.name}</strong>` +
          `<span>DMG req: ${mon.loot.req.toLocaleString('en-US')}</span></div>` +
          `</div></div>`
        : '';
      // The "View Monster Stats" modal (the exact wire the real battle page
      // embeds — monster-stats.js parses it for the swarm's damage forecast).
      const ms = mon.mstats || {};
      const mcell = (label, val, cls) =>
        `<div class="monster-stat-cell${cls || ''}"><span class="label">${label}</span><strong>${val}</strong></div>`;
      const statsModal =
        `<div id="monsterStatsModal" class="battle-modal-backdrop" style="display:none">` +
        `<div class="battle-modal-card"><div class="battle-modal-head">` +
        `<h2>${mon.name} Stats</h2>` +
        `<button type="button" class="battle-modal-close" onclick="closeMonsterStatsModal()">Close</button></div>` +
        `<p class="battle-modal-copy">Detailed monster stats and resistance values for this battle.</p>` +
        `<div class="monster-stats-grid">` +
        mcell('Attack', ms.atk || 0) +
        mcell('Defense', ms.def || 0) +
        mcell('Pet Defense', ms.petDef || 0) +
        mcell('Equipment Defense', ms.eqDef || 0) +
        mcell('Element', ms.element || 'None') +
        mcell('Element Rate', (ms.elementRate || 0) + '%') +
        mcell('Rewards Up To', 'LV ' + (ms.rewardsLv || 300)) +
        mcell('Crit Rate Resistance', (ms.critRateRes || 0) + '%', ' resistance') +
        mcell('Crit Damage Resistance', (ms.critDmgRes || 0) + '%', ' resistance') +
        mcell('Final Damage Resistance', (ms.finalRes || 0) + '%', ' resistance') +
        mcell('Passive Damage Resistance', (ms.passiveRes || 0) + '%', ' resistance') +
        `</div></div></div>` +
        `<button type="button" class="monster-stats-button" onclick="openMonsterStatsModal()">View Monster Stats</button>` +
        `<script>function openMonsterStatsModal(){var m=document.getElementById('monsterStatsModal');if(m)m.style.display='flex';}\n` +
        `function closeMonsterStatsModal(){var m=document.getElementById('monsterStatsModal');if(m)m.style.display='none';}</script>`;
      // EXP stat blocks (the LevelUp Looter's readWaveExpMeta: EXP Cap ~N,
      // EXP / DMG rate) — drive the corpse sweep's best-EXP-first order.
      const expBlocks =
        `<div class="stat-block"><span class="label">EXP Cap</span><span>~${(mon.expCap || 1500).toLocaleString('en-US')}</span></div>` +
        `<div class="stat-block"><span class="label">EXP / DMG</span><strong>0.02</strong></div>`;
      return html(res, 200, page(topBar(uid),
        `<div class="battle-card player-card">` +
        `<div class="hp-text" id="pHpText" style="font-size:13px;">💚 376,500 / 358,250 HP</div>` +
        `<div class="mp-text" id="pManaText" style="font-size:13px;">🔷 200 / 1,200 MP</div></div>` +
        `<aside id="battleDrawer">${cards}</aside>` +
        `<div class="battle-view" data-monster-id="${mon.id}" data-name="${mon.name}"${mon.dead ? ' data-dead="1"' : ''}>` +
        `<h3>${mon.name}</h3><span class="hp-bar">${mon.dead ? 'this monster is already dead' : 'alive'}</span></div>` +
        lootHtml + expBlocks + statsModal +
        // 48h auto-die bosses embed their true death clock (Boss Tracker's
        // AUTO_DIE_CFG — the only honest remaining-life source).
        (mon.nextDieHours
          ? `<script>window.AUTO_DIE_CFG = { nextDieMs: ${Date.now() + mon.nextDieHours * 3600000}, serverNowMs: ${Date.now()} };</script>`
          : '')
      ));
    }

    if (path === '/loot.php' && req.method === 'POST') {
      // Record the whole request — the kill-loot hook must send the same
      // shape the game's own Loot button does (instance_id '0' + dgmid).
      lastLootPost = {
        monster_id: body.monster_id != null ? body.monster_id : null,
        user_id: body.user_id != null ? body.user_id : null,
        instance_id: body.instance_id != null ? body.instance_id : null,
        dgmid: body.dgmid != null ? body.dgmid : null,
        uid,
        at: Date.now(),
      };
      const mon = findMonster(body.monster_id);
      if (!mon) return json(res, 200, { status: 'error', message: 'monster not found' });
      return json(res, 200, {
        status: 'success',
        message: 'You earned <strong>500 EXP</strong>.',
        rewards: { exp: 500, gold: 120 },
        items: [{ name: 'Bone Shard', qty: 1 }],
      });
    }

    // ── Reaction stamina farm (postreaction.php contract) ─────────────────
    if (path === '/' || path === '/lastupdates.php') {
      const links = MANGAS.map((s) => `<a href="/manga/${s}">${s}</a>`).join('\n');
      return html(res, 200, page(topBar(uid), `<div class="updates">${links}</div>`));
    }
    if (path.startsWith('/manga/')) {
      const slug = path.replace('/manga/', '');
      const mangaId = MANGA_IDS[slug];
      if (!mangaId) return html(res, 404, page('no manga'));
      const links = [...CHAPTERS[mangaId]].reverse()
        .map((c) => `<a href="/chaptered.php?manga=${mangaId}&chapter=${c}">chapter ${c}</a>`)
        .join('\n');
      return html(res, 200, page(topBar(uid), `<div class="chapters">${links}</div>`));
    }
    if (path === '/chaptered.php') {
      const mangaId = Number(url.searchParams.get('manga'));
      const chapter = url.searchParams.get('chapter');
      const cid = chapterIdOf(mangaId, chapter);
      if (!cid) return html(res, 404, page('no chapter'));
      return html(res, 200, page(topBar(uid),
        `<div id="cw-comments" data-chapter="${cid}">comments</div>`));
    }
    if (path === '/comments_api.php') {
      // The reaction widget's csrf source: { viewer: { csrf } }. No session →
      // no viewer (the farm script's "not-logged" branch).
      if (!uid) return json(res, 200, { viewer: null });
      const csrf = crypto.randomBytes(8).toString('hex');
      reactionsByUid.set(`csrf:${uid}`, csrf);
      return json(res, 200, { viewer: { csrf }, comments: [] });
    }
    if (path === '/postreaction.php' && req.method === 'POST') {
      lastReaction = {
        chapterid: body.chapterid != null ? body.chapterid : null,
        reaction: body.reaction != null ? body.reaction : null,
        useruid: body.useruid != null ? body.useruid : null,
        csrf: body.csrf != null ? body.csrf : null,
        uid,
        at: Date.now(),
      };
      // Wrong or missing csrf → empty reply (the script's failure branch).
      if (!body.csrf || body.csrf !== reactionsByUid.get(`csrf:${uid}`)) {
        return html(res, 200, '');
      }
      const seen = reactionsByUid.get(`re:${uid}`) || new Map();
      reactionsByUid.set(`re:${uid}`, seen);
      const first = !seen.has(String(body.chapterid));
      seen.set(String(body.chapterid), body.reaction);
      reactionCount++;
      return html(res, 200, first ? 'added' : 'updated');
    }

    // ── Shops (merchant / guild / Damon) ────────────────────────────────────
    if (path === '/merchant.php') {
      shopSeed(uid);
      const stock = merchantStockByUid.get(uid);
      const rem = Math.max(0, MERCHANT.maxq - stock.bought);
      const row = (m, currency) =>
        `<div class="card" data-merch-id="${m.id}" data-currency="${currency}" data-price="${m.price}" data-maxq="${m.maxq}" data-bought="0">` +
        `<div class="name">${m.name}</div><div class="price">${m.price} ${currency}</div></div>`;
      return html(res, 200, page(topBar(uid),
        `<span id="goldBalance">${goldByUid.get(uid).toLocaleString('en-US')}</span>` +
        row(MERCHANT, 'gold') +
        row(MERCHANT_HP, 'gold') +
        row(MERCHANT_MANA, 'gold') +
        row(MERCHANT_EGG, 'gold') +
        `<div class="card" data-merch-id="302" data-currency="gems" data-price="5" data-maxq="10" data-bought="0">` +
        `<div class="name">Greater Gem of Stamina</div><div class="price">5 gems</div></div>` +
        (rem <= 0 ? '<div class="soldout">Small Stamina Potion sold out</div>' : '')
      ));
    }
    if (path === '/merchant_buy.php' && req.method === 'POST') {
      shopSeed(uid);
      lastMerchantBuy = { merch_id: body.merch_id, qty: body.qty, uid, at: Date.now() };
      const item = [MERCHANT, MERCHANT_HP, MERCHANT_MANA, MERCHANT_EGG]
        .find((m) => String(m.id) === String(body.merch_id));
      if (!item) {
        return json(res, 200, { status: 'error', message: 'unknown merch item' });
      }
      const qty = Number(body.qty) || 0;
      // The stamina row carries the per-session bought counter (tests assert
      // it); the other kinds are capped by their maxq alone.
      const rem = item === MERCHANT
        ? Math.max(0, MERCHANT.maxq - merchantStockByUid.get(uid).bought)
        : item.maxq;
      const affordable = Math.floor(goldByUid.get(uid) / item.price);
      if (qty < 1 || qty > rem || qty > affordable) {
        return json(res, 200, { status: 'error', message: 'not enough gold or stock' });
      }
      if (item === MERCHANT) merchantStockByUid.get(uid).bought += qty;
      goldByUid.set(uid, goldByUid.get(uid) - qty * item.price);
      return json(res, 200, { status: 'success', message: `bought ${qty}` });
    }
    if (path === '/adventurers_guild.php') {
      shopSeed(uid);
      const bought = guildBoughtByUid.get(uid);
      const rem = Math.max(0, GUILD_ITEM.limit - bought);
      // Quest board — mirrors the real page the scout captured:
      // active contract first (progress + giveup / finish / donate),
      // then the available contracts with Accept buttons.
      const q = questOf(uid);
      // The live game REWRITES the active contract's objective: the monster
      // name is dropped and the damage shorthand spelled out
      // ("… · Monster: lizardman shadowclaw · min 3m dmg" → "… · min 3,000,000 dmg").
      const rewriteActive = (meta) => meta.kind === 'kill'
        ? meta.objective
          .replace(/\s*·\s*Monster:[^·]+/i, '')
          .replace(/min\s+([\d.]+)\s*([kmb])\s+dmg/i, (s, n, suf) =>
            `min ${Math.floor(parseFloat(n) * ({ k: 1e3, m: 1e6, b: 1e9 }[suf] || 1)).toLocaleString('en-US')} dmg`)
        : meta.objective;
      const questRow = (meta, active) => {
        let controls = '';
        let progress = '';
        const objective = active ? rewriteActive(meta) : meta.objective;
        if (active) {
          const done = q.progress >= meta.goal;
          progress = `<div class="quest-progress"><strong>Progress:</strong> ${Math.min(q.progress, meta.goal)} / ${meta.goal}</div>`;
          if (meta.kind === 'gather') {
            // Two owned Goblin Essences — one Donate button each.
            controls = [901, 902]
              .map((iid) => `<button class="quest-donate-btn" type="button" onclick="donateGatherItem(${meta.id}, ${iid});">Donate</button>`)
              .join('');
          }
          controls += done
            ? `<button class="quest-finish-btn" type="button" onclick="finishQuest(${meta.id}, this);">Finish quest</button>`
            : `<button class="quest-giveup-btn" type="button" onclick="giveUpQuest(${meta.id}, this);">Give up</button>`;
        } else {
          controls = `<button class="quest-accept-btn" type="button" onclick="acceptQuest(${meta.id}, this);">Accept quest</button>`;
        }
        return `<div class="quest-row"><div><div class="quest-main-title">${meta.title}</div>` +
          `<div class="quest-main-desc">${meta.desc || ''}</div>` +
          `<div class="quest-tags"><span class="quest-tag">Rank: ${meta.rank}</span></div>` +
          `<div class="quest-requirements"><span class="quest-req-label">Objective</span>` +
          `<span class="quest-req-text">${objective}</span></div>${progress}</div>` +
          `<div class="quest-side"><div class="quest-reward-label">Reward</div>` +
          `<div class="quest-reward">${meta.reward}</div>${controls}</div></div>`;
      };
      const activeMeta = q.accepted ? GUILD_QUESTS[q.accepted] : null;
      const rows = [
        ...(activeMeta ? [questRow(activeMeta, true)] : []),
        ...Object.values(GUILD_QUESTS)
          .filter((m) => m.id !== q.accepted && !q.finished.includes(m.id))
          .map((m) => questRow(m, false)),
      ].join('\n');
      return html(res, 200, page(topBar(uid),
        `<div class="adv-shop-section">` +
        `<div class="banner-pill"><strong>Your Points</strong><span>${guildPointsByUid.get(uid).toLocaleString('en-US')}</span></div>` +
        `<div class="adv-shop-row">` +
        `<span class="adv-shop-item-name">${GUILD_ITEM.name}</span>` +
        `<span class="adv-shop-price">${GUILD_ITEM.price} points</span>` +
        `<span class="adv-shop-limit">${rem} / ${GUILD_ITEM.limit} remaining</span>` +
        `<button class="adv-shop-buy-btn" onclick="buyShopItem(${GUILD_ITEM.id})"${rem <= 0 ? ' disabled' : ''}>Buy</button>` +
        `</div></div>` +
        `<div class="quest-list">${rows}</div>`
      ));
    }
    if (path === '/adventurers_accept_quest.php' && req.method === 'POST') {
      shopSeed(uid);
      const meta = GUILD_QUESTS[Number(body.quest_id)];
      const q = questOf(uid);
      if (!meta) return json(res, 200, { status: 'error', message: 'unknown quest' });
      if (q.accepted) return json(res, 200, { status: 'error', message: 'Finish or abandon your current quest first.' });
      if (q.finished.includes(meta.id)) return json(res, 200, { status: 'error', message: 'quest already completed' });
      q.accepted = meta.id;
      q.progress = 0;
      return json(res, 200, { status: 'ok', message: 'Quest accepted! You can now start working on this contract.' });
    }
    if (path === '/adventurers_finish_quest.php' && req.method === 'POST') {
      shopSeed(uid);
      const meta = GUILD_QUESTS[Number(body.quest_id)];
      const q = questOf(uid);
      if (!meta || q.accepted !== meta.id) return json(res, 200, { status: 'error', message: 'not accepted' });
      if (q.progress < meta.goal) return json(res, 200, { status: 'error', message: 'objective not met yet' });
      q.finished.push(meta.id);
      q.accepted = null;
      q.progress = 0;
      guildPointsByUid.set(uid, guildPointsByUid.get(uid) + 100);
      // The reward line's AP pays the class skill tree ("100 AP • 10,000 Gold")
      // — the quests-earn/tree-spend loop the live game runs.
      const apReward = Number((String(meta.reward || '').match(/(\d+)\s*AP/i) || [])[1]) || 0;
      treeOf(uid).ap += apReward;
      return json(res, 200, { status: 'ok', message: 'Quest finished!' });
    }
    if (path === '/adventurers_donate_gather.php' && req.method === 'POST') {
      shopSeed(uid);
      const meta = GUILD_QUESTS[Number(body.quest_id)];
      const q = questOf(uid);
      if (!meta || q.accepted !== meta.id || meta.kind !== 'gather') {
        return json(res, 200, { status: 'error', message: 'quest does not accept this item' });
      }
      q.donated++;
      q.progress = Math.min(meta.goal, q.progress + 1);
      return json(res, 200, { status: 'ok', message: `donated (${q.progress}/${meta.goal})` });
    }

    // ── Classes (classes.php + class_skill_tree.php) ─────────────────────
    // Mirrors the live page in both states (2026-11 scout):
    //   CLASSLESS — four class strips, a Class Preview panel and a confirm
    //   form per class: <input name="choose_class_id" value="N">.
    //   CLASSED   — "You are already bound to a class." + "Your class: X"
    //   + a View Skill Tree link. No choose form anywhere.
    if (path === '/classes.php' && req.method === 'POST') {
      const id = Number(body.choose_class_id);
      lastClassPostByUid.set(uid, { uid, classId: id, at: Date.now() });
      if (!CLASS_NAMES[id]) return html(res, 303, '', { Location: '/classes.php' });
      if (!classByUid.has(uid)) classByUid.set(uid, CLASS_NAMES[id]); // permanent
      return html(res, 303, '', { Location: '/classes.php' });
    }
    if (path === '/classes.php') {
      const cur = classByUid.get(uid) || null;
      if (cur) {
        return html(res, 200, page(topBar(uid),
          `<div class="section-classes">You are already bound to a class. Below is your current path and its available skills.</div>` +
          `<div class="detail-class-name">Your class: ${cur}</div>` +
          `<a href="class_skill_tree.php">View Skill Tree</a>`
        ));
      }
      const strips = Object.entries(CLASS_NAMES).map(([id, name]) =>
        `<a href="?class_id=${id}" class="class-strip"><div class="class-strip-tag">Base Class</div>` +
        `<div class="class-strip-name">${name}</div></a>`).join('');
      const forms = Object.entries(CLASS_NAMES).map(([id, name]) =>
        `<form method="post" class="confirm-form">` +
        `<input type="hidden" name="choose_class_id" value="${id}">` +
        `<button type="submit" class="btn-confirm">Confirm this Class</button></form>` +
        `<span class="detail-note">Requirements: Character level ≥ 200 — ${name} passive + PvE skill preview</span>`).join('');
      return html(res, 200, page(topBar(uid),
        `<div class="class-strips">${strips}</div>` +
        `<div class="detail-panel"><div class="detail-title">Class Preview</div>${forms}</div>`
      ));
    }
    if (path === '/class_skill_tree.php' && req.method === 'POST') {
      // The tree's own AJAX surface (the page's AjaxActions): urlencoded
      // action=unlock_skill|level_up + skill_node_id → JSON.
      const cls = classByUid.get(uid) || null;
      const st = treeOf(uid);
      const action = String(body.action || '');
      const skillId = String(body.skill_node_id || '');
      lastTreePostByUid.set(uid, { uid, action, skillId, at: Date.now() });
      if (!cls) return json(res, 200, { ok: false, error: 'no class bound' });
      const cat = (TREE_BY_CLASS[cls] || []).find((s) => String(s.id) === skillId);
      if (!cat) return json(res, 200, { ok: false, error: 'unknown skill node' });
      const own = st.owned.get(skillId);
      if (action === 'unlock_skill') {
        if (own) return json(res, 200, { ok: false, error: 'skill already owned' });
        if (userLevel(uid) < cat.unlock_level) {
          return json(res, 200, { ok: false, error: `requires character level ${cat.unlock_level}` });
        }
        if (st.ap < cat.adv_points_req) {
          return json(res, 200, { ok: false, error: `not enough Adv. Points (${st.ap}/${cat.adv_points_req})` });
        }
        st.ap -= cat.adv_points_req;
        st.owned.set(skillId, { level: 1, usedTimes: 0 });
        return json(res, 200, { ok: true, level: 1, used_times: 0, adv_points_left: st.ap });
      }
      if (action === 'level_up') {
        if (!own) return json(res, 200, { ok: false, error: 'skill not unlocked yet' });
        if (own.level >= cat.max_level) return json(res, 200, { ok: false, error: 'skill is at max level' });
        if (!cat.nextAP) return json(res, 200, { ok: false, error: 'no level rule published' });
        if (st.ap < cat.nextAP) {
          return json(res, 200, { ok: false, error: `not enough Adv. Points (${st.ap}/${cat.nextAP})` });
        }
        st.ap -= cat.nextAP;
        own.level += 1;
        return json(res, 200, { ok: true, level: own.level, used_times: own.usedTimes, adv_points_left: st.ap });
      }
      return json(res, 200, { ok: false, error: 'unknown action' });
    }
    if (path === '/class_skill_tree.php') {
      // The live page embeds the tree + config as two JS globals and renders
      // client-side; the trailing `// ← NEW` comment after the config object
      // is part of the live markup (the parser must survive it). Classless
      // sessions get the game's "choose a class first" page — NO tree data.
      const cls = classByUid.get(uid) || null;
      if (!cls) {
        return html(res, 200, page(topBar(uid),
          `<div class="section-classes">You need to choose a class before your skill tree can open.</div>` +
          `<a href="classes.php">Browse Classes</a>`
        ));
      }
      const st = treeOf(uid);
      const rows = treeRowsFor(uid);
      const owned = rows.filter((r) => r.owned).length;
      return html(res, 200, page(topBar(uid),
        `<h1>${cls} — Skill Tree</h1><div class="skill-card"><div class="skill-name">Passive</div></div>` +
        `<script>\n// Data from PHP\nwindow.SkillTreeData = ${JSON.stringify(rows)};\n` +
        `window.SkillTreeConfig = {\n  ajaxUrl: "\\/class_skill_tree.php",\n  className: "${cls}",\n  totalSkills: ${rows.length},\n  ownedCount: ${owned},\n  advExp: ${st.ap},\n  classImage: "\\/images\\/classes\\/mage_class.webp",\n  classPassive: "${CLASS_PASSIVES[cls] || ''}" // ← NEW\n};\n<\/script>`
      ));
    }

    // ── Achievements & collections claims ─────────────────────────────────
    // The real pages render .card[data-ach-id] blocks whose claim-btn is
    // enabled once earned, and inline claim scripts embedding the csrf:
    //   body: new URLSearchParams({ach_id:id,csrf:"…"})
    const claimCards = () => {
      const cs = claimsOf(uid);
      const card = (attr, id, title, earned) =>
        `<div class="card" ${attr}="${id}"><div class="title">${title}</div>` +
        `<div class="desc">Rewards: 5,000 gold</div>` +
        `<button class="btn claim-btn"${earned && !cs.ach.has(String(id)) ? '' : ' disabled'}>Claim</button></div>`;
      const col = (attr, id, title, earned) =>
        `<div class="card" ${attr}="${id}"><div class="title">${title}</div>` +
        `<div class="reward">Reward: +50 attack</div>` +
        `<button class="btn claim-btn"${earned && !cs.col.has(String(id)) ? '' : ' disabled'}>Claim</button></div>`;
      return {
        ach: [
          card('data-ach-id', 11, 'First Blood', true),
          card('data-ach-id', 12, 'Century Slayer', false),
          card('data-ach-id', 13, 'Guild Pillar', true),
        ].join('\n'),
        col: [
          col('data-col-id', 21, 'Bone Collection', true),
          col('data-col-id', 22, 'Drake Collection', false),
          col('data-col-id', 23, 'Relic Collection', true),
        ].join('\n'),
      };
    };
    if (path === '/achievements.php') {
      const cards = claimCards().ach;
      return html(res, 200, page(topBar(uid), cards +
        `<script>document.querySelectorAll('.claim-btn').forEach(btn => { btn.addEventListener('click', async () => { const card = btn.closest('.card'); const id = card?.getAttribute('data-ach-id'); const res = await fetch('achievements_claim.php', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ach_id:id,csrf:"${pageCsrf(uid)}"}).toString() }); }); });</script>`));
    }
    if (path === '/achievements_claim.php' && req.method === 'POST') {
      const cs = claimsOf(uid);
      const id = Number(body.ach_id);
      const earned = [11, 13].includes(id);
      if (!body.csrf || body.csrf !== pageCsrf(uid)) return json(res, 200, { status: 'error', message: 'bad csrf' });
      if (!earned) return json(res, 200, { status: 'error', message: 'not earned yet' });
      if (cs.ach.has(String(id))) return json(res, 200, { status: 'error', message: 'already claimed' });
      cs.ach.add(String(id));
      return json(res, 200, { status: 'success', message: `achievement ${id} claimed` });
    }
    if (path === '/collections.php') {
      const cards = claimCards().col;
      return html(res, 200, page(topBar(uid), cards +
        `<script>document.querySelectorAll('.claim-btn').forEach(btn => { btn.addEventListener('click', async () => { const card = btn.closest('.card'); const id = card?.getAttribute('data-col-id'); const res = await fetch('collections_claim.php', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({collection_id:id,csrf:"${pageCsrf(uid)}"}).toString() }); }); });</script>`));
    }
    if (path === '/collections_claim.php' && req.method === 'POST') {
      const cs = claimsOf(uid);
      const id = Number(body.collection_id);
      const earned = [21, 23].includes(id);
      if (!body.csrf || body.csrf !== pageCsrf(uid)) return json(res, 200, { status: 'error', message: 'bad csrf' });
      if (!earned) return json(res, 200, { status: 'error', message: 'not earned yet' });
      if (cs.col.has(String(id))) return json(res, 200, { status: 'error', message: 'already claimed' });
      cs.col.add(String(id));
      return json(res, 200, { status: 'success', message: `collection ${id} claimed` });
    }

    // ── Battle Pass (battle_pass.php) ──────────────────────────────────
    // Season off: byte-for-byte the live page the scout captured (252
    // bytes). Season on: two daily quest rows + one tier reward, the game's
    // own claim-btn pattern (disabled until the progress is there, claimed
    // rows render disabled too) and the page's own claim script.
    if (path === '/battle_pass.php') {
      if (!bpSeasonOn) {
        return html(res, 200, `<div style='padding:20px;color:#fff;background:#0f1115;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial'> <h2 style='margin:0'>No Battle Pass season available.</h2> <p style='opacity:.8'>Come back later.</p> </div>`);
      }
      const bp = bpOf(uid);
      const rows = BP_QUESTS.map((q) => {
        const cur = bpQuestProgress(uid, q);
        const open = cur >= q.goal && !bp.claimed.has(String(q.id));
        return `<div class="card" data-quest-id="${q.id}">` +
          `<div class="quest-main-title">${q.title}</div>` +
          `<span class="quest-req-text">${q.objective}</span>` +
          `<div class="quest-progress">${cur.toLocaleString('en-US')} / ${q.goal.toLocaleString('en-US')}</div>` +
          `<button class="claim-btn" onclick="claimBattlePass(${q.id})"${open ? '' : ' disabled'}>Claim</button></div>`;
      }).join('\n');
      const tier = `<div class="card" data-quest-id="${BP_TIER.id}">` +
        `<div class="quest-main-title">${BP_TIER.title}</div>` +
        `<span class="quest-req-text">${BP_TIER.objective}</span>` +
        `<button class="claim-btn" onclick="claimBattlePass(${BP_TIER.id})"${bp.claimed.has(String(BP_TIER.id)) ? ' disabled' : ''}>Claim</button></div>`;
      const script = `<script>const csrf = "${pageCsrf(uid)}";\n` +
        `async function claimBattlePass(id){ await fetch('battle_pass_claim.php', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({quest_id:id, csrf}).toString() }); }\n</script>`;
      return html(res, 200, page(topBar(uid), `<div class="bp-season">Battle Pass · Season of the Emberfall</div>` + rows + tier + script));
    }
    if (path === '/battle_pass_claim.php' && req.method === 'POST') {
      const bp = bpOf(uid);
      if (!body.csrf || body.csrf !== pageCsrf(uid)) return json(res, 200, { status: 'error', message: 'bad csrf' });
      const id = Number(body.quest_id);
      const daily = BP_QUESTS.find((q) => q.id === id);
      if (!daily && id !== BP_TIER.id) return json(res, 200, { status: 'error', message: 'no such reward' });
      const ready = daily ? bpQuestProgress(uid, daily) >= daily.goal : true; // tier rows are ready once reached
      if (!ready) return json(res, 200, { status: 'error', message: 'quest not complete yet' });
      if (bp.claimed.has(String(id))) return json(res, 200, { status: 'error', message: 'already claimed' });
      bp.claimed.add(String(id));
      return json(res, 200, { status: 'success', message: `battle pass reward ${id} claimed: 100 BP XP` });
    }

    // ── Event daily contracts (Dragon Realm sanctuary board) ──────────────
    if (path === '/game_dash.php') {
      return html(res, 200, page(topBar(uid),
        `<div class="dash">dashboard</div>` +
        `<a href="/event_page.php?event=13">Dragon Realm event</a>` +
        `<a href="/achievements.php">achievements</a>` +
        `<a href="/collections.php">collections</a>`));
    }
    if (path === '/event_page.php') {
      const panel = url.searchParams.get('panel') || '';
      const ev = eventOf(uid);
      const csrf = pageCsrf(uid);
      const today = new Date().toISOString().slice(0, 10);
      if (panel === 'sanctuary:board') {
        // Two progress cards + one dispatch contract with two valid choices
        // + one supply card (never claimable from the board).
        const dispatch = (label, answer) => ({
          action: 'sc_daily',
          label,
          hidden: { quest: EVENT_DISPATCH_QUEST, day: today, answer },
          fields: [],
        });
        // A submitted dispatch contract no longer offers its choices —
        // exactly like the real board re-renders after a turn-in.
        const evDone = ev.dispatch.has(`${EVENT_DISPATCH_QUEST}|${today}`);
        return json(res, 200, {
          status: 'ok',
          panel: {
            title: 'Fountain Noticeboard',
            kind: 'sanctuary',
            view: 'board',
            key: 'sanctuary:board',
            note: 'Hunting quests require a manual hit and manual loot.',
            wallet: 100,
            csrf,
            now: Date.now(),
            cards: [
              { title: 'Patrol: Mock Drake', text: 'Defeat 15 Mock Drake.', image: '', label: '3 / 15', progress: 0.2, forms: [] },
              { title: "What Remains", text: 'What makes the rescue complete?', image: '', label: evDone ? 'Submitted' : 'Sanctuary dispatch', progress: evDone ? 1 : 0, forms: evDone ? [] : [dispatch('Helping the young survive', 'a717'), dispatch('Taking every scale', '11620e')] },
              { title: 'Supply: Mock Seal', text: 'Deliver 5 Mock Seal.', image: '', label: '0 / 5', progress: 0, forms: [] },
            ],
            forms: [],
          },
        });
      }
      if (panel) return json(res, 404, { status: 'error', message: 'unknown panel' });
      if (req.method === 'POST') {
        // The game's own sanctuary.js posts {action, ...hidden, csrf} to the
        // panel URL it loaded the board from.
        if (body.action === 'sc_daily') {
          // Protocol fidelity (the real server rejects these exactly like
          // this): revision + request are mandatory, csrf must match.
          if (!body.csrf || body.csrf !== csrf) return json(res, 200, { status: 'error', message: 'bad csrf' });
          if (body.revision == null || body.request == null) return json(res, 200, { status: 'error', message: 'Invalid action. Reload this page.' });
          const key = `${body.quest}|${body.day}`;
          if (ev.dispatch.has(key)) return json(res, 200, { status: 'error', message: 'Contract already submitted.' });
          if (Number(body.quest) !== EVENT_DISPATCH_QUEST) return json(res, 200, { status: 'error', message: 'unknown dispatch quest' });
          ev.dispatch.add(key);
          return json(res, 200, { status: 'ok', message: 'Contract submitted.' });
        }
        if (body.action === 'enroll') {
          ev.enrolled = true;
          return json(res, 200, { status: 'ok', message: 'enrolled' });
        }
        return json(res, 200, { status: 'error', message: 'unknown action' });
      }
      // The page embeds the JSON panel API base — the escaped form the real
      // page ships ("\/event_page.php?event=13\u0026map=23").
      return html(res, 200, page(topBar(uid),
        `<div class="ec-map">Dragon Realm</div>` +
        `<script type="application/json" id="markerless-config">{"locations":[],"panelUrl":"\/event_page.php?event=13\u0026map=23"}</script>`));
    }
    if (path === '/adventurers_shop_buy.php' && req.method === 'POST') {
      shopSeed(uid);
      lastGuildBuy = { shop_item_id: body.shop_item_id, uid, at: Date.now() };
      if (String(body.shop_item_id) !== GUILD_ITEM.id) {
        return json(res, 200, { status: 'error', message: 'unknown shop item' });
      }
      const bought = guildBoughtByUid.get(uid);
      if (bought >= GUILD_ITEM.limit || guildPointsByUid.get(uid) < GUILD_ITEM.price) {
        return json(res, 200, { status: 'error', message: 'limit reached or not enough points' });
      }
      guildBoughtByUid.set(uid, bought + 1);
      guildPointsByUid.set(uid, guildPointsByUid.get(uid) - GUILD_ITEM.price);
      return json(res, 200, { status: 'ok', message: 'purchased' });
    }
    if (path === '/olympus_damon_buy.php') {
      shopSeed(uid);
      if (req.method === 'GET' && url.searchParams.get('action') === 'state') {
        const d = damonByUid.get(uid);
        return json(res, 200, {
          status: 'success',
          gold: goldByUid.get(uid),
          offers: [{
            key: DAMON_OFFER.key,
            name: DAMON_OFFER.name,
            price: DAMON_OFFER.price,
            weekly_limit: DAMON_OFFER.weekly,
            bought: d.bought,
            remaining: Math.max(0, DAMON_OFFER.weekly - d.bought),
            image_url: '/items/lsp.png',
          }],
        });
      }
      if (req.method === 'POST') {
        lastDamonBuy = { offer: body.offer, qty: body.qty, uid, at: Date.now() };
        if (String(body.offer) !== DAMON_OFFER.key) {
          return json(res, 200, { status: 'error', message: 'unknown offer' });
        }
        const d = damonByUid.get(uid);
        const qty = Number(body.qty) || 0;
        const rem = Math.max(0, DAMON_OFFER.weekly - d.bought);
        const affordable = Math.floor(goldByUid.get(uid) / DAMON_OFFER.price);
        if (qty < 1 || qty > rem || qty > affordable) {
          return json(res, 200, { status: 'error', message: 'not enough gold or weekly limit' });
        }
        d.bought += qty;
        goldByUid.set(uid, goldByUid.get(uid) - qty * DAMON_OFFER.price);
        return json(res, 200, {
          status: 'success',
          message: `bought ${qty}`,
          offers: [{
            key: DAMON_OFFER.key,
            bought: d.bought,
            remaining: Math.max(0, DAMON_OFFER.weekly - d.bought),
          }],
        });
      }
    }

    // ── Guild dungeon (DungeonCleaner contract) ──────────────────────────────
    if (path === '/guild_dungeon.php') {
      // The LIVE hub's shape: each card carries a guild_dungeon_enter.php?id=
      // link (the CURRENT instance id — it churns every open), a .h title and
      // a STABLE dungeon_info.php?id= kind link (1 easy · 2 hard · 3 poly/cube
      // layout). .grid (active) / .grid.ended wrappers; ended runs are the
      // cleared/closed/failed ones "awaiting leader/vice to loot". The
      // linkless kind card mirrors the live "Only leader/vice can open."
      // template card shown when no run of that kind is open today.
      const card = (i) =>
        `<div class="card"><a href="guild_dungeon_enter.php?id=${i.id}">` +
        `<div class="h">${i.name}</div>` +
        `<a href="dungeon_info.php?id=${i.kindId}" class="btn">ℹ️ Info</a>` +
        `<div class="meta">${i.type}</div></a></div>`;
      const kindCard = (k) =>
        `<div class="card"><div class="h">${k.name}</div>` +
        `<a href="dungeon_info.php?id=${k.kindId}" class="btn">ℹ️ Info</a>` +
        `<div class="meta">Only leader/vice can open.</div></div>`;
      const active = DUNGEON_INSTANCES.filter((i) => !i.ended).map(card).join('\n') +
        '\n' + kindCard({ name: 'Shadowbridge Warrens', kindId: 1 });
      const ended = DUNGEON_INSTANCES.filter((i) => i.ended).map(card).join('\n');
      const g = guildOf(uid);
      return html(res, 200, page(topBar(uid),
        `<div class="grid">${active}</div><div class="grid ended">${ended}</div>` +
        `<script>\n(function(){\n  const isLoggedIn = true;\n  const guildId     = ${g.id};\n})();\n</script>`));
    }
    // The caller's own guild dashboard (guild_dash.php ignores ?guild_id= —
    // it always answers with the session's guild, like the live game).
    if (path === '/guild_dash.php') {
      const g = guildOf(uid);
      return html(res, 200, page(topBar(uid),
        `<h1><span class="guild-tag">[ ${g.tag} ]</span> ${g.name}</h1>` +
        `<div class="grid"></div>` +
        `<script>\n(function(){\n  const isLoggedIn = true;\n  const guildId     = ${g.id};\n})();\n</script>`));
    }
    if (path === '/guild_dungeon_instance.php') {
      const inst = DUNGEON_INSTANCES.find((x) => String(x.id) === String(url.searchParams.get('id')));
      if (!inst) return html(res, 404, page('no instance'));
      // Cube instances redirect to the dedicated cube page (live behavior).
      if (inst.type === 'cube') {
        res.writeHead(303, { Location: `/guild_dungeon_cube.php?instance_id=${inst.id}` });
        return res.end();
      }
      // Floors come from the named roster (mob floors then the boss room).
      const roster = { easy: [1, 2, 3, 4, 5], hard: [6, 7, 8, 9, 10], poly: [11, 12, 13, 14] }[inst.dungeonKey] || [];
      const names = { 1: 'Brood Pits', 2: 'Plunder Warrens', 3: 'Shattered Stone Causeways', 4: 'Territory Center', 5: 'Boss Room', 6: "The Vizier's Conspiracy Hall", 11: 'Gate Prism' };
      return html(res, 200, page(topBar(uid),
        roster.map((l) =>
          `<a class="pin" title="${names[l] || `Location ${l}`}" href="guild_dungeon_location.php?instance_id=${inst.id}&location_id=${l}">${names[l] || `Location ${l}`}</a>`)
          .join('\n')));
    }
    // The cube page: a JS page whose `const STATE = {…}` blob lists the run's
    // nodes; combat nodes carry linked_location_id floors.
    if (path === '/guild_dungeon_cube.php') {
      const inst = DUNGEON_INSTANCES.find((x) => x.type === 'cube'
        && String(x.id) === String(url.searchParams.get('instance_id')));
      if (!inst) return html(res, 404, page('no cube'));
      return html(res, 200, page(topBar(uid),
        `<h2>The Crucible</h2>` +
        `<script>\n  const STATE = ${JSON.stringify(cubeStateFor(uid))};\n</script>`));
    }
    if (path === '/guild_dungeon_cube_action.php' && req.method === 'POST') {
      if (body.action !== 'enter_node') return json(res, 200, { ok: false, message: 'unknown action' });
      const inst = DUNGEON_INSTANCES.find((x) => x.type === 'cube'
        && String(x.id) === String(body.instance_id));
      if (!inst) return json(res, 200, { ok: false, message: 'no such instance' });
      const state = cubeStateFor(uid);
      const node = state.nodes.find((n) => String(n.id) === String(body.node_id));
      if (!node) return json(res, 200, { ok: false, message: 'no such node' });
      lastCubeActionByUid.set(uid, {
        action: 'enter_node',
        instance_id: body.instance_id != null ? body.instance_id : null,
        node_id: body.node_id != null ? body.node_id : null,
        face_key: body.face_key != null ? body.face_key : null,
        uid,
        at: Date.now(),
      });
      noteCubeTouch(body);
      const redirect = node.linked_location_id
        ? `guild_dungeon_location.php?instance_id=${inst.id}&location_id=${node.linked_location_id}`
        : null;
      return json(res, 200, { ok: true, redirect, state });
    }
    if (path === '/guild_dungeon_location.php') {
      const key = `${url.searchParams.get('instance_id')}:${url.searchParams.get('location_id')}`;
      const mobs = dungeonOf(uid)[key] || [];
      const rows = mobs.map((m) => {
        // State pills exactly like the real floors: joined / looted.
        const pillHtml = (m.joined ? '<span class="pill">joined</span>' : '') +
          (m.looted ? '<span class="pill">looted</span>' : '');
        return `<div class="mon${m.dead ? ' dead' : ''}" data-dgmid="${m.dgmid}" data-name="${m.name}"${m.dead ? ' data-dead="1"' : ''}>` +
        `<h4>${m.name}</h4>` +
        `${pillHtml}` +
        `<span class="mon-hp">${m.hp.toLocaleString('en-US')} / ${m.maxHp.toLocaleString('en-US')}</span>` +
        // Dead floors keep a View link (the real page does) so parsers can
        // still resolve dgmid from the row; a Loot button marks lootable.
        `<a class="mon-view" href="battle.php?instance_id=${url.searchParams.get('instance_id')}&dgmid=${m.dgmid}">👀 View</a>` +
        (m.dead
          ? `<button class="mon-loot" data-loot="${m.dgmid}">Loot</button>`
          : `<a class="mon-fight" href="battle.php?instance_id=${url.searchParams.get('instance_id')}&dgmid=${m.dgmid}">⚔ Fight</a>`) +
        `</div>`;
      }).join('\n');
      return html(res, 200, page(topBar(uid), `<div class="mon-list">${rows}</div>`));
    }
    if (path === '/dungeon_join_battle.php' && req.method === 'POST') {
      noteCubeTouch(body);
      lastDungeonJoinByUid.set(uid, {
        instance_id: body.instance_id != null ? body.instance_id : null,
        dgmid: body.dgmid != null ? body.dgmid : null,
        uid,
        at: Date.now(),
      });
      if (!findDungeonMob(uid, body.dgmid)) return json(res, 200, { status: 'error', message: 'monster not found' });
      return json(res, 200, { status: 'success', message: 'joined' });
    }
    if (path === '/dungeon_loot.php' && req.method === 'POST') {
      noteCubeTouch(body);
      const dmon = findDungeonMob(uid, body.dgmid);
      if (!dmon) return json(res, 200, { status: 'error', message: 'monster not found' });
      if (!dmon.dead) return json(res, 200, { status: 'error', message: 'monster is not dead yet' });
      lastDungeonLootByUid.set(uid, {
        instance_id: body.instance_id != null ? body.instance_id : null,
        dgmid: body.dgmid != null ? body.dgmid : null,
        user_id: body.user_id != null ? body.user_id : null,
        uid,
        at: Date.now(),
      });
      dungeonLootCount++;
      return json(res, 200, {
        status: 'success',
        message: 'loot collected',
        rewards: { exp: 800, gold: 200 },
        items: [{ name: 'Warren Relic', qty: 1 }],
      });
    }

    // ── Auto farm driver ───────────────────────────────────────────────────
    if (path === '/auto_farm_status.php' && req.method === 'GET') {
      const state = autoFarm.get(uid) || { enabled: false, targets: [], settings: {} };
      return json(res, 200, {
        ok: true,
        settings: {
          IS_ENABLED: state.enabled ? '1' : '0',
          FINISHED: '0',
          TOTAL_MONSTERS_TO_KILL: '100',
          TARGETS: state.targets.length,
        },
      });
    }
    if (path === '/auto_farm_actions.php' && req.method === 'POST') {
      let state = autoFarm.get(uid);
      if (!state) { state = { enabled: false, targets: [], settings: {} }; autoFarm.set(uid, state); }
      switch (body.action) {
        case 'toggle': state.enabled = body.enabled === '1'; break;
        case 'reset': state.targets = []; state.enabled = false; break;
        case 'save_settings': state.settings = { ...body }; break;
        case 'add_target': state.targets.push({ ...body }); break;
        case 'update_target': {
          const t = state.targets.find((x) => x.TARGET_ID === body.TARGET_ID);
          if (t) Object.assign(t, body);
          break;
        }
        default: break;
      }
      return html(res, 200, 'ok');
    }

    // ── PVP style (phase 2) ────────────────────────────────────────────────
    if (path === '/pvp_style_state.php') {
      return json(res, 200, { ok: true, active: true });
    }
    if (path === '/pvp_style_action.php' && req.method === 'POST') {
      return json(res, 200, { ok: true, message: 'skill used' });
    }

    // ── PvP season ladder (Divers pillar 3) ────────────────────────────────
    // OPEN season board (tokens 30, solo + party buttons, rank/tier pills) —
    // the pvp.js round parses this, matchmakes once and follows the redirect.
    if (path === '/pvp.php') {
      return html(res, 200, page('PvP', `
<div class="banner"><div class="banner-title">The Total Eclipse PvP Season</div>
<div class="banner-pill"><strong>Leaderboard:</strong> <span>#3,262</span></div>
<div class="info-pill"><strong>Tier:</strong> <span>Novice</span></div>
<div class="info-pill"><strong>Tokens:</strong> <span>30</span></div></div>
<button class="js-matchmake" data-ladder="solo">Find Solo Match</button>
<button class="js-matchmake" data-ladder="party">Find Party Match</button>
<section class="section"><div class="empty-message">You have not played any solo ladder matches this season yet.</div></section>
<script>function pvpPost(u,b){return fetch(u,{method:'POST',body:new URLSearchParams(b)})}</script>`));
    }
    if (path === '/pvp_matchmake.php' && req.method === 'POST') {
      const ladder = body.ladder || 'solo';
      if (!['solo', 'party'].includes(ladder)) return json(res, 200, { status: 'error', message: 'unknown ladder' });
      pvpMatches.set(uid, (pvpMatches.get(uid) || 0) + 1);
      return json(res, 200, { status: 'success', redirect: '/pvp_battle.php?id=' + (1000 + pvpMatches.get(uid)) });
    }
    // The battle page the redirect lands on — the fight engine's future
    // sample. Shape markers only (title + opponent), no interactive state.
    if (path.startsWith('/pvp_battle.php')) {
      return html(res, 200, `<!doctype html><html><head><title>PvP Battle · The Total Eclipse Season</title></head><body>
<div class="battleDrawer"><div class="vs-banner">VS Arron32</div>
<div class="opponent">Arron32 · Tier Novice</div>
<button class="attack-btn">Attack</button></div></body></html>`);
    }

    return html(res, 404, page('mock: unknown path ' + path));
  });
});

function findMonster(id) {
  for (const list of Object.values(WAVE_MONSTERS)) {
    const m = list.find((x) => String(x.id) === String(id));
    if (m) return m;
  }
  return null;
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`mock game listening on http://127.0.0.1:${PORT}`));
}
module.exports = { server, USERS, WAVE_MONSTERS, GATES, STAMINA_MAX, autoFarm };