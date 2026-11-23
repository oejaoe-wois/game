'use strict';
// combat.js — faithful Node port of bosses_alt_auto.js combat machinery:
//   - discoverOnWave(): wave-page monster discovery (scout)
//   - combatLoop(): join → probe → optimal tier → error handling → FINISHED/DEAD
//   - handlePhase2Battle(): the PVP monster-phase solver with keep-alive pings
//   - executeHeal / useStaminaPotion / smartLooting / getExpStatus
// Endpoint contract is byte-compatible with the extension (form-encoded posts).
const { logger, sleep } = require('./util');
const loot = require('./loot');

// Port of SKILL_TIERS / PVP_SKILL_TIERS (bosses_alt_auto.js).
const SKILL_TIERS = [
  { id: '0', cost: 1 },
  { id: '-1', cost: 10 },
  { id: '-2', cost: 50 },
  { id: '-3', cost: 100 },
  { id: '-4', cost: 200 },
  { id: '-5', cost: 1000 },
];

const PVP_SKILL_TIERS = [
  { id: '0', cost: 1 },
  { id: '-1', cost: 10 },
  { id: 'adv:4', cost: 50 },
  { id: 'adv:8', cost: 50 },
  { id: 'adv:12', cost: 50 },
  { id: 'adv:16', cost: 50 },
  { id: 'adv:20', cost: 50 },
  { id: 'adv:24', cost: 50 },
  { id: 'adv:28', cost: 50 },
  { id: 'adv:32', cost: 50 },
];

// Re-probe thresholds after consecutive hits at the same tier.
function needsReProbe(stamCost, consecutiveCount) {
  if (stamCost === '200' && consecutiveCount >= 5) return true;
  if (stamCost === '100' && consecutiveCount >= 5) return true;
  if (stamCost === '50' && consecutiveCount >= 5) return true;
  if (stamCost === '10' && consecutiveCount >= 10) return true;
  if (stamCost === '1' && consecutiveCount >= 15) return true;
  return false;
}

// ── Wave-page discovery (the SCOUT's eyes) ────────────────────────────────────
// Port of the runBossCleaner() wave parsing: regex over data-monster-id with
// ±300/500 char snippets, dead-row filtering, name via data-name or fallback
// to boss-name substring matching. Sets hide_dead_monsters=1 first, exactly
// like the extension's setCookieExtension call.
async function discoverOnWave(game, wavePath) {
  game.jar.set('hide_dead_monsters', '1', 30 * 24 * 3600);
  const res = await game.get(`/active_wave.php?${wavePath}`, { redirect: 'manual' });
  return parseWaveMonsters(res.text || '');
}

// Pure parser half of discoverOnWave (the scout already holds the HTML from
// its own fetch — one request serves mobs AND auto-summon cards).
// Each card also carries data-expire — the instance's server-side auto-die
// epoch (seconds). Mobs (and bosses) die there even if nobody lands the last
// hit, then a NEW instance id takes the slot — so expiresAt rides along on
// every published row and the panel counts it down.
// Live cards also carry data-userdmg (THIS viewer's damage — the reward-cap
// resume point) and data-capnotreached (1 = the mob's reward cap is NOT yet
// reached by your damage — exp/gold still flow; 0 = cap reached, gear only).
function parseWaveMonsters(html) {
  const monsters = [];
  const regex = /data-monster-id=["']?(\d+)["']?/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const monsterId = match[1];
    // One opening tag per card: everything from this data-monster-id up to
    // the NEXT card's id belongs to THIS row. Looking backwards (the old
    // ±300 window) leaked the previous card's data-name / data-expire into
    // rows that lacked their own — a nameless card inherited a boss name
    // and a timer-less card inherited a stale die time.
    const next = regex.exec(html);
    const lastCard = !next;
    const end = lastCard ? Math.min(html.length, match.index + 700) : next.index;
    if (!lastCard) regex.lastIndex = next.index; // let the loop re-find this card
    const snippet = html.substring(match.index, end);
    // A failed exec resets lastIndex to 0 — the LAST card must always break,
    // dead or alive, or the scan restarts from the top forever (OOM).
    if (snippet.includes('data-dead="1"')) {
      if (lastCard) break;
      continue;
    }

    let name = '';
    const nameMatch = snippet.match(/data-name=["']([^"']+)["']/i);
    if (nameMatch) name = nameMatch[1].trim().toLowerCase();
    let expiresAt = null;
    const expMatch = snippet.match(/data-expire=["']?(\d+)["']?/i);
    if (expMatch) {
      const sec = parseInt(expMatch[1], 10);
      // The clock is server-side; clock skew of a few minutes is harmless —
      // this is a countdown display, not a scheduling input.
      if (Number.isFinite(sec) && sec > 1_000_000_000) expiresAt = sec * 1000;
    }
    // Reward-cap intel (live-verified: the attribute flips to 0 once YOUR
    // total damage on the mob passes its reward cap — further damage only
    // buys gear, so the farm skips those mobs unless a dive target says so).
    const youDmg = parseInt(String((snippet.match(/data-userdmg=["']?([\d,]+)["']?/i) || [])[1] || '0').replace(/,/g, ''), 10) || 0;
    const capReached = /data-capnotreached=["']?0["']?/i.test(snippet);
    monsters.push({ id: monsterId, name, expiresAt, youDmg, capReached });
    if (lastCard) break;
  }
  return monsters;
}

// Name matching port (bidirectional includes, like the extension).
function matchBossName(monsterName, bossName) {
  const m = String(monsterName || '').toLowerCase();
  const b = String(bossName || '').toLowerCase();
  if (!m || !b) return false;
  return m.includes(b) || b.includes(m);
}

// Wave-page reward-level banner: "Rewards Up To LV 300" — past that ACCOUNT
// level the wave still drops gear and items but NO exp and gold. The live
// gate pages keep the number in their header when they render it at all; a
// wave.json entry's rewardCapLv overrides what the page hides. Returns the
// parsed level or 0 when the page does not show one.
function parseWaveRewardCap(html) {
  const m = String(html || '').match(/rewards?\s*(?:up\s*to|max(?:imum)?)?\s*(?:lv|level)\.?\s*([\d,]+)/i)
    || String(html || '').match(/(?:lv|level)\.?\s*([\d,]+)\s*(?:rewards?|loot)/i);
  if (!m) return 0;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── The game's own auto-farm (auto_farm_status.php / auto_farm_actions.php) ──
// While it is ENABLED the game rejects every manual hit: damage.php answers
// "You can't attack monsters while your auto farm is on" (HTTP 400) — the
// whole engine goes hungry. The wave page's Auto Farm card drives these
// endpoints (Start button → action=toggle&enabled=1, Pause → enabled=0, the
// page reloads after a confirmed toggle), so the engine speaks the same two:
//   GET  auto_farm_status.php  → { ok, settings: { IS_ENABLED: '0'|'1', … } }
//   POST auto_farm_actions.php action=toggle&enabled=0   (pause)
async function readAutoFarmStatus(game) {
  try {
    const res = await game.get(`/auto_farm_status.php?_t=${Date.now()}`, { redirect: 'manual' });
    let json = {};
    try { json = JSON.parse(res.text); } catch (_) { json = {}; }
    const s = json.settings || {};
    return {
      ok: !!json.ok,
      enabled: Number(s.IS_ENABLED) === 1,
      finished: Number(s.FINISHED) === 1,
      raw: s,
    };
  } catch (_) {
    return { ok: false, enabled: false, finished: false, raw: {} };
  }
}

// Pause the game-side auto-farm (the same POST the page's Pause button
// sends). Returns true only on a confirmed toggle — the game answers plain
// text, so "200" is the best signal we get; the next damage.php round is the
// real proof.
async function disableAutoFarm(game) {
  try {
    const res = await game.postForm('/auto_farm_actions.php', { action: 'toggle', enabled: '0' });
    const text = String(res.text || '').toLowerCase();
    return res.status >= 200 && res.status < 300 && !text.includes('error');
  } catch (_) {
    return false;
  }
}

// ── Heal / potions / EXP (ports) ──────────────────────────────────────────────
// Port of AIO_BG.healPotion (user_heal_potion.php + user_id).
async function executeHeal(game, userId) {
  try {
    const res = await game.postForm('/user_heal_potion.php', { user_id: String(userId) });
    return (res.text || '').toLowerCase().includes('success');
  } catch (_) {
    return false;
  }
}

// Port of getExpStatus (stats.php EXP span parsing). The same page embeds
// #stats-state (csrf/view/user.{STAT_POINTS,ATTACK,DEFENSE,MAX_STAMINA}) —
// fold it in passively so workers get banked stat points for free.
const stats = require('./stats');
async function getExpStatus(game) {
  try {
    const res = await game.get(`/stats.php?_t=${Date.now()}`, { redirect: 'manual' });
    const m = (res.text || '').match(/<span>EXP&nbsp;<\/span>\s*<span>([\d,]+)\s*\/\s*([\d,]+)<\/span>/i);
    const state = stats.parseStatsState(res.text);
    const fold = state && state.user
      ? {
          points: Number(state.user.STAT_POINTS) || 0,
          attack: Number(state.user.ATTACK) || 0,
          defense: Number(state.user.DEFENSE) || 0,
          staminaMax: Number(state.user.MAX_STAMINA) || 0,
        }
      : null;
    if (m) {
      const currentExp = parseInt(m[1].replace(/,/g, ''), 10);
      const totalExp = parseInt(m[2].replace(/,/g, ''), 10);
      return {
        currentExp,
        totalExp,
        requiredExp: Math.max(0, totalExp - currentExp),
        percentExp: (currentExp / totalExp) * 100,
        stats: fold,
      };
    }
    if (fold) return { stats: fold }; // stats page without the EXP span
  } catch (_) { /* fallthrough */ }
  return null;
}

// Port of useStaminaPotion (bosses_alt_auto.js), which is the live traffic the
// game shows when you drink a potion:
//   GET inventory.php?_t=<ts> → split class="slot-box" → find the slot whose
//   text names the item → read the inv id from its useItem() button →
//   POST use_item.php with the ONE captured field — inv_id. (The drawer's
//   usePotionCard() speaks the exact same one-field body; item_id / qty are
//   never sent — the live capture shows the game's client posts inv_id only.)
async function useInventoryItem(game, slotNames) {
  const names = (slotNames || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  if (!names.length) return false;
  try {
    const res = await game.get(`/inventory.php?_t=${Date.now()}`, { redirect: 'manual' });
    const slots = (res.text || '').split('class="slot-box"');
    for (let i = 1; i < slots.length; i++) {
      const slot = slots[i].toLowerCase();
      if (!names.some((n) => slot.includes(n))) continue;
      const m = slots[i].match(/useItem\(\s*(\d+)\s*,\s*(\d+)/i);
      if (!m) continue;
      // Live capture: the game's own client POSTs ONE field — inv_id=…
      // (data-inv-id is the per-account inventory row id).
      const post = await game.postForm('/use_item.php', { inv_id: m[1] });
      logger.debug(`use_item.php inv_id=${m[1]} → HTTP ${post.status} ${(post.text || '').slice(0, 60)}`);
      return post.status >= 200 && post.status < 300;
    }
  } catch (_) { /* network hiccup → caller falls back */ }
  return false;
}

// ── Precision wave farming (port of runPrecisionWaveCombat) ──────────────────
// The wave pages (active_wave.php?gate=X&wave=Y) render one card per mob with
// a battle.php?id={id} "Join Battle" link (bosses sit inside .boss-card rows
// and are handled by combatLoop instead). Port of scanCards(): find every mob
// card, read its name, the damage THIS account already dealt on it
// ("You: 12,345" — the per-account resume point) and its dead flag.
function parseWaveCards(html) {
  const text = String(html || '');
  // Closest-card semantics (a.closest('.card, .monster-card, div[class*=card]')):
  // chunk the page at each card container opening tag, then analyse one chunk
  // per mob — a neighbour's "You:" or boss-card can never leak across.
  // The bare `card` alternative carries a (?<![\w-]) lookbehind so the Boss
  // Tracker's auto-summon-card rows (which embed battle.php?id= links) are
  // NOT treated as mob cards.
  const boundary = /<div[^>]*class=["'][^"']*(?:mon-row|monster-card|boss-card|(?<![\w-])card)["'][^>]*>/gi;
  const marks = [];
  let bm;
  while ((bm = boundary.exec(text)) !== null) marks.push({ index: bm.index, tag: bm[0] });
  if (!marks.length) return [];

  const cards = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    // The chunk is THIS card's content, up to the next card boundary — the
    // page prefix (header, top bar, auto-summon cards…) is never parsed, so
    // the Boss Tracker rows' battle.php links can't leak into the mob list.
    const chunk = text.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined);
    const linkM = chunk.match(/battle\.php\?[?&]*id=(\d+)/i) || chunk.match(/[?&]id=(\d+)/);
    if (!linkM) continue;
    const id = linkM[1];
    if (seen.has(id)) continue;
    seen.add(id);
    if (/boss-card/i.test(chunk)) continue; // bosses go through combatLoop

    let name = '';
    const nameM = chunk.match(/<h[34][^>]*>([^<]+)<\/h[34]>/i)
      || chunk.match(/class=["'][^"']*name[^"']*["'][^>]*>([^<]+)</i)
      || chunk.match(/<strong[^>]*>([^<]+)<\/strong>/i);
    if (nameM) name = nameM[1].trim();
    if (!name) name = `Monster #${id}`;

    // Reward-cap resume point. The live cards carry the account's own damage
    // in data-userdmg (machine readable — the visible "You: X" line the old
    // parse relied on no longer renders on every gate), so the attribute is
    // read FIRST and the text kept as the fallback. youDmg is what makes a
    // round RESUME instead of re-attacking mobs it already capped.
    let youDmg = parseInt(String((chunk.match(/data-userdmg=["']?([\d,]+)["']?/i) || [])[1] || '0').replace(/,/g, ''), 10) || 0;
    if (!youDmg) {
      const dmgM = chunk.match(/You:\s*([\d,]+)/i);
      if (dmgM) youDmg = parseInt(dmgM[1].replace(/,/g, ''), 10) || 0;
    }

    const dead = /data-dead=["']?1["']?/i.test(chunk)
      || /HP\s*0\s*\//i.test(chunk)
      || /defeated/i.test(chunk);

    // data-capnotreached="1" = YOUR damage is still under the mob's reward
    // cap (exp/gold flow); "0" = cap reached — more damage buys gear only.
    // Machines read it straight off the card; no banner scraping needed.
    const capReached = /data-capnotreached=["']?0["']?/i.test(chunk);

    cards.push({ id, name, youDmg, dead, capReached });
  }
  return cards;
}

// Port of the per-mob precision loop: join (the live wave client POSTs all
// three fields — id, monster_id, user_id), then 1-stamina Slashes
// ── per-mob damage floor (guild contracts' "min 3m dmg" rule) ───────────────
// A kill contract only counts when the mob DIED with at least N of YOUR
// damage on it ("Kill 5 monster(s) · Monster: Lizardman Shadowclaw · min 3m
// dmg"). The floor for a mob comes from three sources, highest authority
// last:
//   1. cfg.mobMinDamage               — the global MOB_MIN_DAMAGE env
//   2. cfg.mobMinDamageJson           — per-name overrides ({"*": …, "lizard…": 3m})
//   3. cfg.questReq                   — the ACTIVE guild contract's own rule
//                                       (monster name match → its minDamage)
// The worker passes the active contract as cfg.questReq =
// {kind:'kill', monster:'lizardman shadowclaw', minDamage:3000000, …}.
function minDamageFor(name, cfg) {
  if (!cfg) return 0;
  const lower = String(name || '').trim().toLowerCase();
  let floor = Number(cfg.mobMinDamage) || 0;
  const spec = cfg.mobMinDamageJson;
  if (spec && lower) {
    // Last matching rule wins; the catch-all "*" is the JSON's own default.
    if (spec.fallback != null) floor = spec.fallback;
    for (const r of spec.rules || []) {
      if (r.re.test(lower)) floor = r.min;
    }
  }
  const qr = cfg.questReq;
  if (qr && qr.kind === 'kill' && qr.monster && lower && lower.includes(qr.monster)) {
    floor = Math.max(floor, Number(qr.minDamage) || 0);
  }
  return floor > 0 ? Math.floor(floor) : 0;
}

// One Slash (skill_id=0, stamina_cost=1) against a wave mob, until it dies
// (SLAIN), the strict damage cap is reached with no floor in play (FINISHED),
// the server says out of stamina, or the game's own auto-farm answers for us
// (never our tool). Contract mobs (floor > 0) fight PAST the loot gate: the
// quest needs the KILL with our damage ≥ floor, so a floored fight only ends
// in death or an empty stamina bar — "capped and alive" never counts.
// onDamage(damage) — optional live progress callback fired whenever the
// account's accumulated damage on THIS mob changes (damage.php's
// totaldmgdealt). The swarm coordinator uses it to move the per-account
// progress bars while a long fight runs.
async function waveCombat({ game, userId, monsterId, cap, startDamage, floor = 0, onEvent, onDamage, shouldAbort }) {
  const cfg = game.cfg;
  const label = `mob ${monsterId}`;

  let joinText = '';
  try {
    const joinRes = await game.postForm('/user_join_battle.php', {
      id: String(monsterId),
      monster_id: String(monsterId),
      user_id: String(userId),
    });
    joinText = (joinRes.text || '').toLowerCase();
  } catch (e) {
    onEvent && onEvent(`join ${label} failed: ${e.message}`);
    return 'ERROR';
  }
  if (joinText.includes('already dead') || joinText.includes("can't attack")) {
    onEvent && onEvent(`${label} already dead / not attackable`);
    return 'DEAD';
  }

  let damage = Number(startDamage) || 0;
  let cooldownPauses = 0;
  let loopGuard = 0;
  let floorNoted = false; // one "past the loot gate" notice per fight
  let rejoins = 0;        // "removed due to inactivity" → the game wants a fresh join

  for (;;) {
    if (++loopGuard > 2000) {
      onEvent && onEvent(`${label} loop guard hit — bailing out`);
      // 'STUCK' (not ERROR): the cap is unreachable within a sane hit budget
      // (wall mob / stalled replies). The wave round marks the mob skipped
      // for the session so it is never re-fought into the same wall.
      return 'STUCK';
    }
    // An armed swarm owns the fleet: a normal round checks between hits and
    // hands the account back the moment the swarm needs it — a queued mob
    // must never wait 20 minutes behind a 100M-cap Olympus wall fight.
    if (shouldAbort && shouldAbort()) {
      onEvent && onEvent(`${label} preempted — the swarm needs this account`);
      return 'ABORTED';
    }

    const capSatisfied = damage >= cap;
    if (capSatisfied && damage >= floor && floor === 0) {
      onEvent && onEvent(`${label} damage cap reached (${damage} / ${cap})`);
      return 'FINISHED';
    }
    // Floor above the cap (or no cap at all): the contract needs the KILL
    // with our damage ≥ floor — a mob left alive at the loot gate can never
    // count, so the fight only ends in death or an empty stamina bar. One
    // notice per fight, not per hit.
    if (floor > 0 && capSatisfied && !floorNoted) {
      floorNoted = true;
      onEvent && onEvent(`${label} past the loot gate (${damage}/${cap}) — contract floor ${floor} needs the kill`);
    }

    let json = {};
    try {
      const res = await game.postForm('/damage.php', {
        monster_id: String(monsterId),
        skill_id: '0',       // 1-stamina Slash, exactly like the live script
        stamina_cost: '1',
      });
      await sleep((cfg && cfg.waveHitDelayMs) || 650);
      try { json = JSON.parse(res.text); } catch (_) { json = {}; }
    } catch (e) {
      onEvent && onEvent(`${label} damage.php network error: ${e.message}`);
      await sleep((cfg && cfg.waveHitDelayMs) || 650);
      continue;
    }

    if (json.status === 'error') {
      const msg = (json.message || '').toLowerCase();
      if (msg.includes('auto farm')) {
        // The in-game auto-farm is running; the engine never touches
        // auto_farm_actions.php — the worker warns and the round stops.
        onEvent && onEvent('the in-game auto-farm is ON — switch it off on the wave page');
        return 'AUTO_FARM_ON';
      }
      if (msg.includes('inactivity') || msg.includes('rejoin')) {
        // The battle session went stale server-side ("You were removed due to
        // inactivity. Please rejoin the battle.") — the game's own client
        // answers this with a fresh user_join_battle.php POST, and so do we.
        // Without the rejoin this error loops for up to 20 minutes of blind
        // backoffs while the swarm coordinator waits on a silent account.
        if (++rejoins > 3) {
          onEvent && onEvent(`${label} rejoin limit hit (${rejoins - 1}) — bailing out`);
          return 'ERROR';
        }
        onEvent && onEvent(`${label} battle session stale — rejoining (attempt ${rejoins})`);
        try {
          const reRes = await game.postForm('/user_join_battle.php', {
            id: String(monsterId),
            monster_id: String(monsterId),
            user_id: String(userId),
          });
          const reText = (reRes.text || '').toLowerCase();
          if (reText.includes('already dead') || reText.includes("can't attack")) {
            onEvent && onEvent(`${label} already dead / not attackable (on rejoin)`);
            return 'DEAD';
          }
        } catch (e) {
          onEvent && onEvent(`${label} rejoin failed: ${e.message}`);
          return 'ERROR';
        }
        continue;
      }
      if (msg.includes('quickly') || msg.includes('cooldown')) {
        cooldownPauses++;
        await sleep(cfg && cfg.fastTest ? 60 : 1000);
        continue;
      }
      if (msg.includes('dead')) return 'DEAD';
      if (msg.includes('not enough stamina')) return 'OUT_OF_STAMINA';
      // Unknown error → short backoff, keep going (bounded by loopGuard).
      await sleep((cfg && cfg.waveHitDelayMs) || 650);
      continue;
    }

    if (json.status === 'success' || json.hp) {
      if (typeof json.stamina !== 'undefined') game.noteStamina(json.stamina);

      if (typeof json.totaldmgdealt !== 'undefined') {
        damage = Number(json.totaldmgdealt);
      } else {
        const dmgM = json.message ? json.message.match(/<strong>([\d,]+)<\/strong>/) : null;
        if (dmgM) damage += Number(dmgM[1].replace(/,/g, ''));
      }
      if (onDamage) onDamage(damage);

      if (json.hp && Number(json.hp.value) <= 0) {
        onEvent && onEvent(`${label} defeated (${damage} dmg${cooldownPauses ? `, ${cooldownPauses} cooldown pauses` : ''})`);
        return 'SLAIN';
      }
      continue;
    }

    // Non-JSON garbage → backoff.
    await sleep((cfg && cfg.waveHitDelayMs) || 650);
  }
}

// One worker cycle = ONE wave page, round-robin across the registry (the
// registry order is the gate map: Gate 1 waves 1-3, then Olympus). Eligible
// mobs: alive, "You:" damage still under the strict cap, stamina ≥ 1 before
// each engagement (the script's per-mob stamina check). Returns a round
// summary for the dashboard + audit trail.
//
// Per-mob caps (the loot scanner port): each wave and gate carries different
// numbers, and a mob's own battle page states its best-loot gate as
// "DMG req: X" — attacking past it wastes stamina. mobCapMode 'auto'
// (default) resolves each mob's cap live → learned → known tables;
// 'fixed' pins everything to cfg.mobDamageCap.
async function waveFarmRound({ game, userId, cfg, wave, onEvent, shouldAbort }) {
  const fixed = cfg.mobCapMode === 'fixed';
  const maxMobs = cfg.waveMobsPerRound;
  // round.looted — manual loots of THIS round's kills (loot.php, the exact
  // request the game's own Loot button makes). The Dragon Realm event dailies
  // (sanctuary board) count "defeat N X and manually loot it today" — a kill
  // without a loot POST does not register, so every SLAIN is looted right
  // away when cfg.waveLootKills is on (WAVE_LOOT_KILLS=0 to disable).
  const round = { wave: wave.label, path: wave.path, eligible: 0, matched: 0, questMatched: 0, dived: 0, attacked: 0, slain: 0, capped: 0, floored: 0, cappedSkip: 0, looted: 0, stopped: null, caps: {} };
  // Battle-pass keywords (battlepass.js questHint): while the season's
  // damage quest ("deal 300,000 damage to Lizard/Sea mobs") is open, mobs
  // whose name matches a keyword feed BOTH the farm and the quest — so the
  // worker passes cfg.bpKeywords and matching mobs are attacked FIRST.
  const bpKeywords = Array.isArray(cfg.bpKeywords) ? cfg.bpKeywords : [];
  const questReq = cfg.questReq;
  const bpMatch = (mob) => {
    const name = String(mob.name || '').toLowerCase();
    if (bpKeywords.some((k) => name.includes(k))) return true;
    // The active guild contract's monster is a quest mob too — attack it first.
    return !!(questReq && questReq.kind === 'kill' && questReq.monster && name.includes(questReq.monster));
  };
  // ── Diver targeting (the user's own hunting system) ────────────────────
  // The account's dive targets ("goblin skirmisher, troll ravager") are
  // matched as substrings; matching mobs go to the very front of the attack
  // order — ahead of battle-pass and contract mobs. DIVE_ONLY=1 makes the
  // diver attack NOTHING else: stamina only ever buys the named mobs.
  const divers = require('./divers');
  const diveTargets = Array.isArray(cfg.diveTargets) ? cfg.diveTargets : [];
  const diveOnly = cfg.diveOnly === true && diveTargets.length > 0;
  const diveMatch = (mob) => divers.matchDive(mob.name, diveTargets);

  let cards = [];
  try {
    const res = await game.get(`/active_wave.php?${wave.path}`, { redirect: 'manual' });
    cards = parseWaveCards(res.text || '');
  } catch (e) {
    round.stopped = `wave fetch failed: ${e.message}`;
    return round;
  }
  // Teach the hunt map: every parsed wave page records which mob names live
  // here (data/hunt-map.json) so a later guild kill contract can steer the
  // picker straight to the hosting wave. In-memory unless DATA_DIR is set.
  try {
    const hunt = require('./hunt');
    hunt.rememberWaveMobs(wave.path, cards.map((c) => c.name));
  } catch (_) { /* hunt map is an optimization, never a dependency */ }
  // The wave page also carries the stamina top bar — scanVitals already
  // picked it up; guard each engagement like the script does.
  await game.pace(cfg.paceMinMs, cfg.paceMaxMs);

  // Static cap per mob (no network): learned → known mob → known wave → cfg.
  const staticCapFor = (mob) => {
    if (fixed) return { cap: cfg.mobDamageCap, source: 'config' };
    return loot.resolveMobCap({ name: mob.name, wavePath: wave.path, cfg });
  };

  const capOf = (r) => (r.cap > 0 ? r.cap : Infinity); // 0 = no cap known → fight to the death
  // Session-level wall list: a mob whose fight bailed out on the loop guard
  // (STUCK) is skipped for the rest of THIS session — re-fighting it every
  // round would just hammer the same wall 2,000 more times.
  if (!game.stuckMobs) game.stuckMobs = new Set();
  const eligible = cards.filter((c) => {
    if (c.dead) return false;
    if (game.stuckMobs.has(String(c.id))) return false;
    const f = minDamageFor(c.name, cfg);
    if (c.youDmg >= Math.max(capOf(staticCapFor(c)), f)) return false;
    // Reward cap reached (data-capnotreached="0"): this account's damage on
    // the mob is past its reward cap — further damage buys gear only. That
    // is a pure stamina waste EXCEPT for a diver hunting it on purpose
    // (gear hunting) or a contract floor that still needs the kill.
    if (c.capReached && !diveMatch(c) && f <= 0) { round.cappedSkip++; return false; }
    // DIVE_ONLY: the diver attacks NOTHING but its named mobs.
    if (diveOnly && !diveMatch(c)) return false;
    return true;
  });
  round.eligible = eligible.length;
  round.matched = eligible.filter(bpMatch).length;
  // The contract mob ALONE (bp keywords excluded) — the worker's pin
  // self-heal demotes a pinned page whose round saw zero of them.
  round.questMatched = eligible.filter((mob) => !!(questReq && questReq.kind === 'kill'
    && questReq.monster && String(mob.name || '').toLowerCase().includes(String(questReq.monster).toLowerCase()))).length;
  // Attack order: dive targets first, then battle-pass/contract mobs, then
  // the page's own order (stable sort keeps each bucket's order).
  if (diveTargets.length || bpKeywords.length || (questReq && questReq.kind === 'kill' && questReq.monster)) {
    eligible.sort((a, b) => Number(diveMatch(b)) - Number(diveMatch(a)) || Number(bpMatch(b)) - Number(bpMatch(a)));
  }

  for (const mob of eligible.slice(0, maxMobs)) {
    const sta = game.lastStamina;
    if (sta && sta.cur < 1) {
      round.stopped = 'OUT_OF_STAMINA';
      onEvent && onEvent(`wave ${wave.label}: out of stamina — stopping the round`);
      break;
    }

    // Auto mode: one FREE view per unknown mob (battle.php costs zero
    // stamina) reads the mob's real loot gate, exactly like the console
    // scanner. Learned mobs and known loot-less mobs skip the view.
    let resolved = staticCapFor(mob);
    if (!fixed && resolved.source !== 'learned' && !loot.hasNoLootMemo(mob.name)) {
      try {
        const view = await viewBattle(game, mob.id);
        if (view && view.dead) {
          onEvent && onEvent(`${mob.name || mob.id} reads dead on battle.php — skipped`);
          continue;
        }
        if (view && view.maxDamageReq > 0) {
          loot.learnCap(mob.name, view.maxDamageReq, wave.path); // persisted to data/loot-caps.json
          resolved = { cap: view.maxDamageReq, source: 'live-loot' };
          onEvent && onEvent(`${mob.name || mob.id} loot gate learned: ${view.maxDamageReq.toLocaleString('en-US')} dmg`);
        } else {
          loot.memoNoLoot(mob.name);
        }
      } catch (_) { /* peek failed → keep the static cap */ }
      await game.pace(cfg.paceMinMs, cfg.paceMaxMs);
    }

    const cap = capOf(resolved);
    const floor = minDamageFor(mob.name, cfg);
    if (mob.youDmg >= cap && mob.youDmg >= floor) continue; // refined cap already satisfied

    const result = await waveCombat({
      game,
      userId,
      monsterId: mob.id,
      cap,
      floor,
      startDamage: mob.youDmg,
      onEvent,
      shouldAbort,
    });
    round.attacked++;
    if (result === 'ABORTED') {
      // The armed swarm claimed this account mid-fight — hand it over
      // immediately; the remaining wave mobs wait for the next round.
      round.stopped = 'SWARM_PREEMPT';
      break;
    }
    if (result === 'STUCK') {
      // The hit budget could not reach this mob's cap — never re-fight it in
      // this session (the wall does not care about our stamina).
      game.stuckMobs.add(String(mob.id));
      round.stuck = (round.stuck || 0) + 1;
      onEvent && onEvent(`${mob.name || mob.id} unreachable cap — skipped for this session`);
      continue;
    }
    if (diveMatch(mob)) round.dived++;
    if (floor > cap) round.floored++;
    if (resolved.cap > 0) round.caps[mob.name || `mob ${mob.id}`] = { cap: resolved.cap, source: resolved.source };
    if (result === 'SLAIN') {
      round.slain++;
      // Manual loot of our own kill — event hunting dailies require it and
      // the drops are free. Lazy require: corpses.js needs combat.js for
      // viewBattle, so the cycle is broken by resolving it at call time.
      if (cfg.waveLootKills) {
        try {
          const corpses = require('./corpses');
          const lr = await corpses.lootCorpse(game, userId, mob.id);
          if (lr.ok) {
            round.looted++;
            onEvent && onEvent(`${mob.name || mob.id} looted — ${lr.message}`);
          }
        } catch (_) { /* loot hiccup — the corpse sweep still collects it */ }
      }
    }
    if (result === 'FINISHED') round.capped++;
    if (result === 'AUTO_FARM_ON') {
      // The game's own auto-farm rejected the hit. Surface it so the worker
      // pauses the auto-farm (AUTO_FARM_FIX, default on) instead of silently
      // finishing a round that attacked nothing.
      round.stopped = 'AUTO_FARM_ON';
      break;
    }
    if (result === 'OUT_OF_STAMINA') {
      round.stopped = 'OUT_OF_STAMINA';
      break;
    }
    await game.pace(cfg.paceMinMs, cfg.paceMaxMs);
  }
  return round;
}

// ── Battle drawer potions (the game's own consumables UI) ─────────────────
// Real markup per card (battle.php's <aside id="battleDrawer">):
//   <button class="potion-use-btn" data-inv="303210560" data-item="30"
//           data-name="Small Stamina Potion" data-max="1723" …>
// data-inv is the PER-ACCOUNT inventory row id (changes per account);
// data-item is the stable item type (30 small, 35 full, 251 large,
// 359 adventurer, 108 full hp). Quantities ride along in data-max.
function parsePotionCards(text) {
  const cards = [];
  const re = /data-inv="(\d+)"\s+data-item="(\d+)"\s+data-name="([^"]*)"\s+data-max="(\d+)"/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    cards.push({ invId: m[1], itemId: m[2], name: m[3], qty: parseInt(m[4], 10) });
  }
  return cards;
}

// Ladder picker: names are priority-ordered (e.g. small → large → full);
// first name with a matching card that still has quantity wins.
function choosePotion(cards, names) {
  const wanted = (names || []).map((n) => String(n).toLowerCase()).filter(Boolean);
  for (const w of wanted) {
    const hit = (cards || []).find(
      (c) => c.qty > 0 && String(c.name || '').toLowerCase().includes(w)
    );
    if (hit) return hit;
  }
  return null;
}

// Live capture of the drawer's Use button: POST use_item.php with the single
// field `inv_id=<data-inv>` — nothing else.
async function usePotionCard(game, card) {
  try {
    const res = await game.postForm('/use_item.php', { inv_id: String(card.invId) });
    const ok = res.status >= 200 && res.status < 300;
    logger.debug(`use_item.php inv_id=${card.invId} (${card.name}) → HTTP ${res.status} ${(res.text || '').slice(0, 60)}`);
    return ok;
  } catch (_) {
    return false;
  }
}

function drawerCards(game, cards) {
  if (Array.isArray(cards) && cards.length) return cards;
  return (game.lastPotions && game.lastPotions.cards) || [];
}

// Stamina ladder, drawer first (small → large → full by default), then the
// inventory.php slot-box scan as fallback ONLY when no drawer cards were
// ever seen (e.g. accounts that have not opened a battle page yet).
async function drinkStaminaPotion(game, cards) {
  const names = (game.cfg && game.cfg.potionSlotNames && game.cfg.potionSlotNames.length)
    ? game.cfg.potionSlotNames
    : ['small stamina potion', 'large stamina potion', 'full stamina potion'];
  const pool = drawerCards(game, cards);
  if (pool.length) {
    const card = choosePotion(pool, names);
    return card ? usePotionCard(game, card) : false;
  }
  return useInventoryItem(game, names);
}

// Heal path: HP potion from the drawer (default "full hp potion"), falling
// back to the free timed heal (user_heal_potion.php) when none is stocked.
async function drinkHealPotion(game, cards, userId) {
  const names = (game.cfg && game.cfg.hpPotionNames && game.cfg.hpPotionNames.length)
    ? game.cfg.hpPotionNames
    : ['full hp potion'];
  const pool = drawerCards(game, cards);
  if (pool.length) {
    const card = choosePotion(pool, names);
    if (card) return usePotionCard(game, card);
  }
  return executeHeal(game, userId);
}

// Mana ladder (port of the Veyra auto mana watcher): Mana Potion S first,
// then L — the same drawer → inventory fallback as the other ladders. The
// game accepts one drink per use_item.php POST, so one call = one potion.
async function drinkManaPotion(game, cards) {
  const names = (game.cfg && game.cfg.manaPotionNames && game.cfg.manaPotionNames.length)
    ? game.cfg.manaPotionNames
    : ['mana potion s', 'small mana potion', 'mana potion l', 'large mana potion'];
  const pool = drawerCards(game, cards);
  if (pool.length) {
    const card = choosePotion(pool, names);
    return card ? usePotionCard(game, card) : false;
  }
  return useInventoryItem(game, names);
}

// Default alias kept for the out-of-stamina combat path.
const useStaminaPotion = drinkStaminaPotion;

// Port of the "just view, no damage" action: GET battle.php?id=<monsterId>.
// The extension logs this as `Grabbed Link: …/battle.php?id={id}` when you
// open a battle without attacking. Besides the monster's dead-flag it reads
// YOUR hp (#pHpText) and the battleDrawer potion cards — the same data the
// game shows you when you open a fight. Zero stamina is spent.
async function viewBattle(game, monsterId) {
  const res = await game.get(`/battle.php?id=${encodeURIComponent(String(monsterId))}`, { redirect: 'manual' });
  return parseBattleView(res.text, monsterId);
}

// parseBattleView also reads the mob's loot table ("DMG req: X" cards) —
// the same pass the console loot scanner runs. maxDamageReq is the mob's
// best-loot damage threshold: the honest per-mob cap for wave farming.
function parseBattleView(html, monsterId) {
  const text = String(html || '');
  // The dead/lost markers must only match VISIBLE page text: the live battle
  // page embeds an error-message catalog in its JavaScript ("Monster is
  // already dead.", …) — a raw substring test flagged EVERY alive mob as
  // dead and silently starved every wave round ("reads dead — skipped").
  // Strip script/style bodies first; attributes (data-dead="1") survive.
  const visible = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const lower = visible.toLowerCase();
  const dead = lower.includes('data-dead="1"') || lower.includes('already dead');
  const found = text.includes(`data-monster-id="${String(monsterId)}"`) || !lower.includes('monster not found');
  let hp = null;
  const hpM = text.match(/id="pHpText"[^>]*>[^<]*?([\d,]+)\s*\/\s*([\d,]+)\s*HP/);
  if (hpM) {
    hp = {
      cur: parseInt(hpM[1].replace(/,/g, ''), 10),
      max: parseInt(hpM[2].replace(/,/g, ''), 10),
    };
  }
  const drops = loot.parseLootReqs(text);
  // AUTO_DIE_CFG = { nextDieMs: <epoch ms>, serverNowMs } — the 48h auto-die
  // bosses embed their true time-of-death on their own battle page (the Boss
  // Tracker / Veyra spawn timers read exactly this). Remaining life ≤ 24h =
  // phase 2, when damage finally counts toward the loot.
  const dieM = text.match(/nextDieMs\s*:\s*(\d+)/);
  const nextDieMs = dieM ? parseInt(dieM[1], 10) : null;
  // EXP meta stat blocks (the LevelUp Looter's readWaveExpMeta): the battle
  // card carries  EXP Cap ~1,500  and  EXP / DMG 0.02 — expected loot EXP =
  // min(your damage, cap) × rate. Drives the corpse sweep's best-EXP-first
  // order when looting to level up.
  let expCap = 0;
  let expRate = 0;
  const blockRe = /class=["'][^"']*stat-block[^"']*["'][^>]*>([\s\S]{0,300}?)<\/div>/gi;
  let bm;
  while ((bm = blockRe.exec(text)) !== null) {
    const block = bm[1];
    const labelM = block.match(/class=["'][^"']*label[^"']*["'][^>]*>([^<]+)</i);
    const label = labelM ? labelM[1].trim() : '';
    if (/exp cap/i.test(label)) {
      const capM = block.match(/~\s*([\d,]+)/);
      if (capM) expCap = parseInt(capM[1].replace(/,/g, ''), 10) || 0;
    } else if (/exp\s*\/\s*dmg/i.test(label)) {
      const rateM = block.match(/<strong[^>]*>([\d.]+)/i);
      if (rateM) expRate = parseFloat(rateM[1]) || 0;
    }
  }
  return {
    found,
    dead,
    hp,
    potions: parsePotionCards(text),
    loot: drops,
    maxDamageReq: loot.topDamageReq(drops),
    nextDieMs: Number.isFinite(nextDieMs) ? nextDieMs : null,
    expCap,
    expRate,
    viewedAt: Date.now(),
  };
}

// Port of performSmartLooting: burn last EXP gap via loot.php on saved ids.
// levelGroups: {min, max, categories[]} — simplified to capsForLevel output.
async function smartLooting(game, userId, level, requiredExp, allowedCategories, savedIdsByCategory) {
  let needed = requiredExp;
  for (const cat of allowedCategories) {
    if (needed <= 0) break;
    const ids = [...(savedIdsByCategory[cat] || [])];
    for (const mId of ids) {
      if (needed <= 0) break;
      try {
        const res = await game.postForm('/loot.php', { monster_id: String(mId), user_id: String(userId) });
        let json = {};
        try { json = JSON.parse(res.text); } catch (_) { json = {}; }
        if (json.status === 'success' && json.message) {
          const earned = json.message.match(/You earned <strong>([\d,]+) EXP<\/strong>/i);
          if (earned) needed -= parseInt(earned[1].replace(/,/g, ''), 10);
        } else if (json.status === 'error' && (json.message || '').toLowerCase().includes('monster not found')) {
          savedIdsByCategory[cat] = (savedIdsByCategory[cat] || []).filter((x) => String(x) !== String(mId));
        }
      } catch (_) { /* keep going */ }
      await game.pace(900, 1200);
    }
  }
  return needed <= 0;
}

// ── Phase 2 PVP solver (port of handlePhase2Battle) ───────────────────────────
// Pings pvp_style_state.php every ~2s so the server keeps the duel session
// warm, attacks via pvp_style_action.php with the adv: skill ladder, steps
// down on "not enough tokens", ramps up every 4 successes.
async function handlePhase2Battle(game, monsterId, boss, onEvent, hitDelayMs) {
  const label = boss ? boss.name.split(' ')[0].replace(/,/g, '').toUpperCase() : 'BOSS';
  onEvent && onEvent(`boss ${label} shifted to phase 2 PVP`);

  let tierIdx = 1; // start at 10x, like the extension
  let successCount = 0;
  let fails = 0;
  let stalls = 0;

  let heartbeatStop = false;
  const heartbeat = (async () => {
    while (!heartbeatStop) {
      try {
        await game.get(`/pvp_style_state.php?source=monster_phase&since_log_id=3&active_id=${monsterId}`, { redirect: 'manual' });
      } catch (_) { /* best-effort */ }
      await sleep(hitDelayMs * 2);
    }
  })();

  try {
    for (;;) {
      const payload = `source=monster_phase&action=use_skill&active_id=${monsterId}` +
        `&skill_id=${encodeURIComponent(PVP_SKILL_TIERS[tierIdx].id)}` +
        `&target_key=${encodeURIComponent(`enemy:monster_phase:${monsterId}`)}`;

      let json = null;
      try {
        const res = await game.request('/pvp_style_action.php', { method: 'POST', body: payload });
        try { json = JSON.parse(res.text); } catch (_) { json = null; }
      } catch (_) {
        json = null; // timeout/network → treat as stall
      }

      if (!json) {
        stalls++;
        onEvent && onEvent(`phase2 stall #${stalls} — pinging pvp_style_state`);
        try {
          await game.get(`/pvp_style_state.php?source=monster_phase&since_log_id=3&active_id=${monsterId}`, { redirect: 'manual' });
        } catch (_) { /* ignore */ }
        if (stalls >= 3) {
          await sleep(hitDelayMs * 3);
          stalls = 0;
        }
        continue;
      }
      stalls = 0;

      if (json.ok === true) {
        fails = 0;
        if (json.battle_ended || (json.message || '').toLowerCase().includes('ended')) {
          onEvent && onEvent(`phase2 duel won → back to phase 3`);
          return 'P2_DONE';
        }
        successCount++;
        if (successCount % 4 === 0 && tierIdx < PVP_SKILL_TIERS.length - 1) {
          tierIdx++;
          onEvent && onEvent(`phase2 ramping to ${PVP_SKILL_TIERS[tierIdx].cost}x`);
        }
      } else {
        const msg = (json.message || '').toLowerCase();
        if (msg.includes('not your turn')) {
          fails++;
          if (fails >= 4) {
            try {
              await game.get(`/pvp_style_state.php?source=monster_phase&since_log_id=3&active_id=${monsterId}`, { redirect: 'manual' });
            } catch (_) { /* ignore */ }
            fails = 0;
          }
        } else if (msg.includes('not enough tokens')) {
          fails = 0;
          if (tierIdx > 0) tierIdx--;
          successCount = 0;
        } else if (msg.includes('this phase duel is not active')) {
          return 'P2_DONE';
        } else if (msg.includes('over') || msg.includes('defeat')) {
          return 'P2_DONE';
        } else {
          try {
            await game.get(`/pvp_style_state.php?source=monster_phase&since_log_id=3&active_id=${monsterId}`, { redirect: 'manual' });
          } catch (_) { /* ignore */ }
        }
      }
      await sleep(hitDelayMs);
    }
  } finally {
    heartbeatStop = true;
  }
}

// ── Main combat loop (port of executeCombatLoop) ──────────────────────────────
// Returns one of: FINISHED | DEAD | OUT_OF_STAMINA | NOT_PHASE_3 | ERROR
async function combatLoop({ game, userId, monsterId, cap, boss, level, onEvent, savedIdsByCategory }) {
  const cfg = game.cfg;
  const hitDelay = cfg.hitDelayMs;
  const label = boss ? boss.name.split(' ')[0].replace(/,/g, '').toUpperCase() : 'BOSS';

  // Join the battle. Live captures POST all three fields — the extension's
  // boss traffic sent monster_id & user_id, the wave client adds id — the
  // game accepts the superset, so we speak it.
  let joinText = '';
  try {
    const joinRes = await game.postForm('/user_join_battle.php', {
      id: String(monsterId),
      monster_id: String(monsterId),
      user_id: String(userId),
    });
    joinText = (joinRes.text || '').toLowerCase();
  } catch (e) {
    onEvent && onEvent(`join ${label} failed: ${e.message}`);
    return 'ERROR';
  }
  if (joinText.includes('already dead') || joinText.includes("can't attack")) {
    onEvent && onEvent(`${label} already dead / not attackable`);
    return 'DEAD';
  }

  let currentDamage = 0;
  let baseDamage = 0;
  let markedTurns = 0;
  let tierIdx = 5; // default max tier (1000x)
  let currentTierCost = '0';
  let consecutiveTierCount = 0;
  let isVerifyingFinish = false;
  let loopGuard = 0;
  let hitCount = 0;
  let lastPotionAt = 0;

  // HP watch: the fight page (battle.php?id=…) carries YOUR hp and the battle
  // drawer — check it once on join, then every 30 hits, healing when the
  // configured HP% floor is breached. View-only, so it never costs stamina.
  const hpWatch = async () => {
    if (!game.cfg.hpPotionBelowPct) return;
    try {
      const view = await viewBattle(game, monsterId);
      if (view.hp && view.hp.max > 0 && Date.now() - lastPotionAt >= game.cfg.potionCooldownMs) {
        const pct = (view.hp.cur / view.hp.max) * 100;
        if (pct < game.cfg.hpPotionBelowPct) {
          if (await drinkHealPotion(game, view.potions, userId)) {
            lastPotionAt = Date.now();
            onEvent && onEvent(`HP ${Math.round(pct)}% → heal potion used`);
          }
        }
      }
    } catch (_) { /* watch is best-effort */ }
  };
  await hpWatch();

  // Port of getOptimalTierIndex incl. v444 tail optimization (cap 100x).
  function getOptimalTierIndex(remDmg, baseDmg) {
    if (!baseDmg || baseDmg <= 0) return 5;
    let exactIdx = 0;
    for (let i = SKILL_TIERS.length - 1; i >= 0; i--) {
      if (baseDmg * SKILL_TIERS[i].cost <= remDmg) { exactIdx = i; break; }
    }
    if (exactIdx === 0 && remDmg > baseDmg) {
      for (let i = 1; i <= 3; i++) {
        if (baseDmg * SKILL_TIERS[i].cost <= remDmg * 2) return i;
      }
    }
    return exactIdx;
  }

  for (;;) {
    if (++loopGuard > 4000) { // absolute runaway guard
      onEvent && onEvent(`${label} loop guard hit — bailing out`);
      return 'ERROR';
    }

    // Cap check + verification probe (same two-pass logic as the extension).
    if (currentDamage >= cap) {
      if (!isVerifyingFinish) {
        onEvent && onEvent(`${label} target reached in calc (${Math.round(currentDamage)} / ${cap}) — verifying`);
        isVerifyingFinish = true;
        baseDamage = 0;
      } else {
        return 'FINISHED';
      }
    }

    let skillId = '0';
    let stamCost = '1';
    let isProbe = false;

    if (baseDamage === 0) {
      isProbe = true; // 1x probe
    } else if (markedTurns > 0) {
      markedTurns--;
    } else {
      const remainingNeeded = cap - currentDamage;
      const optimalIdx = getOptimalTierIndex(remainingNeeded, baseDamage);
      tierIdx = Math.min(tierIdx, optimalIdx);
      skillId = SKILL_TIERS[tierIdx].id;
      stamCost = String(SKILL_TIERS[tierIdx].cost);
    }

    // Attack: damage.php monster_id & skill_id & stamina_cost.
    let json = {};
    try {
      const res = await game.postForm('/damage.php', {
        monster_id: String(monsterId),
        skill_id: skillId,
        stamina_cost: stamCost,
      });
      await sleep(hitDelay);
      try { json = JSON.parse(res.text); } catch (_) { json = {}; }
    } catch (e) {
      onEvent && onEvent(`${label} damage.php network error: ${e.message}`);
      await sleep(hitDelay * 2);
      continue;
    }

    // Phase-3 guard (boss.phase === 3 configs).
    if (boss && boss.phase === 3 && json.phase && json.phase.current !== undefined && json.phase.current !== 3) {
      return 'NOT_PHASE_3';
    }

    if (json.status === 'error') {
      const msg = (json.message || '').toLowerCase();

      // The game rejects manual damage while ITS OWN auto-farm runs. The
      // engine never touches auto_farm_actions.php (autoFarmPanel is off
      // limits) — surface it once and stop this fight; the worker warns.
      if (msg.includes('auto farm is on')) {
        onEvent && onEvent('the in-game auto-farm is ON — switch it off on the wave page; the engine does not manage it');
        return 'AUTO_FARM_ON';
      }

      if (msg.includes('pvp duel phase') || msg.includes('defeat that form first')) {
        const p2 = await handlePhase2Battle(game, monsterId, boss, onEvent, hitDelay);
        if (p2 === 'P2_DONE') continue;
        return 'ERROR';
      }

      if (msg.includes('dead') || msg.includes('died')) {
        if (msg.includes('monster') || msg.includes('already dead')) return 'DEAD';
        if (!(await executeHeal(game, userId))) return 'DEAD';
        continue;
      }

      if (msg.includes('not enough stamina')) {
        if (tierIdx > 0) {
          tierIdx--;
          onEvent && onEvent(`${label} stamina low → step down to ${SKILL_TIERS[tierIdx].cost}x`);
        } else {
          const exp = await getExpStatus(game);
          let handled = false;
          if (exp && exp.percentExp >= 80 && exp.requiredExp <= 40000000 && savedIdsByCategory) {
            handled = await smartLooting(game, userId, level, exp.requiredExp, ['generals', 'heralds'], savedIdsByCategory);
          }
          if (!handled) {
            if (!(await drinkStaminaPotion(game))) return 'OUT_OF_STAMINA';
            lastPotionAt = Date.now();
            onEvent && onEvent(`${label} used stamina potion`);
          }
          baseDamage = 0;
          tierIdx = 5;
        }
        continue;
      }

      // Unknown error → short backoff, keep going (bounded by loopGuard).
      logger.debug(`combat unknown error vs ${label}: ${json.message || '(none)'}`);
      await sleep(hitDelay * 2);
      continue;
    }

    if (json.status === 'success') {
      hitCount++;
      if (hitCount % 30 === 0) await hpWatch(); // periodic HP check mid-fight
      let hitDamage = 0;
      const dmgMatch = json.message ? json.message.match(/<strong>([\d,]+)<\/strong>/) : null;
      if (dmgMatch) hitDamage = Number(dmgMatch[1].replace(/,/g, ''));
      currentDamage = json.totaldmgdealt !== undefined ? Number(json.totaldmgdealt) : currentDamage + hitDamage;

      if (isProbe && hitDamage > 0) {
        baseDamage = hitDamage;
        onEvent && onEvent(`${label} probe hit ${hitDamage} — optimizing`);
        if (isVerifyingFinish) {
          if (currentDamage < cap) {
            isVerifyingFinish = false;
          } else {
            return 'FINISHED';
          }
        }
      }

      if (json.message && /marked you for/i.test(json.message)) {
        markedTurns = 2;
      }

      if (!isProbe && hitDamage > 0) {
        if (stamCost === currentTierCost) consecutiveTierCount++;
        else { currentTierCost = stamCost; consecutiveTierCount = 1; }
        if (needsReProbe(stamCost, consecutiveTierCount)) {
          baseDamage = 0;
          tierIdx = 5;
          consecutiveTierCount = 0;
        }
      }
      continue;
    }

    // Non-JSON garbage → backoff.
    await sleep(hitDelay * 2);
  }
}

// ── Bus dive (fleet hunt) ─────────────────────────────────────────────────────
// "I want to attack all Troll Ravager" — the scout publishes every live mob
// id it sees to the TargetBus; a diver with dive targets hits the MATCHING
// bus ids directly (join + slash to death), whatever wave page they live on,
// BEFORE the pinned-wave round. The bus is never cached: ids come from the
// scout's latest sweep and expired instances are skipped. cap=Infinity means
// each account fights its target until it dies — a fleet of accounts stacks
// on the same mob id and kills it fast; the next cycle picks the fresh ids.
async function diveBusRound({ game, userId, cfg, busMobs, targets, onEvent, shouldAbort }) {
  const divers = require('./divers');
  const round = { attacked: 0, slain: 0, capped: 0, looted: 0, stopped: null, targets: [] };
  const list = (busMobs || []).filter((m) => m && m.id && divers.matchDive(m.name, targets));
  if (!list.length) return round;
  round.targets = list.slice(0, 12).map((m) => `${m.name || 'mob'} (${m.id})`);
  const maxMobs = cfg.waveMobsPerRound;
  for (const mob of list.slice(0, maxMobs)) {
    const sta = game.lastStamina;
    if (sta && sta.cur < 1) {
      round.stopped = 'OUT_OF_STAMINA';
      onEvent && onEvent(`bus dive: out of stamina — stopping`);
      break;
    }
    // The instance may have auto-died since the sweep — expired ids are
    // skipped without spending the free view (the next sweep replaces them).
    if (mob.expiresAt && mob.expiresAt < Date.now()) continue;
    const result = await waveCombat({
      game,
      userId,
      monsterId: mob.id,
      cap: Infinity,
      floor: 0,
      startDamage: 0,
      onEvent,
      shouldAbort,
    });
    round.attacked++;
    if (result === 'ABORTED') { round.stopped = 'SWARM_PREEMPT'; break; }
    if (result === 'SLAIN') round.slain++;
    if (result === 'FINISHED') round.capped++;
    if (result === 'SLAIN' && cfg.waveLootKills) {
      try {
        const corpses = require('./corpses');
        const lr = await corpses.lootCorpse(game, userId, mob.id);
        if (lr.ok) {
          round.looted++;
          onEvent && onEvent(`${mob.name || mob.id} looted — ${lr.message}`);
        }
      } catch (_) { /* loot hiccup — corpse sweep collects it */ }
    }
    if (result === 'AUTO_FARM_ON') { round.stopped = 'AUTO_FARM_ON'; break; }
    if (result === 'OUT_OF_STAMINA') { round.stopped = 'OUT_OF_STAMINA'; break; }
    await game.pace(cfg.paceMinMs, cfg.paceMaxMs);
  }
  return round;
}

module.exports = {
  SKILL_TIERS,
  PVP_SKILL_TIERS,
  discoverOnWave,
  parseWaveMonsters,
  matchBossName,
  parseWaveCards,
  parseWaveRewardCap,
  waveCombat,
  waveFarmRound,
  diveBusRound,
  minDamageFor,
  executeHeal,
  getExpStatus,
  useInventoryItem,
  parsePotionCards,
  choosePotion,
  usePotionCard,
  drinkStaminaPotion,
  drinkHealPotion,
  drinkManaPotion,
  useStaminaPotion,
  viewBattle,
  parseBattleView,
  readAutoFarmStatus,
  disableAutoFarm,
  smartLooting,
  handlePhase2Battle,
  combatLoop,
};
