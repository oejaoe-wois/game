'use strict';
// pvp.js — the Divers' third pillar: the PvP season ladder.
//
// pvp.php carries the season board (banner title, leaderboard rank, tier,
// battle tokens) and its own JS shows the two actions a season allows:
//   POST pvp_matchmake.php { ladder: 'solo' | 'party' }
//     → { status:'success', redirect:'/…battle page…' } | { message }
//   POST pvp_refill.php    { refill: 1, ladder }  (solo 500 gems, party 2500)
// The season can be CLOSED — the page then renders
//   <strong>Season Ended:</strong> <span>Solo matchmaking is closed.</span>
// and no .js-matchmake buttons. Live-verified 2026-11-22: season 4 ended,
// Tier Novice, 30 tokens, leaderboard #3,262 — matchmaking closed.
//
// The worker's PvP round is therefore: read the board → report tier/tokens →
// matchmake ONLY while the season is open and tokens remain → follow the
// redirect and detect the battle page (its shape is logged for the fight
// engine — the interactive ladder battle needs one live open-season sample
// before it can be automated; the round never blindly attacks a page it
// cannot parse).
const { logger } = require('./util');

// Parse the season board off pvp.php. Every field is optional — the page
// varies (open season vs ended vs pre-season) and the parser must never
// fabricate state it does not see.
function parsePvpHome(html) {
  const text = String(html || '');
  const grab = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const num = (s) => (s == null ? null : parseInt(String(s).replace(/,/g, ''), 10) || 0);
  // "Season Ended: Solo matchmaking is closed." (live) / generic variants.
  const closedMsg = grab(/Season Ended:<\/strong>\s*<span>([^<]+)<\/span>/i)
    || (/Matchmaking[^<]{0,160}closed/i.test(text) ? 'matchmaking closed' : null);
  // Matchmake buttons only render while the season is open.
  const ladders = [...new Set(
    [...text.matchAll(/js-matchmake[^>]*data-ladder=["'](\w+)["']/gi)].map((m) => m[1].toLowerCase())
  )];
  return {
    season: grab(/banner-title">([^<]+)/),
    rank: num(grab(/(?:Leaderboard|Solo Rank):<\/strong>\s*<span>#?([\d,]+)/i)),
    tier: grab(/Tier:<\/strong>\s*<span>([^<]+)<\/span>/i),
    tokens: num(grab(/Tokens:<\/strong>\s*<span>([\d,]+)<\/span>/i)),
    // Open = a matchmake button for that ladder is on the page AND no
    // season-ended notice says otherwise.
    soloOpen: ladders.includes('solo') && !/Solo matchmaking is closed/i.test(text),
    partyOpen: ladders.includes('party') && !/Party matchmaking is closed/i.test(text),
    closedMessage: closedMsg,
    endpoints: [...new Set(text.match(/pvp_[a-z_]+\.php/g) || [])],
  };
}

// POST pvp_matchmake.php — the page's own pvpPost shape (urlencoded,
// X-Requested-With). A closed season or no tokens answers status != success
// with a message; a match answers with the battle redirect.
async function matchmake(game, ladder = 'solo') {
  const res = await game.postForm('/pvp_matchmake.php', { ladder: String(ladder) }, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 140) }; }
  const ok = json.status === 'success';
  return {
    ok,
    redirect: ok ? (json.redirect || null) : null,
    message: ok ? 'matched' : String(json.message || json._raw || 'no match').slice(0, 160),
  };
}

// What kind of page did the matchmake redirect land on? The fight engine
// needs one live sample of the real battle page — until then the round
// records the shape markers instead of guessing at attacks.
function classifyBattlePage(html) {
  const text = String(html || '');
  return {
    isBattle: /battleDrawer|pvp_battle|vs-|opponent/i.test(text),
    title: (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || null,
    hasAttackSet: /Attack Set|attack_set/i.test(text),
    hasAutoFarmPanel: /autoFarmPanel|auto_farm_actions/i.test(text),
  };
}

// One PvP round. Reads the board, matchmakes while open + tokens remain,
// follows ONE redirect and reports. Never fatal. opts.maxMatches caps the
// round (1 token = 1 match by default — the game's token economy).
async function pvpRound(game, opts = {}) {
  const out = { parsed: null, matches: 0, results: [], stopped: null };
  try {
    const res = await game.get('/pvp.php', { redirect: 'manual' });
    out.parsed = parsePvpHome(res.text || '');
  } catch (e) {
    out.stopped = `pvp.php read failed: ${e.message}`;
    return out;
  }
  const ladder = opts.ladder === 'party' ? 'party' : 'solo';
  const open = ladder === 'solo' ? out.parsed.soloOpen : out.parsed.partyOpen;
  if (!open) {
    out.stopped = out.parsed.closedMessage || 'matchmaking not open';
    return out;
  }
  const maxMatches = Math.max(0, Math.min(Number(opts.maxMatches) || 1, Number(out.parsed.tokens) || 0));
  for (let i = 0; i < maxMatches; i++) {
    let m;
    try {
      m = await matchmake(game, ladder);
    } catch (e) {
      out.stopped = `matchmake failed: ${e.message}`;
      break;
    }
    await game.pace(800, 1600);
    if (!m.ok) {
      out.results.push({ ok: false, message: m.message });
      out.stopped = m.message;
      break;
    }
    if (m.redirect) {
      let shape = null;
      try {
        const b = await game.get(m.redirect.startsWith('/') ? m.redirect : `/${m.redirect}`, { redirect: 'manual' });
        shape = classifyBattlePage(b.text || '');
      } catch (e) {
        shape = { isBattle: false, error: e.message };
      }
      out.results.push({ ok: true, redirect: m.redirect, shape });
      out.matches++;
      // The fight engine lands here once a live open-season battle sample
      // exists; until then one matchmake per round keeps the telemetry.
      break;
    }
    out.results.push({ ok: true, message: 'no redirect returned' });
    out.matches++;
    break;
  }
  return out;
}

module.exports = { parsePvpHome, matchmake, classifyBattlePage, pvpRound };
