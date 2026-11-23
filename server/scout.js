'use strict';
// scout.js — the "resource gathering account".
//
// Runs on one logged-in account (the oldest healthy worker, or the nickname
// given in SCOUT_NICKNAME). Each interval it fetches every configured wave
// page, discovers live monster instances, matches them to the boss catalogue
// and publishes both to the TargetBus. Every farmer then knows: "attack mob
// id X" — the exact coordination you described.
const { logger } = require('./util');
const { discoverOnWave, parseWaveMonsters, matchBossName, viewBattle, parseWaveRewardCap } = require('./combat');
const { getBossCategory } = require('./bosses');
const spawns = require('./spawns');
const divers = require('./divers');

// The extension's "just view, no damage" link (logged as
// Grabbed Link: …/battle.php?id={id}). Built for every discovered mob so the
// dashboard can open the battle page without spending stamina.
function battleUrlFor(cfg, monsterId) {
  return `${cfg.gameBase}/battle.php?id=${encodeURIComponent(String(monsterId))}`;
}

class Scout {
  constructor({ cfg, bus, bosses, bossCategories, getClient, label }) {
    this.cfg = cfg;
    this.bus = bus;
    this.bosses = bosses;               // catalogue [{key,name,wave,phase}]
    this.bossCategories = bossCategories; // key -> category
    this.getClient = getClient;         // () -> GameClient | null (logged in)
    this.label = label || 'scout';
    this.timer = null;
    this.running = false;
    // key -> [monsterId,...] mirrors GLOBAL_SAVED_BOSS_IDS (category capped).
    this.savedIdsByCategory = { generals: [], oceanus_poseidon: [], heralds: [], mains: [] };
    // Last auto-summon scan (for GET /api/spawns).
    this.lastSpawns = { at: 0, cards: [] };
    // Reward-level caps learned live from wave-page banners
    // ("Rewards Up To LV X") — GET /api/waves merges these with config.
    this.rewardCaps = new Map(); // wave path -> level
  }

  // Learned caps view for the API (plain object, registry path → level).
  learnedRewardCaps() {
    return Object.fromEntries(this.rewardCaps);
  }

  // Port of saveBossMonsterId: remember discovered ids per category with caps.
  rememberBossId(key, monsterId) {
    const category = this.bossCategories[key];
    if (!category || !monsterId) return;
    const strId = String(monsterId);
    const saved = this.savedIdsByCategory;
    if (!saved[category]) saved[category] = [];
    if (!saved[category].includes(strId)) {
      saved[category].push(strId);
      const limit = { generals: 26, oceanus_poseidon: 7, heralds: 40, mains: 16 }[category] || 20;
      while (saved[category].length > limit) saved[category].shift();
    }
  }

  savedIds() {
    return this.savedIdsByCategory;
  }

  // The sweep list: every configured gate/wave page (Gate 1 + Olympus in
  // registry order) plus any boss-catalogue wave that is not already on it,
  // PLUS every event wave discovered from the live event pages (the Divers'
  // dynamic registry — config/waves.json stays the base, events rotate).
  // Each entry carries the display label the dashboard shows.
  waveList(eventWaves) {
    const configured = (this.cfg.wavePages || []).map((w) => ({ path: w.path, label: w.label }));
    const seen = new Set(configured.map((w) => w.path));
    for (const b of this.bosses) {
      if (!b.wave || seen.has(b.wave)) continue;
      seen.add(b.wave);
      const m = String(b.wave).match(/gate=(\d+)&wave=(\d+)/);
      configured.push({
        path: b.wave,
        label: m ? `gate ${m[1]} · wave ${m[2]}` : String(b.wave),
      });
    }
    for (const w of eventWaves || []) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      configured.push({ path: w.path, label: w.label });
    }
    return configured;
  }

  async runOnce() {
    const client = this.getClient();
    if (!client) {
      this.bus.markScoutRun(new Error('no logged-in account available yet'));
      return;
    }

    // Event-wave discovery first (cached 15 min inside divers): the dashboard
    // + event pages are parsed for active_wave.php?event=N&wave=M links and
    // the result persists to data/event-waves.json for the whole farm.
    let eventWaves = [];
    try {
      eventWaves = await divers.eventWaves(client);
    } catch (_) { /* discovery is an optimization — sweep the registry as-is */ }

    const waves = this.waveList(eventWaves);
    const bossesOut = [];
    const mobsOut = [];
    const spawnRows = []; // auto-summon cards for the dashboard / /api/spawns
    const failedWaves = []; // waves whose fetch threw this sweep (their bus rows are kept)
    let lastErr = null;

    for (const wave of waves) {
      let html = null;
      let monsters = [];
      try {
        // Same hide_dead_monsters=1 setup discoverOnWave does, then ONE
        // fetch that feeds both the mob parse and the auto-summon cards.
        client.jar.set('hide_dead_monsters', '1', 30 * 24 * 3600);
        const res = await client.get(`/active_wave.php?${wave.path}`, { redirect: 'manual' });
        html = res.text;
        monsters = parseWaveMonsters(html || '');
      } catch (e) {
        lastErr = e;
        failedWaves.push(wave.path);
        logger.warn(`scout: wave ${wave.path} fetch failed: ${e.message}`);
        continue;
      }
      await client.pace(this.cfg.paceMinMs, this.cfg.paceMaxMs);

      // Reward-level cap learning: if the page renders its "Rewards Up To LV
      // X" banner the level is remembered (GET /api/waves shows it; the
      // divers' picker sinks the wave for accounts above it). Config entries
      // with an explicit rewardCapLv always win over a learned value.
      const pageCap = parseWaveRewardCap(html || '');
      if (pageCap > 0 && !(wave.rewardCapLv > 0)) this.rewardCaps.set(wave.path, pageCap);

      // Auto-summon cards on this wave (Boss Tracker port): alive/next-ts
      // flags + the monster-id map from the same page's .monster-card rows.
      const cards = spawns.parseAutoSummons(html || '');
      const views = new Map(); // monsterId → battle view (peek pass below)

      for (const m of monsters) {
        mobsOut.push({
          id: m.id,
          name: m.name,
          wave: wave.path,
          waveLabel: wave.label,
          battleUrl: battleUrlFor(this.cfg, m.id),
          // The instance's server-side auto-die epoch (ms): mobs churn fast —
          // dead ones are replaced by NEW ids on the same page — so the panel
          // counts this down and the freshness replace keeps the bus honest.
          expiresAt: m.expiresAt || null,
          // Reward-cap intel from the card: capReached=true means THIS mob's
          // reward cap is already passed by the FETCHER's damage — every
          // account's own caps differ, so this is a hint, not a rule.
          capReached: m.capReached || false,
          youDmg: m.youDmg || 0,
        });
      }

      // Match discovered monsters to configured bosses on this wave. Before
      // broadcasting, the scout peeks the battle page (battle.php?id=… — the
      // view-only GET, zero stamina). Dead there → skip this sweep; a peek
      // error is never fatal (fail open, the join response still guards).
      const bossesOnWave = this.bosses.filter((b) => b.wave === wave.path);
      for (const boss of bossesOnWave) {
        const found = monsters.find((m) => matchBossName(m.name, boss.name));
        if (!found || !found.id) continue;
        const pub = {
          key: boss.key,
          name: boss.name,
          monsterId: found.id,
          wave: wave.path,
          waveLabel: wave.label,
          battleUrl: battleUrlFor(this.cfg, found.id),
        };
        try {
          const view = await viewBattle(client, found.id);
          if (view.dead) {
            logger.info(`scout: ${boss.name} (mob ${found.id}) reads as dead on battle.php — not published this sweep`);
            await client.pace(this.cfg.paceMinMs, this.cfg.paceMaxMs);
            continue;
          }
          if (view.nextDieMs != null) {
            // 48h auto-die phase from the boss's own AUTO_DIE_CFG: the same
            // view the peek already fetched — zero extra requests.
            views.set(String(found.id), view);
            pub.nextDieMs = view.nextDieMs;
            pub.spawnPhase = spawns.phaseFromRemainingMs(view.nextDieMs - Date.now(), this.cfg.bossPhase2Hours);
            pub.remainingMs = Math.max(0, view.nextDieMs - Date.now());
          }
          await client.pace(this.cfg.paceMinMs, this.cfg.paceMaxMs);
        } catch (_) { /* peek failed — publish anyway */ }
        this.rememberBossId(boss.key, found.id);
        bossesOut.push(pub);
      }

      // Fold the peek views into the auto-summon cards, then keep them for
      // the dashboard (GET /api/spawns).
      if (cards.length) {
        spawns.annotatePhases(cards, views, { phase2Hours: this.cfg.bossPhase2Hours });
        for (const c of cards) spawnRows.push({ wave: wave.path, waveLabel: wave.label, ...spawns.spawnSummary([c])[0] });
      }
      logger.debug(`scout: wave ${wave.path} → ${monsters.length} live mobs, ${cards.length} auto-summon cards`);
    }

    this.lastSpawns = { at: Date.now(), cards: spawnRows };
    // Publish the FULL sweep as one snapshot: mobs from pages we could not
    // re-check this sweep are carried (failedWaves), everything else is
    // replaced — a mob killed on the page leaves the bus within one sweep.
    this.bus.publish({ bosses: bossesOut, mobs: mobsOut, failedWaves });
    this.bus.markScoutRun(lastErr);
    logger.info(`scout: published ${bossesOut.length} boss targets, ${mobsOut.length} mobs, ${spawnRows.length} spawn cards` +
      (failedWaves.length ? ` · ${failedWaves.length} wave fetch(es) failed` : ''));
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (e) {
        logger.error(`scout run failed: ${e.message}`);
        this.bus.markScoutRun(e);
      }
      this.timer = setTimeout(tick, this.cfg.scoutIntervalMs);
    };
    this.timer = setTimeout(tick, 3000); // first sweep shortly after boot
    logger.info(`scout started (interval ${this.cfg.scoutIntervalMs}ms)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}

module.exports = { Scout };
