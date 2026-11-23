'use strict';
/* login.js — the sign-in page. Same POST /api/login as before; the issued
   session token stays in this browser's localStorage. On success we bounce
   straight to the dashboard. A still-valid saved session skips the form. */
(function () {
  const { session } = window.AioFarm;

  const $ = (id) => document.getElementById(id);
  $('serverUrl').value = session.url;

  // Already signed in (and the token still works) → dashboard immediately.
  if (session.signedIn()) {
    (async () => {
      try {
        await window.AioFarm.api('/api/me');
        location.replace('dashboard.html');
      } catch (_) { /* stale token — the form below takes over */ }
    })();
  }

  function setBusy(on) { $('btnLogin').disabled = !!on; }

  async function login() {
    const msg = $('loginMsg');
    const base = ($('serverUrl').value || '').trim().replace(/\/+$/, '');
    const username = ($('loginUser').value || '').trim();
    const password = $('loginPass').value || '';
    if (!base || !username || !password) {
      msg.className = 'msg bad';
      msg.textContent = 'server URL, username and password are all required';
      return;
    }
    session.url = base;
    setBusy(true);
    msg.className = 'msg';
    msg.textContent = 'signing in…';
    try {
      const res = await fetch(session.url + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      session.token = data.token;
      msg.className = 'msg good';
      msg.textContent = `signed in as ${data.username} — opening the dashboard…`;
      location.replace('dashboard.html');
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = `sign-in failed: ${e.message}`;
      setBusy(false);
    }
  }

  $('btnLogin').addEventListener('click', login);
  $('loginPass').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') login(); });
  $('loginUser').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') login(); });
  $('toggleLoginPass').addEventListener('click', () => {
    const el = $('loginPass');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('toggleLoginPass').textContent = el.type === 'password' ? 'show' : 'hide';
  });
})();
