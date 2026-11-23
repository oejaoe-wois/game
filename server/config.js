'use strict';
// config.js — env parsing with sane defaults. See .env.example for docs.
const path = require('path');
require('./env'); // optional farm.env / .env file (real env vars still win)

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}
function float(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}
function required(name, minLen) {
  const v = process.env[name];
  if (!v || v.length < minLen) {
    throw new Error(
      `Missing or weak env var ${name} (needs ${minLen}+ chars). ` +
      `See .env.example — set it in your host's environment variables panel.`
    );
  }
  return v;
}
// Like required(), but an empty/unset value is legitimate (empty string).
// Used for the OPTIONAL built-in fetcher: without it every visible account
// fights and the scout rides a worker's session instead.
function optional(name, minLen) {
  const v = process.env[name] || '';
  if (v && v.length < minLen) {
    throw new Error(
      `Env var ${name} is too short (needs ${minLen}+ chars, or leave it empty). ` +
      `See .env.example.`
    );
  }
  return v;
}

const { loadWavePages } = require('./waves');

const FAST_TEST = process.env.FAST_TEST === '1';

// ── Per-mob minimum damage (MOB_MIN_DAMAGE / MOB_MIN_DAMAGE_JSON) ───────────
// The floor: keep attacking a mob until THIS much of the account's own damage
// has landed on it (the guild contracts' "Kill 5 … · min 3m dmg" rule — a
// kill only counts when at least that much of YOUR damage hit the mob).
//   MOB_MIN_DAMAGE       one number for every mob (0 = off, the default)
//   MOB_MIN_DAMAGE_JSON  per-name overrides, matched against the lowercase
//                        mob name; the LAST matching rule wins, "*" is the
//                        catch-all. e.g.
//                        {"*": 0, "lizardman": 3000000, "troll ravager": "2.5m"}
// Values accept plain numbers or k/m/b shorthand ("3m" → 3000000).
function parseDamageShorthand(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const s = String(v || '').trim().toLowerCase().replace(/[,\s_]/g, '');
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.floor(parseFloat(m[1]) * mult);
}

function parseMinDamageJson(str) {
  const out = { fallback: null, rules: [] };
  const raw = String(str || '').trim();
  if (!raw) return out;
  let obj;
  try { obj = JSON.parse(raw); } catch (_) {
    console.warn('[config] MOB_MIN_DAMAGE_JSON is not valid JSON — ignored');
    return out;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const min = parseDamageShorthand(v);
    const key = String(k).trim().toLowerCase();
    if (!key) continue;
    if (key === '*') { out.fallback = min; continue; }
    out.rules.push({ key, re: new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), min });
  }
  return out;
}

// ── Sites ────────────────────────────────────────────────────────────────────
// The farm can run accounts on several game sites at the same time. Every
// site gets its own target bus, its own fetcher (scout) and its own gate/wave
// list; accounts carry a `site` key. 'demonic' is the original site (and the
// default for accounts saved before multi-site support existed).
const DEFAULT_SITE = 'demonic';
const SITES = [
  {
    key: 'demonic',
    label: 'Demonic Scans',
    base: (process.env.GAME_BASE || 'https://demonicscans.org').replace(/\/+$/, ''),
    envSuffix: '',
  },
  {
    key: 'veyra',
    label: 'Veyra',
    base: (process.env.VEYRA_BASE || 'https://veyragame.com').replace(/\/+$/, ''),
    envSuffix: '_VEYRA',
  },
];
const defaultWavePages = loadWavePages();
// WAVE_PAGES_VEYRA overrides the gate/wave list for that site only; without
// it the site uses the same list as the default site.
for (const site of SITES) {
  site.wavePages = site.envSuffix && process.env['WAVE_PAGES' + site.envSuffix]
    ? loadWavePages(process.env['WAVE_PAGES' + site.envSuffix])
    : defaultWavePages;
}

const config = {
  fastTest: FAST_TEST,
  sites: SITES,
  defaultSite: DEFAULT_SITE,
  port: num(process.env.PORT, 3000),
  gameBase: (process.env.GAME_BASE || 'https://demonicscans.org').replace(/\/+$/, ''),
  // Panel login — a username + password, NOT a secret key. The panel posts
  // them to POST /api/login and gets a session token back (7-day expiry,
  // gone on restart). ADMIN_TOKEN is optional from here on: if someone still
  // sets it, it keeps working as a master token for curl/scripts — otherwise
  // username+password is the only way in.
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim(),
  adminPassword: required('ADMIN_PASSWORD', 8),
  adminToken: (process.env.ADMIN_TOKEN || '').trim(), // optional legacy master
  // ── Built-in admin fetcher (the engine's own game account) ────────────────
  // When set: seeded into the encrypted store at boot, kept HIDDEN from every
  // panel/API listing, and permanently THE fetcher: it sweeps every gate/wave
  // page and broadcasts the mob ids every other account attacks — and it joins
  // the battles it broadcasts about itself. Users can neither see it, remove
  // it, nor re-point the fetcher anywhere else. NO defaults on purpose: a
  // fetcher login must live only in the host's private environment variables
  // (Wispbyte panel), never in the repo.
  // The built-in fetcher is OPTIONAL: leave ADMIN_GAME_EMAIL empty (or unset)
  // to run with NO hidden account — every visible account then fights, swarms
  // and hunts, and the site's scout sweeps pages through the oldest healthy
  // worker's session instead. Set it to reserve one game account for
  // read-only page sweeps (its stamina never mixes with the fleet's).
  adminGameEmail: optional('ADMIN_GAME_EMAIL', 3).toLowerCase(),
  adminGamePassword: optional('ADMIN_GAME_PASSWORD', 1),
  adminGameNickname: (process.env.ADMIN_GAME_NICKNAME || 'core-fetcher').trim(),
  // Set TRUST_PROXY=1 when the host puts a reverse proxy in front of the app
  // (Wispbyte does): per-IP rate limits then use the proxy-reported client IP
  // instead of treating every visitor as one address.
  trustProxy: process.env.TRUST_PROXY === '1',
  sessionTtlMs: num(process.env.SESSION_TTL_HOURS, 168) * 3600 * 1000,
  secretKey: required('AIO_SECRET_KEY', 32),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  jitterScale: float(process.env.JITTER_SCALE, 1.0),
  loginStaggerMs: num(process.env.LOGIN_STAGGER_MS, 45000),
  scoutIntervalMs: num(process.env.SCOUT_INTERVAL_MS, 120000),
  maxFarmTargets: num(process.env.MAX_FARM_TARGETS, 5),
  hitDelayMs: num(process.env.HIT_DELAY_MS, FAST_TEST ? 120 : 1000),
  paceMinMs: num(process.env.PACE_MIN_MS, FAST_TEST ? 50 : 2000),
  paceMaxMs: num(process.env.PACE_MAX_MS, FAST_TEST ? 150 : 8000),
  cycleMinMs: num(process.env.CYCLE_MIN_MS, FAST_TEST ? 1500 : 20000),
  cycleMaxMs: num(process.env.CYCLE_MAX_MS, FAST_TEST ? 3000 : 60000),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 20000),
  // HTTP transport: 'auto' (default) — curl subprocess when the binary
  // exists (Cloudflare's TLS fingerprinting passes curl, not Node's fetch),
  // fetch otherwise; 'curl' forces curl; 'fetch' forces the old path.
  transport: (['curl', 'fetch'].includes(String(process.env.CURL_TRANSPORT || 'auto').toLowerCase())
    ? String(process.env.CURL_TRANSPORT).toLowerCase() : 'auto'),
  reloginCooldownMs: num(process.env.RELOGIN_COOLDOWN_MS, 600000),
  // Optional: nickname of the designated fetcher (scout) account. Set once
  // via env for headless setups — or designate from the panel/API instead
  // (panel/API choice wins because it persists to data/farm.json).
  scoutNickname: (process.env.SCOUT_NICKNAME || '').trim(),
  // How often each worker re-reads stats.php for its EXP read-out (dashboard).
  expPollMs: num(process.env.EXP_POLL_MS, FAST_TEST ? 2000 : 300000),
  // Stamina potion ladder — priority order, first match with quantity wins.
  // Matches the potion-card names on battle.php's battleDrawer (the game's
  // own consumables UI) or, as a fallback, inventory.php slot text.
  potionSlotNames: (process.env.POTION_SLOT_NAMES || 'small stamina potion,large stamina potion,full stamina potion')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // HP potions, same matching rules — used when HP% drops below hpPotionBelowPct.
  hpPotionNames: (process.env.HP_POTION_NAMES || 'full hp potion')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Proactive vitals (0 disables that auto-action):
  //   stamina < staminaPotionBelow → drink the stamina ladder
  //   hp% < hpPotionBelowPct       → heal potion / free timed heal
  // The extension's AI skips stamina potions while EXP >= 80% (a level-up
  // would waste the refill) — ported as-is. potionCooldownMs spaces drinks.
  staminaPotionBelow: (Number(process.env.STAMINA_POTION_BELOW) >= 0
    ? Number(process.env.STAMINA_POTION_BELOW) : 50),
  hpPotionBelowPct: (Number(process.env.HP_POTION_BELOW_PCT) >= 0
    ? Number(process.env.HP_POTION_BELOW_PCT) : 30),
  potionCooldownMs: num(process.env.POTION_COOLDOWN_MS, FAST_TEST ? 5000 : 300000),
  // Optional Discord webhook: fire-and-forget pings on login_fail,
  // session_lost and account_degraded. Empty = disabled.
  discordWebhookUrl: (process.env.DISCORD_WEBHOOK_URL || '').trim(),
  bossCapsJson: process.env.BOSS_CAPS_JSON || '',
  // ── Precision wave farming (port of runPrecisionWaveCombat) ──────────────
  // Every gate/wave gets its own active_wave.php?gate=X&wave=Y page with
  // different monsters and values — workers sweep the registry below
  // (see server/waves.js for the env/file override formats).
  wavePages: defaultWavePages,
  // Strict per-mob damage stop: a mob is abandoned the moment the account's
  // cumulative "You:" damage on it reaches this number (TARGET_DAMAGE in the
  // live wave script; the wave page's "You: X" reading is the resume point).
  // With mobCapMode 'auto' this is only the LAST-RESORT cap for mobs whose
  // loot gate could not be resolved anywhere else.
  mobDamageCap: num(process.env.MOB_DAMAGE_CAP, 70000),
  // Per-mob damage FLOOR (the reverse of the cap): keep attacking until at
  // least this much of the account's own damage landed on the mob — the
  // guild contracts' "min 3m dmg" rule. 0 = off. A floor ABOVE the loot cap
  // keeps the fight going past the cap and on to the kill (a kill contract
  // only counts when the mob DIES with your damage ≥ the floor). See
  // parseMinDamageJson for the per-name JSON override.
  mobMinDamage: parseDamageShorthand(process.env.MOB_MIN_DAMAGE || 0),
  mobMinDamageJson: parseMinDamageJson(process.env.MOB_MIN_DAMAGE_JSON),
  // Per-mob cap source (the loot scanner port):
  //   'auto'  (default) — each mob's cap comes from its battle page's
  //           "DMG req:" loot gate (learned + persisted to
  //           data/loot-caps.json), falling back to the measured per-mob /
  //           per-wave tables in server/loot.js, then to MOB_DAMAGE_CAP.
  //   'fixed' — ignore loot entirely; every mob stops at MOB_DAMAGE_CAP.
  mobCapMode: (process.env.MOB_CAP_MODE === 'fixed' ? 'fixed' : 'auto'),
  // The engine joins and slashes wave mobs itself. While the game's own
  // auto-farm (the wave page's autoFarmPanel) is ENABLED the game rejects
  // every manual hit ("You can't attack monsters while your auto farm is on")
  // — so by default the worker PAUSES it itself (auto_farm_status.php check +
  // the card's own action=toggle&enabled=0 POST, verified before resuming).
  // AUTO_FARM_FIX=0 restores the old warn-only behaviour.
  autoFarmFix: process.env.AUTO_FARM_FIX !== '0',
  // Max mobs attacked per worker cycle (each cycle visits ONE wave page,
  // round-robin across the registry so accounts spread over the gates).
  waveMobsPerRound: num(process.env.WAVE_MOBS_PER_ROUND, 4),
  // ── Divers (the engine's own hunting system) ─────────────────────────────
  // The game's built-in auto-farmer stays OFF (autoFarmFix above); every
  // account instead DIVES: it sweeps the wave/event pages and hunts the mobs
  // the user named on the account (per-account diveTargets — see the panel's
  // "Dive targets" field). DIVE_ONLY=1 makes divers attack NOTHING but their
  // named mobs (pure target hunting); the default keeps farming every
  // eligible mob while always prioritizing the named ones.
  diveOnly: process.env.DIVE_ONLY === '1',
  // BUS DIVE (fleet hunt): a diver with dive targets first hits the LIVE bus
  // ids matching its targets — the scout publishes every mob id it sees, so
  // "attack all Troll Ravager" lands on every account's very next cycle
  // without waiting for the pinned-wave rotation. DIVE_BUS=0 turns it off
  // (divers then only hunt on their pinned wave pages).
  diveBus: process.env.DIVE_BUS !== '0',
  // Pause between wave slashes (ms) — ATTACK_DELAY_MS=650 in the live script.
  waveHitDelayMs: num(process.env.WAVE_HIT_DELAY_MS, FAST_TEST ? 40 : 650),
  // ── Stat allocation (port of the console allocatePlan engine) ─────────────
  // The game's stats_ajax.php only accepts chunks of [100, 50, 5, 1]; the
  // engine decomposes any plan. STAT_PLAN="attack=100,defense=50,stamina=44444".
  // Run on demand via POST /api/stats/allocate (the panel button), or
  // automatically once per session when STAT_AUTO_ALLOCATE=1 and the banked
  // STAT_POINTS cover the plan.
  statPlan: (() => {
    const plan = { attack: 0, defense: 0, stamina: 0 };
    for (const part of String(process.env.STAT_PLAN || '').split(',')) {
      const m = part.trim().match(/^(attack|defense|stamina)\s*=\s*(\d+)$/i);
      if (m) plan[m[1].toLowerCase()] = parseInt(m[2], 10);
    }
    return plan;
  })(),
  statAutoAllocate: process.env.STAT_AUTO_ALLOCATE === '1',
  // ── Stat TARGETS (port of the Veyra auto stat allocator) ──────────────────
  // Instead of spending a fixed plan, keep spending every banked point until
  // each attribute reaches its target: STAT_TARGETS="attack=1000,defense=1000,
  // stamina=1000". Attack first, then defense, then stamina — the Veyra order.
  // Each chunk is the largest of [100, 50, 5, 1] that fits both the remaining
  // need and the banked points; the loop stops when the targets are met or the
  // points run dry. STAT_TARGETS_AUTO=1 runs it from the worker loop (cheap:
  // it only fires when stats.php shows unspent points).
  statTargets: (() => {
    const plan = { attack: 0, defense: 0, stamina: 0 };
    for (const part of String(process.env.STAT_TARGETS || '').split(',')) {
      const m = part.trim().match(/^(attack|defense|stamina)\s*=\s*(\d+)$/i);
      if (m) plan[m[1].toLowerCase()] = parseInt(m[2], 10);
    }
    return plan;
  })(),
  statTargetsAuto: process.env.STAT_TARGETS_AUTO === '1',
  // ── Auto mana (port of the Veyra auto mana watcher) ───────────────────────
  // When the battle page shows #pManaText drained to <= MANA_POTION_BELOW
  // (0 = only when the bar is fully used up, exactly like the script), drink
  // a mana potion: Mana Potion S first, then L (MANA_POTION_NAMES order).
  manaPotionNames: (process.env.MANA_POTION_NAMES || 'mana potion s,small mana potion,mana potion l,large mana potion')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  manaPotionBelow: (Number(process.env.MANA_POTION_BELOW) >= 0
    ? Number(process.env.MANA_POTION_BELOW) : 0),
  // ── Reaction stamina farm (port of veyra_stamina_farm) ────────────────────
  // Reacts to manga chapters (/postreaction.php) for +2 stamina each. One
  // batch of REACTION_BATCH reactions is woven into every worker cycle while
  // stamina is below max; REACTION_DAILY_CAP (0 = off) and REACTION_TARGET
  // (stop at this stamina) bound it; after REACTION_NO_GAIN_STOP consecutive
  // dry stamina checks the farm rests until the next day.
  reactionFarm: {
    enabled: process.env.REACTION_FARM !== '0',
    reaction: (process.env.REACTION_EMOJI || '1').trim(),
    batchPerCycle: num(process.env.REACTION_BATCH, FAST_TEST ? 4 : 10),
    dailyCap: num(process.env.REACTION_DAILY_CAP, 0),
    targetStamina: num(process.env.REACTION_TARGET, 0),
    checkEvery: num(process.env.REACTION_CHECK_EVERY, 5),
    noGainStop: num(process.env.REACTION_NO_GAIN_STOP, 4),
  },
  // ── Potion shop buy-all (port of the Veyra stamina buy-all) ───────────────
  // When the stamina ladder comes up dry and stamina is low, sweep every
  // stamina potion the gold/points can carry: merchant.php → merchant_buy.php,
  // adventurers_guild.php → adventurers_shop_buy.php (one per call),
  // olympus_damon_buy.php?action=state → POST {offer, qty}. POTION_BUY=0
  // disables; POTION_BUY_COOLDOWN_MS spaces sweeps per account.
  potionBuy: {
    enabled: process.env.POTION_BUY !== '0',
    cooldownMs: num(process.env.POTION_BUY_COOLDOWN_MS, FAST_TEST ? 5000 : 30 * 60 * 1000),
    maxSpendPerSweep: num(process.env.POTION_BUY_MAX_SPEND, 0), // 0 = gold/points allow
    // Which merchant kinds the sweep buys: stamina, hp, mana (the drink
    // ladders' stock). POTION_BUY_KINDS="stamina" narrows it.
    kinds: String(process.env.POTION_BUY_KINDS || 'stamina,hp,mana'),
  },
  // ── Equip best (Divers' gear keep-up) ──────────────────────────────────
  // inventory.php is parsed per account; every equipped slot with a strictly
  // better bag item of the same type is re-worn via inventory_ajax.php
  // (equip_item, slot_id=0 — the game's own modal call). Attack counts more
  // than defense by default (kill speed pays the farm's EXP), tune with
  // EQUIP_ATK_WEIGHT / EQUIP_DEF_WEIGHT. EQUIP_AUTO=0 disables the automatic
  // round; POST /api/equip still runs it on demand.
  equip: {
    enabled: process.env.EQUIP_AUTO !== '0',
    cooldownMs: num(process.env.EQUIP_COOLDOWN_MS, FAST_TEST ? 5000 : 15 * 60 * 1000),
    set: String(process.env.EQUIP_SET || 'attack'),
    atkWeight: num(process.env.EQUIP_ATK_WEIGHT, 3),
    defWeight: num(process.env.EQUIP_DEF_WEIGHT, 1),
    maxEquips: num(process.env.EQUIP_MAX_PER_ROUND, 8),
  },
  // ── Blacksmith crafter ───────────────────────────────────────────────────
  // Wave mobs drop crafting materials; the blacksmith turns them into gear.
  // Every gate (Grakthar / Olympus / Events) is swept and every recipe the
  // page marks craftable is forged (highest attack first), then the new gear
  // is equipped by the equip-best round. BLACKSMITH_CRAFT=0 disables.
  blacksmith: {
    enabled: process.env.BLACKSMITH_CRAFT !== '0',
    cooldownMs: num(process.env.BLACKSMITH_COOLDOWN_MS, FAST_TEST ? 5000 : 30 * 60 * 1000),
    maxCrafts: num(process.env.BLACKSMITH_MAX_CRAFTS, 4),
  },
  // ── Dead-boss corpse sweep (port of the Veyra dead bosses list) ───────────
  // Waves are scanned with show_dead_bosses_only=1 for cards that still have
  // a Loot button and this account's damage on them (data-userdmg), then
  // /loot.php {monster_id, user_id, instance_id:'0'} collects the rewards.
  //   'smart'  (default) — sweep when out of stamina or EXP ≥ corpseExpNearPct%
  //              (a level-up refills stamina — the same trick DungeonCleaner uses)
  //   'always' — a sweep every cycle
  //   'off'    — disabled
  corpseLoot: {
    mode: (['off', 'smart', 'always'].includes(process.env.CORPSE_LOOT)
      ? process.env.CORPSE_LOOT : 'smart'),
    maxPerSweep: num(process.env.CORPSE_LOOT_MAX, 25),
    corpseExpNearPct: num(process.env.CORPSE_EXP_NEAR_PCT, 80),
    // The LevelUp Looter's autoloot trigger: sweep when the bar falls to
    // this level (default 10, the script's autoStaminaThreshold).
    corpseStaminaBelow: (Number(process.env.CORPSE_STAMINA_BELOW) >= 0
      ? Number(process.env.CORPSE_STAMINA_BELOW) : 10),
  },
  // ── Auto-battle potion caps (the LevelUp Looter's post-level-up step) ─
  // After a level-up, raise the wave page's "Max Large/Full Stamina Potions
  // to use" setting by this much so the in-game auto-battle may drink more
  // per fight. POTION_CAP_RAISE="fsp=5,lsp=10"; leave empty to disable.
  potionCapRaise: (() => {
    const out = { fsp: 0, lsp: 0 };
    for (const part of String(process.env.POTION_CAP_RAISE || '').split(',')) {
      const m = part.trim().match(/^(fsp|lsp)\s*=\s*(\d+)$/i);
      if (m) out[m[1].toLowerCase()] = parseInt(m[2], 10);
    }
    return out;
  })(),
  // ── Guild dungeon farm (port of DungeonCleaner) ───────────────────────────
  // guild_dungeon.php → instances → location pins → .mon battle.php?dgmid=
  // cards → dungeon_join_battle.php {instance_id, dgmid} → damage.php
  // {instance_id, dgmid, skill_id, stamina_cost} → dungeon_loot.php for the
  // dead. DUNGEON_FARM=0 disables; DUNGEON_MOBS_PER_CYCLE caps each visit.
  // cube: The Polyhedral Crucible instances are farmed through their
  // guild_dungeon_cube.php STATE (available combat nodes → enter_node POST →
  // linked floors). DUNGEON_CUBE=0 skips them again (they are NOT broken —
  // the old skip predates the cube page discovery — but the switch stays).
  dungeon: {
    enabled: process.env.DUNGEON_FARM !== '0',
    maxMobsPerCycle: num(process.env.DUNGEON_MOBS_PER_CYCLE, FAST_TEST ? 2 : 6),
    betweenHitsMs: num(process.env.DUNGEON_BETWEEN_HITS_MS, FAST_TEST ? 30 : 300),
    cube: process.env.DUNGEON_CUBE !== '0',
  },
  // ── Manual loot of wave kills ─────────────────────────────────────────────
  // After the engine slashes a mob dead, POST loot.php exactly like the
  // game's own Loot button. The Dragon Realm event dailies count "defeat N
  // X and manually loot it today" — "Auto-Farm and Auto-Loot do not count" —
  // and unclaimed kills expire without their drops. WAVE_LOOT_KILLS=0 turns
  // the hook off (the corpse sweep still collects leftovers).
  waveLootKills: process.env.WAVE_LOOT_KILLS !== '0',
  // ── Achievement & collection claims ────────────────────────────────────────
  // achievements.php / collections.php render enabled Claim buttons once
  // earned; the engine sweeps both pages and claims everything ready
  // (gold/gems/permanent stat points — nothing is spent). CLAIMS=0 disables;
  // CLAIMS_COOLDOWN_MS spaces the sweeps (claims are earned slowly).
  claims: {
    enabled: process.env.CLAIMS !== '0',
    cooldownMs: num(process.env.CLAIMS_COOLDOWN_MS, FAST_TEST ? 5000 : 2 * 60 * 60 * 1000),
  },
  // ── Adventurers Guild contracts ────────────────────────────────────
  // Accept → farm → finish loop on adventurers_guild.php. One contract slot:
  // kill/skill contracts are completed by the normal wave farming, so the
  // engine turns them in and accepts the next. QUESTS_ACCEPT=0 stops new
  // accepts (finishing/donating still run); QUESTS_DONATE=1 opts into
  // donating gather items (they are consumed — off by default).
  // hunt: while a KILL contract is armed, the wave picker drives the worker
  // straight to the wave that hosts the contract monster (persistent
  // data/hunt-map.json built from every parsed wave page; unknown mobs are
  // probed page-by-page until found). The kill contracts need a CLASS — a
  // classless account has no damage skill and cannot meet "min 3m dmg"
  // floors — so accepts are held while the account is still classless (the
  // class picker binds one at level 200+ and the accepts resume).
  // QUESTS_HUNT=0 keeps farming strictly round-robin.
  guildQuests: {
    enabled: process.env.GUILD_QUESTS !== '0',
    cooldownMs: num(process.env.QUESTS_COOLDOWN_MS, FAST_TEST ? 5000 : 20 * 60 * 1000),
    accept: process.env.QUESTS_ACCEPT !== '0',
    donate: process.env.QUESTS_DONATE === '1',
    hunt: process.env.QUESTS_HUNT !== '0',
  },
  // ── Guild auto-join ("accept guilds") ───────────────────────────────────────
  // An account that carries a panel guild code but answers GUILD-LESS is
  // joined to that exact guild: "Open recruitment" guilds join instantly,
  // "Application" guilds get an application (the leader approves later) —
  // live-verified 2026-11-23. No code → never join blind (the engine never
  // picks a guild for you). GUILD_AUTO_JOIN=0 disables farm-wide.
  guildAutoJoin: process.env.GUILD_AUTO_JOIN !== '0',
  guildJoinCooldownMs: num(process.env.GUILD_JOIN_COOLDOWN_MS, FAST_TEST ? 5000 : 30 * 60 * 1000),
  // ── Event daily contracts (Dragon Realm sanctuary board) ───────────────────
  // Discovers live events from the dashboard, reads the Fountain Noticeboard
  // (panel=sanctuary:board) for the progress feed, and submits the ready
  // dispatch choices (sc_daily — one valid choice per contract per day).
  // Supply contracts are never auto-turned-in (items would be consumed).
  // EVENT_DAILIES=0 disables; the round no-ops cleanly when no event is live.
  eventDailies: {
    enabled: process.env.EVENT_DAILIES !== '0',
    cooldownMs: num(process.env.EVENT_DAILIES_COOLDOWN_MS, FAST_TEST ? 5000 : 45 * 60 * 1000),
  },
  // ── Battle Pass (battle_pass.php) ──────────────────────────────────────────
  // The season page ships two daily quests — "spend 500 stamina" (fills from
  // normal farming) and a mob-family damage quest ("deal 300,000 damage to
  // Lizard/Sea mobs"). While the damage quest is open the wave picker
  // prioritizes waves whose mob names match the quest's keywords and the
  // matching mobs are attacked first. BATTLE_PASS=0 disables the whole
  // module; BATTLE_PASS_WAVE_PRIORITY=0 keeps farming strictly round-robin;
  // BATTLE_PASS_COOLDOWN_MS spaces the page reads. No season live → no-op.
  battlePass: {
    enabled: process.env.BATTLE_PASS !== '0',
    cooldownMs: num(process.env.BATTLE_PASS_COOLDOWN_MS, FAST_TEST ? 5000 : 30 * 60 * 1000),
    wavePriority: process.env.BATTLE_PASS_WAVE_PRIORITY !== '0',
  },
  // ── PvP season ladder (Divers pillar 3) ─────────────────────────────────────
  // The round reads pvp.php (season, leaderboard rank, tier, battle tokens),
  // matchmakes ONLY while the season is open and tokens remain, follows the
  // redirect and reports the battle-page shape (the interactive fight engine
  // needs one live open-season sample; the season is CLOSED 2026-11-22 —
  // "Solo matchmaking is closed." — so the round is a safe no-op until it
  // opens). PVP=0 disables the pillar; PVP_LADDER solo|party; PVP_MAX_MATCHES
  // caps tokens spent per round; PVP_COOLDOWN_MS spaces the page reads.
  pvp: {
    enabled: process.env.PVP !== '0',
    ladder: process.env.PVP_LADDER === 'party' ? 'party' : 'solo',
    maxMatches: num(process.env.PVP_MAX_MATCHES, 1),
    cooldownMs: num(process.env.PVP_COOLDOWN_MS, FAST_TEST ? 5000 : 10 * 60 * 1000),
  },
  // ── Class system (classes.php) ─────────────────────────────────────────────
  // Classless accounts (new/lower-level friends' accounts) still farm waves,
  // bosses and every daily sweep — nothing requires a class. What the engine
  // ADDS: once an account hits level 200 (every base class's requirement)
  // and is still classless, it POSTs the optimal starting class for farming.
  // Ranking (PvE damage per 200-stamina cast): Mage Fireball 4,000,000 +
  // 10% ATK > Hunter Back Stab 2,700,000 > Warrior Ironclad 1,000,000 >
  // Cleric (no PvE damage skill). CLASS_AUTO_PICK = auto (default, Mage) |
  // warrior | hunter | cleric | off. Per-account classPick (panel/API)
  // overrides the env default for that account only. The choice is
  // PERMANENT in the game — 'off' is always respected.
  classPick: {
    enabled: String(process.env.CLASS_AUTO_PICK || 'auto').trim().toLowerCase() !== 'off',
    pref: String(process.env.CLASS_AUTO_PICK || 'auto').trim().toLowerCase(),
    minLevel: num(process.env.CLASS_MIN_LEVEL, 200),
    cooldownMs: num(process.env.CLASS_COOLDOWN_MS, FAST_TEST ? 5000 : 6 * 60 * 60 * 1000),
  },
  // ── Class skill tree (class_skill_tree.php) ────────────────────────
  // Once an account is CLASS-bound, its tree is upgraded automatically:
  // unlock the PvE damage skills first (Mage Fireball unlocks FREE — 0 AP),
  // then level them by damage-per-stamina, then everything else, while Adv.
  // Points remain above SKILL_TREE_RESERVE. AP comes from the Adventurers
  // Guild contracts ("100 AP • 10,000 Gold") — quests earn, the tree spends.
  // SKILL_TREE=0 disables; SKILL_TREE_MAX_SPENDS caps POSTs per round;
  // SKILL_TREE_RESERVE keeps AP banked for manual spends.
  skillTree: {
    enabled: process.env.SKILL_TREE !== '0',
    cooldownMs: num(process.env.SKILL_TREE_COOLDOWN_MS, FAST_TEST ? 5000 : 30 * 60 * 1000),
    reserve: num(process.env.SKILL_TREE_RESERVE, 0),
    maxSpends: num(process.env.SKILL_TREE_MAX_SPENDS, 10),
  },
  // ── Boss spawn phases (port of the Boss Tracker / Veyra spawn timers) ─────
  // Battle pages embed AUTO_DIE_CFG = { nextDieMs: ... } for the 48h auto-die
  // bosses. Remaining life > 24h = phase 1 (damage is wasted there — the
  // tracker's own rule), <= 24h = phase 2. BOSS_PHASE_GATE=1 (default) makes
  // workers skip phase-1 targets until the boss enters phase 2.
  bossPhaseGate: process.env.BOSS_PHASE_GATE !== '0',
  // 48h life span / phase-2 threshold, kept configurable for clone servers.
  bossPhaseTotalHours: num(process.env.BOSS_PHASE_TOTAL_HOURS, 48),
  bossPhase2Hours: num(process.env.BOSS_PHASE2_HOURS, 24),
  logLevel: process.env.LOG_LEVEL || 'info',
};

// The learned loot-cap cache lives in DATA_DIR (survives restarts).
require('./loot').initCapsCache(config.dataDir);
// The hunt map (mob name → hosting wave) shares the same data dir.
require('./hunt').initHuntMap(config.dataDir);
// The divers' discovered event waves (event_page.php → active_wave.php
// links) persist to the same dir; the scout refreshes them every sweep.
require('./divers').initEventWaves(config.dataDir);

// Helpers (non-enumerable so nothing ever serialises them by accident).
Object.defineProperties(config, {
  siteByKey: { value: (key) => SITES.find((x) => x.key === key) || null },
  // The hidden fetcher's login for one site. Falls back to the main
  // ADMIN_GAME_* pair, so one account can serve every site; set
  // ADMIN_GAME_EMAIL_VEYRA / ADMIN_GAME_PASSWORD_VEYRA to use a different
  // account on that site.
  fetcherFor: {
    value: (key) => {
      const site = SITES.find((x) => x.key === key);
      const sfx = site ? site.envSuffix : '';
      const email = (sfx && process.env['ADMIN_GAME_EMAIL' + sfx] || '').trim().toLowerCase() || config.adminGameEmail;
      const password = (sfx && process.env['ADMIN_GAME_PASSWORD' + sfx]) || config.adminGamePassword;
      return { email, password, nickname: config.adminGameNickname };
    },
  },
  // Every fetcher address, for the "reserved" check on add-account.
  fetcherEmails: {
    value: () => new Set(SITES.map((x) => config.fetcherFor(x.key).email)),
  },
});

// Exposed for the unit tests (and any future panel field) — the parsers
// behind MOB_MIN_DAMAGE / MOB_MIN_DAMAGE_JSON.
Object.defineProperties(config, {
  parseDamageShorthand: { value: parseDamageShorthand },
  parseMinDamageJson: { value: parseMinDamageJson },
});

module.exports = config;
