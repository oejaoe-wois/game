'use strict';
// battlepass.js — the Battle Pass (battle_pass.php), ready BEFORE the next
// season drops:
//
//   Season off (live-verified): the page renders a 252-byte
//   "No Battle Pass season available. Come back later." — a clean no-op.
//
//   Season on (player intel on how it runs): typically TWO daily quests
//   that reset with the season day:
//     • "Spend 500 stamina" — accrues from the engine's own farming (every
//       Slash costs stamina), nothing extra to do.
//     • "Deal 300,000 damage to Lizard / Sea mobs" (the mob family rotates
//       per season) — while this quest is incomplete the engine steers wave
//       farming toward waves whose mob names match the quest's keywords,
//       and within a wave the matching mobs are attacked FIRST. Every hit
//       then feeds both the farm and the quest.
//   Claiming: the game's own claim-btn convention (achievements.php and
//   collections.php render the exact same pattern — an enabled
//   <button class="claim-btn" onclick="claimXxx(ID)"> once the reward is
//   ready, disabled while it is not). The parser reads the page's OWN
//   claim handlers + POST endpoint + csrf out of the inline JS, so a
//   season with extra reward rows still claims everything ready. Nothing
//   is spent — battle pass claims are pure rewards.
const { logger } = require('./util');

// "No Battle Pass season available." → nothing to do.
function isInactive(html) {
  return /No Battle Pass season available/i.test(String(html || ''));
}

// The season's csrf, by the game's own inline-JS conventions:
//   const csrf = "…";  /  csrf:"…"  /  <input name="csrf_token" value="…">
function parseCsrf(html) {
  const text = String(html || '');
  const m = text.match(/csrf["'\s::=]+["']([0-9a-f]{16,64})["']/i)
    || text.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// The claim POST endpoint, read from the page's own JS (the achievements /
// collections pages all embed `fetch('xxx_claim.php', …)`); fall back to
// the conventional name. Also pick up the id field name the page itself
// uses in its claim body (ach_id / collection_id / quest_id / reward_id …).
function parseEndpoint(html) {
  const text = String(html || '');
  const scripts = text.match(/<script[\s\S]*?<\/script>/gi) || [];
  let endpoint = null;
  let field = null;
  for (const s of scripts) {
    if (!endpoint) {
      const em = s.match(/([a-z0-9_]*battle_pass[a-z0-9_]*claim[a-z0-9_]*\.php)/i)
        || s.match(/([a-z0-9_]*claim[a-z0-9_]*\.php)/i);
      if (em) endpoint = em[1];
    }
    if (!field) {
      // body: new URLSearchParams({ quest_id: id, csrf }) — or fetch bodies
      // built the same way anywhere on the page.
      const fm = s.match(/(\w*_id)\s*[:=]\s*(?:id|cardId|questId|rewardId)/i);
      if (fm) field = fm[1];
    }
  }
  return { endpoint: endpoint || 'battle_pass_claim.php', field: field || 'quest_id' };
}

// Split the page into quest/reward card chunks (the game's .card /
// .quest-row conventions) and read each one's title, objective, progress
// and claim affordance. Only chunks with something actionable survive.
function parseQuestRows(html) {
  const text = String(html || '');
  const re = /<div[^>]*class=["'][^"']*(?:quest-row|quest-card|bp-row|bp-card|card)["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : undefined);
    const clean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = clean((chunk.match(/<h[1-5][^>]*>([\s\S]*?)<\/h[1-5]>/i) || [])[1]
      || (chunk.match(/class=["'][^"']*(?:quest-main-title|bp-title|card-title)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    const objectiveM = chunk.match(/class=["'][^"']*(?:quest-req-text|bp-desc|objective)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div)>/i)
      || chunk.match(/>([^<>]*(?:damage|dmg|stamina|kill|defeat|slay|deliver|spend|use)[^<>]*)</i);
    const progressM = chunk.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    const claimM = chunk.match(/<button[^>]*claim-btn[^>]*>/i);
    const idM = chunk.match(/on\w+\s*=\s*["'][\w]*claim[\w]*\((\d+)/i)
      || chunk.match(/data-(?:\w*-)?id=["']?(\d+)["']?/i);

    const row = {
      title,
      objective: clean(objectiveM ? objectiveM[1] : ''),
      progress: progressM
        ? { cur: parseInt(progressM[1].replace(/,/g, ''), 10), max: parseInt(progressM[2].replace(/,/g, ''), 10) }
        : null,
      claimId: claimM && idM ? idM[1] : null,
      claimReady: !!(claimM && !/disabled/i.test(claimM[0])),
      tier: /tier/i.test(chunk),
    };
    if (row.claimId || row.progress || row.objective) rows.push(row);
  }
  return rows;
}

// Fold the rows into quests (one entry per claimable row) and the list of
// rewards that can be claimed right now (enabled claim buttons).
function summarize(rows) {
  const quests = rows.filter((r) => !r.tier && (r.objective || r.progress));
  const claimReady = rows.filter((r) => r.claimId && r.claimReady).map((r) => ({
    id: r.claimId,
    tier: r.tier,
    title: r.title,
  }));
  return { quests, claimReady };
}

// Extract what the farming loop needs from the quest objectives:
//   • needStamina — "Spend 500 Stamina"
//   • needDamage  — "Deal 300,000 damage to Lizard mobs"
//   • needKills   — "Kill 10 Sea Serpents"
//   • keywords    — the mob family words (lizard / sea / serpent …) pulled
//     from a curated lexicon PLUS any other noun the objective carries, so
//     an unseen season family still steers the wave picks.
const STOPWORDS = new Set([
  'deal', 'deals', 'damage', 'dmg', 'spend', 'spent', 'stamina', 'kill', 'kills',
  'defeat', 'slay', 'mobs', 'mob', 'monster', 'monsters', 'any', 'today', 'reward',
  'rewards', 'points', 'pass', 'battle', 'quest', 'quests', 'daily', 'your', 'them',
  'their', 'with', 'from', 'using', 'while', 'this', 'that', 'have', 'complete',
  'completed', 'progress', 'earn', 'gain', 'make', 'more', 'than', 'then', 'when',
  'gold', 'gems', 'exp', 'level', 'enemies', 'enemy', 'waves', 'wave',
]);
const FAMILY_LEXICON = [
  'lizard', 'lizardman', 'sea', 'ocean', 'oceanic', 'tide', 'tidal', 'reef', 'coral',
  'abyss', 'abyssal', 'kraken', 'serpent', 'naga', 'shark', 'crab', 'eel', 'fish',
  'siren', 'triton', 'leviathan', 'hydra', 'drake', 'mire', 'marsh', 'swamp',
];

function questHint(quests) {
  const hint = { needStamina: null, needDamage: null, needKills: null, keywords: [], incomplete: false };
  for (const q of quests) {
    const obj = String(q.objective || '');
    const p = q.progress;
    const open = !p || p.cur < p.max;
    if (open) hint.incomplete = true;

    if (!hint.needStamina) {
      const m = obj.match(/(?:spend|use)\s+([\d,]+)\s*stamina/i);
      if (m) hint.needStamina = parseInt(m[1].replace(/,/g, ''), 10);
    }
    if (!hint.needDamage) {
      const m = obj.match(/([\d,]+)\s*(?:damage|dmg)/i);
      if (m) hint.needDamage = parseInt(m[1].replace(/,/g, ''), 10);
    }
    if (!hint.needKills) {
      const m = obj.match(/(?:kill|defeat|slay)\s+([\d,]+)/i);
      if (m) hint.needKills = parseInt(m[1].replace(/,/g, ''), 10);
    }

    // Keywords come from the curated family lexicon first (that is what
    // "lizard or sea mobs" means), then any other noun-looking word in the
    // objective — an unseen family still gets picked up.
    const lower = obj.toLowerCase();
    for (const w of FAMILY_LEXICON) {
      if (lower.includes(w) && !hint.keywords.includes(w)) hint.keywords.push(w);
    }
    if (open && (hint.needDamage || hint.needKills)) {
      for (const raw of lower.match(/[a-z]{4,}/g) || []) {
        if (STOPWORDS.has(raw) || FAMILY_LEXICON.includes(raw)) continue;
        if (!hint.keywords.includes(raw)) hint.keywords.push(raw);
      }
    }
  }
  // A quest that only asks for stamina has no wave to steer toward.
  if (!hint.needDamage && !hint.needKills) hint.keywords = [];
  return hint;
}

// Wave priority: remembered matching waves first, never-visited next,
// known non-matching last. Pure + stable so the round-robin order is
// preserved inside each bucket.
function orderWaves(list, memory) {
  const score = (w) => (memory.get(w.path) === 'match' ? 0 : memory.get(w.path) === 'nomatch' ? 2 : 1);
  return list.map((w, i) => ({ w, i }))
    .sort((a, b) => score(a.w) - score(b.w) || a.i - b.i)
    .map((x) => x.w);
}

// One battle pass round: read the page, claim everything ready, report the
// quest progress + the farming hint for the worker to act on.
async function battlePassRound(game) {
  const report = { active: null, quests: [], hint: null, claimed: 0, messages: [], notes: [] };
  let html = '';
  try {
    const res = await game.get('/battle_pass.php', { redirect: 'manual' });
    html = res.text || '';
  } catch (e) {
    report.notes.push(`battle pass page failed: ${e.message}`);
    return report;
  }
  if (isInactive(html)) {
    report.active = false;
    report.notes.push('no battle pass season live — no-op');
    return report;
  }
  report.active = true;
  const csrf = parseCsrf(html);
  const rows = summarize(parseQuestRows(html));
  report.quests = rows.quests;
  report.hint = questHint(rows.quests);

  if (rows.claimReady.length) {
    if (!csrf) {
      report.notes.push(`claimable ${rows.claimReady.length} but no csrf found`);
      return report;
    }
    const { endpoint, field } = parseEndpoint(html);
    for (const c of rows.claimReady) {
      await game.pace(600, 1400);
      try {
        const res = await game.postForm(`/${endpoint.replace(/^\//, '')}`, { [field]: String(c.id), csrf });
        let json = {};
        try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
        if (json.status === 'success') {
          report.claimed++;
          if (json.message) report.messages.push(`${c.title || `#${c.id}`}: ${String(json.message).slice(0, 120)}`);
        } else {
          report.messages.push(`${c.title || `#${c.id}`}: ${String(json.message || json.status || json._raw || 'claim failed').slice(0, 120)}`);
        }
      } catch (e) {
        report.messages.push(`${c.title || `#${c.id}`}: ${e.message}`);
      }
    }
  }
  logger.debug(`battle pass: active=${report.active} quests=${report.quests.length} claimed=${report.claimed} keywords=[${(report.hint && report.hint.keywords).join(', ')}]`);
  return report;
}

module.exports = { isInactive, parseCsrf, parseEndpoint, parseQuestRows, summarize, questHint, orderWaves, battlePassRound };
