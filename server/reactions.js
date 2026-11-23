'use strict';
// reactions.js — the stamina reaction farm (port of veyra_stamina_farm.user.js
// + the Veyra Auto hub's reaction farm, HTTP core only).
//
// The game pays +2 stamina per manga-chapter reaction:
//   GET  /chaptered.php?manga=X&chapter=Y     → the chapter widget carries
//                                               id="cw-comments" data-chapter="N"
//   GET  /comments_api.php?chapterid=N&sort=… → JSON { viewer: { csrf } }
//   POST /postreaction.php                    → chapterid / reaction / useruid /
//                                               csrf  → body text "added" or
//                                               "updated"
//   cookie reacted_chap_<id> = <reaction>     → the game's own "already done"
//                                               marker; we replay it so a
//                                               restart never re-reacts.
// Manga/chapter discovery mirrors the farm script exactly:
//   / and /lastupdates.php list /manga/<slug> hrefs; a manga page lists
//   /chaptered.php?manga=…&chapter=… hrefs, oldest chapter FIRST (reversed).
//
// Everything runs through one account's GameClient, so the cookies
// (reacted_chap_*, useruid) live in that account's isolated jar.
const { logger, sleep } = require('./util');

// Server-midnight day key (the farm script uses IST, UTC+5:30 — kept as-is).
function serverDay() {
  return new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
}

function chapterIdIn(html) {
  const m = String(html || '').match(/id="cw-comments"[^>]*data-chapter="(\d+)"/)
    || String(html || '').match(/data-chapter="(\d+)"/);
  return m ? m[1] : null;
}

async function listMangas(game) {
  const set = new Set();
  for (const page of ['/', '/lastupdates.php']) {
    try {
      const res = await game.get(page, { redirect: 'manual' });
      for (const m of String(res.text || '').matchAll(/href="(\/manga\/[^"#?]+)"/g)) {
        set.add(m[1]);
      }
    } catch (_) { /* one source failing is fine */ }
  }
  return [...set];
}

async function listChapters(game, mangaPath) {
  const res = await game.get(mangaPath, { redirect: 'manual' });
  const set = new Set();
  for (const m of String(res.text || '').matchAll(/href="(\/chaptered\.php\?manga=\d+&(?:amp;)?chapter=[\w.\-]+)"/g)) {
    set.add(m[1].replace('&amp;', '&'));
  }
  return [...set].reverse(); // oldest first — the farm script's order
}

// One reaction. Returns the trimmed response body ('added' / 'updated' /
// 'already' / 'not-logged' / 'no-widget' / other server text).
async function reactChapter(game, chapterPath, reaction) {
  const res = await game.get(chapterPath, { redirect: 'manual' });
  const id = chapterIdIn(res.text);
  if (!id) return 'no-widget';
  if (game.jar.get(`reacted_chap_${id}`) === String(reaction)) return 'already';

  const api = await game.get(
    `/comments_api.php?chapterid=${encodeURIComponent(id)}&sort=newest&q=&offset=0&focus=0`,
    { redirect: 'manual' }
  );
  let csrf = null;
  try {
    const data = JSON.parse(api.text);
    csrf = data && data.viewer && data.viewer.csrf;
  } catch (_) { /* not JSON → treated below */ }
  if (!csrf) return 'not-logged';

  // The script generates uid-XXXX when the cookie is missing and persists it.
  let useruid = game.jar.get('useruid');
  if (!useruid) {
    useruid = 'uid-' + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
    game.jar.set('useruid', useruid, 365 * 86400);
  }

  await sleep(game.cfg.fastTest ? 10 : 600);
  const post = await game.postForm('/postreaction.php', {
    chapterid: id,
    reaction: String(reaction),
    useruid,
    csrf,
  });
  const out = String(post.text || '').trim();
  if (out === 'added' || out === 'updated') {
    // Same marker cookie the game sets in the browser (1 year, like the script).
    game.jar.set(`reacted_chap_${id}`, String(reaction), 365 * 86400);
  }
  logger.debug(`reactions: chapter ${id} → ${out.slice(0, 40) || `HTTP ${post.status}`}`);
  return out.slice(0, 40) || `http ${post.status}`;
}

// Farm one batch: walk mangas × chapters until `batch` NEW reactions landed
// (or the sources ran dry). Carries the per-account daily counters the farm
// script keeps — pass a stateful `counters` object across calls:
//   { day, reacts, gained, last, lastAt, capHit, noGain }
async function staminaFarmBatch(game, opts = {}) {
  const cfg = opts; // { reaction, batch, counters, onEvent, staminaFn, dailyCap, targetStamina, checkEvery, noGainStop }
  const reaction = String(cfg.reaction || '1');
  const batch = Math.max(1, Number(cfg.batch) || 10);
  const counters = cfg.counters || { day: serverDay(), reacts: 0, gained: 0, last: null, lastAt: 0, capHit: false, noGain: 0 };

  const report = { reacted: 0, added: 0, already: 0, skipped: 0, errors: 0, notLogged: false, counters, stopped: null };
  // Wall-clock budget: the batch caps GAINS, but a catalog that is already
  // fully reacted answers 'already' forever (never 'added') — without a hard
  // ceiling the sweep walks EVERY chapter of EVERY manga (10-30+ minutes of
  // silent requests) and the worker's cycle never comes back. The budget
  // keeps each batch inside its cycle no matter what the catalog answers.
  const startedAt = Date.now();
  const budgetMs = Math.max(15000, Number(cfg.timeBudgetMs) || 90000);
  // Engagement cap: 'already'/'skipped' chapters never count toward the added
  // batch, so a fully-reacted catalog would otherwise be walked end to end.
  // 4× batch engagements (plus the wall-clock budget) bound the sweep while
  // keeping `batch` = genuine NEW reactions.
  const maxEngagements = Math.max(batch, Number(cfg.maxEngagements) || batch * 4);

  // New server day → fresh counters (the farm script's day rollover).
  if (counters.day !== serverDay()) {
    counters.day = serverDay();
    counters.reacts = 0; counters.gained = 0; counters.last = null; counters.lastAt = 0;
    counters.capHit = false; counters.noGain = 0;
  }
  if (counters.capHit) { report.stopped = 'daily_cap'; return report; }

  const mangas = await listMangas(game);
  if (!mangas.length) { report.stopped = 'no_manga'; return report; }

  for (const manga of mangas) {
    if (report.added >= batch || report.reacted >= maxEngagements || Date.now() - startedAt > budgetMs) break;
    let chapters = [];
    try {
      chapters = await listChapters(game, manga);
    } catch (_) { continue; }
    for (const chap of chapters) {
      if (report.added >= batch || report.reacted >= maxEngagements || Date.now() - startedAt > budgetMs) break;
      let out = '';
      try {
        out = await reactChapter(game, chap, reaction);
      } catch (e) {
        report.errors++;
        await sleep(game.cfg.fastTest ? 5 : 5000);
        continue;
      }
      if (out === 'not-logged') { report.notLogged = true; break; }
      const ok = out === 'added' || out === 'updated';
      report.reacted++;
      if (out === 'already' || ok) report.already += out === 'already' ? 1 : 0;
      if (ok) {
        report.added++;
        counters.reacts++;
      } else {
        report.skipped++;
      }
      await sleep(game.cfg.fastTest ? 5 : 300);
    }
    if (report.notLogged) break;
  }
  if (Date.now() - startedAt > budgetMs) report.stopped = report.stopped || 'time_budget';

  // Periodic stamina check (the script's cfg.checkEvery gate) — measures the
  // real gain and drives the cap / target / no-gain stops.
  const shouldCheck = cfg.staminaFn && counters.reacts > 0
    && (cfg.checkEvery == null || counters.reacts % Math.max(1, cfg.checkEvery) === 0 || report.added >= batch);
  if (shouldCheck) {
    const stam = await cfg.staminaFn();
    if (stam) {
      const recent = counters.last != null && Date.now() - counters.lastAt < 10 * 60 * 1000;
      const gain = recent ? Math.max(0, stam.cur - counters.last) : 0;
      if (gain > 0) counters.gained += gain;
      counters.last = stam.cur;
      counters.lastAt = Date.now();
      counters.noGain = gain > 0 ? 0 : counters.noGain + 1;
      if (cfg.dailyCap && counters.gained >= cfg.dailyCap) {
        counters.capHit = true;
        report.stopped = 'daily_cap';
      } else if (cfg.targetStamina && stam.cur >= cfg.targetStamina) {
        report.stopped = 'target_reached';
      } else if (cfg.noGainStop && counters.noGain >= cfg.noGainStop) {
        counters.capHit = true;
        report.stopped = 'no_gain';
      }
    }
  }
  return report;
}

module.exports = {
  serverDay,
  chapterIdIn,
  listMangas,
  listChapters,
  reactChapter,
  staminaFarmBatch,
};
