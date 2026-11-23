'use strict';
// claims.js — free-money sweeps the old farm never touched:
//
//   achievements.php  — every achievement card (.card[data-ach-id]) carries a
//     Claim button that is only enabled once the achievement is earned. The
//     page's own inline JS POSTs achievements_claim.php {ach_id, csrf}.
//     Rewards: gold, gems, items — pure profit, nothing is spent.
//   collections.php   — the same card pattern (.card[data-col-id]) with
//     permanent STAT rewards ("Reward: +50 attack"). The page POSTs
//     collections_claim.php {collection_id, csrf}.
//
// Only ENABLED buttons are claimed — `disabled` means the progress is not
// there yet, and claiming early is rejected by the game anyway. Both pages
// are one GET each; the claim POSTs only fire for cards that render ready.
const { logger } = require('./util');

// Chunk the page at card boundaries so a neighbour's button can never leak.
function parseClaimCards(html, attr) {
  const text = String(html || '');
  const re = new RegExp(`<div[^>]*class=["'][^"']*card[^"']*["'][^>]*${attr}=["']?(\\d+)["']?`, 'gi');
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ id: m[1], at: m.index });
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : undefined);
    if (!/claim-btn/.test(chunk)) continue;
    // disabled>Claim = progress not earned yet; an enabled claim-btn is ready.
    const btn = chunk.match(/<button[^>]*claim-btn[^>]*>/i);
    if (!btn || /disabled/i.test(btn[0])) continue;
    if (!seen.has(marks[i].id)) { seen.add(marks[i].id); ids.push(marks[i].id); }
  }
  return ids;
}

// The csrf token rides inside each page's own inline claim script:
//   body: new URLSearchParams({ach_id:id,csrf:"…"})           (achievements)
//   body: new URLSearchParams({collection_id:id,csrf:"…"})    (collections)
function parsePageCsrf(html, anchor) {
  const text = String(html || '');
  const re = anchor
    ? new RegExp(`${anchor}[\\s\\S]{0,120}?csrf:["']([0-9a-f]{16,64})["']`, 'i')
    : /csrf:["']([0-9a-f]{16,64})["']/i;
  const m = text.match(re);
  if (m) return m[1];
  const any = text.match(/name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i);
  return any ? any[1] : null;
}

async function claimPage(game, { page, attr, anchor, endpoint, field, label }) {
  const ids = [];
  let csrf = null;
  let claimed = 0;
  let failed = 0;
  const messages = [];
  try {
    const res = await game.get(`/${page}`, { redirect: 'manual' });
    ids.push(...parseClaimCards(res.text, attr));
    csrf = parsePageCsrf(res.text, anchor);
  } catch (e) {
    return { claimed: 0, failed: 0, ids, messages: [`${label} page failed: ${e.message}`] };
  }
  if (!ids.length) return { claimed: 0, failed: 0, ids, messages };
  if (!csrf) {
    return { claimed: 0, failed: 0, ids, messages: [`${label}: claimable ${ids.length} but no csrf found`] };
  }
  for (const id of ids) {
    try {
      const res = await game.postForm(`/${endpoint}`, { [field]: String(id), csrf });
      let json = {};
      try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
      if (json.status === 'success') {
        claimed++;
        if (json.message) messages.push(`#${id}: ${String(json.message).slice(0, 120)}`);
      } else {
        failed++;
        messages.push(`#${id}: ${String(json.message || json.status || json._raw || 'claim failed').slice(0, 120)}`);
      }
    } catch (e) {
      failed++;
      messages.push(`#${id}: ${e.message}`);
    }
    await game.pace(600, 1400);
  }
  logger.debug(`claims: ${label} claimed=${claimed} failed=${failed} of ${ids.length}`);
  return { claimed, failed, ids, messages };
}

// One sweep of both pages. Values are reported for the audit trail; the
// caller throttles how often this runs (claims are rare — earned slowly).
async function claimsRound(game, opts = {}) {
  const ach = await claimPage(game, {
    page: 'achievements.php', attr: 'data-ach-id', anchor: 'ach_id',
    endpoint: 'achievements_claim.php', field: 'ach_id', label: 'achievements',
  });
  await game.pace(800, 1800);
  const col = await claimPage(game, {
    page: 'collections.php', attr: 'data-col-id', anchor: 'collection_id',
    endpoint: 'collections_claim.php', field: 'collection_id', label: 'collections',
  });
  return {
    achievements: ach,
    collections: col,
    claimed: ach.claimed + col.claimed,
    failed: ach.failed + col.failed,
  };
}

module.exports = { parseClaimCards, parsePageCsrf, claimPage, claimsRound };
