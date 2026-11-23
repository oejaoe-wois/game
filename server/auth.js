'use strict';
// auth.js — Node port of aio_core_accounts.js (the single CSRF login copy).
//
// Flow (unchanged from the extension):
//   1) GET  /game_login.php  → extract csrf_token
//   2) POST csrf_token + email + password   (303 suppressed, session created)
//   3) GET  /game_login.php  → a signed-in session never gets the form back
//
// Cloudflare (2026-11): the edge can answer ANY request with a managed
// challenge ("Just a moment…", 403). A challenge page is never a login
// form and never a signed-in session — both checks below treat it as
// "not in" and login() fails with a readable message instead of the
// engine silently scraping challenge HTML all night.
const { logger } = require('./util');

// A managed-challenge PAGE is different from Cloudflare's ambient scripts:
// every page on the site loads /cdn-cgi/challenge-platform/scripts/jsd/… in
// the background (harmless), while an actual challenge page identifies
// itself in the <title> ("Just a moment…") or its inline challenge opts
// (window._cf_chl_opt / cf_chl_opt form field). Match only those.
const CHALLENGE_RE = /<title[^>]*>\s*(?:just a moment|attention required|please wait|checking your browser|verifying you are human)|window\._cf_chl_opt|name=["']cf_chl_opt["']|cf-browser-verification/i;

function isChallenge(html) {
  return CHALLENGE_RE.test(String(html || ''));
}

// Port of isLoggedIn(): 3xx away from the login page OR no csrf form = in.
// A Cloudflare challenge page is NOT logged in.
async function isLoggedIn(game) {
  try {
    const res = await game.get('/game_login.php', { redirect: 'manual' });
    if (isChallenge(res.text)) return false;
    if (res.status >= 300 && res.status < 400) return true;
    if (game.looksLikeLogin(res.text)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// Port of login(): throws on rejection with the same user-facing messages.
async function login(game, email, password) {
  const probe = await game.get('/game_login.php', { redirect: 'manual' }).catch(() => null);
  if (probe && isChallenge(probe.text)) {
    throw new Error('Cloudflare is challenging this session — the engine could not even open the login page (curl transport missing? set CURL_TRANSPORT=auto and make sure curl is installed)');
  }
  const csrf = await game.getCsrf('/game_login.php');
  if (!csrf) {
    if (await isLoggedIn(game)) return { ok: true, already: true };
    throw new Error('could not read the login form (game changed?)');
  }
  await game.postForm('/game_login.php', {
    csrf_token: csrf,
    email: String(email || ''),
    password: String(password || ''),
  }, { redirect: 'manual' });

  const ok = await isLoggedIn(game);
  if (!ok) throw new Error('login rejected — check the saved email and password');
  return { ok: true };
}

// Port of logout(): GET logout page for its csrf, POST it.
async function logout(game) {
  try {
    const csrf = await game.getCsrf('/game_logout.php');
    if (csrf) await game.postForm('/game_logout.php', { csrf_token: csrf }, { redirect: 'manual' });
    return true;
  } catch (e) {
    logger.warn(`logout failed for ${game.label}: ${e.message}`);
    return false;
  }
}

// Port of the getUserId() strategy order, adapted to a headless client:
//   1. cookie 'demon' (the game sets this at login)
//   2. inline USER_ID= in fetched page HTML
//   3. profile.php?id= links on the dashboard/inventory page
async function getUserId(game) {
  const demon = game.jar.get('demon');
  if (demon) {
    try { return decodeURIComponent(demon); } catch (_) { return demon; }
  }
  try {
    const res = await game.get('/inventory.php', { redirect: 'manual' });
    const html = res.text || '';
    let m = html.match(/(?:const|let|var)\s+USER_ID\s*=\s*['"]?(\d+)['"]?/);
    if (m) return m[1];
    m = html.match(/profile\.php\?id=(\d+)/);
    if (m) return m[1];
  } catch (_) { /* fallthrough */ }
  return null;
}

// Port of the level parser in bosses_alt_auto.js runBossCleaner().
async function getPlayerLevel(game) {
  try {
    const res = await game.get('/inventory.php', { redirect: 'manual' });
    const m = (res.text || '').match(/<div class="gtb-level">\s*LV\s*(\d+)<\/div>/i);
    if (m) return parseInt(m[1], 10);
  } catch (_) { /* fallthrough */ }
  return 0;
}

module.exports = { isLoggedIn, login, logout, getUserId, getPlayerLevel, isChallenge };
