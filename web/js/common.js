'use strict';
/* common.js — the shared core every panel page loads before its own script.
   Provides (window.AioFarm):
   · esc / fmtAge / fmtK / vitalsCell            — formatting helpers
   · session                                     — localStorage session (same
     keys as the old single-page panel: aiofarm_server_url / aiofarm_admin_token)
   · api(path, opts)                             — fetch wrapper (X-Admin-Token,
     401 → session dropped → back to the sign-in page)
   · requireSession()                            — guard: no token → redirect
   · initChrome(active, opts)                    — injects header + nav + conn
     badge + sign-out into #siteHeader; highlights the active tab
   · toast(msg, kind)                            — replaces alert()
   · startPolling(fn, ms)                        — interval that pauses while
     the tab is hidden (saves the server 120 req/min per forgotten tab) */
(function () {
  const LS_URL = 'aiofarm_server_url';
  const LS_TOKEN = 'aiofarm_admin_token';
  const LOGIN_PAGE = 'index.html';

  // ── formatting ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtAge(ts) {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  // Compact 376.5k / 7.2M style formatting for the vitals columns.
  function fmtK(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return (Math.round(n / 100) / 10) + 'k';
    return String(n);
  }

  function vitalsCell(v) {
    if (!v || (!v.stamina && !v.hp && !v.mana)) return '—';
    const hp = v.hp && v.hp.max ? `${fmtK(v.hp.cur)}/${fmtK(v.hp.max)}` : '—';
    const st = v.stamina && v.stamina.max ? `${fmtK(v.stamina.cur)}/${fmtK(v.stamina.max)}` : '—';
    const mp = v.mana && v.mana.max ? `${fmtK(v.mana.cur)}/${fmtK(v.mana.max)}mp` : null;
    return `${hp} · ${st}${mp ? ` · ${mp}` : ''}`;
  }

  const STATUS_COLORS = {
    running: 'ok', logging_in: 'warn', starting: 'warn',
    logged_out: 'warn', error: 'bad', stopped: 'bad', crashed: 'bad',
  };

  // ── session ──────────────────────────────────────────────────────────────
  const session = {
    get url() { return (localStorage.getItem(LS_URL) || '').trim().replace(/\/+$/, ''); },
    set url(v) {
      const clean = String(v || '').trim().replace(/\/+$/, '');
      if (clean) localStorage.setItem(LS_URL, clean);
      else localStorage.removeItem(LS_URL);
    },
    get token() { return (localStorage.getItem(LS_TOKEN) || '').trim(); },
    set token(v) {
      if (v) localStorage.setItem(LS_TOKEN, String(v));
      else localStorage.removeItem(LS_TOKEN);
    },
    signedIn() { return !!(this.url && this.token); },
    drop() { this.token = ''; },
  };

  let me = { username: '', role: 'user' };
  function isOwner() { return me.role === 'owner'; }

  // ── api ──────────────────────────────────────────────────────────────────
  let onSignedOut = null; // set by initChrome; used when a 401 kills the session
  async function api(path, opts = {}) {
    if (!session.signedIn()) throw new Error('sign in first (server URL + username + password)');
    const res = await fetch(session.url + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': session.token,
        ...(opts.headers || {}),
      },
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON body */ }
    if (!res.ok || data.ok === false) {
      // A dead session token → drop it and bounce to the sign-in page.
      if (res.status === 401 && path !== '/api/login') {
        session.drop();
        if (onSignedOut) onSignedOut();
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  // ── chrome (header + nav + badge) ────────────────────────────────────────
  const NAV = [
    { href: 'dashboard.html', key: 'dashboard', label: 'Dashboard' },
    { href: 'accounts.html', key: 'accounts', label: 'Accounts' },
    { href: 'targets.html', key: 'targets', label: 'Targets' },
    { href: 'stats.html', key: 'stats', label: 'Stats' },
    { href: 'users.html', key: 'users', label: 'Users', ownerOnly: true },
  ];

  function requireSession() {
    if (session.signedIn()) return true;
    location.replace(LOGIN_PAGE);
    return false;
  }

  function initChrome(active, { tagline } = {}) {
    const host = document.getElementById('siteHeader');
    if (!host) return { badge: () => {}, text: () => {} };
    document.body.classList.toggle('is-owner', isOwner());

    host.innerHTML = `
      <div class="topbar">
        <a class="brand" href="dashboard.html">
          <span class="brand-mark">▲</span>
          <div>
            <h1>aio-farm</h1>
            <p class="tagline">${esc(tagline || 'shared-target multi-account orchestrator · server-side containers')}</p>
          </div>
        </a>
        <div class="conn" id="connBadge" data-state="unknown">
          <span class="dot"></span><span id="connText">not connected</span>
        </div>
      </div>
      <nav class="tabs" id="mainNav">
        ${NAV.map((n) => `<a href="${n.href}" data-nav="${n.key}" class="${n.ownerOnly ? 'owner-only' : ''}${n.key === active ? ' active' : ''}">${n.label}</a>`).join('')}
        <span style="flex:1"></span>
        <span id="whoChip" class="chip dim" style="align-self:center"></span>
        <button id="btnSignout" class="ghost small" style="align-self:center">Sign out</button>
      </nav>`;

    const badge = host.querySelector('#connBadge');
    const text = host.querySelector('#connText');
    const chip = host.querySelector('#whoChip');

    function renderWho() {
      document.body.classList.toggle('is-owner', isOwner());
      const navUsers = host.querySelector('[data-nav="users"]');
      if (navUsers) navUsers.style.display = isOwner() ? 'inline-block' : 'none';
      chip.textContent = me.username
        ? `${me.username} · ${isOwner() ? 'owner' : 'user'}`
        : '';
    }
    renderWho();

    host.querySelector('#btnSignout').addEventListener('click', async () => {
      try {
        await fetch(session.url + '/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': session.token },
          body: '{}',
        });
      } catch (_) { /* best effort — the local session is going away anyway */ }
      session.drop();
      location.href = LOGIN_PAGE;
    });

    onSignedOut = () => {
      setBadge('unknown', 'signed out — session expired');
      setTimeout(() => location.replace(LOGIN_PAGE), 600);
    };

    return {
      setBadge(state, label) {
        badge.dataset.state = state;
        text.textContent = label;
      },
      setMe(username, role) {
        me = { username: username || me.username, role: role || me.role };
        renderWho();
      },
      isOwner,
    };
  }

  // ── toast ────────────────────────────────────────────────────────────────
  function toast(msg, kind = '', ms = 4200) {
    let host = document.getElementById('toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = String(msg || '');
    host.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function confirmDanger(question) {
    return window.confirm(question);
  }

  // ── polling (pauses while the tab is hidden) ─────────────────────────────
  function startPolling(fn, ms = 15000, runNow = true) {
    let timer = null;
    const tick = () => { if (!document.hidden) fn().catch(() => {}); };
    const start = () => { if (!timer) timer = setInterval(tick, ms); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else { start(); tick(); }
    });
    start();
    if (runNow) tick();
    return { stop };
  }

  window.AioFarm = {
    esc, fmtAge, fmtK, vitalsCell, STATUS_COLORS,
    session, api, requireSession, initChrome, toast, confirmDanger,
    startPolling, isOwner, get me() { return me; },
  };
})();
