'use strict';
// workers.js — one worker per account. Each worker owns its own GameClient +
// CookieJar (the "container" isolation) and runs an independent async loop:
//
//   staggered login → getUserId → cycle:
//     • boss targets from the bus matching this account's level-group caps
//       → run the ported combat loop
//     • otherwise → point the game's server-side auto-farm at scout mobs
//       (the game grinds on its own while the worker idles)
//
// Failures back off, sessions re-login with a cooldown, everything is
// reported through workerState() for the API/dashboard.
const fs = require('fs');
const path = require('path');
const { logger, sleep, jitter, maskEmail } = require('./util');
const { GameClient } = require('./game');
const { CookieJar } = require('./jar');
const auth = require('./auth');
const { combatLoop, waveCombat, waveFarmRound, diveBusRound, getExpStatus, drinkStaminaPotion, drinkHealPotion, drinkManaPotion, minDamageFor, readAutoFarmStatus, disableAutoFarm } = require('./combat');
const statEngine = require('./stats');
const reactions = require('./reactions');
const shop = require('./shop');
const equip = require('./equip');
const blacksmith = require('./blacksmith');
const corpses = require('./corpses');
const dungeons = require('./dungeons');
const guilds = require('./guilds');
const claims = require('./claims');
const quests = require('./quests');
const events = require('./events');
const battlepass = require('./battlepass');
const classes = require('./classes');
const skilltree = require('./skilltree');
const hunt = require('./hunt');
const divers = require('./divers');
const pvp = require('./pvp');
const { SwarmCoordinator } = require('./swarm');
const monsterStats = require('./monster-stats');
const loadout = require('./loadout');
const damage = require('./damage');
const { capsForLevel, getBossCategory } = require('./bosses');
const { TargetBus } = require('./bus');
const { Scout } = require('./scout');

// DIVE PINNING: the registry waves the hunt map hosts ANY of this diver's
// target keywords on, in target order, de-duplicated. Module-level so the
// picker stays callable on lightweight fixtures too (the dailies tests drive
// pickNextWave on a bare object).
function divePinWaves(targets, list) {
  const pins = [];
  for (const t of targets || []) {
    const pin = hunt.findMobWave(t);
    if (!pin || !pin.wave) continue;
    const w = (list || []).find((x) => x.path === pin.wave);
    if (w && !pins.some((x) => x.path === w.path)) pins.push(w);
  }
  return pins;
}

class AccountWorker {
  constructor({ account, store, cfg, bus, swarm, bosses, caps, audit, isFarmEnabled }) {
    this.account = account; // {id, nickname, email, site, role?, hidden?}
    this.store = store;
    this.cfg = cfg;
    this.bus = bus;
    // The site's swarm-attack coordinator (checkbox swarm): an armed job
    // routes this worker's cycles through the queued mob ids / dungeon mob
    // types before any normal farming happens. See swarm.js.
    this.swarm = swarm || null;
    this.bosses = bosses;
    this.caps = caps;
    this.audit = audit;
    this.isFarmEnabled = isFarmEnabled || (() => true);
    // 'admin' = the built-in fetcher: it sweeps + broadcasts targets and
    // joins the battles it broadcasts about, and NOTHING else — no dungeon
    // runs, no corpse sweeps, no reaction farm, no shop sweeps (lean by
    // design: fetching is its job, fighting its own broadcasts is its fight).
    this.role = account.role === 'admin' ? 'admin' : 'user';
    // The active guild contract's kill requirement ({monster, minDamage,
    // kills, title}) — refreshed by maybeGuildQuests, consumed by the wave
    // and dungeon engines as the per-mob damage floor.
    this.questReq = null;
    // ── Diver targeting (the user's own hunting system) ───────────────────
    // The account's dive targets ("goblin skirmisher, troll ravager") —
    // re-read from the store on every patch so panel edits apply live.
    this.diveTargets = divers.parseDiveTargets(account.diveTargets);

    this.jar = new CookieJar();
    this.client = new GameClient({
      gameBase: cfg.gameBase,
      jar: this.jar,
      cfg,
      label: account.nickname,
    });

    this.state = {
      id: account.id,
      nickname: account.nickname,
      emailMasked: null, // filled by manager (kept out of worker code)
      status: 'starting',
      userId: null,
      level: 0,
      lastError: null,
      lastActionAt: 0,
      bossHits: 0,
      farmConfiguredAt: 0,
      startedAt: Date.now(),
      runningBoss: null,
      // Precision wave farming (runPrecisionWaveCombat port): rounds run
      // round-robin across the configured gates/waves.
      waveHits: 0,
      waveRounds: 0,
      runningWave: null,
      // Diver visibility: the account's named targets + how much of the
      // farming actually bought them (matched mobs attacked this session).
      dive: { targets: this.diveTargets, attacked: 0, slain: 0, lastWave: null, pinnedWave: null, pinCount: 0 },
      // Fleet-hunt (bus dive) telemetry: the last "attack all X" volley the
      // worker fired against live bus ids, and when.
      diveBus: { lastAt: 0, attacked: 0, slain: 0, lastTargets: null },
      // Gear keep-up: equip-best rounds and blacksmith crafts this session.
      equip: { checkedAt: 0, equipped: 0, lastReport: null },
      blacksmith: { checkedAt: 0, crafted: 0, lastReport: null },
      exp: { gained: 0, lastCur: 0, percent: null, at: 0 },
      // Passive vitals (fed by game.js scanVitals on every HTML response):
      // stamina from the top bar (#stamina_span), HP from battle pages
      // (#pHpText), mana from #pManaText (Veyra auto-mana source).
      // potionsDrunk counts proactive drinks.
      vitals: { stamina: null, hp: null, mana: null, potionsDrunk: 0 },
      // Reaction stamina farm (postreaction.php): per-session daily counters,
      // same day-key semantics as the farm script (server midnight, UTC+5:30).
      reactions: { day: null, reacts: 0, gained: 0, batches: 0, capHit: false },
      // Corpses swept (loot.php instance_id=0) and dungeon rounds.
      corpseSweeps: 0, corpsesLooted: 0, dungeonRounds: 0, dungeonKills: 0,
      // Checkbox swarm telemetry: engagements this session + the dungeon
      // mob types this account last saw on the guild dungeon floors.
      swarmRounds: 0, dungeonMobs: [],
      // PvP season ladder (Divers pillar 3): last pvp.php board read + the
      // matches this session made (matchmake → redirect → battle shape).
      pvp: { checkedAt: 0, season: null, tier: null, tokens: null, rank: null, closed: null, matches: 0, lastBattle: null },
      // Manual loots of our own wave kills (the event hunting dailies count
      // only kills that were manually looted — combat.js fires the loot POST
      // right after every SLAIN when cfg.waveLootKills is on).
      waveLooted: 0,
      // Achievements + collections claim sweeps (claims.js) and their yield.
      claims: { checkedAt: 0, claimed: 0, lastReport: null },
      // Adventurers Guild contracts (quests.js): accepted/finished/donated.
      // questReq = the ACTIVE contract's farming requirement (kill contract:
      // monster name + per-kill minimum damage) — the combat engines read it
      // as the per-mob damage floor so "Kill 5 … · min 3m dmg" kills count.
      // quests.huntInfo = the hunt steering state while a kill contract is
      // armed ({monster, wave, pinned, probed}) — null when no hunt is on.
      quests: { checkedAt: 0, accepted: 0, finished: 0, donated: 0, lastReport: null, questReq: null, huntInfo: null },
      // Event daily contracts (events.js): board progress + dispatch submits.
      events: { checkedAt: 0, submitted: 0, lastReport: null },
      // Battle Pass (battlepass.js): season status, quest progress, claims.
      battlePass: { checkedAt: 0, active: null, claimed: 0, lastReport: null },
      // Class skill tree (skilltree.js): bound class, AP wallet, spends.
      skillTree: { checkedAt: 0, className: null, points: null, unlocked: 0, leveled: 0, lastReport: null },
      // Class system (classes.js): the account's bound base class, level at
      // the last check, and what the picker did. null until the first round.
      classInfo: null,
      // The account's own guild, detected from the game (hub guildId const +
      // guild_dash tag/name) and verified against the panel's guild code.
      // null until the first dungeon round; mismatch flips verified=false and
      // the worker refuses guild dungeons until the code is fixed.
      guild: null,
      // Potion-shop buy-alls and their yield.
      purchases: 0, potionsBought: 0,
      // Stat-allocation visibility (stats.php #stats-state, read on every EXP
      // poll): banked points + current attributes, plus the last run report.
      stats: {
        points: null, attack: null, defense: null, staminaMax: null,
        allocations: 0, lastPlan: null, lastTargets: null, lastError: null,
      },
    };
    this.stopFlag = false;
    this.reloginAfter = 0;
    this.lastPotionAt = 0;
    this.lastBuyAt = 0;
    this.lastEquipAt = 0;
    this.lastBlacksmithAt = 0;
    this.lastClaimsAt = 0;
    this.lastQuestsAt = 0;
    this.lastEventsAt = 0;
    this.lastBattlePassAt = 0;
    this.lastClassPickAt = 0;
    this.lastSkillTreeAt = 0;
    // Battle-pass steering: the open season's quest keywords + which wave
    // pages actually host matching mobs (learned from each wave round, so
    // the round-robin can prefer those pages while the quest is open).
    this.bpHint = null;
    this.bpWaveMemory = new Map(); // wave path -> 'match' | 'nomatch'
    // Hunt steering (hunt.js): the wave pages already probed for the armed
    // contract's monster this session (mob key → Set of paths), so the
    // picker probes unvisited pages first until the persistent map pins it.
    this.huntProbes = new Map(); // mob key -> Set(wave path)
    this.ladderDry = false; // stamina ladder found nothing last drink attempt
    this.doneBossKeysThisCycle = new Set();
    // The extension's saveBossMonsterId rule: once THIS account has taken a
    // boss instance to its cap (FINISHED) or found it dead, remember the mob
    // id per boss key and stop re-picking that instance — the worker falls
    // through to wave farming until the scout broadcasts a NEW instance id
    // (a fresh spawn) for the same key.
    this.handledBossMobs = new Map(); // boss key -> monsterId already handled
    // Round-robin cursor into cfg.wavePages, offset by the worker index so
    // N accounts spread across the 12 gate pages instead of stampeding one.
    this.index = 0;
    this.waveCursor = 0;
    this.autoFarmWarned = false; // one warning per session when the in-game auto-farm is on
    this.autoAllocateDone = false; // one stat plan per session (STAT_AUTO_ALLOCATE)
    this.autoTargetsDone = false; // targets allocator: re-armed on every EXP poll
    // Session cache of the game-reported guild identity (tag + name + id).
    // One guild_dash.php probe per session; handed to every dungeon cycle so
    // tag/name guild codes verify without extra requests. scanGuild()
    // refreshes it — accounts from DIFFERENT guilds (friends) each scan
    // their own, and a mid-session guild switch re-scans automatically.
    this.sessionGuild = null;
    this.lastGuildScanAt = 0;
    // Guild auto-join throttle: one join/apply attempt per cooldown window
    // (a full guild or a pending application must not become a POST loop).
    this.lastGuildJoinAt = 0;
  }

  maskEmailLater(masked) {
    this.state.emailMasked = masked;
  }

  markError(msg) {
    this.state.lastError = String(msg || '').slice(0, 300);
    this.state.lastActionAt = Date.now();
  }

  markAction(extra) {
    this.state.lastActionAt = Date.now();
    if (extra) Object.assign(this.state, extra);
  }

  async start(index) {
    this.index = index || 0;
    const stagger = this.cfg.fastTest
      ? this.index * 300
      : this.index * this.cfg.loginStaggerMs * (0.8 + Math.random() * 0.4);
    logger.info(`worker ${this.account.nickname}: starting in ${Math.round(stagger / 1000)}s`);
    await sleep(stagger);
    if (this.stopFlag) return;
    await this.loop();
  }

  stop() {
    this.stopFlag = true;
    this.state.status = 'stopped';
  }

  // Detects the game having logged us out (login form slipped into a response).
  sessionLooksDead(text) {
    return this.client.looksLikeLogin(text);
  }

  async ensureLogin() {
    if (Date.now() < this.reloginAfter) {
      throw new Error('re-login cooling down');
    }
    this.state.status = 'logging_in';
    const password = this.store.getPassword(this.account.id);
    try {
      await auth.login(this.client, this.account.email, password);
      const userId = await auth.getUserId(this.client);
      if (!userId) throw new Error('logged in but could not resolve user id');
      this.state.userId = userId;
      this.state.status = 'running';
      this.state.lastError = null;
      this.autoFarmWarned = false; // fresh session — re-arm the in-game auto-farm warning
      this.markAction();
      this.audit('login_ok', { account: this.state.emailMasked, userId });
      this.state.level = await auth.getPlayerLevel(this.client);
      // A leftover auto-farm blocks every manual hit — pause it now so the
      // first round hunts instead of collecting 400s.
      await this.maybeAutoFarmFix('session start');
      logger.info(`worker ${this.account.nickname}: logged in (uid ${userId}, lvl ${this.state.level})`);
      // Bind the optimal class BEFORE the first cycle — the class choice
      // shapes the whole session (passive + PvE skill). Throttled by
      // CLASS_COOLDOWN_MS; 'off' never runs; the fetcher stays lean.
      if (this.role !== 'admin') await this.maybeClassPick();
    } catch (e) {
      this.reloginAfter = Date.now() + this.cfg.reloginCooldownMs;
      this.markError(e.message);
      this.state.status = 'error';
      this.audit('login_fail', { account: this.state.emailMasked, error: e.message });
      throw e;
    }
  }

  // Proof-of-life: poll stats.php so the dashboard can show EXP gained and a
  // fresh "last action" age per account. One cheap GET, throttled by
  // cfg.expPollMs. A level-up resets the counter — never counted as a loss.
  // The same response (and every other HTML page) feeds the vitals scan.
  async maybePollExp() {
    if (Date.now() - this.state.exp.at < this.cfg.expPollMs) {
      this.foldVitals();
      return;
    }
    try {
      const exp = await getExpStatus(this.client);
      this.state.exp.at = Date.now();
      if (exp && exp.stats) {
        // stats.php embeds #stats-state — free visibility on banked points.
        this.state.stats.points = exp.stats.points;
        this.state.stats.attack = exp.stats.attack;
        this.state.stats.defense = exp.stats.defense;
        this.state.stats.staminaMax = exp.stats.staminaMax;
      }
      if (exp && Number.isFinite(exp.currentExp)) {
        const cur = exp.currentExp;
        const prev = this.state.exp.lastCur;
        if (prev > 0 && cur >= prev) this.state.exp.gained += cur - prev;
        this.state.exp.lastCur = cur;
        if (Number.isFinite(exp.percentExp)) {
          this.state.exp.percent = Math.round(exp.percentExp);
        }
        if (Number.isFinite(exp.requiredExp)) {
          this.state.exp.requiredExp = exp.requiredExp; // corpse "loot to level up" budget
        }
      }
      this.markAction();
    } catch (_) {
      this.state.exp.at = Date.now(); // stats hiccup — retry on next schedule
    }
    this.foldVitals();
  }

  // Copy the client's freshest passive vitals into worker state.
  foldVitals() {
    if (this.client.lastStamina) {
      this.state.vitals.stamina = { ...this.client.lastStamina };
    }
    if (this.client.lastHp) {
      this.state.vitals.hp = { ...this.client.lastHp };
    }
    if (this.client.lastMana) {
      this.state.vitals.mana = { ...this.client.lastMana };
    }
  }

  // Proactive potion policy (farm-on only, shared cooldown between drinks):
  //   stamina < STAMINA_POTION_BELOW → stamina ladder (skipped while
  //     EXP >= 80% — ported from the extension's AI, a level-up would
  //     waste the refill)
  //   hp% < HP_POTION_BELOW_PCT      → heal potion, else free timed heal
  //   mana <= MANA_POTION_BELOW      → mana ladder (Veyra auto mana: the
  //     default threshold 0 means "the bar is used up")
  // A dry stamina ladder sets ladderDry — the buy-all sweep's trigger.
  async maybeAutoPotion() {
    this.foldVitals();
    const now = Date.now();
    if (now - this.lastPotionAt < this.cfg.potionCooldownMs) return;
    const v = this.state.vitals;
    const expPct = this.state.exp.percent;

    const stam = v.stamina;
    if (stam && this.cfg.staminaPotionBelow > 0 && stam.cur < this.cfg.staminaPotionBelow
        && !(expPct != null && expPct >= 80)) {
      if (await drinkStaminaPotion(this.client)) {
        this.lastPotionAt = now;
        this.ladderDry = false;
        v.potionsDrunk++;
        logger.info(`worker ${this.account.nickname}: stamina ${stam.cur}/${stam.max} → stamina potion used`);
      } else {
        this.ladderDry = true; // nothing stocked — the shop sweep can step in
      }
      return; // one kind per cooldown window
    }

    const hp = v.hp;
    if (hp && hp.max > 0 && this.cfg.hpPotionBelowPct > 0
        && (hp.cur / hp.max) * 100 < this.cfg.hpPotionBelowPct) {
      if (await drinkHealPotion(this.client, null, this.state.userId)) {
        this.lastPotionAt = now;
        v.potionsDrunk++;
        logger.info(`worker ${this.account.nickname}: HP ${Math.round((hp.cur / hp.max) * 100)}% → heal potion used`);
      }
      return;
    }

    const mana = v.mana;
    if (mana && mana.max > 0 && this.cfg.manaPotionNames.length
        && mana.cur <= this.cfg.manaPotionBelow) {
      if (await drinkManaPotion(this.client)) {
        this.lastPotionAt = now;
        v.potionsDrunk++;
        logger.info(`worker ${this.account.nickname}: mana ${mana.cur}/${mana.max} → mana potion used`);
      }
    }
  }

  // Auto stat allocation. Two modes:
  //   STAT_AUTO_ALLOCATE=1  — legacy fixed plan: once banked STAT_POINTS cover
  //     the plan, run allocatePlan once per session.
  //   STAT_TARGETS_AUTO=1   — Veyra targets mode: keep spending banked points
  //     toward STAT_TARGETS (attack → defense → stamina) until the targets
  //     are met or the points run dry; re-armed on every EXP poll so the next
  //     level-up's points are spent too.
  async maybeAutoAllocate() {
    // Targets mode.
    if (this.cfg.statTargetsAuto) {
      const targets = statEngine.planTotals(this.cfg.statTargets);
      const goal = targets.attack + targets.defense + targets.stamina;
      if (goal > 0 && !this.autoTargetsDone && this.state.stats.points != null && this.state.stats.points > 0) {
        const report = await statEngine.allocateTargets(this.client, targets, { fastTest: this.cfg.fastTest });
        this.state.stats.lastTargets = targets;
        if (report.ok) {
          this.state.stats.allocations++;
          this.state.stats.points = report.pointsLeft;
          if (report.attributes) {
            this.state.stats.attack = report.attributes.attack;
            this.state.stats.defense = report.attributes.defense;
            this.state.stats.staminaMax = report.attributes.stamina;
          }
          this.state.stats.lastError = null;
          logger.info(
            `worker ${this.account.nickname}: stat targets spent ${report.applied} points ` +
            `(${report.reason}, ${report.pointsLeft} left)`
          );
        } else {
          this.state.stats.lastError = report.reason || 'targets_failed';
          logger.warn(`worker ${this.account.nickname}: stat targets failed (${report.reason})`);
        }
        this.audit('stat_allocation', {
          account: this.state.emailMasked,
          mode: 'targets',
          targets: report.targets,
          applied: report.applied,
          ok: report.ok,
          reason: report.reason,
          auto: true,
        });
        // Points drained (or targets hit) — don't re-fire until the next poll
        // sees points again. Re-arm lazily in maybePollExp.
        if (report.ok && report.reason === 'points_drained') this.autoTargetsDone = true;
      }
      if (this.autoTargetsDone && this.state.stats.points != null && this.state.stats.points > 0) {
        this.autoTargetsDone = false; // new points banked — spend them
      }
      return;
    }

    // Legacy fixed-plan mode.
    const plan = this.cfg.statPlan;
    const total = statEngine.planTotals(plan);
    const planTotal = total.attack + total.defense + total.stamina;
    if (!this.cfg.statAutoAllocate || planTotal <= 0 || this.autoAllocateDone) return;
    const points = this.state.stats.points;
    if (points == null || points < planTotal) return; // still saving up
    this.autoAllocateDone = true; // one shot per session (success or failure)
    const report = await statEngine.allocatePlan(this.client, plan, { fastTest: this.cfg.fastTest });
    this.state.stats.lastPlan = plan;
    if (report.ok) {
      this.state.stats.allocations++;
      this.state.stats.points = report.pointsLeft;
      this.state.stats.attack = report.attributes.attack;
      this.state.stats.defense = report.attributes.defense;
      this.state.stats.staminaMax = report.attributes.maxStamina;
      this.state.stats.lastError = null;
      logger.info(`worker ${this.account.nickname}: stat plan allocated (+${report.applied} points spent, ${report.pointsLeft} left)`);
    } else {
      this.state.stats.lastError = report.reason || 'stat_failed';
      logger.warn(`worker ${this.account.nickname}: stat allocation failed (${report.reason})`);
    }
    this.audit('stat_allocation', {
      account: this.state.emailMasked,
      plan: report.plan,
      applied: report.applied,
      ok: report.ok,
      reason: report.reason,
      auto: true,
    });
  }

  // Pick the boss target this account should attack now. Faithful to the
  // extension semantics: only bosses enabled for this account's level group,
  // cap from the group config, skip ones already handled this cycle — and
  // (saveBossMonsterId) skip the exact mob instance this account already
  // took to its cap or found dead this session, so a finished boss never
  // starves the wave farm.
  // Boss Tracker rule: a 48h auto-die boss still in phase 1 (more than
  // BOSS_PHASE2_HOURS of life left) is exempt — damage there doesn't count
  // toward the loot, so the workers wait for phase 2 (config gate on).
  pickBossTarget(snapshot) {
    const col = capsForLevel(this.state.level, this.caps);
    if (!col) return null;
    const now = Date.now();
    for (const [key, target] of Object.entries(snapshot.bosses)) {
      if (this.doneBossKeysThisCycle.has(key)) continue;
      // saveBossMonsterId: this very mob instance already hit its cap / read
      // dead this session — skip it until a NEW instance id is broadcast.
      if (this.handledBossMobs && this.handledBossMobs.get(key) === String(target.monsterId)) continue;
      const conf = col[key];
      if (!conf || !conf.c) continue;
      // Freshness: only attack targets found in the last 30 min.
      if (now - target.foundAt > 30 * 60 * 1000) continue;
      if (this.cfg.bossPhaseGate && target.spawnPhase === 1) continue;
      const boss = this.bosses.find((b) => b.key === key);
      return { key, monsterId: target.monsterId, cap: conf.v, boss: boss || { key, name: target.name } };
    }
    return null;
  }

  // The game's own auto-farm (the wave page's autoFarmPanel /
  // auto_farm_actions.php) blocks EVERY manual hit while it runs: damage.php
  // answers "You can't attack monsters while your auto farm is on". Hunting
  // in waves is the engine's whole job, so the worker now FIXES the state
  // itself — the same two calls the Auto Farm card makes:
  //   GET  auto_farm_status.php  → settings.IS_ENABLED
  //   POST auto_farm_actions.php action=toggle&enabled=0   (Pause button)
  // AUTO_FARM_FIX=0 restores the old warn-only behaviour.
  async fixAutoFarmOn(reason) {
    if (!this.cfg.autoFarmFix) {
      this.warnAutoFarmOn();
      return false;
    }
    const status = await readAutoFarmStatus(this.client);
    if (!status.enabled) {
      // The 400 was stale (the game paused it already) — nothing to do.
      logger.info(`worker ${this.account.nickname}: auto-farm already off (${reason})`);
      return true;
    }
    const ok = await disableAutoFarm(this.client);
    const state = await readAutoFarmStatus(this.client); // verify, don't trust
    const off = ok && !state.enabled;
    if (off) {
      logger.info(`worker ${this.account.nickname}: in-game auto-farm PAUSED (${reason}) — manual wave hunting resumes`);
      this.audit('auto_farm_disabled', { account: this.state.emailMasked, reason });
      this.markAction();
    } else {
      // Engine could not confirm the pause — the game still rejects hits.
      this.warnAutoFarmOn();
    }
    return off;
  }

  // One cheap status GET at session start: pause a leftover auto-farm BEFORE
  // the first round wastes attacks on 400s. Never fatal.
  async maybeAutoFarmFix(reason) {
    if (!this.cfg.autoFarmFix) return;
    try {
      const status = await readAutoFarmStatus(this.client);
      if (status.enabled) await this.fixAutoFarmOn(reason);
    } catch (_) { /* best effort — the round detects it too */ }
  }

  // Legacy warn-only path (AUTO_FARM_FIX=0 or an unconfirmed toggle).
  warnAutoFarmOn() {
    // The panel row must keep showing the hint (other successes clear
    // lastError), but log/audit only once per session.
    const hint = 'in-game auto-farm is ON — the game rejects every manual hit. ' +
      'The engine tried to pause it; if this keeps showing, pause it on the ' +
      'wave page (Auto Farm card; renders at Lv 400+).';
    this.markError(hint); // visible on the panel's account row, not just logs
    if (this.autoFarmWarned) return;
    this.autoFarmWarned = true;
    logger.warn(`worker ${this.account.nickname}: ${hint}`);
    this.audit('auto_farm_warning', {
      account: this.state.emailMasked,
      hint,
    });
  }

  // The wave registry this diver round-robins over: config/waves.json (the
  // gates) PLUS every event wave the scout discovered dynamically (Divers'
  // fourth pillar — events rotate, so their wave pages join at runtime from
  // data/event-waves.json, refreshed by the scout, read-only here).
  waveRegistry() {
    const base = this.cfg.wavePages || [];
    const extra = divers.storedEventWaves().filter((w) => !base.some((b) => b.path === w.path));
    return extra.length ? [...base, ...extra.map((w) => ({ path: w.path, label: w.label }))] : base;
  }

  // Round-robin over the gate/wave registry, offset by worker index so
  // parallel accounts cover different pages in the same window. While the
  // battle-pass damage quest is open, waves REMEMBERED to host matching
  // mobs go first (never-visited next, known non-matching last) — the
  // registry's own order is kept inside each bucket.
  // REWARD-CAP STEERING: a wave whose "Rewards Up To LV X" gate sits BELOW
  // this account's level pays gear only (no exp/gold) — such waves sink to
  // the back of the rotation so exp-positive pages come first. Dive targets
  // win over the steering: a diver sent to hunt a specific mob still reaches
  // its page (the dive sort inside the round handles the mobs).
  // DIVE STEERING (Divers pillar 1 — the user's named mob hunt): a diver
  // with target keywords goes straight to the wave(s) the hunt map pins for
  // them — seeded from config/mobs.json (the live-scraped rosters) and kept
  // fresh by every parsed wave page. Multi-target divers rotate across ALL
  // their pinned pages (the per-round dive sort hunts the matching mobs on
  // each). Targets the map does not know yet keep the round-robin (the map
  // learns from every round + the scout's sweep, so the pin appears on its
  // own). Guild contracts still outrank dive targets — a concrete contract
  // with a damage floor beats a keyword family.
  // HUNT STEERING (guild kill contracts): while a contract names a monster,
  // the persistent hunt map (hunt.js) pins the wave that hosts it and the
  // worker farms THAT page first (quest mob attacks first via combat's
  // contract sort). Unknown monster → probe: pages not yet checked for this
  // name this session go first, so every round teaches one more page until
  // the map pins the hunt. questMob hunting wins over battle-pass steering —
  // a concrete named mob beats a keyword family.
  pickNextWave() {
    const list = divers.orderWavesByRewardCap(this.waveRegistry(), this.state.level);
    if (!list.length) return null;
    if (this.cfg.guildQuests && this.cfg.guildQuests.hunt
      && this.questReq && this.questReq.kind === 'kill' && this.questReq.monster) {
      const key = hunt.normalizeName(this.questReq.monster);
      const pin = hunt.findMobWave(this.questReq.monster);
      // HARD PIN only on a LEARNED row (a live sighting). A seeded row is the
      // config's guess — it steers the probe order below but never traps the
      // contract on a page that may not host the mob in this world.
      if (pin && pin.wave && !pin.seed) {
        const pinned = list.find((w) => w.path === pin.wave);
        if (pinned) {
          this.state.quests.huntInfo = { monster: this.questReq.monster, wave: pinned.label, pinned: true };
          this._wavePin = { kind: 'quest', monster: this.questReq.monster, path: pinned.path };
          return pinned; // straight to the mob's page — stay until the contract turns in
        }
      }
      // Not pinned yet → probe: each round visits one UNVISITED page
      // (registry order, offset by worker index so parallel accounts probe
      // different pages in the same window). Every visited page feeds the
      // map from waveFarmRound, so the pin appears as soon as the mob is
      // seen anywhere. After a full sweep without a sighting the hunt
      // falls back to the normal order below (the mob may have moved).
      // The config seed (config/mobs.json rosters) hints the FIRST unvisited
      // page to probe — one round to a likely host instead of a blind scan;
      // a live sighting there upgrades the seed to a verified pin.
      let probed = this.huntProbes.get(key);
      if (!probed) { probed = new Set(); this.huntProbes.set(key, probed); }
      const fresh = list.filter((w) => !probed.has(w.path));
      if (fresh.length) {
        let wave = null;
        if (pin && pin.wave && !probed.has(pin.wave)) {
          wave = fresh.find((w) => w.path === pin.wave) || null; // seeded hint first
        }
        if (!wave) wave = fresh[this.index % fresh.length];
        probed.add(wave.path);
        this._wavePin = null; // a probe is never a pin
        this.state.quests.huntInfo = {
          monster: this.questReq.monster,
          wave: wave.label,
          pinned: false,
          probed: probed.size,
        };
        return wave;
      }
      this._wavePin = null; // full sweep dry — fall through to the rotation
    }
    // DIVE STEERING first (after contracts): the user's named targets pin
    // their hosting waves; rotation cycles the pins so a diver hunting mobs
    // on two pages covers both.
    if (this.diveTargets && this.diveTargets.length) {
      const pins = divePinWaves(this.diveTargets, list);
      if (pins.length) {
        const wave = pins[this.waveCursor % pins.length];
        this.waveCursor = (this.waveCursor + 1) % pins.length;
        this.state.dive.pinnedWave = wave.label;
        this.state.dive.pinCount = pins.length;
        this._wavePin = { kind: 'dive', targets: [...this.diveTargets], path: wave.path };
        return wave;
      }
      this.state.dive.pinnedWave = null;
      this.state.dive.pinCount = 0;
    }
    this._wavePin = null; // plain rotation round — nothing pinned to demote
    const steering = (this.cfg.battlePass && this.cfg.battlePass.wavePriority)
      && (this.bpHint || (this.questReq && this.questReq.monster));
    const ordered = steering
      ? battlepass.orderWaves(list, this.bpWaveMemory)
      : list;
    const wave = ordered[(this.index + this.waveCursor) % ordered.length];
    this.waveCursor = (this.waveCursor + 1) % ordered.length;
    return wave;
  }

  // Precision wave round (port of runPrecisionWaveCombat): visit one wave
  // page, join + slash the eligible mobs under the strict per-mob damage cap,
  // stop on empty stamina (the potion ladder refills before the next round).
  async precisionWaveCycle() {
    // ── BUS DIVE (fleet hunt, Divers pillar 1) ────────────────────────────
    // With dive targets set (per account, or fleet-wide via POST /api/hunt),
    // the worker FIRST hits the live bus ids matching them — "attack all
    // Troll Ravager" lands on every account's next cycle, whatever wave the
    // mobs live on, then the pinned-wave round keeps hunting the same page.
    if (this.cfg.diveBus !== false && this.diveTargets.length) {
      const snap = this.bus.snapshot();
      const busRound = await diveBusRound({
        game: this.client,
        userId: this.state.userId,
        cfg: { ...this.cfg, diveTargets: this.diveTargets },
        busMobs: snap.mobs || [],
        targets: this.diveTargets,
        onEvent: (msg) => logger.debug(`worker ${this.account.nickname}: ${msg}`),
        // An armed swarm owns the fleet — a long bus-dive fight yields
        // between hits the moment the swarm needs this account.
        shouldAbort: () => !!(this.swarm && this.swarm.armed() && this.swarm.owesWork(this.account.id)),
      });
      if (busRound.attacked) {
        this.state.diveBus = {
          lastAt: Date.now(),
          attacked: (this.state.diveBus.attacked || 0) + busRound.attacked,
          slain: (this.state.diveBus.slain || 0) + (busRound.slain || 0),
          lastTargets: busRound.targets,
        };
        this.state.dive.attacked += busRound.attacked;
        this.state.dive.slain = (this.state.dive.slain || 0) + (busRound.slain || 0);
        logger.info(`worker ${this.account.nickname}: bus dive — ${busRound.attacked} target mob(s) hit` +
          ` (${busRound.slain || 0} slain${busRound.looted ? `, ${busRound.looted} looted` : ''}): ${busRound.targets.join(', ')}`);
        this.audit('bus_dive', {
          account: this.state.emailMasked,
          targets: this.diveTargets,
          attacked: busRound.attacked,
          slain: busRound.slain || 0,
          mobs: busRound.targets,
        });
        this.markAction();
      }
      if (busRound.stopped === 'AUTO_FARM_ON') {
        await this.fixAutoFarmOn('bus dive');
      }
      if (busRound.stopped === 'OUT_OF_STAMINA') {
        if (await drinkStaminaPotion(this.client)) {
          this.state.vitals.potionsDrunk++;
          this.lastPotionAt = Date.now();
          this.ladderDry = false;
          logger.info(`worker ${this.account.nickname}: bus dive out of stamina → potion ladder used`);
        } else {
          this.ladderDry = true;
          if (this.role !== 'admin') await this.maybeCorpseSweep();
          return null; // bar is dry — skip the wave round entirely this cycle
        }
      }
    }
    const wave = this.pickNextWave();
    if (!wave) {
      await this.client.pace(800, 2000);
      return null;
    }
    this.state.runningWave = wave.label;
    // The battle-pass keywords + the active guild contract's monster + THIS
    // diver's own target mobs ride along on a per-round cfg copy (the shared
    // config object is never mutated): matching mobs attack first, contract
    // mobs carry their damage floor, DIVE_ONLY skips everything unnamed, and
    // the round reports how many matched in each bucket.
    const wantsSteering = this.diveTargets.length > 0 || this.bpHint || this.questReq;
    const roundCfg = wantsSteering
      ? {
        ...this.cfg,
        bpKeywords: this.bpHint ? this.bpHint.keywords : undefined,
        questReq: this.questReq || undefined,
        diveTargets: this.diveTargets.length ? this.diveTargets : undefined,
        diveOnly: this.cfg.diveOnly === true,
      }
      : this.cfg;
    const round = await waveFarmRound({
      game: this.client,
      userId: this.state.userId,
      cfg: roundCfg,
      wave,
      onEvent: (msg) => logger.debug(`worker ${this.account.nickname}: ${msg}`),
      // An armed swarm owns the fleet — a long wave fight (a 100M-cap
      // Olympus wall can run 20+ minutes) yields between hits the moment
      // the swarm needs this account.
      shouldAbort: () => !!(this.swarm && this.swarm.armed() && this.swarm.owesWork(this.account.id)),
    });
    // Wave memory steers the picker: remember which pages carry quest mobs
    // (battle-pass family OR the guild contract's monster) so matching waves
    // are visited first. round.matched counts both kinds of match.
    if (this.bpHint || (this.questReq && this.questReq.monster)) {
      this.bpWaveMemory.set(wave.path, round.matched > 0 ? 'match' : 'nomatch');
    }
    // PIN SELF-HEAL: a pinned round that saw NONE of its mobs means the pin
    // went stale (the game moved the mob, or the seed was wrong for this
    // world). Demote the map rows for that wave — the probe/rotation takes
    // over and the next live sighting re-pins the mob's real page.
    if (this._wavePin && this._wavePin.path === wave.path) {
      if (this._wavePin.kind === 'quest' && (round.questMatched || 0) === 0) {
        const gone = hunt.demoteWave(wave.path, [this._wavePin.monster]);
        if (gone) {
          logger.info(`worker ${this.account.nickname}: hunt pin demoted — ${this._wavePin.monster} not on ${wave.label} (${gone} map row(s)); probing resumes`);
          this.state.quests.huntInfo = {
            monster: this._wavePin.monster, wave: wave.label, pinned: false, demoted: true,
          };
        }
      }
      if (this._wavePin.kind === 'dive' && (round.dived || 0) === 0) {
        const gone = hunt.demoteWave(wave.path, this._wavePin.targets);
        if (gone) {
          logger.info(`worker ${this.account.nickname}: dive pin demoted — none of the targets on ${wave.label} (${gone} map row(s)); roaming resumes`);
          this.state.dive.pinnedWave = null;
          this.state.dive.pinCount = 0;
        }
      }
    }
    this._wavePin = null;
    this.state.waveRounds++;
    this.state.waveHits += round.attacked;
    this.state.waveLooted = (this.state.waveLooted || 0) + (round.looted || 0);
    // Diver telemetry: how much of the session actually bought the named
    // targets (the panel shows this per account row).
    if (this.diveTargets.length) {
      this.state.dive.attacked += round.dived || 0;
      if (round.dived > 0) this.state.dive.lastWave = round.wave;
    }
    this.state.runningWave = null;
    this.markAction();
    logger.info(
      `worker ${this.account.nickname}: wave ${round.wave} — ${round.attacked} mobs ` +
      `(${round.slain} slain, ${round.capped} capped${round.looted ? `, ${round.looted} looted` : ''}` +
      `${round.dived ? `, ${round.dived} dived` : ''}` +
      `${round.cappedSkip ? `, ${round.cappedSkip} reward-capped skipped` : ''}` +
      `${this.bpHint && round.matched ? `, ${round.matched} bp-matched` : ''}` +
      `${round.floored ? `, ${round.floored} contract-floor` : ''})` +
      `${round.stopped ? ` · ${round.stopped}` : ''}`
    );
    this.audit('wave_round', {
      account: this.state.emailMasked,
      wave: round.wave,
      attacked: round.attacked,
      slain: round.slain,
      capped: round.capped,
      looted: round.looted || undefined,
      dived: round.dived || undefined,
      cappedSkip: round.cappedSkip || undefined,
      stopped: round.stopped || undefined,
    });
    if (round.stopped === 'AUTO_FARM_ON') {
      await this.fixAutoFarmOn('wave round');
    }
    if (round.stopped === 'OUT_OF_STAMINA') {
      if (await drinkStaminaPotion(this.client)) {
        this.state.vitals.potionsDrunk++;
        this.lastPotionAt = Date.now();
        this.ladderDry = false;
        logger.info(`worker ${this.account.nickname}: out of stamina → potion ladder used`);
      } else {
        this.ladderDry = true; // dry → the corpse sweep / shop sweep step in
        if (this.role !== 'admin') await this.maybeCorpseSweep();
      }
    }
    return round;
  }

  // Mirror the game-reported guild identity into the panel state. The code
  // verdict recomputes here too — so a changed/added guild code re-verifies
  // on the next scan or dungeon round, not only on the next dungeon fight.
  mirrorGuild() {
    const g = this.sessionGuild;
    if (!g || (!g.id && !g.tag && !g.name)) return;
    const code = String(this.account.guildCode || '').trim();
    this.state.guild = {
      id: g.id || null,
      tag: g.tag || null,
      name: g.name || null,
      code,
      verified: code ? dungeons.guildMatches(code, g) : null,
      at: Date.now(),
    };
  }

  // Guild identity scan (one guild_dash.php GET — the game always answers
  // the CALLER's guild). Runs for EVERY account regardless of the dungeon
  // config, so friends in other guilds get their own guild detected and
  // shown without touching any dungeon code. Throttled: full identity on
  // first sight, gap-fills when id/tag are known but the name is not, and a
  // re-probe every 30 min catches mid-session guild switches.
  async scanGuild() {
    const g = this.sessionGuild;
    const stale = Date.now() - this.lastGuildScanAt > 30 * 60 * 1000;
    if (g && g.id && (g.tag || g.name) && !stale) return;
    this.lastGuildScanAt = Date.now();
    try {
      const fresh = await dungeons.fetchOwnGuild(this.client);
      if (!fresh) {
        // Guild-less. If the account carries an explicit panel guild code,
        // make the account MATCH its code: join (open recruitment) or apply
        // (application mode). No code → never join blind. The verdict lands
        // in the audit log + state.guild.join for the panel.
        await this.maybeAutoJoinGuild();
        return;
      }
      const prevId = g && g.id;
      this.sessionGuild = dungeons.mergeGuild(g, fresh);
      if (prevId && this.sessionGuild.id && String(prevId) !== String(this.sessionGuild.id)) {
        logger.info(`worker ${this.account.nickname}: guild changed #${prevId} → ` +
          `#${this.sessionGuild.id}${this.sessionGuild.tag ? ` [${this.sessionGuild.tag}]` : ''}`);
        this.audit('guild_change', {
          account: this.state.emailMasked,
          from: prevId,
          to: this.sessionGuild.id,
          tag: this.sessionGuild.tag || undefined,
          note: 'identity rescanned, old tag/name dropped',
        });
      }
      this.mirrorGuild();
    } catch (_) { /* network hiccup — retried on a later cycle */ }
  }

  // ACCEPT GUILDS: the account asked for a guild (panel guild code) but the
  // game reports none — search the directory for that exact guild and take
  // the join/apply form if the page offers one. Throttled by
  // GUILD_JOIN_COOLDOWN_MS so a full guild or a pending application never
  // becomes a POST loop; GUILD_AUTO_JOIN=0 (or no code) disables entirely.
  async maybeAutoJoinGuild() {
    const code = String(this.account.guildCode || '').trim();
    if (!code || this.cfg.guildAutoJoin === false) return;
    const now = Date.now();
    if (now - this.lastGuildJoinAt < (this.cfg.guildJoinCooldownMs || 30 * 60 * 1000)) return;
    this.lastGuildJoinAt = now;
    logger.info(`worker ${this.account.nickname}: guild-less with code "${code}" — searching the guild registry…`);
    let result = null;
    try {
      result = await guilds.joinGuild(this.client, { code });
    } catch (e) {
      result = { ok: 'error', error: e.message };
    }
    const detail = guilds.describe(result);
    this.audit('guild_join', {
      account: this.state.emailMasked,
      code,
      verdict: result && result.ok,
      detail,
    });
    logger.info(`worker ${this.account.nickname}: guild auto-join → ${detail}`);
    this.state.guild = {
      ...(this.state.guild || {}),
      code,
      verified: null,
      join: { ok: result && result.ok, detail, at: Date.now() },
    };
    if (result && (result.ok === 'joined' || result.ok === 'applied_verified') && result.guild) {
      // Confirm the new identity through the engine's own path (dash probe),
      // then the existing verdict flow takes over — dungeons unlock without
      // touching this account's config again.
      try {
        const fresh = await dungeons.fetchOwnGuild(this.client);
        if (fresh) {
          this.sessionGuild = dungeons.mergeGuild(this.sessionGuild, fresh);
          this.mirrorGuild();
        }
      } catch (_) { /* next scan re-checks */ }
    }
  }

  // One swarm engagement on the queue's CURRENT wave target: join + slash
  // by mob id until this account's remaining quota (cap) is banked or the
  // instance dies. The coordinator banks the damage (live via onDamage,
  // final via report) — the next cycle resumes mid-quota if the bar is not
  // full yet. Returns true when the cycle was spent on the swarm.
  //
  // STAMINA AWARE: the account's bar is refreshed from stats.php first — a
  // dry account drinks the potion ladder ONCE and otherwise SITS OUT the
  // cycle reporting OUT_OF_STAMINA (no wasted join POSTs hammering a mob it
  // cannot hit); the panel shows exactly who is waiting for a refill.
  // DAMAGE FORECAST: the mob's "View Monster Stats" block (battle view —
  // zero stamina) + the account's own loadout feed the game's damage
  // formula, so the log and the panel show ≈dmg/hit and ≈hits left BEFORE
  // the first hit lands. A pure forecast — never a dependency: any failure
  // here degrades to fighting without decoration.
  async swarmRound() {
    const work = this.swarm.claim(this.account.id, this.account.nickname);
    if (!work) return false;
    const label = work.name || `mob ${work.mobId}`;
    this.state.runningWave = `swarm: ${label}`;
    logger.info(`worker ${this.account.nickname}: SWARM ${label} (mob ${work.mobId}) — ` +
      `${work.damageSoFar.toLocaleString('en-US')}/${work.quota.toLocaleString('en-US')} dmg banked, cap this pass ${work.cap.toLocaleString('en-US')}`);

    // ── stamina gate (stats.php is the source of truth) ──
    try {
      // maxAgeMs 5000 + authoritative: a stale bar here costs a wasted join
      // POST against the live game (the fleet's most precious currency) — and
      // a bar folded from an unrelated page can be seconds behind the game.
      // Only the game's own live numbers (stats.php / the damage echo) may
      // satisfy this gate; anything older forces one stats.php GET.
      const sta = await loadout.staminaNow(this.client, { maxAgeMs: 5000, authoritative: true });
      if (sta) {
        this.swarm.noteVitals(this.account.id, { staminaCur: sta.cur, staminaMax: sta.max });
        this.state.vitals.stamina = { cur: sta.cur, max: sta.max, at: sta.at };
      }
      const cur = sta ? Number(sta.cur) : null;
      if (cur != null && cur < 1) {
        const drank = await drinkStaminaPotion(this.client);
        if (drank) {
          this.state.vitals.potionsDrunk++;
          this.lastPotionAt = Date.now();
          this.ladderDry = false;
          logger.info(`worker ${this.account.nickname}: swarm target reached on an empty bar → potion ladder used`);
        } else {
          this.ladderDry = true;
          this.swarm.report(this.account.id, { key: work.key, result: 'OUT_OF_STAMINA', damage: work.damageSoFar, name: work.name });
          this.state.runningWave = null;
          logger.info(`worker ${this.account.nickname}: swarm waits — stamina dry (${cur}/${sta ? sta.max : '?'}), no potion left; the fleet fights on without this account`);
          this.markAction();
          return true; // cycle spent standing by — the swarm tracks the wait
        }
      }
    } catch (_) { /* vitals are best-effort — the fight's own OUT_OF_STAMINA verdict still guards it */ }

    // ── damage forecast (monster stats modal + the game's formula) ──
    try {
      const seen = await monsterStats.get(this.client, work.mobId);
      if (seen && seen.stats) {
        const lo = await loadout.fetchLoadout(this.client);
        this.state.loadout = {
          equipAtk: lo.equipAtk, petAtk: lo.petAtk, attackStat: lo.attackStat, at: lo.at,
        };
        const pred = damage.predictDamage({
          equipAtk: lo.equipAtk,
          petAtk: lo.petAtk,
          attackStat: lo.attackStat,
          playerElement: lo.element,
          playerElementRate: lo.elementRate,
          staminaCost: 1,
        }, seen.stats);
        const hitsLeft = damage.hitsFor(Math.max(0, work.cap), pred.total);
        this.swarm.noteIntel(work.key, {
          mobName: seen.stats.name,
          defense: seen.stats.defense,
          eqDefense: seen.stats.eqDefense,
          petDefense: seen.stats.petDefense,
          element: seen.stats.elementLabel,
          elementRate: seen.stats.elementRate,
          rewardsUpToLv: seen.stats.rewardsUpToLv,
          avgHit: pred.total,
          base: pred.base,
          elemental: pred.elemental,
          countered: pred.countered,
          hitsLeft,
        });
        logger.info(`worker ${this.account.nickname}: forecast vs ${seen.stats.name} — ≈${pred.total.toLocaleString('en-US')} dmg/hit` +
          `${pred.countered ? ' (element countered, rate ×2)' : ''} · ≈${hitsLeft.toLocaleString('en-US')} hit(s) to the cap · ${monsterStats.describe(seen.stats)}`);
      }
    } catch (_) { /* forecast is decoration — fight on without it */ }

    let seenDamage = work.damageSoFar;
    const result = await waveCombat({
      game: this.client,
      userId: this.state.userId,
      monsterId: work.mobId,
      cap: work.cap,
      startDamage: work.damageSoFar,
      onEvent: (msg) => logger.debug(`worker ${this.account.nickname}: ${msg}`),
      onDamage: (d) => {
        seenDamage = d;
        this.swarm.progress(this.account.id, work.key, d);
      },
    });
    this.state.runningWave = null;
    this.state.swarmRounds++;
    this.swarm.report(this.account.id, { key: work.key, result, damage: seenDamage, name: work.name });
    if (this.client.lastStamina) {
      this.swarm.noteVitals(this.account.id, {
        staminaCur: this.client.lastStamina.cur,
        staminaMax: this.client.lastStamina.max,
      });
    }
    this.audit('swarm_hit', {
      account: this.state.emailMasked,
      mob: label,
      mobId: work.mobId,
      result,
      damage: seenDamage,
    });
    this.markAction();
    logger.info(`worker ${this.account.nickname}: swarm ${label} → ${result} (${seenDamage.toLocaleString('en-US')} dmg on the instance)`);
    if (result === 'AUTO_FARM_ON') {
      await this.fixAutoFarmOn('swarm');
    }
    if (result === 'OUT_OF_STAMINA') {
      if (await drinkStaminaPotion(this.client)) {
        this.state.vitals.potionsDrunk++;
        this.lastPotionAt = Date.now();
        this.ladderDry = false;
        logger.info(`worker ${this.account.nickname}: swarm out of stamina → potion ladder used`);
      } else {
        this.ladderDry = true;
        if (this.role !== 'admin') await this.maybeCorpseSweep(); // free EXP while the bar refills
      }
    }
    return true;
  }

  // Guild dungeon cycle (DungeonCleaner port): hub → guild check →
  // instances → floors → loot dead → fight live, capped per cycle so waves
  // keep their share. The account's guild code (optional panel field) is
  // verified first; a mismatch stops the dungeon farm for this cycle —
  // people only ever attack their own guild's mobs. Every account farms
  // its OWN guild: the hub only ever lists the session's guild's runs.
  // SWARM FOCUS: when the swarm queue's current target is a dungeon mob,
  // claimDungeon() narrows the whole cycle to that ONE mob type with the
  // account's remaining quota as the per-fight cap.
  async dungeonCycle() {
    try {
      const swarmWork = this.swarm && this.swarm.armed()
        ? this.swarm.claimDungeon(this.account.id, this.account.nickname)
        : null;
      if (swarmWork) {
        logger.info(`worker ${this.account.nickname}: swarm focus on dungeon "${swarmWork.name}" — ` +
          `${this.swarm.damageFor(this.account.id, swarmWork.key).toLocaleString('en-US')}/${swarmWork.quota.toLocaleString('en-US')} banked`);
      }
      const result = await dungeons.dungeonCycle(this.client, {
        userId: this.state.userId,
        maxMobs: this.cfg.dungeon.maxMobsPerCycle,
        betweenHitsMs: this.cfg.dungeon.betweenHitsMs,
        guildCode: this.account.guildCode || '',
        guild: this.sessionGuild,
        cubeEnabled: this.cfg.dungeon.cube !== false,
        swarmTarget: swarmWork ? { key: swarmWork.key, name: swarmWork.name, cap: swarmWork.cap } : null,
        onSwarmHit: (info) => {
          if (this.swarm && swarmWork) {
            this.swarm.reportDungeon(this.account.id, {
              key: swarmWork.key,
              damage: info.damage,
              outcome: info.outcome,
            });
          }
        },
        // Per-mob damage floor: the active guild contract's "min 3m dmg"
        // rule (plus any MOB_MIN_DAMAGE settings) — mobs below their floor's
        // reach are skipped, fights report floorMet.
        minDamageFor: (name) => minDamageFor(name, { ...this.cfg, questReq: this.questReq || undefined }),
      });
      // Cache the game-reported guild identity for later cycles and mirror
      // it into the panel state. The hub only carries the id — when it
      // CHANGED (the account switched guilds mid-session), the cached
      // tag/name belong to the old guild: mergeGuild drops them and one
      // guild_dash re-probe re-scans the new identity.
      if (result.guild && (result.guild.id || result.guild.tag || result.guild.name)) {
        const prevId = this.sessionGuild && this.sessionGuild.id;
        this.sessionGuild = dungeons.mergeGuild(this.sessionGuild, result.guild);
        if (prevId && this.sessionGuild.id && String(prevId) !== String(this.sessionGuild.id)
          && !this.sessionGuild.tag && !this.sessionGuild.name) {
          try {
            const fresh = await dungeons.fetchOwnGuild(this.client);
            if (fresh) this.sessionGuild = dungeons.mergeGuild(this.sessionGuild, fresh);
          } catch (_) { /* identity refilled by the next scan */ }
          this.lastGuildScanAt = Date.now();
          this.audit('guild_change', {
            account: this.state.emailMasked,
            from: prevId,
            to: this.sessionGuild.id,
            tag: this.sessionGuild.tag || undefined,
            note: 'hub guild id changed — identity rescanned',
          });
        }
        this.mirrorGuild();
      }
      if (result.stopped === 'GUILD_MISMATCH') {
        this.audit('guild_mismatch', {
          account: this.state.emailMasked,
          code: this.account.guildCode,
          found: this.state.guild ? `${this.state.guild.tag || ''} ${this.state.guild.name || ''} #${this.state.guild.id || '?'}`.trim() : 'unknown',
          note: 'dungeon farm skipped — account only attacks its own guild mobs',
        });
      }
      this.state.dungeonRounds++;
      this.state.dungeonKills += result.fights.filter((f) => f.outcome === 'MOB_DEAD').length;
      // The mob types this account just saw on the dungeon floors — the
      // swarm card's quick-pick chips ("same with dungeon mobs in guild").
      this.state.dungeonMobs = result.mobNames || [];
      this.markAction();
      logger.info(
        `worker ${this.account.nickname}: dungeon — ${result.instances} instances, ` +
        `${result.locations} floors, ${result.looted} looted, ${result.fights.length} fights` +
        `${result.flooredSkipped ? `, ${result.flooredSkipped} below-floor skipped` : ''}` +
        `${result.stopped ? `, stopped: ${result.stopped}` : ''}` +
        `${this.state.guild && this.state.guild.tag ? ` [${this.state.guild.tag}]` : ''}`
      );
      this.audit('dungeon_round', {
        account: this.state.emailMasked,
        instances: result.instances,
        looted: result.looted,
        fights: result.fights.length,
        stopped: result.stopped || undefined,
        cubeSkipped: result.cubeSkipped || undefined,
        notes: (result.notes || []).slice(0, 4),
      });
      return result;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: dungeon cycle skipped (${e.message})`);
      return null;
    }
  }

  // Reaction stamina farm batch (postreaction.php): a few chapters per cycle
  // while stamina is below max. Counters live in worker state (per session).
  async maybeReactionFarm() {
    const rf = this.cfg.reactionFarm;
    if (!rf.enabled || rf.batchPerCycle <= 0) return null;
    const stam = this.state.vitals.stamina;
    if (stam && stam.max && stam.cur >= stam.max) return null; // bar already full
    if (rf.targetStamina && stam && stam.cur >= rf.targetStamina) return null;
    const counters = {
      day: this.state.reactions.day,
      reacts: this.state.reactions.reacts,
      gained: this.state.reactions.gained,
      last: null,
      lastAt: 0,
      capHit: this.state.reactions.capHit,
      noGain: 0,
    };
    const report = await reactions.staminaFarmBatch(this.client, {
      reaction: rf.reaction,
      batch: rf.batchPerCycle,
      counters,
      dailyCap: rf.dailyCap,
      targetStamina: rf.targetStamina,
      checkEvery: rf.checkEvery,
      noGainStop: rf.noGainStop,
      staminaFn: async () => {
        const res = await this.client.get('/game_dash.php', { redirect: 'manual' });
        return this.client.lastStamina; // scanVitals folds the top bar in
      },
    });
    this.state.reactions = {
      day: counters.day,
      reacts: counters.reacts,
      gained: counters.gained,
      batches: this.state.reactions.batches + 1,
      capHit: !!counters.capHit,
      lastStop: report.stopped || null,
      notLogged: report.notLogged || undefined,
    };
    this.markAction();
    if (report.added > 0 || report.stopped) {
      logger.info(
        `worker ${this.account.nickname}: reaction farm +${report.added} ` +
        `(day total ${counters.reacts} reacts, +${counters.gained} stamina)` +
        `${report.stopped ? ` · ${report.stopped}` : ''}`
      );
      this.audit('reaction_farm', {
        account: this.state.emailMasked,
        added: report.added,
        reacted: report.reacted,
        dayReacts: counters.reacts,
        dayGained: counters.gained,
        stopped: report.stopped || undefined,
      });
    }
    return report;
  }

  // Dead-boss corpse sweep (loot.php instance_id='0' + dgmid, the LevelUp
  // Looter's wave loot request). Triggers (smart mode):
  //   dry     — stamina fully used up
  //   low     — stamina <= corpseStaminaBelow (the script's autoloot
  //             threshold, default 10)
  //   nearLevel — EXP ≥ corpseExpNearPct% (a level-up refills stamina)
  async maybeCorpseSweep() {
    const cl = this.cfg.corpseLoot;
    if (!cl || cl.mode === 'off') return null;
    const stam = this.state.vitals.stamina;
    const dry = !!(stam && stam.cur <= 0);
    const low = !!(stam && cl.corpseStaminaBelow > 0 && stam.cur <= cl.corpseStaminaBelow);
    const nearLevel = this.state.exp.percent != null
      && this.state.exp.percent >= cl.corpseExpNearPct;
    if (cl.mode !== 'always' && !dry && !low && !nearLevel) return null;

    const requiredExp = nearLevel ? Math.max(0, this.state.exp.requiredExp || 0) : 0;
    const { corpses: list } = await corpses.scanCorpses(this.client, this.cfg.wavePages || []);
    if (!list.length) return { looted: 0, expGained: 0 };
    const result = await corpses.lootCorpses(this.client, this.state.userId, list, {
      maxLoot: cl.maxPerSweep,
      requiredExp,
      fastTest: this.cfg.fastTest,
    });
    this.state.corpseSweeps++;
    this.state.corpsesLooted += result.looted;
    this.markAction();
    logger.info(
      `worker ${this.account.nickname}: corpse sweep — ${result.looted} looted ` +
      `(+${result.expGained} EXP${result.leveledUp ? ', level-up covered' : ''}, ${result.skipped} skipped)`
    );
    this.audit('corpse_sweep', {
      account: this.state.emailMasked,
      looted: result.looted,
      exp: result.expGained,
      skipped: result.skipped,
      leveledUp: result.leveledUp || undefined,
      trigger: dry ? 'stamina_dry' : low ? 'stamina_low' : 'near_level',
    });
    // Post-level-up step (the LevelUp Looter's applyPostLevelUpPotions):
    // a level-up means bigger auto-battle potion budgets are affordable.
    if (result.leveledUp) {
      await this.maybeRaisePotionCaps();
    }
    // The EXP poll refreshes the gap; a level-up would refill stamina.
    return result;
  }

  // Raise the wave page's "Max Large/Full Stamina Potions to use" by the
  // configured POTION_CAP_RAISE amounts (best-effort, audited).
  async maybeRaisePotionCaps() {
    const plan = this.cfg.potionCapRaise;
    if (!plan || (!plan.fsp && !plan.lsp)) return null;
    const applied = {};
    for (const kind of ['fsp', 'lsp']) {
      if (!plan[kind]) continue;
      try {
        const r = await shop.raiseAutoBattlePotionCap(this.client, kind, plan[kind]);
        applied[kind] = r.ok ? `${r.from}→${r.to}` : r.reason || 'failed';
      } catch (e) {
        applied[kind] = e.message;
      }
    }
    logger.info(`worker ${this.account.nickname}: potion caps after level-up — ${JSON.stringify(applied)}`);
    this.audit('potion_cap_raise', { account: this.state.emailMasked, applied });
    return applied;
  }

  // Blacksmith crafter (Divers' gear keep-up): sweep every gate, forge every
  // recipe the page marks craftable (the materials come from wave hunting),
  // then clear the equip cooldown so the new gear is worn immediately.
  async maybeBlacksmith() {
    const bs = this.cfg.blacksmith;
    if (!bs || !bs.enabled || this.role === 'admin') return null;
    if (Date.now() - this.lastBlacksmithAt < bs.cooldownMs) return null;
    this.lastBlacksmithAt = Date.now();
    try {
      const report = await blacksmith.blacksmithRound(this.client, { maxCrafts: bs.maxCrafts });
      this.state.blacksmith.checkedAt = Date.now();
      this.state.blacksmith.lastReport = report;
      if (report.crafted.length) {
        this.state.blacksmith.crafted += report.crafted.length;
        logger.info(`worker ${this.account.nickname}: blacksmith — forged ${report.crafted.length} item(s): ` +
          report.crafted.map((c) => c.name).join(', '));
        this.audit('blacksmith_craft', {
          account: this.state.emailMasked,
          crafted: report.crafted,
          refused: report.refused,
          scanned: report.scanned,
          craftable: report.craftable,
        });
        this.lastEquipAt = 0; // new gear → equip-best runs on the next hook
        this.markAction();
      }
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: blacksmith round failed (${e.message})`);
      return null;
    }
  }

  // Equip-best (Divers' gear keep-up): parse inventory.php, wear every
  // strictly-better bag item (inventory_ajax.php equip_item — the game's own
  // modal call). Runs after crafting and on its own cooldown.
  async maybeEquipBest() {
    const eq = this.cfg.equip;
    if (!eq || !eq.enabled || this.role === 'admin') return null;
    if (Date.now() - this.lastEquipAt < eq.cooldownMs) return null;
    this.lastEquipAt = Date.now();
    try {
      // Counter-element preference: while a swarm runs, wear gear whose
      // element COUNTERS the mob the fleet is on right now (the swarm intel
      // carries the mob's element from the battle-page's stats modal).
      let preferElements = [];
      if (this.swarm && typeof this.swarm.armed === 'function' && this.swarm.armed()) {
        const t = this.swarm.currentTarget();
        const intel = t && this.swarm.intelFor(t.key);
        const mobEl = intel && damage.normalizeElement(intel.element);
        if (mobEl) preferElements = damage.counterOf(mobEl);
      }
      const report = await equip.equipBest(this.client, {
        set: eq.set,
        atkWeight: eq.atkWeight,
        defWeight: eq.defWeight,
        maxEquips: eq.maxEquips,
        preferElements,
      });
      this.state.equip.checkedAt = Date.now();
      if (report.equipped) {
        this.state.equip.equipped += report.equipped;
        this.state.equip.lastReport = report;
        logger.info(`worker ${this.account.nickname}: equip-best — wore ${report.equipped} upgrade(s): ` +
          report.improved.map((i) => `${i.slot} → ${i.to}`).join(', '));
        this.audit('equip_best', {
          account: this.state.emailMasked,
          set: report.set,
          equipped: report.equipped,
          improved: report.improved,
          skipped: report.skipped,
        });
        this.markAction();
      }
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: equip-best failed (${e.message})`);
      return null;
    }
  }

  // Potion shop buy-all (Veyra stamina buy-all). Trigger: the stamina ladder
  // came up dry while stamina is low — restock every shop once per cooldown.
  // POTION_BUY_KINDS (default stamina,hp,mana) picks the merchant kinds: the
  // hunt ladders drink stamina, HP and mana, so the sweep keeps all three
  // stocked with the same gold budget.
  async maybeBuyPotions() {
    const pb = this.cfg.potionBuy;
    if (!pb || !pb.enabled) return null;
    if (Date.now() - this.lastBuyAt < pb.cooldownMs) return null;
    const stam = this.state.vitals.stamina;
    const low = !!(stam && stam.max && stam.cur < stam.max * 0.5);
    if (!this.ladderDry && !low) return null;
    this.lastBuyAt = Date.now();
    try {
      const summary = await shop.buyAllStaminaPotions(this.client, { fastTest: this.cfg.fastTest, kinds: pb.kinds });
      if (summary.bought > 0) {
        this.state.purchases++;
        this.state.potionsBought += summary.bought;
        this.ladderDry = false; // restocked
        logger.info(
          `worker ${this.account.nickname}: potion buy-all — ${summary.bought} potions ` +
          `(merchant ${summary.merchant.bought}, guild ${summary.guild.bought}, damon ${summary.damon.bought})`
        );
        this.audit('potion_purchase', {
          account: this.state.emailMasked,
          bought: summary.bought,
          spent: summary.spent,
          merchant: summary.merchant.bought,
          guild: summary.guild.bought,
          damon: summary.damon.bought,
        });
      }
      return summary;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: potion buy-all failed (${e.message})`);
      return null;
    }
  }

  async cycle() {
    // Global pause (POST /api/farm {enabled:false}): hold positions, keep the
    // session warm, keep the dashboard's last-action age fresh.
    if (!this.isFarmEnabled()) {
      await this.client.pace(800, 2000);
      this.markAction();
      await this.scanGuild();
      await this.maybePollExp();
      await this.maybeAutoAllocate();
      return;
    }

    await this.scanGuild();

    // ── SWARM ATTACK (checkbox swarm) ──────────────────────────────────────
    // An armed swarm job owns the fleet, ONE queued mob at a time: wave
    // targets are fought right here (join + slash by mob id until this
    // account's quota is banked), dungeon targets route into dungeonCycle()
    // through the swarm filter. Accounts that already met their quota fall
    // through to the normal farm while the rest of the fleet catches up —
    // the queue only advances when EVERY live account has its share.
    // The built-in fetcher never swarms: its stamina belongs to fetching.
    if (this.swarm && this.swarm.armed() && this.role !== 'admin') {
      const cur = this.swarm.currentTargetView();
      if (cur && cur.kind === 'dungeon') {
        if (this.cfg.dungeon.enabled) {
          await this.dungeonCycle(); // the swarm filter drives it
          await this.postCycleHooks();
          return;
        }
        logger.warn(`worker ${this.account.nickname}: swarm dungeon target queued but the dungeon farm is disabled — running the normal farm`);
      } else if (await this.swarmRound()) {
        await this.postCycleHooks();
        return;
      }
    }

    const snapshot = this.bus.snapshot();
    const target = this.pickBossTarget(snapshot);

    if (target) {
      this.state.runningBoss = `${target.boss.name} (mob ${target.monsterId})`;
      logger.info(`worker ${this.account.nickname}: attacking ${target.boss.name} (mob ${target.monsterId}, cap ${target.cap})`);
      const result = await combatLoop({
        game: this.client,
        userId: this.state.userId,
        monsterId: target.monsterId,
        cap: target.cap,
        boss: target.boss,
        level: this.state.level,
        onEvent: (msg) => logger.debug(`worker ${this.account.nickname}: ${msg}`),
        savedIdsByCategory: null,
      });
      this.state.bossHits++;
      this.markAction({ runningBoss: null });
      logger.info(`worker ${this.account.nickname}: ${target.boss.name} → ${result}`);
      this.audit('boss_result', { account: this.state.emailMasked, boss: target.boss.name, result });
      this.doneBossKeysThisCycle.add(target.key);
      // saveBossMonsterId: cap reached (FINISHED) or mob not attackable
      // (DEAD) — this instance is handled for the session. A NEW mob id on
      // the same boss key re-arms it automatically.
      if (result === 'FINISHED' || result === 'DEAD') {
        this.handledBossMobs.set(target.key, String(target.monsterId));
      }
      if (result === 'AUTO_FARM_ON') {
        await this.fixAutoFarmOn('boss fight');
      }
      if (result === 'OUT_OF_STAMINA') {
        // Mark all keys done for a while — this worker needs resources.
        for (const k of Object.keys(snapshot.bosses)) this.doneBossKeysThisCycle.add(k);
        if (this.role !== 'admin') await this.maybeCorpseSweep(); // free EXP while the bar refills
      }
      await this.postCycleHooks();
      return;
    }

    // No boss for this account → farm. The precision engine joins and
    // slashes the wave mobs itself under the strict per-mob damage cap. The
    // game's own auto-farm (autoFarmPanel / auto_farm_actions.php) is never
    // used for anything. The admin fetcher farms the SAME registry it
    // broadcasts — fetching and joining its own battles is its whole job.
    await this.precisionWaveCycle();
    if (this.cfg.dungeon.enabled && this.role !== 'admin') {
      await this.dungeonCycle();
    }
    await this.postCycleHooks();
  }

  // Vitals & side-farm hooks — run at the END of every cycle, boss or wave
  // branch alike, so a live boss target never starves the rest of the farm.
  // The admin fetcher stays lean: EXP/stat visibility + vitals potions only
  // (it fetches and joins battles — side farms are the users' accounts' job).
  // Achievement + collection claim sweep (claims.js). Both pages cost one
  // GET each; the claim POSTs only fire for cards the game rendered ready.
  // Throttled by CLAIMS_COOLDOWN_MS — achievements are earned slowly.
  async maybeClaims() {
    const c = this.cfg.claims;
    if (!c || !c.enabled) return null;
    if (Date.now() - this.lastClaimsAt < c.cooldownMs) return null;
    this.lastClaimsAt = Date.now();
    try {
      const report = await claims.claimsRound(this.client, { fastTest: this.cfg.fastTest });
      this.state.claims.checkedAt = Date.now();
      this.state.claims.claimed += report.claimed;
      this.state.claims.lastReport = {
        achievements: report.achievements.ids.length,
        collections: report.collections.ids.length,
        claimed: report.claimed,
        failed: report.failed,
        messages: [...report.achievements.messages, ...report.collections.messages].slice(0, 6),
      };
      if (report.claimed > 0 || report.failed > 0) {
        logger.info(
          `worker ${this.account.nickname}: claims — ${report.claimed} claimed` +
          ` (${report.failed} refused) · achievements: ${report.achievements.ids.length}, collections: ${report.collections.ids.length}`
        );
        this.audit('claims_sweep', {
          account: this.state.emailMasked,
          claimed: report.claimed,
          failed: report.failed,
          achievements: report.achievements.ids,
          collections: report.collections.ids,
        });
      }
      this.markAction();
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: claim sweep failed (${e.message})`);
      return null;
    }
  }

  // Adventurers Guild contract round (quests.js): finish what the wave farm
  // completed, donate gather items when QUESTS_DONATE=1, accept the next
  // kill contract. One GET per round; throttled by QUESTS_COOLDOWN_MS.
  // Kill contracts need a CLASS — without one there is no damage skill, so
  // "min 3m dmg" floors can never be met and the contract slot would stall
  // forever. While the account is classless the accepts are held (turn-ins
  // and donations still run); the class picker binds a class at level 200+
  // and accepts resume on their own. Gather contracts stay available to
  // classless accounts, so an already-active gather contract is untouched.
  async maybeGuildQuests() {
    const gq = this.cfg.guildQuests;
    if (!gq || !gq.enabled) return null;
    if (Date.now() - this.lastQuestsAt < gq.cooldownMs) return null;
    this.lastQuestsAt = Date.now();
    const classless = !!(this.state.classInfo && this.state.classInfo.classless === true);
    try {
      const report = await quests.guildQuestRound(this.client, {
        accept: gq.accept && !classless,
        donate: gq.donate,
        fastTest: this.cfg.fastTest,
      });
      this.state.quests.checkedAt = Date.now();
      this.state.quests.lastReport = report;
      if (classless && report.available) {
        report.notes.push(`accepts held while classless (${report.available} contract(s) on the board)`);
      }
      // The active contract's requirement — a kill contract with "min 3m dmg"
      // arms the per-mob damage floor for its monster. Turn-ins clear it; the
      // next round re-arms from whatever the board shows then.
      if (report.requirement && report.requirement.kind === 'kill' && report.requirement.monster) {
        this.questReq = report.requirement;
      } else if (report.finished) {
        // Contract done — clear the floor, the hunt pin state and this
        // session's probe memory for that monster (the map itself keeps the
        // wave knowledge for the NEXT contract of the same mob).
        if (this.questReq && this.questReq.monster) {
          this.huntProbes.delete(hunt.normalizeName(this.questReq.monster));
        }
        this.questReq = null;
        this.state.quests.huntInfo = null;
      }
      this.state.quests.questReq = this.questReq;
      if (this.questReq) {
        logger.info(
          `worker ${this.account.nickname}: contract floor armed — ${this.questReq.title || 'quest'}: ` +
          `${this.questReq.kills}× ${this.questReq.monster} with ≥ ${(this.questReq.minDamage || 0).toLocaleString('en-US')} dmg each`
        );
      }
      if (report.finished) {
        this.state.quests.finished++;
        logger.info(`worker ${this.account.nickname}: guild contract finished — ${report.finished.title || report.finished.id} (${report.finished.message})`);
        this.audit('guild_quest_finished', { account: this.state.emailMasked, ...report.finished });
      }
      if (report.donated.length) {
        this.state.quests.donated += report.donated.length;
        logger.info(`worker ${this.account.nickname}: guild contract donated ${report.donated.length} item(s)`);
        this.audit('guild_quest_donated', { account: this.state.emailMasked, items: report.donated });
      }
      if (report.accepted && report.accepted.ok) {
        this.state.quests.accepted++;
        logger.info(`worker ${this.account.nickname}: guild contract accepted — ${report.accepted.title} (${report.accepted.objective || 'no objective'})`);
        this.audit('guild_quest_accepted', { account: this.state.emailMasked, quest: report.accepted });
      }
      this.markAction();
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: guild quest round failed (${e.message})`);
      return null;
    }
  }

  // Event daily contracts (events.js): dashboard → live events → sanctuary
  // board. The hunting contracts fill from normal farming + kill loots; the
  // engine submits the ready dispatch choices and audits the board state.
  // Throttled by EVENT_DAILIES_COOLDOWN_MS; a day with no live event no-ops.
  async maybeEventDailies() {
    const ed = this.cfg.eventDailies;
    if (!ed || !ed.enabled) return null;
    if (Date.now() - this.lastEventsAt < ed.cooldownMs) return null;
    this.lastEventsAt = Date.now();
    try {
      const report = await events.eventDailiesRound(this.client, { fastTest: this.cfg.fastTest });
      this.state.events.checkedAt = Date.now();
      const submitted = report.events.reduce((n, e) => n + e.submitted.filter((s) => s.ok).length, 0);
      const boards = report.events.filter((e) => e.board);
      this.state.events.submitted += submitted;
      this.state.events.lastReport = {
        events: report.events.map((e) => ({
          id: e.id,
          board: e.board ? { title: e.board.title, cards: e.board.cards.length, wallet: e.board.wallet } : null,
          submitted: e.submitted,
          notes: e.notes,
        })),
        submitted,
      };
      if (submitted > 0) {
        logger.info(`worker ${this.account.nickname}: event dailies — ${submitted} dispatch contract(s) submitted`);
        this.audit('event_dispatch', { account: this.state.emailMasked, submitted });
      }
      if (boards.length) {
        for (const e of boards) {
          logger.debug(`worker ${this.account.nickname}: event ${e.id} board "${e.board.title}" — ${e.board.cards.length} contracts tracked`);
        }
        this.audit('event_board', {
          account: this.state.emailMasked,
          boards: boards.map((e) => ({ id: e.id, title: e.board.title, cards: e.board.cards.map((c) => ({ title: c.title, label: c.label })) })),
        });
      }
      this.markAction();
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: event dailies failed (${e.message})`);
      return null;
    }
  }

  // Battle Pass round (battlepass.js): read battle_pass.php, claim every
  // ready reward, and — while the season's damage quest ("deal 300,000
  // damage to Lizard/Sea mobs") is open — arm the wave-steering keywords.
  // No season live (the current state) or season ended → a clean no-op that
  // also clears any stale hint, so farming goes back to plain round-robin.
  // Throttled by BATTLE_PASS_COOLDOWN_MS.
  async maybeBattlePass() {
    const bp = this.cfg.battlePass;
    if (!bp || !bp.enabled) return null;
    if (Date.now() - this.lastBattlePassAt < bp.cooldownMs) return null;
    this.lastBattlePassAt = Date.now();
    try {
      const report = await battlepass.battlePassRound(this.client);
      this.state.battlePass.checkedAt = Date.now();
      this.state.battlePass.active = report.active;
      this.state.battlePass.lastReport = {
        active: report.active,
        quests: report.quests.map((q) => ({ title: q.title, objective: q.objective, progress: q.progress })),
        claimed: report.claimed,
        messages: report.messages.slice(0, 6),
        notes: report.notes,
      };
      this.state.battlePass.claimed += report.claimed;
      const hint = report.active && report.hint && report.hint.incomplete && report.hint.keywords.length
        ? { keywords: report.hint.keywords, needDamage: report.hint.needDamage, needKills: report.hint.needKills, at: Date.now() }
        : null;
      const hintChanged = JSON.stringify(hint && hint.keywords) !== JSON.stringify(this.bpHint && this.bpHint.keywords);
      this.bpHint = hint;
      if (report.claimed > 0) {
        logger.info(`worker ${this.account.nickname}: battle pass — ${report.claimed} reward(s) claimed`);
        this.audit('battle_pass_claim', { account: this.state.emailMasked, claimed: report.claimed, messages: report.messages });
      }
      if (hint && hintChanged) {
        logger.info(`worker ${this.account.nickname}: battle pass quest open — wave priority on [${hint.keywords.join(', ')}]` +
          `${hint.needDamage ? ` · ${hint.needDamage.toLocaleString('en-US')} damage needed` : ''}`);
        this.audit('battle_pass_hint', { account: this.state.emailMasked, keywords: hint.keywords, needDamage: hint.needDamage, needKills: hint.needKills });
        this.bpWaveMemory.clear(); // new keywords → the old wave memory is stale
      } else if (!hint && this.bpWaveMemory.size) {
        this.bpWaveMemory.clear(); // quest done or season over → plain round-robin
      }
      this.markAction();
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: battle pass round failed (${e.message})`);
      return null;
    }
  }

  // Class system round (classes.js): every account farms fine without a
  // class (waves, bosses, all dailies) — this only ADDS the optimal starting
  // class the moment the game allows one (level ≥ 200, still classless).
  // The per-account classPick policy wins over the env default; 'off' is
  // always respected because the game's choice is PERMANENT. Throttled by
  // CLASS_COOLDOWN_MS — a level-up pick happens within that window.
  async maybeClassPick() {
    const cp = this.cfg.classPick;
    if (!cp) return null;
    const pref = this.account.classPick || cp.pref;
    if (pref === 'off' || !cp.enabled) return null;
    if (Date.now() - this.lastClassPickAt < cp.cooldownMs) return null;
    this.lastClassPickAt = Date.now();
    try {
      const report = await classes.ensureClass(this.client, { pick: pref, minLevel: cp.minLevel });
      this.state.classInfo = {
        checkedAt: report.checkedAt,
        currentClass: report.currentClass || (report.picked && report.picked.ok ? report.picked.name : null),
        classless: report.classless,
        level: report.level,
        action: report.action,
        lastReport: { action: report.action, picked: report.picked, notes: report.notes, at: report.checkedAt },
      };
      if (report.action === 'picked') {
        logger.info(`worker ${this.account.nickname}: class picked — ${report.picked.name} (${classes.rationale(report.picked.key)})`);
        this.audit('class_picked', { account: this.state.emailMasked, class: report.picked.key, level: report.level });
      } else if (report.action === 'low-level') {
        logger.info(`worker ${this.account.nickname}: class pick waiting — level ${report.level} < ${cp.minLevel}`);
      } else if (report.action === 'failed') {
        this.markError('class pick failed — will retry');
      }
      this.markAction();
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: class round failed (${e.message})`);
      return null;
    }
  }

  // Class skill tree round (skilltree.js): spend Adv. Points on the bound
  // class's tree — unlock the damage skills first (Mage Fireball is FREE),
  // level them by damage-per-stamina, then everything else. Runs AFTER the
  // class round in the same cycle so a fresh pick upgrades on its very next
  // hook pass; classless accounts no-op inside the module (no tree page).
  // Throttled by SKILL_TREE_COOLDOWN_MS — AP income is quest-paced, so an
  // idle wallet costs one cheap page GET per cooldown.
  async maybeSkillTree() {
    const st = this.cfg.skillTree;
    if (!st || !st.enabled) return null;
    if (Date.now() - this.lastSkillTreeAt < st.cooldownMs) return null;
    this.lastSkillTreeAt = Date.now();
    try {
      const report = await skilltree.upgradeRound(this.client, {
        reserve: st.reserve,
        maxSpends: st.maxSpends,
        level: (this.state.classInfo && this.state.classInfo.level) || 0,
      });
      this.state.skillTree.checkedAt = report.checkedAt;
      this.state.skillTree.className = report.className || this.state.skillTree.className;
      this.state.skillTree.points = report.pointsLeft;
      this.state.skillTree.unlocked += report.unlocked.length;
      this.state.skillTree.leveled += report.leveled.length;
      this.state.skillTree.lastReport = {
        action: report.spent ? 'upgraded' : 'checked',
        unlocked: report.unlocked, leveled: report.leveled,
        refused: report.refused, skipped: report.skipped,
        pointsStart: report.pointsStart, pointsLeft: report.pointsLeft,
        notes: report.notes, at: report.checkedAt,
      };
      if (report.spent) {
        logger.info(`worker ${this.account.nickname}: skill tree — ${skilltree.summarize(report)} (AP ${report.pointsStart} → ${report.pointsLeft})`);
        this.audit('skill_tree_upgrade', {
          account: this.state.emailMasked,
          class: report.className,
          unlocked: report.unlocked, leveled: report.leveled,
          pointsLeft: report.pointsLeft,
        });
      }
      this.markAction();
      return report;
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: skill tree round failed (${e.message})`);
      return null;
    }
  }

  async postCycleHooks() {
    // Each hook is timed: a hook that quietly eats minutes shows up in the
    // debug log instead of silently stalling the whole cycle.
    const runHook = async (name, fn) => {
      const t0 = Date.now();
      logger.debug(`worker ${this.account.nickname}: hook ${name} enter`);
      try {
        await fn();
      } catch (e) {
        logger.debug(`worker ${this.account.nickname}: hook ${name} threw: ${e.message}`);
      }
      const ms = Date.now() - t0;
      if (ms > 8000) logger.debug(`worker ${this.account.nickname}: hook ${name} took ${(ms / 1000).toFixed(1)}s`);
    };
    await runHook('maybePollExp', () => this.maybePollExp());
    await runHook('maybeAutoAllocate', () => this.maybeAutoAllocate());
    if (this.role === 'admin') {
      await runHook('maybeAutoPotion', () => this.maybeAutoPotion());
      return;
    }
    await runHook('maybeReactionFarm', () => this.maybeReactionFarm());
    await runHook('maybeCorpseSweep', () => this.maybeCorpseSweep()); // smart trigger: dry bar / near level-up
    await runHook('maybeBuyPotions', () => this.maybeBuyPotions());
    // Gear keep-up: forge what the wave drops made craftable, then wear the
    // best items (maybeBlacksmith clears the equip cooldown when it crafts).
    await runHook('maybeBlacksmith', () => this.maybeBlacksmith());
    await runHook('maybeEquipBest', () => this.maybeEquipBest());
    await runHook('maybeAutoPotion', () => this.maybeAutoPotion());
    // Class state FIRST (fills state.classInfo — the guild-contract accepts
    // are held while classless, and the tree needs the bound class), then
    // the tree, then the missed-game sweep: achievements/collections claims,
    // Adventurers Guild contracts, event daily contracts, battle pass.
    // Each is internally throttled (one cheap GET when idle) and audited, so
    // the cycle stays lean.
    await runHook('maybeClassPick', () => this.maybeClassPick());
    await runHook('maybeSkillTree', () => this.maybeSkillTree());
    await runHook('maybeClaims', () => this.maybeClaims());
    await runHook('maybeGuildQuests', () => this.maybeGuildQuests());
    await runHook('maybeEventDailies', () => this.maybeEventDailies());
    await runHook('maybeBattlePass', () => this.maybeBattlePass());
    await runHook('maybePvp', () => this.maybePvp());
  }

  // PvP season ladder round (pvp.js — Divers pillar 3): read the board, then
  // matchmake ONLY while the season is open and tokens remain. A closed
  // season (the live state 2026-11-22) is a clean no-op that still reports
  // tier/tokens/rank so the panel shows the season's real state.
  async maybePvp() {
    const c = this.cfg.pvp;
    if (!c || !c.enabled) return;
    if (Date.now() - (this.lastPvpAt || 0) < c.cooldownMs) return;
    this.lastPvpAt = Date.now();
    try {
      const report = await pvp.pvpRound(this.client, { ladder: c.ladder, maxMatches: c.maxMatches });
      const p = report.parsed || {};
      this.state.pvp.checkedAt = Date.now();
      if (p.season != null) this.state.pvp.season = p.season;
      if (p.tier != null) this.state.pvp.tier = p.tier;
      if (p.tokens != null) this.state.pvp.tokens = p.tokens;
      if (p.rank != null) this.state.pvp.rank = p.rank;
      this.state.pvp.closed = report.stopped || null;
      if (report.matches) {
        this.state.pvp.matches += report.matches;
        const last = report.results[report.results.length - 1];
        if (last && last.shape) this.state.pvp.lastBattle = last.shape.title || (last.shape.isBattle ? 'battle page' : 'unknown page');
        logger.info(`worker ${this.account.nickname}: pvp — ${report.matches} match(es) made` +
          `${this.state.pvp.lastBattle ? ` → ${this.state.pvp.lastBattle}` : ''}`);
        this.audit('pvp_match', { account: this.state.emailMasked, matches: report.matches, ladder: c.ladder });
        this.markAction();
      } else if (report.stopped) {
        logger.debug(`worker ${this.account.nickname}: pvp — season state: ${report.stopped}`);
      }
    } catch (e) {
      logger.debug(`worker ${this.account.nickname}: pvp round failed (${e.message})`);
    }
  }

  async loop() {
    let consecutiveErrors = 0;
    while (!this.stopFlag) {
      try {
        if (!this.state.userId || this.state.status !== 'running') {
          await this.ensureLogin();
        }
        await this.cycle();
        consecutiveErrors = 0;
        this.doneBossKeysThisCycle.clear();
        const pause = this.cfg.fastTest
          ? jitter(this.cfg.cycleMinMs, this.cfg.cycleMaxMs, 1)
          : jitter(this.cfg.cycleMinMs, this.cfg.cycleMaxMs, this.cfg.jitterScale);
        await sleep(pause);
      } catch (e) {
        consecutiveErrors++;
        this.markError(e.message);
        logger.warn(`worker ${this.account.nickname}: cycle error (${consecutiveErrors}): ${e.message}`);
        if (consecutiveErrors === 3) {
          // One-shot per error streak — feeds the dashboard / Discord ping.
          this.audit('account_degraded', { account: this.state.emailMasked, errors: consecutiveErrors, error: e.message });
        }
        if (this.sessionLooksDead(null) || /login|logged/i.test(e.message)) {
          if (this.state.status === 'running') {
            // The game ended this session (kicked / expired / banned).
            this.audit('session_lost', { account: this.state.emailMasked, error: e.message });
          }
          this.state.userId = null;
          this.state.status = 'logged_out';
        }
        const backoff = Math.min(
          5 * 60 * 1000,
          (this.cfg.fastTest ? 2000 : 15000) * consecutiveErrors
        );
        await sleep(this.cfg.fastTest ? backoff : jitter(backoff * 0.8, backoff * 1.3, 1));
      }
    }
  }
}

class WorkerManager {
  constructor({ store, cfg, bosses, caps, bossCategories, audit }) {
    this.store = store;
    this.cfg = cfg;
    this.bosses = bosses;
    this.caps = caps;
    this.bossCategories = bossCategories;
    this.audit = audit;
    this.workers = new Map(); // id -> AccountWorker
    this.farmEnabled = true;
    // One context per game site: its own target bus, fetcher (scout) and
    // gate/wave list. Sites run side by side, fully independent — a stalled
    // login or a slow sweep on one site never holds up the other.
    this.sites = new Map(); // siteKey -> {key,label,cfg,bus,scout,adminAccountId,scoutClientGetter,started}
    // Every built-in fetcher account id (one per site).
    this.adminIds = new Set();
    // data/farm.json (no secrets): which account is the fetcher, per site.
    this.settingsFile = path.join(store.dir, 'farm.json');
  }

  persistFarmSettings() {
    const ids = {};
    for (const [key, ctx] of this.sites) ids[key] = ctx.adminAccountId;
    const tmp = this.settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      scoutAccountId: ids[this.cfg.defaultSite] || null, // legacy single-site key
      scoutAccountIds: ids,
    }, null, 2));
    fs.renameSync(tmp, this.settingsFile);
  }

  // ── Sites ──────────────────────────────────────────────────────────────────
  // ensureSite() builds a site's context (own bus, own scout, own fetcher)
  // the first time it is needed; startSite() then launches its workers.
  ensureSite(key) {
    let ctx = this.sites.get(key);
    if (ctx) return ctx;
    const def = this.cfg.siteByKey(key);
    if (!def) throw new Error(`unknown site "${key}"`);
    // A view of the config for THIS site: same settings, but its own base URL
    // and gate/wave list. Everything that reads cfg.gameBase / cfg.wavePages
    // (clients, scout, corpse + shop sweeps) automatically targets the site.
    const siteCfg = Object.assign(Object.create(this.cfg), {
      gameBase: def.base, wavePages: def.wavePages, siteKey: key,
    });
    const bus = new TargetBus({
      dataDir: this.store.dir,
      fileName: key === this.cfg.defaultSite ? 'targets.json' : `targets-${key}.json`,
    });
    // The site's swarm-attack coordinator (checkbox swarm): one ordered
    // queue per site, persisted next to the bus so a restart resumes the job.
    const swarm = new SwarmCoordinator({
      dataDir: this.store.dir,
      fileName: key === this.cfg.defaultSite ? 'swarm.json' : `swarm-${key}.json`,
      bus,
    });
    ctx = {
      key, label: def.label, cfg: siteCfg, bus, swarm,
      scout: null, adminAccountId: null, scoutClientGetter: null, started: false,
    };
    ctx.scout = new Scout({
      cfg: siteCfg, bus,
      bosses: this.bosses, bossCategories: this.bossCategories,
      getClient: () => this.getScoutClient(key),
      label: `scout:${key}`,
    });
    this.sites.set(key, ctx);
    this.seedAdminAccount(key);
    return ctx;
  }

  site(key) {
    return this.sites.get(key || this.cfg.defaultSite) || null;
  }

  siteWorkerCount(key) {
    let n = 0;
    for (const w of this.workers.values()) if ((w.account.site || this.cfg.defaultSite) === key) n++;
    return n;
  }

  // Launch every stored account of one site (its fetcher first), then its
  // scout. Idempotent. Each site numbers its own workers from 0, so login
  // staggering never makes one site queue behind the other.
  startSite(key) {
    const ctx = this.ensureSite(key);
    if (ctx.started) return ctx;
    ctx.started = true;
    const rows = this.store.internalRows().filter((r) => r.site === key);
    rows.sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1));
    rows.forEach((row) => this.launch(row, this.siteWorkerCount(key)));
    this.buildScoutGetter(key);
    ctx.scout.start();
    return ctx;
  }

  // ── The built-in admin fetcher (one per site) ────────────────────────────
  // Seed (or refresh) the engine's own game account for a site: hidden from
  // every panel/API listing, encrypted like any other row, and pinned as THE
  // fetcher for every account on that site. addAccount() upserts by
  // (site, email), so a re-seed also refreshes the stored password.
  seedAdminAccount(key) {
    const ctx = this.sites.get(key);
    if (!ctx) return null;
    const f = this.cfg.fetcherFor(key);
    if (!f.email) return null;
    const fresh = !this.store.internalRows().some((r) => r.email === f.email && r.site === key);
    const row = this.store.addAccount({
      nickname: f.nickname || 'core-fetcher',
      email: f.email,
      password: f.password,
      role: 'admin',
      hidden: true,
      site: key,
    });
    ctx.adminAccountId = row.id;
    this.adminIds.add(row.id);
    this.persistFarmSettings();
    if (fresh) {
      this.audit('admin_fetcher_seeded', {
        account: 'built-in fetcher',
        site: key,
        note: 'built-in fetcher ready — hidden from the panel; fetches for every account on this site and joins the battles it broadcasts',
      });
    } else {
      logger.debug(`admin fetcher account re-seeded for ${key} (password/role refreshed, hidden)`);
    }
    return row;
  }

  isAdminAccountId(id) {
    return !!id && this.adminIds.has(id);
  }

  // Start every site that has stored accounts (the default site always runs).
  startAll() {
    const siteKeys = new Set([this.cfg.defaultSite]);
    for (const r of this.store.internalRows()) if (r.site) siteKeys.add(r.site);
    for (const key of siteKeys) {
      if (!this.cfg.siteByKey(key)) {
        logger.warn(`stored accounts reference unknown site "${key}" — skipped`);
        continue;
      }
      this.startSite(key);
    }
  }

  launch(accountRow, index) {
    if (this.workers.has(accountRow.id)) return;
    const siteKey = accountRow.site || this.cfg.defaultSite;
    const ctx = this.ensureSite(siteKey);
    const stored = this.store.find(accountRow.id);
    const worker = new AccountWorker({
      account: {
        id: accountRow.id,
        nickname: accountRow.nickname,
        email: accountRow.email,
        site: siteKey,
        role: accountRow.role,
        hidden: accountRow.hidden,
        guildCode: (stored && stored.guildCode) || accountRow.guildCode || null,
        classPick: (stored && stored.classPick) || accountRow.classPick || null,
        diveTargets: (stored && stored.diveTargets) || accountRow.diveTargets || null,
      },
      store: this.store,
      cfg: ctx.cfg,
      bus: ctx.bus,
      swarm: ctx.swarm,
      bosses: this.bosses,
      caps: this.caps,
      audit: this.audit,
      isFarmEnabled: () => this.farmEnabled,
    });
    worker.maskEmailLater(accountRow.role === 'admin' ? 'built-in fetcher' : maskEmail(accountRow.email));
    this.workers.set(accountRow.id, worker);
    worker.start(index == null ? this.siteWorkerCount(siteKey) - 1 : index).catch((e) => {
      logger.error(`worker ${accountRow.nickname} crashed: ${e.message}`);
      worker.state.status = 'crashed';
      worker.markError(e.message);
    });
    this.audit('worker_started', { account: worker.state.emailMasked, site: siteKey });
  }

  // ── Who may touch which account ──────────────────────────────────────────
  // viewer = {username, role}. The owner sees and controls everything; a
  // normal user only the accounts they added. Rows from before multi-user
  // support have no owner and therefore belong to the owner alone. The
  // built-in fetcher is never accessible to anyone through the API.
  canAccess(viewer, id) {
    if (!viewer || this.isAdminAccountId(id)) return false;
    const row = this.store.find(id);
    if (!row || row.hidden) return false;
    if (viewer.role === 'owner') return true;
    return !!row.owner && row.owner.toLowerCase() === String(viewer.username).toLowerCase();
  }

  async addAccount({ nickname, email, password, site, viewer, guildCode, classPick, diveTargets }) {
    if (!viewer) throw new Error('not signed in');
    const siteKey = String(site || this.cfg.defaultSite);
    if (!this.cfg.siteByKey(siteKey)) throw new Error('unknown site');
    if (this.cfg.fetcherEmails().has(String(email).trim().toLowerCase())) {
      throw new Error('this email cannot be added');
    }
    // First account on a site brings the whole site up (fetcher + scout)
    // BEFORE the row is stored, so it is launched exactly once below.
    // Re-adding an email is "fix my password" — but only for its own person.
    // Without this a friend could overwrite (and thereby hijack) someone
    // else's account just by adding the same email.
    const clash = this.store.findByLogin(email, siteKey);
    if (clash && !this.canAccess(viewer, clash.id)) {
      throw new Error('that game account is already on the farm under another login');
    }
    this.startSite(siteKey);
    const row = this.store.addAccount({ nickname, email, password, site: siteKey, owner: viewer.username, guildCode, classPick, diveTargets });
    const running = this.workers.get(row.id);
    if (running) {
      // Same email added again = "fix my password": the stored password is
      // already replaced, so force a fresh login with it right away. The
      // guild code, class pick and dive targets ride along — new values
      // re-arm them.
      running.account.nickname = row.nickname;
      running.account.guildCode = row.guildCode || null;
      running.account.classPick = row.classPick || null;
      running.account.diveTargets = row.diveTargets || null;
      running.diveTargets = divers.parseDiveTargets(row.diveTargets);
      running.state.dive.targets = running.diveTargets;
      running.sessionGuild = null;
      running.state.guild = null;
      running.state.userId = null;
      running.state.status = 'logged_out';
      running.reloginAfter = 0;
      this.audit('account_updated', { account: maskEmail(row.email), site: siteKey });
    } else {
      this.launch({ id: row.id, nickname: row.nickname, email: row.email, site: siteKey, guildCode: row.guildCode || null, classPick: row.classPick || null, diveTargets: row.diveTargets || null }, this.siteWorkerCount(siteKey));
    }
    this.buildScoutGetter(siteKey);
    this.audit('account_added', { account: maskEmail(row.email), site: siteKey });
    return this.apiRow(row.id);
  }

  async removeAccount(id, viewer) {
    if (viewer && !this.isAdminAccountId(id) && !this.canAccess(viewer, id)) return false;
    if (this.isAdminAccountId(id)) {
      this.audit('account_remove_refused', { reason: 'the built-in fetcher account cannot be removed' });
      return false;
    }
    const worker = this.workers.get(id);
    const row = this.store.internalRows().find((r) => r.id === id);
    if (worker) {
      worker.stop();
      this.workers.delete(id);
    }
    const had = this.store.removeAccount(id);
    this.buildScoutGetter(row ? row.site : undefined);
    this.audit('account_removed', { account: row ? maskEmail(row.email) : id, site: row ? row.site : undefined, existed: had });
    return had;
  }

  async relogin(id, viewer) {
    if (viewer && !this.canAccess(viewer, id)) return false;
    const worker = this.workers.get(id);
    if (!worker) return false;
    worker.state.userId = null;
    worker.reloginAfter = 0;
    worker.state.status = 'logged_out';
    this.audit('relogin_requested', { account: worker.state.emailMasked });
    return true;
  }

  // Patch a running/stopped account's policy: classPick (per-account classes
  // policy) and/or guildCode. The running worker picks the new values up
  // immediately (the class round reads account.classPick every pass; the
  // guild verdict re-verifies on the next dungeon round).
  updateAccount(id, patch, viewer) {
    if (viewer && !this.canAccess(viewer, id)) return { error: 'no_such_account' };
    if (this.isAdminAccountId(id)) return { error: 'the built-in fetcher account is fixed' };
    const row = this.store.updateAccount(id, patch || {});
    if (!row) return { error: 'no_such_account' };
    if (row.error) return row; // store-level validation refusal
    const worker = this.workers.get(id);
    if (worker) {
      worker.account.guildCode = row.guildCode || null;
      worker.account.classPick = row.classPick || null;
      if (patch && patch.guildCode !== undefined) {
        worker.sessionGuild = null; // force the guild verdict to re-verify
      }
      if (patch && patch.diveTargets !== undefined) {
        // Live dive retarget: the next wave round already hunts the new
        // list (waveFarmRound reads the per-round cfg copy).
        worker.account.diveTargets = row.diveTargets || null;
        worker.diveTargets = divers.parseDiveTargets(row.diveTargets);
        worker.state.dive.targets = worker.diveTargets;
      }
    }
    this.audit('account_policy_updated', {
      account: maskEmail(row.email),
      classPick: row.classPick || 'auto',
      guildCode: row.guildCode || null,
      diveTargets: row.diveTargets || null,
    });
    return { account: this.apiRow(id) };
  }

  // ── Fleet hunt (Divers pillar 1, fleet-wide) ────────────────────────────
  // "I want to attack all Troll Ravager" — set the SAME dive targets on every
  // (accessible) account of one site, live: the store rows are patched
  // (survives restarts) and every running worker re-arms its target list on
  // the spot; the very next cycle each account bus-dives the matching live
  // mob ids and keeps hunting the pinned pages. mob=null clears the hunt.
  fleetHunt(site, mob, viewer) {
    const siteKey = String(site || this.cfg.defaultSite);
    if (!this.cfg.siteByKey(siteKey)) return { error: 'unknown_site' };
    const targets = String(mob || '').trim().slice(0, 300) || null;
    let updated = 0;
    const accounts = [];
    for (const row of this.store.internalRows()) {
      if ((row.site || this.cfg.defaultSite) !== siteKey) continue;
      if (row.hidden || this.isAdminAccountId(row.id)) continue;
      const out = this.updateAccount(row.id, { diveTargets: targets }, viewer);
      if (out && !out.error) {
        updated++;
        accounts.push({ id: out.account.id, nickname: out.account.nickname, diveTargets: out.account.diveTargets || null });
      }
    }
    this.audit('fleet_hunt', { site: siteKey, mob: targets, accounts: updated });
    return { ok: true, site: siteKey, mob: targets, updated, accounts };
  }

  // Fleet-hunt view: the mob every accessible account of the site hunts —
  // non-null only when they all share the same list.
  fleetHuntStatus(site, viewer) {
    const siteKey = String(site || this.cfg.defaultSite);
    const perAccount = [];
    for (const row of this.store.internalRows()) {
      if ((row.site || this.cfg.defaultSite) !== siteKey) continue;
      if (row.hidden || this.isAdminAccountId(row.id)) continue;
      if (viewer && !this.canAccess(viewer, row.id)) continue;
      perAccount.push({ id: row.id, nickname: row.nickname, diveTargets: row.diveTargets || null });
    }
    const mobs = new Set(perAccount.map((a) => a.diveTargets || ''));
    const unified = perAccount.length && mobs.size === 1 ? (perAccount[0].diveTargets || null) : null;
    return { ok: true, site: siteKey, mob: unified, perAccount };
  }

  // ── Swarm attack (checkbox swarm, Divers) ────────────────────────────────
  // The user ticks live mobs in the panel, gives each mob TYPE a damage
  // quota and starts the swarm: every account joins the queued mob ids one
  // by one (mob 1 until every account's quota, then mob 2, …) until the
  // queue is empty. Dungeon mobs ride the same queue as mob-type names.
  swarmStart(site, payload, viewer) {
    const siteKey = String(site || this.cfg.defaultSite);
    let ctx;
    try {
      ctx = this.ensureSite(siteKey);
    } catch (_) {
      return { ok: false, error: 'unknown_site' };
    }
    const out = ctx.swarm.start({
      targets: payload && payload.targets,
      mode: payload && payload.mode,
      autoRefill: !!(payload && payload.autoRefill),
      // The site's swarming fleet (every visible non-fetcher account): a
      // member that has not joined yet blocks the advance during the grace
      // window instead of being skipped by its faster fleet-mates.
      roster: this.store.internalRows()
        .filter((r) => (r.site || this.cfg.defaultSite) === siteKey && !r.hidden && !this.isAdminAccountId(r.id))
        .map((r) => ({ id: r.id, nickname: r.nickname })),
    });
    if (out.ok) {
      this.audit('swarm_start', {
        site: siteKey,
        by: (viewer && viewer.username) || 'panel',
        targets: Array.isArray(payload && payload.targets) ? payload.targets.length : 0,
        mode: out.mode,
        autoRefill: out.autoRefill,
        first: out.currentTarget ? (out.currentTarget.name || out.currentTarget.mobId) : null,
      });
    }
    return out;
  }

  swarmStop(site, viewer) {
    const siteKey = String(site || this.cfg.defaultSite);
    const ctx = this.site(siteKey);
    if (!ctx) return { ok: false, error: 'unknown_site' };
    const out = ctx.swarm.stop();
    if (out.ok) {
      this.audit('swarm_stop', { site: siteKey, by: (viewer && viewer.username) || 'panel' });
    }
    return out;
  }

  swarmStatus(site) {
    const siteKey = String(site || this.cfg.defaultSite);
    const ctx = this.site(siteKey);
    return ctx ? ctx.swarm.statusView()
      : { ok: true, armed: false, status: 'idle', mode: 'per_account', targets: [], accounts: [], log: [] };
  }

  // Dungeon mob types the fleet actually SAW on guild dungeon floors — the
  // swarm card's quick-pick chips. Union across the site's workers.
  dungeonMobNames(site) {
    const siteKey = String(site || this.cfg.defaultSite);
    const seen = new Set();
    for (const w of this.workers.values()) {
      if ((w.account.site || this.cfg.defaultSite) !== siteKey) continue;
      for (const n of w.state.dungeonMobs || []) seen.add(n);
    }
    return [...seen].slice(0, 40);
  }

  // Run equip-best on one account NOW (panel button / API). accountId selects
  // the worker; null picks the oldest healthy user account. preferElement(s)
  // (optional) biases scoring toward gear whose element counters the mob.
  async equipNow(accountId, viewer, preferElements) {
    const picked = this.pickUserWorker(accountId, viewer);
    if (picked.error) return { ok: false, reason: picked.error };
    const worker = picked.worker;
    const eq = worker.cfg.equip || {};
    const report = await equip.equipBest(worker.client, {
      set: eq.set || 'attack',
      atkWeight: eq.atkWeight || 3,
      defWeight: eq.defWeight || 1,
      maxEquips: eq.maxEquips || 8,
      preferElements: Array.isArray(preferElements)
        ? preferElements.map((e) => damage.normalizeElement(e)).filter(Boolean)
        : (preferElements ? [damage.normalizeElement(preferElements)].filter(Boolean) : []),
    });
    worker.state.equip.checkedAt = Date.now();
    if (report.equipped) {
      worker.state.equip.equipped += report.equipped;
      worker.state.equip.lastReport = report;
      this.audit('equip_best', {
        account: worker.state.emailMasked,
        set: report.set,
        equipped: report.equipped,
        improved: report.improved,
        manual: true,
      });
      worker.markAction();
    }
    return report;
  }

  // Run a blacksmith craft sweep on one account NOW (panel button / API).
  async craftBlacksmith(accountId, viewer) {
    const picked = this.pickUserWorker(accountId, viewer);
    if (picked.error) return { ok: false, reason: picked.error };
    const worker = picked.worker;
    const bs = worker.cfg.blacksmith || {};
    const report = await blacksmith.blacksmithRound(worker.client, { maxCrafts: bs.maxCrafts || 4 });
    worker.state.blacksmith.checkedAt = Date.now();
    worker.state.blacksmith.lastReport = report;
    if (report.crafted.length) {
      worker.state.blacksmith.crafted += report.crafted.length;
      this.audit('blacksmith_craft', { account: worker.state.emailMasked, crafted: report.crafted, manual: true });
      worker.markAction();
    }
    return report;
  }

  // Pick the worker a panel action runs on. NEVER the built-in fetcher: it is
  // infrastructure (hidden, and it launches first, so it would otherwise win
  // every "oldest healthy account" pick and get stats/shop actions meant for
  // user accounts).
  pickUserWorker(accountId, viewer) {
    if (accountId) {
      const w = this.workers.get(accountId);
      if (!w || this.isAdminAccountId(accountId) || !this.canAccess(viewer, accountId)) return { error: 'no_such_account' };
      if (w.stopFlag || w.state.status !== 'running') return { error: 'no_healthy_account' };
      return { worker: w };
    }
    let best = null;
    for (const w of this.workers.values()) {
      if (this.isAdminAccountId(w.account.id) || !this.canAccess(viewer, w.account.id)) continue;
      if (!w.stopFlag && w.state.status === 'running' && w.state.userId
        && (!best || w.state.startedAt < best.state.startedAt)) best = w;
    }
    return best ? { worker: best } : { error: 'no_healthy_account' };
  }

  // Run the stat-allocation engine on one account NOW (panel button / API).
  // accountId selects the worker; null picks the oldest healthy one. The plan
  // comes from the caller or falls back to the configured STAT_PLAN.
  async allocateStats(accountId, plan, viewer) {
    const picked = this.pickUserWorker(accountId, viewer);
    if (picked.error) return { ok: false, reason: picked.error };
    const worker = picked.worker;
    const thePlan = statEngine.planTotals(plan && (plan.attack || plan.defense || plan.stamina)
      ? plan : this.cfg.statPlan);
    const report = await statEngine.allocatePlan(worker.client, thePlan, { fastTest: this.cfg.fastTest });
    worker.state.stats.lastPlan = thePlan;
    if (report.ok) {
      worker.state.stats.allocations++;
      worker.state.stats.points = report.pointsLeft;
      worker.state.stats.attack = report.attributes.attack;
      worker.state.stats.defense = report.attributes.defense;
      worker.state.stats.staminaMax = report.attributes.maxStamina;
      worker.state.stats.lastError = null;
    } else if (report.reason !== 'insufficient_points') {
      worker.state.stats.lastError = report.reason || 'stat_failed';
    }
    this.audit('stat_allocation', {
      account: worker.state.emailMasked,
      plan: report.plan,
      applied: report.applied,
      ok: report.ok,
      reason: report.reason,
      auto: false,
    });
    return report;
  }

  // Targets variant (Veyra allocator): spend banked points up to per-attribute
  // goals on one account NOW. Same account-selection rules as allocateStats.
  async allocateTargets(accountId, targets, viewer) {
    const picked = this.pickUserWorker(accountId, viewer);
    if (picked.error) return { ok: false, reason: picked.error };
    const worker = picked.worker;
    const goals = statEngine.planTotals(targets);
    const report = await statEngine.allocateTargets(worker.client, goals, { fastTest: this.cfg.fastTest });
    worker.state.stats.lastTargets = goals;
    if (report.ok) {
      worker.state.stats.allocations++;
      worker.state.stats.points = report.pointsLeft;
      if (report.attributes) {
        worker.state.stats.attack = report.attributes.attack;
        worker.state.stats.defense = report.attributes.defense;
        worker.state.stats.staminaMax = report.attributes.stamina;
      }
      worker.state.stats.lastError = null;
    } else if (report.reason !== 'points_drained') {
      worker.state.stats.lastError = report.reason || 'targets_failed';
    }
    this.audit('stat_allocation', {
      account: worker.state.emailMasked,
      mode: 'targets',
      targets: report.targets,
      applied: report.applied,
      ok: report.ok,
      reason: report.reason,
      auto: false,
    });
    return report;
  }

  // Run the potion-shop buy-all on one account NOW (panel button / API).
  // accountId selects the worker; null picks the oldest healthy one.
  async buyStaminaPotions(accountId, viewer) {
    const picked = this.pickUserWorker(accountId, viewer);
    if (picked.error) return { ok: false, reason: picked.error };
    const worker = picked.worker;
    const summary = await shop.buyAllStaminaPotions(worker.client, { fastTest: this.cfg.fastTest });
    if (summary.bought > 0) {
      worker.state.purchases++;
      worker.state.potionsBought += summary.bought;
      worker.ladderDry = false;
    }
    this.audit('potion_purchase', {
      account: worker.state.emailMasked,
      bought: summary.bought,
      spent: summary.spent,
      merchant: summary.merchant.bought,
      guild: summary.guild.bought,
      damon: summary.damon.bought,
      manual: true,
    });
    return { ok: true, ...summary };
  }

  // Designate the fetcher. The designation is FIXED to each site's built-in
  // admin fetcher: passing its id re-affirms it, anything else is refused
  // (the API answers 403), and clearing is refused too — every site always
  // has its fetcher.
  setScoutAccount(id) {
    const ctx = [...this.sites.values()].find((c) => id && c.adminAccountId === id);
    if (!ctx) {
      this.audit('scout_designation_refused', {
        requested: id ? String(id).slice(0, 8) + '…' : null,
        reason: 'fetching is fixed to the built-in admin fetcher',
      });
      return null;
    }
    this.persistFarmSettings();
    this.buildScoutGetter(ctx.key);
    this.audit('scout_designated', { account: 'built-in fetcher (hidden)', site: ctx.key });
    return this.scoutAccount(ctx.key);
  }

  // Masked view for the API/dashboard. The built-in fetcher stays hidden:
  // users learn THAT fetching is fixed, never WHO runs it.
  scoutAccount(siteKey) {
    const ctx = this.site(siteKey);
    if (!ctx || !ctx.adminAccountId) return null;
    return { id: null, nickname: 'built-in fetcher', hidden: true };
  }

  // A site's scout borrows one logged-in worker's client: that site's
  // fetcher when it is healthy, otherwise the oldest healthy worker ON THE
  // SAME SITE (never another site's — cookies and mob ids don't cross) so the
  // sweep keeps running while the fetcher re-logins or cools down.
  buildScoutGetter(siteKey) {
    const keys = siteKey ? [siteKey] : [...this.sites.keys()];
    for (const key of keys) {
      const ctx = this.sites.get(key);
      if (!ctx) continue;
      ctx.scoutClientGetter = () => {
        const healthy = (w) => !w.stopFlag && w.state.status === 'running' && w.state.userId
          && (w.account.site || this.cfg.defaultSite) === key;
        if (ctx.adminAccountId) {
          for (const w of this.workers.values()) {
            if (w.account.id === ctx.adminAccountId && healthy(w)) return w.client;
          }
        }
        let best = null;
        for (const w of this.workers.values()) {
          if (healthy(w) && (!best || w.state.startedAt < best.state.startedAt)) best = w;
        }
        return best ? best.client : null;
      };
    }
  }

  getScoutClient(siteKey) {
    const ctx = this.site(siteKey);
    return ctx && ctx.scoutClientGetter ? ctx.scoutClientGetter() : null;
  }

  // The fleet's average loadout (equipAtk / petAtk / attackStat the workers
  // last measured for the damage forecast) — the panel's "≈N hits" hint on
  // ticked mobs uses this instead of any single account's gear.
  fleetLoadout(siteKey) {
    const site = String(siteKey || this.cfg.defaultSite);
    const rows = [];
    for (const w of this.workers.values()) {
      if ((w.account.site || this.cfg.defaultSite) !== site) continue;
      const lo = w.state && w.state.loadout;
      if (lo && Number.isFinite(Number(lo.attackStat)) && (lo.equipAtk || lo.petAtk || lo.attackStat)) {
        rows.push(lo);
      }
    }
    if (!rows.length) return null;
    const avg = (key) => Math.round(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0) / rows.length);
    return { equipAtk: avg('equipAtk'), petAtk: avg('petAtk'), attackStat: avg('attackStat'), accounts: rows.length };
  }

  apiRow(id) {
    const w = this.workers.get(id);
    const row = this.store.list().find((a) => a.id === id);
    if (!row) return null;
    return {
      ...row,
      status: w ? w.state.status : 'stopped',
      level: w ? w.state.level : 0,
      lastError: w ? w.state.lastError : null,
      lastActionAt: w ? w.state.lastActionAt : null,
      bossHits: w ? w.state.bossHits : 0,
      runningBoss: w ? w.state.runningBoss : null,
      waveHits: w ? w.state.waveHits : 0,
      waveRounds: w ? w.state.waveRounds : 0,
      runningWave: w ? w.state.runningWave : null,
      // Diver state: the account's named targets + how many of them the
      // session actually attacked (panel: "diving: N targets · M hits").
      dive: w ? { ...w.state.dive } : null,
      // Fleet-hunt (bus dive) telemetry + gear keep-up (equip-best/blacksmith).
      diveBus: w ? { ...w.state.diveBus } : null,
      equip: w ? { ...w.state.equip } : null,
      blacksmith: w ? { ...w.state.blacksmith } : null,
      farmConfiguredAt: w ? w.state.farmConfiguredAt : 0,
      reactions: w ? { ...w.state.reactions } : null,
      corpseSweeps: w ? w.state.corpseSweeps : 0,
      corpsesLooted: w ? w.state.corpsesLooted : 0,
      dungeonRounds: w ? w.state.dungeonRounds : 0,
      dungeonKills: w ? w.state.dungeonKills : 0,
      guild: w ? w.state.guild : null,
      purchases: w ? w.state.purchases : 0,
      potionsBought: w ? w.state.potionsBought : 0,
      // Dailies sweeps (claims.js / quests.js / events.js / battlepass.js):
      // the panel's account rows show the cl/q/ev/bp counters from these.
      claims: w ? { ...w.state.claims } : null,
      quests: w ? { ...w.state.quests } : null,
      events: w ? { ...w.state.events } : null,
      battlePass: w ? { ...w.state.battlePass } : null,
      pvp: w ? { ...w.state.pvp } : null,
      classInfo: w && w.state.classInfo ? { ...w.state.classInfo } : null,
      skillTree: w ? { ...w.state.skillTree } : null,
      stats: w ? { ...w.state.stats } : null,
      exp: w
        ? { gained: w.state.exp.gained, percent: w.state.exp.percent, at: w.state.exp.at }
        : null,
      vitals: w
        ? {
            stamina: w.state.vitals.stamina,
            hp: w.state.vitals.hp,
            mana: w.state.vitals.mana,
            potionsDrunk: w.state.vitals.potionsDrunk,
          }
        : null,
    };
  }

  status(viewer) {
    // Hidden rows (the built-in fetchers) never reach the API: not in the
    // account list, not in the stored count. A normal user additionally only
    // gets the accounts they own; the owner gets everything.
    const visibleIds = new Set(
      this.store.internalRows().filter((r) => !r.hidden && this.canAccess(viewer, r.id)).map((r) => r.id)
    );
    const isOwner = !!viewer && viewer.role === 'owner';
    return {
      farmEnabled: this.farmEnabled,
      fetcherFixed: true,
      scoutAccount: this.scoutAccount(this.cfg.defaultSite),
      sites: this.cfg.sites.map((def) => {
        const ctx = this.sites.get(def.key);
        const snap = ctx ? ctx.bus.snapshot() : null;
        return {
          key: def.key,
          label: def.label,
          active: !!ctx,
          accounts: [...this.workers.values()].filter((w) => visibleIds.has(w.account.id)
            && (w.account.site || this.cfg.defaultSite) === def.key).length,
          fetcher: ctx ? this.scoutAccount(def.key) : null,
          scout: snap ? { lastRun: snap.lastScoutRun, lastError: snap.lastScoutError } : null,
        };
      }),
      accounts: [...this.workers.keys()].filter((id) => visibleIds.has(id)).map((id) => {
        const r = this.apiRow(id);
        if (!isOwner) delete r.owner; // friends don't need to see who else uses the farm
        return r;
      }),
      storedCount: visibleIds.size,
    };
  }
}

module.exports = { AccountWorker, WorkerManager };
