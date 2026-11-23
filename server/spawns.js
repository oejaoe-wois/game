'use strict';
// spawns.js — boss spawn timers + 48h auto-die phase tracking (port of the
// Boss Tracker userscript and the Veyra spawn-timer dock, HTTP only).
//
// Boss wave pages render one .auto-summon-card per scheduled boss:
//   <div class="auto-summon-card" data-alive="1" data-next-ts="1764000000">
//     <div class="auto-summon-name">Zeus, Duelist of the Storm Throne</div>
//     <div class="auto-summon-sub">Auto-die: 48h · …</div>
//     <a class="auto-join-btn" href="battle.php?id=9017">Join</a>
//     <div class="auto-damage">🩸 You: 12,345</div>
//   </div>
// data-next-ts = spawn_time + auto-spawn — set once per spawn, held through
// the whole cycle (including the dead window), so it doubles as the
// life-transition marker the Boss Tracker uses.
//
// The boss's own battle page embeds window.AUTO_DIE_CFG = { nextDieMs, … } —
// the ONLY honest remaining-life source (combat.parseBattleView already
// reads it). Remaining ≤ phase2Hours → phase 2 (damage counts); otherwise
// phase 1 (the tracker's rule: exempt from damage until then).
const { sleep } = require('./util');

// "Auto-die: 48h" → seconds (h/m/d suffixes).
function dieSeconds(subText) {
  const m = String(subText || '').match(/Auto-die:\s*.*?(\d+\.?\d*)\s*([hmd])/i);
  if (!m) return 0;
  const mult = { h: 3600, m: 60, d: 86400 }[m[2].toLowerCase()] || 0;
  return Math.round(parseFloat(m[1]) * mult);
}

function isPhasedSub(subText) {
  return /auto-die:\s*48h/i.test(String(subText || ''));
}

// Chunk the page at .auto-summon-card boundaries and read every card. The
// monster-id map comes from the same page's .monster-card rows
// (data-monster-id + data-monster-name/data-name), matching by exact name or
// the "first name before the comma" core (Veyra's core() rule).
function parseAutoSummons(html) {
  const text = String(html || '');
  const core = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ').split(',')[0].trim();

  const idMap = {};
  const cardRe = /<div[^>]*class=["'][^"']*monster-card[^"']*["'][^>]*>/gi;
  const cardMarks = [];
  let cm;
  while ((cm = cardRe.exec(text)) !== null) cardMarks.push(cm.index);
  for (let i = 0; i < cardMarks.length; i++) {
    const chunk = text.slice(cardMarks[i], i + 1 < cardMarks.length ? cardMarks[i + 1] : undefined);
    const id = (chunk.match(/data-monster-id=["']?(\d+)["']?/i) || [])[1];
    const nm = (chunk.match(/data-(?:monster-)?name=["']([^"']+)["']/i) || [])[1]
      || (chunk.match(/<h[1-5][^>]*>([^<]+)</i) || [])[1];
    if (id && nm) {
      const lower = nm.trim().toLowerCase();
      idMap[lower] = id;
      if (core(lower) && !idMap[core(lower)]) idMap[core(lower)] = id;
    }
  }

  const re = /<div[^>]*class=["'][^"']*auto-summon-card[^"']*["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : undefined);
    const name = ((chunk.match(/class=["'][^"']*auto-summon-name[^"']*["'][^>]*>([^<]+)</i) || [])[1] || '').trim();
    const sub = ((chunk.match(/class=["'][^"']*auto-summon-sub[^"']*["'][^>]*>([^<]+)</i) || [])[1] || '').trim();
    if (!name && !sub) continue;
    const alive = /data-alive=["']?1["']?/i.test(chunk);
    const nextTs = parseInt((chunk.match(/data-next-ts=["']?(\d+)["']?/i) || [])[1] || '0', 10);
    const joinHref = (chunk.match(/class=["'][^"']*auto-join-btn[^"']*["'][^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    const idM = joinHref.match(/battle\.php\?(?:[^"']*&)?id=(\d+)/i) || joinHref.match(/[?&]id=(\d+)/);
    const lower = name.toLowerCase();
    const monsterId = (idM && idM[1]) || idMap[lower] || idMap[core(lower)] || null;
    out.push({
      name: name || `summon ${monsterId || '?'}`,
      sub,
      alive,
      nextTs,
      dieSec: dieSeconds(sub),
      phased: isPhasedSub(sub),
      monsterId,
      joinHref: joinHref || null,
      youDmg: (() => {
        const d = (chunk.match(/class=["'][^"']*auto-damage[^"']*["'][^>]*>([^<]*)</i) || [])[1] || '';
        const n = String(d).replace('🩸 You:', '').replace(/[,\s]/g, '').trim();
        return /^\d+$/.test(n) ? parseInt(n, 10) : null;
      })(),
    });
  }
  return out;
}

// Phase from a battle page's nextDieMs (already parsed by parseBattleView —
// this helper exists for callers holding raw HTML).
function nextDieMsFromHtml(html) {
  const m = String(html || '').match(/nextDieMs\s*:\s*(\d+)/);
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) ? n : null;
}

// phase 1 = more than `phase2Hours` of life left, phase 2 = the final window,
// 0 = overdue (about to die / already dead on the server clock).
function phaseFromRemainingMs(remainingMs, phase2Hours) {
  const threshold = (Number(phase2Hours) > 0 ? Number(phase2Hours) : 24) * 3600 * 1000;
  if (remainingMs <= 0) return 0;
  return remainingMs > threshold ? 1 : 2;
}

// Annotate alive phased bosses with their true death clock. `views` is a
// Map(monsterId → parseBattleView result) gathered by the scout's peek pass —
// ZERO extra requests; a boss whose battle page was never peeked just stays
// unphased (treated as "requires damage", the safe default).
function annotatePhases(cards, views, { phase2Hours } = {}) {
  const now = Date.now();
  for (const card of cards) {
    if (!card.alive || !card.monsterId) continue;
    const view = views && views.get(String(card.monsterId));
    if (!view || view.nextDieMs == null) continue;
    card.nextDieMs = view.nextDieMs;
    card.phase = phaseFromRemainingMs(view.nextDieMs - now, phase2Hours);
    card.remainingMs = Math.max(0, view.nextDieMs - now);
  }
  return cards;
}

// Human summary for the dashboard (the spawn-timer sheet's rows).
function spawnSummary(cards) {
  return cards.map((c) => ({
    name: c.name,
    alive: c.alive,
    nextTs: c.nextTs || null,
    nextDieMs: c.nextDieMs || null,
    phase: c.phase ?? null,
    monsterId: c.monsterId,
    youDmg: c.youDmg,
    dieSec: c.dieSec,
    sub: c.sub,
  }));
}

async function paceGuard(game) {
  await sleep(game.cfg.fastTest ? 5 : 200);
}

module.exports = {
  dieSeconds,
  isPhasedSub,
  parseAutoSummons,
  nextDieMsFromHtml,
  phaseFromRemainingMs,
  annotatePhases,
  spawnSummary,
  paceGuard,
};
