'use strict';
// game.js — the single HTTP voice the farm speaks to the game with.
// Node port of aio_core_api.js + aio_core_bg.js request helpers, but every
// request carries ONE account's cookie jar instead of the browser jar.
//
// ── transports ──────────────────────────────────────────────────────────
// 2026-11: Cloudflare fronts the game and TLS-fingerprints Node's fetch —
// every request earns a 403 "Just a moment…" challenge page no matter the
// User-Agent. curl's TLS stack passes the same edge, so requests ride a
// curl subprocess when one exists (see curl-transport.js): same headers,
// same cookie jar (Set-Cookie parsed back per response), redirect:'manual'
// semantics preserved. CURL_TRANSPORT=auto (default) picks curl when the
// binary exists and falls back to fetch; 'curl' forces it; 'fetch' keeps
// the pure-Node path (fine behind your own browser-borrowed clearance).
// Login/Cloudflare detection lives in auth.js — a challenge page is never
// mistaken for a logged-in session.
const { logger, sleep, jitter } = require('./util');
const { curlAvailable, curlRequest } = require('./curl-transport');

const GAME_BASE_DEFAULT = 'https://demonicscans.org';
// A real browser UA on every request (curl and fetch alike) — the farm is
// one more browser tab as far as the edge is concerned.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function pickTransport(cfg) {
  const t = String((cfg && cfg.transport) || 'auto').toLowerCase();
  if (t === 'fetch') return 'fetch';
  if (t === 'curl') return 'curl';
  // auto: curl when available, fetch otherwise (and under fastTest keep
  // the in-process path so the mock suites never depend on a binary).
  if (cfg && cfg.fastTest) return 'fetch';
  return curlAvailable() ? 'curl' : 'fetch';
}

// Regex port of fetchCsrfFromPage() in aio_core_accounts.js (both attr orders).
const CSRF_RES = [
  /name=["']csrf_token["'][^>]*value=["']([^"']+)["']/,
  /value=["']([^"']+)["'][^>]*name=["']csrf_token["']/,
];

function csrfFromHtml(html) {
  for (const re of CSRF_RES) {
    const m = (html || '').match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

class GameClient {
  /**
   * @param {object} opts
   *   gameBase   e.g. https://demonicscans.org
   *   jar        CookieJar (per account)
   *   cfg        server config (pacing, timeouts, jitter scale)
   *   label      for logs (nickname/masked email)
   */
  constructor({ gameBase, jar, cfg, label }) {
    this.base = (gameBase || GAME_BASE_DEFAULT).replace(/\/+$/, '');
    this.jar = jar;
    this.cfg = cfg;
    this.label = label || 'client';
    // Passive vitals, refreshed by scanVitals() on every HTML response.
    // Sources (all from real game markup):
    //   top bar      <span id="stamina_span">8</span> / 7,190
    //   battle card  <div id="pHpText">💚 376,500 / 358,250 HP</div>
    //   battleDrawer .potion-use-btn data-inv data-item data-name data-max
    this.lastStamina = null; // {cur, max, at}
    this.lastHp = null;      // {cur, max, at}
    this.lastMana = null;    // {cur, max, at} — battle page #pManaText (Veyra auto mana source)
    this.lastPotions = null; // {cards: [{invId, itemId, name, qty}], at}
  }

  // ── Low-level request ─────────────────────────────────────────────────────
  // redirect:'manual' by default, mirroring the extension (it never follows
  // the 303 chain during login). Returns {status, headers, text, location}.
  async request(pathname, opts = {}) {
    const url = pathname.startsWith('http') ? pathname : this.base + pathname;
    const method = (opts.method || 'GET').toUpperCase();
    const headers = {
      'User-Agent': CHROME_UA,
      'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(opts.headers || {}),
    };
    headers.Cookie = this.jar.header();
    if (method === 'POST') {
      headers.Origin = this.base;
      headers.Referer = this.base + '/';
    }

    // curl first (Cloudflare passes it), fetch as the fallback.
    const transport = pickTransport(this.cfg);
    if (transport === 'curl') {
      let res;
      try {
        res = await curlRequest({
          url,
          method,
          headers,
          body: opts.body || undefined,
          timeoutMs: opts.timeoutMs || this.cfg.requestTimeoutMs,
        });
      } catch (e) {
        // ENOENT (binary vanished mid-run) or a transport hiccup: one logged
        // fallback to fetch keeps the cycle alive instead of crashing it.
        if (!this._curlFallbackWarned) {
          this._curlFallbackWarned = true;
          logger.warn(`curl transport failed (${e.message}) — falling back to fetch for this client`);
        }
        if (e.code === 'ENOENT') return this.fetchRequest(url, method, headers, opts);
        throw e;
      }
      return this.absorb(res);
    }
    return this.fetchRequest(url, method, headers, opts);
  }

  // The original in-process fetch path.
  async fetchRequest(url, method, headers, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || this.cfg.requestTimeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body || undefined,
        redirect: opts.redirect || 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Capture every Set-Cookie into this account's jar.
    let setCookies = [];
    try {
      if (typeof res.headers.getSetCookie === 'function') {
        setCookies = res.headers.getSetCookie();
      } else if (res.headers.raw) {
        setCookies = res.headers.raw()['set-cookie'] || [];
      }
    } catch (_) { /* older runtimes */ }
    if (setCookies.length) this.jar.store(setCookies);

    const text = await res.text();
    this.scanVitals(text);
    return {
      status: res.status,
      headers: res.headers,
      text,
      location: res.headers.get('location') || null,
    };
  }

  // Fold a curl-transport response into the engine: jar, vitals, shape.
  absorb(res) {
    if (res.setCookies && res.setCookies.length) this.jar.store(res.setCookies);
    this.scanVitals(res.text);
    return {
      status: res.status,
      headers: res.headers,
      text: res.text,
      location: res.headers.get('location'),
    };
  }

  async get(pathname, opts) {
    return this.request(pathname, { ...opts, method: 'GET' });
  }

  // Port of postForm(): urlencoded POST, credentials via jar.
  async postForm(pathname, fields, opts) {
    const body = Object.entries(fields || {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return this.request(pathname, { ...opts, method: 'POST', body });
  }

  // ── CSRF helper (port of getCsrfFromPage) ─────────────────────────────────
  async getCsrf(pathname) {
    const res = await this.get(pathname, { redirect: 'manual' });
    return csrfFromHtml(res.text);
  }

  // ── Human-ish pacing (configurable via JITTER_SCALE) ─────────────────────
  async pace(minMs, maxMs) {
    const scale = this.cfg.jitterScale;
    if (this.cfg.fastTest) {
      await sleep(jitter(Math.min(minMs, 40), Math.min(maxMs, 90), 1));
      return;
    }
    await sleep(jitter(minMs, maxMs, scale));
  }

  // ── Passive vitals capture ─────────────────────────────────────────────────
  // Any page the game returns may carry the stamina top bar, the battle
  // player card or the battle drawer. One cheap regex pass over text we
  // already have — the freshest values win, no extra requests.
  scanVitals(text) {
    const t = String(text || '');
    if (!t || t[0] === '{') return; // JSON endpoints carry none of this

    const sta = t.match(/id="stamina_span">\s*([\d,]+)\s*<\/span>\s*\/\s*([\d,]+)/);
    if (sta) {
      this.lastStamina = {
        cur: parseInt(sta[1].replace(/,/g, ''), 10),
        max: parseInt(sta[2].replace(/,/g, ''), 10),
        at: Date.now(),
        src: 'page', // passive fold — the bar rode along on some other page
      };
    }

    const hp = t.match(/id="pHpText"[^>]*>[^<]*?([\d,]+)\s*\/\s*([\d,]+)\s*HP/);
    if (hp) {
      this.lastHp = {
        cur: parseInt(hp[1].replace(/,/g, ''), 10),
        max: parseInt(hp[2].replace(/,/g, ''), 10),
        at: Date.now(),
      };
    }

    // Mana card on battle pages: <div id="pManaText">🔷 1,200 / 1,200 MP</div>
    // (the Veyra auto-mana watcher drinks when this drains; same pair format
    // as #pHpText, sometimes without the trailing unit).
    const mana = t.match(/id="pManaText"[^>]*>[^<]*?([\d,]+)\s*\/\s*([\d,]+)/);
    if (mana) {
      this.lastMana = {
        cur: parseInt(mana[1].replace(/,/g, ''), 10),
        max: parseInt(mana[2].replace(/,/g, ''), 10),
        at: Date.now(),
      };
    }

    if (t.includes('potion-use-btn')) {
      const cards = [];
      const re = /data-inv="(\d+)"\s+data-item="(\d+)"\s+data-name="([^"]*)"\s+data-max="(\d+)"/g;
      let m;
      while ((m = re.exec(t)) !== null) {
        cards.push({ invId: m[1], itemId: m[2], name: m[3], qty: parseInt(m[4], 10) });
      }
      if (cards.length) this.lastPotions = { cards, at: Date.now() };
    }
  }

  // The damage.php JSON carries the live stamina left (`data.stamina` — the
  // wave client rewrites #stamina_span from it after every hit). JSON
  // responses bypass scanVitals, so fold the number in explicitly. The echo
  // is the server's own live number — authoritative like stats.php.
  noteStamina(cur) {
    const n = Number(cur);
    if (!Number.isFinite(n) || n < 0) return;
    this.lastStamina = {
      cur: n,
      max: this.lastStamina ? Math.max(this.lastStamina.max || n, n) : n,
      at: Date.now(),
      src: 'stats',
    };
  }

  looksLikeLogin(text) {
    return !!(text && /name=["']csrf_token["']/.test(text));
  }
}

module.exports = { GameClient, csrfFromHtml, CHROME_UA, pickTransport };
