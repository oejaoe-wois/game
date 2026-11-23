'use strict';
// skilltree.js — the class skill tree (class_skill_tree.php): read the tree,
// spend Adv. Points, level the skills that matter for farming.
//
// Live page anatomy (2026-11, Mage + Cleric accounts verified):
//   The page embeds two globals and renders the 3-D tree client-side:
//
//     window.SkillTreeData = [{ id: 4, name: "Fireball", branch: 1, …,
//       unlock_level: 1, adv_points_req: 0,          ← unlock cost (AP)
//       mana_cost: 30, stamina_cost: 200,
//       flat_stam_dmg: 20000,                        ← PvE flat damage / cast
//       owned: false, level: 0, used_times: 0, max_level: 2,
//       level_rules: [{ level: 2, times_used: 0, adv_points: 2000,
//                       min_rank_id: 2, flat_damage_stamina: 30000, … }],
//       next_rule: { …the next level's rule or null } }, …];
//     window.SkillTreeConfig = { ajaxUrl: "/class_skill_tree.php",
//       className: "Mage", totalSkills: 3, ownedCount: 0, advExp: 0, … };
//       // ← NEW   (a trailing comment — never JSON.parse this object raw)
//
//   Upgrade POSTs go back to the same URL, urlencoded:
//     action=unlock_skill&skill_node_id=<id>   → {ok:true, level, used_times,
//                                                 adv_points_left} | {ok:false,error}
//     action=level_up&skill_node_id=<id>       → same shape
//
// Where Adv. Points come from: Adventurers Guild contracts pay AP
// ("100 AP • 10,000 Gold") — the quest engine and this module form one loop:
// quests earn AP, this module spends it.
//
// Spend policy (FARM optimal, mirrors the class-pick ranking):
//   1. PvE damage skills first — the skill that turns stamina into quest
//      damage ("min 3m dmg" floors). Ranked by damage-per-stamina.
//   2. Then everything else (utility/passives/PvP) while points remain.
//   The FIRST damage skill of the farm classes unlocks FREE (Mage Fireball
//   adv_points_req=0) — a freshly classed account gets its damage skill on
//   the first pass even at 0 AP.
//   Gates honored per skill: unlock_level (char level — Mana Shield asks 200),
//   next_rule.adv_points (level cost), next_rule.times_used (mastery: the
//   skill must be USED in battle N times before the next level), and the
//   server's own refusals (rank floors etc. — recorded, never fatal).
//
// Config (config.js skillTree): enabled · cooldownMs · reserve (AP kept
// unspent) · maxSpends (POST cap per round). Env: SKILL_TREE, 
// SKILL_TREE_COOLDOWN_MS, SKILL_TREE_RESERVE, SKILL_TREE_MAX_SPENDS.
const { logger } = require('./util');

// ── parsing ─────────────────────────────────────────────────────────────────
// window.SkillTreeData is a clean JSON array (extracted, then JSON.parse).
function parseTreeData(html) {
  const m = String(html || '').match(/window\.SkillTreeData\s*=\s*(\[[\s\S]*?\])\s*;\s*window\.SkillTreeConfig/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

// window.SkillTreeConfig carries a trailing `// …` comment, so field-wise
// regex extraction instead of JSON.parse. Missing fields stay null.
function parseTreeConfig(html) {
  const m = String(html || '').match(/window\.SkillTreeConfig\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return null;
  const body = m[1];
  const str = (k) => (body.match(new RegExp(`${k}\\s*:\\s*"([^"]*)"`)) || [])[1] || null;
  const num = (k) => {
    const v = (body.match(new RegExp(`${k}\\s*:\\s*(-?\\d+)`)) || [])[1];
    return v === undefined ? null : Number(v);
  };
  return {
    ajaxUrl: str('ajaxUrl') ? str('ajaxUrl').replace(/\\\//g, '/') : null,
    className: str('className'),
    totalSkills: num('totalSkills'),
    ownedCount: num('ownedCount'),
    advExp: num('advExp'),
    classPassive: str('classPassive'),
  };
}

// Full page read → { data: skills[] | null, config: {...} | null, className,
// points, ownedCount, totalSkills } — data=null means classless (or unknown
// shape); callers no-op on that.
function parseSkillTree(html) {
  const data = parseTreeData(html);
  const config = parseTreeConfig(html);
  return {
    data,
    config,
    className: (config && config.className) || null,
    points: (config && Number.isFinite(config.advExp)) ? config.advExp : null,
    ownedCount: (config && config.ownedCount) || 0,
    totalSkills: (config && config.totalSkills) || (data ? data.length : 0),
  };
}

// ── spend plan ──────────────────────────────────────────────────────────────
// A PvE damage skill spends stamina to deal flat damage (flat_stam_dmg at
// the current level, flat_damage_stamina per level rule). Everything else
// (buffs, shields, PvP exchanges, heals) ranks after.
function isDamageSkill(skill) {
  if (!skill) return false;
  if (Number(skill.stamina_cost) > 0
    && (Number(skill.flat_stam_dmg) > 0
      || (Array.isArray(skill.level_rules)
        && skill.level_rules.some((r) => Number(r.flat_damage_stamina) > 0)))) return true;
  return false;
}

// Damage per stamina of the NEXT level (the thing the AP buys); 0 when the
// level adds no damage (pure cost levels still rank by the current flat).
function nextDamagePerStamina(skill) {
  const stam = Number(skill.stamina_cost) || 0;
  const nr = skill.next_rule;
  const flat = nr ? Number(nr.flat_damage_stamina) || 0 : 0;
  if (stam <= 0) return 0;
  return flat / stam;
}

// The next action for one skill: {action:'unlock'|'level_up', cost, skill}
// or null (maxed / mastery-gated). Gates the caller cannot see (char level)
// are left to the caller; server-side gates surface as refusals.
function nextActionFor(skill) {
  if (!skill) return null;
  if (!skill.owned) {
    return { action: 'unlock', cost: Number(skill.adv_points_req) || 0, skill };
  }
  const level = Number(skill.level) || 0;
  const maxLevel = Number(skill.max_level) || 0;
  if (maxLevel > 0 && level >= maxLevel) return null;
  const nr = skill.next_rule;
  if (!nr) return null; // no rule published → the game gates it some other way
  const needUses = Number(nr.times_used) || 0;
  if (needUses > (Number(skill.used_times) || 0)) return null; // mastery: use it in battle first
  return { action: 'level_up', cost: Number(nr.adv_points) || 0, skill };
}

// Order the skills the way AP should be spent: damage skills first (by the
// damage-per-stamina the next level buys, then by cost so cheap unlocks go
// first), everything else after. Stable — equal keys keep page order.
function planOrder(skills) {
  return skills.map((s) => {
    const dmg = isDamageSkill(s);
    const act = nextActionFor(s);
    const dps = dmg ? nextDamagePerStamina(s) : 0;
    return { s, dmg, act, dps };
  })
    .sort((a, b) => (
      Number(b.dmg) - Number(a.dmg)
      || b.dps - a.dps
      || ((a.act ? a.act.cost : Infinity) - (b.act ? b.act.cost : Infinity))
    ))
    .map((x) => x.s);
}

// ── POSTs ───────────────────────────────────────────────────────────────────
async function treePost(game, action, skillId) {
  // The wire protocol (the page's own AjaxActions): action=unlock_skill |
  // level_up. The plan's internal 'unlock' maps to 'unlock_skill' here.
  const wire = action === 'unlock' ? 'unlock_skill' : String(action);
  const res = await game.postForm('/class_skill_tree.php', {
    action: wire,
    skill_node_id: String(skillId),
  });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { ok: false, error: (res.text || '').slice(0, 120) }; }
  return json;
}

// One upgrade round:
//   1. GET class_skill_tree.php → no SkillTreeData = classless/unknown → no-op.
//   2. Order the tree (damage first), walk it: unlock the locked skills and
//      level the owned ones while the point wallet (page advExp, refreshed
//      from every response's adv_points_left) affords cost + reserve.
//   3. Char-level gate: skills with unlock_level above the account's known
//      level are noted and skipped this round (no wasted POST). Unknown
//      level (0/null) → let the server decide.
//   4. Every POST result is recorded; refusals never stop the round (a
//      rank-gated skill just parks until its floor is reachable).
// opts: { reserve, maxSpends, level, fastTest } — pacing via game.pace().
async function upgradeRound(game, opts = {}) {
  const report = {
    checkedAt: Date.now(),
    className: null, pointsStart: null, pointsLeft: null,
    unlocked: [], leveled: [], refused: [], skipped: [], notes: [],
    spent: 0,
  };
  let res;
  try {
    res = await game.get('/class_skill_tree.php', { redirect: 'manual' });
  } catch (e) {
    report.notes.push(`tree page failed: ${e.message}`);
    return report;
  }
  if (res.status === 302 && /game_login|signout/i.test(res.location || '')) {
    report.notes.push('not logged in');
    return report;
  }
  const tree = parseSkillTree(res.text);
  report.className = tree.className;
  if (!tree.data) {
    report.notes.push('no skill tree on the page (classless?) — nothing to upgrade');
    return report;
  }

  const reserve = Number.isFinite(Number(opts.reserve)) ? Math.max(0, Number(opts.reserve)) : 0;
  const maxSpends = Number(opts.maxSpends) > 0 ? Number(opts.maxSpends) : 10;
  const level = Number(opts.level) || 0;
  let points = Number(tree.points);
  if (!Number.isFinite(points)) {
    // Page did not expose advExp — try one skill unlock anyway? No: without
    // a wallet number we could only overspend blindly. Report and stop.
    report.notes.push('page did not expose the Adv. Point wallet — skipped this round');
    return report;
  }
  report.pointsStart = points;
  report.pointsLeft = points;

  let spends = 0;
  for (const skill of planOrder(tree.data)) {
    if (spends >= maxSpends) {
      report.notes.push(`spend cap ${maxSpends} reached — rest next round`);
      break;
    }
    const act = nextActionFor(skill);
    if (!act) {
      // Maxed, or mastery-gated (needs battle uses) — worth a state note once.
      if (skill.owned && skill.next_rule && Number(skill.next_rule.times_used) > (Number(skill.used_times) || 0)) {
        report.skipped.push({ id: skill.id, name: skill.name, reason: `needs ${skill.next_rule.times_used} battle use(s) (has ${skill.used_times || 0})` });
      }
      continue;
    }
    // Character-level gate (only when we know the level).
    const unlockLevel = Number(skill.unlock_level) || 0;
    if (level > 0 && unlockLevel > level) {
      report.skipped.push({ id: skill.id, name: skill.name, reason: `needs char level ${unlockLevel} (account ${level})` });
      continue;
    }
    if (points - act.cost < reserve) {
      // Nothing else can be cheaper than the cheapest remaining action…
      // but the list is cost-ordered only inside the damage/utility split,
      // so keep walking: a later 0-cost unlock (the free damage skill) may
      // still fit when reserve is 0 and this one does not.
      if (act.cost > 0 && points < reserve) break; // wallet below reserve outright
      if (act.cost > 0 && points - act.cost < reserve) continue; // this one too dear, try the next
    }
    await game.pace(600, 1400);
    let json;
    try {
      json = await treePost(game, act.action, skill.id);
    } catch (e) {
      report.refused.push({ id: skill.id, name: skill.name, action: act.action, error: e.message });
      continue;
    }
    spends++;
    if (json && json.ok) {
      const entry = { id: skill.id, name: skill.name, action: act.action, cost: act.cost, ok: true };
      if (act.action === 'unlock') {
        report.unlocked.push(entry);
        logger.info(`skilltree: unlocked ${skill.name} (${report.className}) — cost ${act.cost} AP`);
      } else {
        entry.level = Number(json.level) || (Number(skill.level) || 0) + 1;
        report.leveled.push(entry);
        logger.info(`skilltree: ${skill.name} → level ${entry.level} — cost ${act.cost} AP`);
      }
      if (Number.isFinite(Number(json.adv_points_left))) {
        points = Number(json.adv_points_left);
        report.pointsLeft = points;
      } else {
        points -= act.cost; // response lacked the wallet — fall back to arithmetic
        report.pointsLeft = points;
      }
      report.spent++;
    } else {
      const err = String((json && json.error) || 'unknown refusal').slice(0, 140);
      report.refused.push({ id: skill.id, name: skill.name, action: act.action, cost: act.cost, error: err });
      // A refusal on an unlock means the game wants something we cannot see
      // (rank floor, event gate). Park THIS skill; the rest may still spend.
    }
  }
  return report;
}

// One-line summary for logs/panel.
function summarize(report) {
  if (!report) return '';
  const parts = [];
  if (report.unlocked && report.unlocked.length) parts.push(`unlocked ${report.unlocked.map((u) => u.name).join(', ')}`);
  if (report.leveled && report.leveled.length) parts.push(`leveled ${report.leveled.map((l) => `${l.name}→lv${l.level}`).join(', ')}`);
  if (report.refused && report.refused.length) parts.push(`${report.refused.length} refused`);
  if (!parts.length) return report.notes && report.notes.length ? report.notes[0] : 'nothing to spend';
  return parts.join(' · ');
}

module.exports = {
  parseTreeData, parseTreeConfig, parseSkillTree,
  isDamageSkill, nextActionFor, planOrder,
  treePost, upgradeRound, summarize,
};
