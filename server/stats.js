'use strict';
// stats.js — the stat-allocation engine. Node port of the live console script
// `allocatePlan({attack, defense, stamina})`, speaking the exact contract the
// game's stats page shows:
//
//   GET  stats.php        → the page embeds an element  id="stats-state"
//                           whose text is JSON:
//                           { csrf, view, user:{ ATTACK, DEFENSE,
//                             MAX_STAMINA, STAT_POINTS } }
//   POST stats_ajax.php   → application/x-www-form-urlencoded
//                           action=allocate
//                           stat=attack|defense|stamina
//                           amount=<chunk>          ← server only accepts
//                                                     chunks of [100, 50, 5, 1]
//                           csrf=<token>            ← from stats-state
//                           view=<version>          ← optimistic concurrency;
//                                                     stale view/csrf → 409
//                           request_id=<24 hex>     ← dedupe key, fresh per
//                                                     attempt
//
//   409 or {ok:false}     → re-fetch fresh state from stats.php and retry the
//                           same chunk (≤2 retries, exactly like the script);
//                           success → state.user / state.view updated from the
//                           response.
//
// Pacing mirrors the console script: 250 ms between chunks, 300 ms after a
// re-sync (10/15 ms in FAST_TEST). Every request goes out on ONE account's
// GameClient, so it carries that account's cookie jar.
const crypto = require('crypto');
const { logger, sleep } = require('./util');

// The server's whitelist — arbitrary amounts MUST be broken into these.
const STAT_CHUNKS = [100, 50, 5, 1];
const STAT_KEYS = ['attack', 'defense', 'stamina'];
const FIELD_BY_STAT = { attack: 'ATTACK', defense: 'DEFENSE', stamina: 'MAX_STAMINA' };
const MAX_CHUNKS_PER_STAT = 5000; // runaway-plan guard (≈500k+ points per stat)

// #stats-state can be rendered as a div, span or JSON <script> — the console
// script reads it via getElementById().textContent, we do the regex version
// (capture everything up to the first closing tag).
function parseStatsState(html) {
  const m = String(html || '').match(/id=["']stats-state["'][^>]*>([\s\S]*?)<\//i);
  if (!m) return null;
  try {
    const state = JSON.parse(m[1].trim());
    return state && typeof state === 'object' ? state : null;
  } catch (_) {
    return null;
  }
}

// The Veyra dashboard reads a second shape: #stats-state can carry the same
// numbers as  core: { points, attack, defense, stamina }  (the redesigned
// stats page) instead of / next to  user: { STAT_POINTS, ... }. Normalize so
// every consumer sees the  user  shape.
function normalizeState(state) {
  if (state && !state.user && state.core && typeof state.core === 'object') {
    const toInt = (v) => {
      const n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const c = state.core;
    state.user = {
      STAT_POINTS: toInt(c.points),
      ATTACK: toInt(c.attack),
      DEFENSE: toInt(c.defense),
      MAX_STAMINA: toInt(c.stamina),
    };
  }
  return state;
}

// 1. Fetch fresh, authoritative state directly from the server (fixes 409
//    Conflict) — the same fetchFreshState() the console script uses.
async function fetchStatsState(game) {
  const res = await game.get(`/stats.php?_t=${Date.now()}`, { redirect: 'manual' });
  const state = normalizeState(parseStatsState(res.text));
  if (!state || !state.user) throw new Error('stats.php carried no #stats-state');
  return state;
}

// Break an arbitrary amount into the server's [100, 50, 5, 1] denominations.
function decompose(amount) {
  const chunks = [];
  let rem = Math.floor(Number(amount) || 0);
  for (const denom of STAT_CHUNKS) {
    while (rem >= denom) {
      chunks.push(denom);
      rem -= denom;
    }
  }
  return chunks;
}

// 24 hex chars — crypto.getRandomValues(new Uint8Array(24)) hex in the script.
function generateRequestId() {
  return crypto.randomBytes(12).toString('hex');
}

function planTotals(plan) {
  const out = { attack: 0, defense: 0, stamina: 0 };
  for (const key of STAT_KEYS) out[key] = Math.max(0, Math.floor(Number((plan || {})[key]) || 0));
  return out;
}

// Process one stat: decompose → POST per chunk with self-healing retries.
// Mutates `state` (fresh tokens flow back into the caller's loop, like the
// script's closure). Returns a per-stat report.
async function allocateToStat(game, statName, totalAmount, state, opts = {}) {
  const pacing = opts.fastTest
    ? { betweenChunks: 10, afterResync: 15 }
    : { betweenChunks: 250, afterResync: 300 };
  const report = {
    stat: statName,
    requested: totalAmount,
    applied: 0,
    ok: false,
    chunks: {},          // denomination -> applied count
    posts: 0,            // total stats_ajax.php POSTs (incl. bounced ones)
    resyncs: 0,          // how many times a stale token forced a re-sync
    lastError: null,
  };

  if (!totalAmount || totalAmount <= 0) {
    report.ok = true; // nothing requested for this stat — not a failure
    return report;
  }

  const chunks = decompose(totalAmount);
  if (totalAmount % 1 !== 0 || chunks.reduce((a, b) => a + b, 0) !== totalAmount) {
    report.lastError = `amount ${totalAmount} is not a whole number`;
    return report;
  }
  if (chunks.length > MAX_CHUNKS_PER_STAT) {
    report.lastError = `plan too large (${chunks.length} chunks > ${MAX_CHUNKS_PER_STAT})`;
    return report;
  }
  report.chunkCount = chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let success = false;
    let retries = 0;

    while (!success && retries < 2) {
      try {
        report.posts++;
        const res = await game.postForm('/stats_ajax.php', {
          action: 'allocate',
          stat: statName,
          amount: String(chunk),
          csrf: String(state.csrf || ''),
          view: String(state.view != null ? state.view : ''),
          request_id: generateRequestId(), // fresh per attempt — dedupe key
        }, { redirect: 'manual' });

        let result = null;
        try { result = JSON.parse(res.text || ''); } catch (_) { /* non-JSON */ }

        if (res.status === 409 || !result || result.ok !== true) {
          // Auto self-heal on 409 / stale token: pull fresh csrf+view from
          // stats.php and retry the SAME chunk.
          report.resyncs++;
          report.lastError = `token rejected on +${chunk} (HTTP ${res.status}) — re-syncing`;
          logger.debug(`stats: ${report.lastError}`);
          Object.assign(state, await fetchStatsState(game));
          opts.onResync && opts.onResync(report.resyncs);
          retries++;
          await sleep(pacing.afterResync);
          continue;
        }

        // Successful allocation — the response carries the new truth.
        state.user = result.user;
        state.view = result.view;
        report.applied += chunk;
        report.chunks[chunk] = (report.chunks[chunk] || 0) + 1;
        success = true;
        const remaining = chunks.slice(i + 1).reduce((a, b) => a + b, 0);
        logger.debug(
          `stats: [${i + 1}/${chunks.length}] +${chunk} ${statName} ` +
          `(remaining ${remaining} · points left ${state.user.STAT_POINTS})`
        );
      } catch (err) {
        report.posts++;
        report.lastError = `network error on +${chunk}: ${err.message}`;
        retries++;
      }

      await sleep(pacing.betweenChunks);
    }

    if (!success) {
      report.lastError = report.lastError || `chunk +${chunk} failed after re-sync`;
      return report; // abort this stat — the caller decides what to do next
    }
  }

  report.ok = report.applied === totalAmount;
  return report;
}

// The allocatePlan port: sync → validate the plan against banked points →
// process attack → defense → stamina in order. Returns a full report and
// NEVER throws for game-level refusals (only a dead session/network bubbles).
async function allocatePlan(game, plan, opts = {}) {
  const totals = planTotals(plan);
  const totalRequested = totals.attack + totals.defense + totals.stamina;

  if (totalRequested <= 0) {
    return { ok: false, reason: 'empty_plan', plan: totals, perStat: [], applied: 0 };
  }

  let state;
  try {
    state = await fetchStatsState(game);
  } catch (e) {
    return { ok: false, reason: 'no_stats_state', error: e.message, plan: totals, perStat: [], applied: 0 };
  }

  const availablePoints = Number(state.user.STAT_POINTS) || 0;
  if (totalRequested > availablePoints) {
    return {
      ok: false,
      reason: 'insufficient_points',
      plan: totals,
      availablePoints,
      perStat: [],
      applied: 0,
    };
  }

  const perStat = [];
  let applied = 0;
  let allOk = true;
  for (const key of STAT_KEYS) {
    if (totals[key] <= 0) continue;
    const rep = await allocateToStat(game, key, totals[key], state, opts);
    perStat.push(rep);
    if (rep.ok) applied += rep.applied;
    else { allOk = false; break; } // a failed stat aborts the remaining plan
  }

  return {
    ok: allOk && applied === totalRequested,
    reason: allOk ? 'allocated' : 'stat_failed',
    plan: totals,
    availablePoints,
    applied,
    pointsLeft: state.user ? (Number(state.user.STAT_POINTS) || 0) : null,
    attributes: state.user
      ? {
          attack: Number(state.user.ATTACK) || 0,
          defense: Number(state.user.DEFENSE) || 0,
          maxStamina: Number(state.user.MAX_STAMINA) || 0,
        }
      : null,
    perStat,
  };
}

// ── Stat TARGETS allocator (port of the Veyra auto stat allocator loop) ──────
// Keeps spending banked points until each attribute reaches its target, in
// the Veyra order attack → defense → stamina. Where allocatePlan() burns a
// fixed amount, this one re-reads the server truth after EVERY chunk and
// picks  chunk = largest of [100,50,5,1] that fits min(remaining need, points)
// — exactly the script's pickChunk(min(need, points)) rule. Stops when the
// targets are met or the points run dry; both are healthy outcomes.
async function allocateTargets(game, targets, opts = {}) {
  const pacing = opts.fastTest
    ? { betweenChunks: 10, afterResync: 15 }
    : { betweenChunks: 250, afterResync: 300 };
  const goals = planTotals(targets);
  const report = {
    mode: 'targets',
    targets: { ...goals },
    applied: 0,
    perStat: { attack: 0, defense: 0, stamina: 0 },
    posts: 0,
    resyncs: 0,
    attributes: null,
    pointsLeft: null,
    ok: false,
    reason: null,
    lastError: null,
  };

  const totalGoal = goals.attack + goals.defense + goals.stamina;
  if (totalGoal <= 0) return { ...report, reason: 'empty_plan' };

  let state;
  try {
    state = await fetchStatsState(game);
  } catch (e) {
    return { ...report, reason: 'no_stats_state', error: e.message };
  }

  const readAttr = (s) => ({
    points: Number(s.user.STAT_POINTS) || 0,
    attack: Number(s.user.ATTACK) || 0,
    defense: Number(s.user.DEFENSE) || 0,
    stamina: Number(s.user.MAX_STAMINA) || 0,
  });

  const MAX_STEPS = 6000; // runaway guard (6000×100 = 600k points in one call)
  let steps = 0;
  while (steps++ < MAX_STEPS) {
    const cur = readAttr(state);
    report.attributes = cur;

    // The first unmet attribute in the Veyra order.
    const need = [
      ['attack', goals.attack - cur.attack],
      ['defense', goals.defense - cur.defense],
      ['stamina', goals.stamina - cur.stamina],
    ].find(([, n]) => n > 0);
    if (!need) { report.reason = 'targets_reached'; break; }
    if (cur.points <= 0) { report.reason = 'points_drained'; break; }

    const [stat, amt] = need;
    const budget = Math.min(amt, cur.points);
    const chunk = STAT_CHUNKS.find((s) => budget >= s); // largest fitting denom
    if (!chunk) { report.reason = 'points_drained'; break; }

    let success = false;
    let retries = 0;
    while (!success && retries < 2) {
      try {
        report.posts++;
        const res = await game.postForm('/stats_ajax.php', {
          action: 'allocate',
          stat,
          amount: String(chunk),
          csrf: String(state.csrf || ''),
          view: String(state.view != null ? state.view : ''),
          request_id: generateRequestId(),
        }, { redirect: 'manual' });

        let result = null;
        try { result = JSON.parse(res.text || ''); } catch (_) { /* non-JSON */ }
        if (res.status === 409 || !result || result.ok !== true) {
          report.resyncs++;
          report.lastError = `token rejected on +${chunk} ${stat} (HTTP ${res.status}) — re-syncing`;
          Object.assign(state, await fetchStatsState(game));
          opts.onResync && opts.onResync(report.resyncs);
          retries++;
          await sleep(pacing.afterResync);
          continue;
        }
        state.user = result.user;
        state.view = result.view;
        report.applied += chunk;
        report.perStat[stat] += chunk;
        success = true;
      } catch (err) {
        report.posts++;
        report.lastError = `network error on +${chunk} ${stat}: ${err.message}`;
        retries++;
      }
      await sleep(pacing.betweenChunks);
    }
    if (!success) {
      report.reason = report.lastError || 'chunk_failed';
      break;
    }
  }

  if (steps >= MAX_STEPS && !report.reason) report.reason = 'step_guard';
  if (state && state.user) {
    report.attributes = readAttr(state);
    report.pointsLeft = report.attributes.points;
  }
  report.ok = report.reason === 'targets_reached' || report.reason === 'points_drained';
  return report;
}

module.exports = {
  STAT_CHUNKS,
  STAT_KEYS,
  FIELD_BY_STAT,
  MAX_CHUNKS_PER_STAT,
  parseStatsState,
  normalizeState,
  fetchStatsState,
  decompose,
  generateRequestId,
  planTotals,
  allocateToStat,
  allocatePlan,
  allocateTargets,
};
