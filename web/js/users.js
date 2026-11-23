'use strict';
/* users.js — owner-only management of friend panel logins (GET/POST/DELETE
   /api/users…). Non-owners are bounced back to the dashboard. */
(function () {
  const F = window.AioFarm;
  const { esc, api, toast, confirmDanger } = F;
  const $ = (id) => document.getElementById(id);

  if (!F.requireSession()) return;
  const chrome = F.initChrome('users', {
    tagline: 'create and manage friend panel logins',
  });

  async function loadUsers() {
    try {
      const r = await api('/api/users');
      const rows = r.users || [];
      $('userRows').innerHTML = rows.length ? rows.map((u) => `<tr>
        <td>${esc(u.username)}</td>
        <td class="num">${u.accounts}</td>
        <td class="actions">
          <button class="ghost small" data-userpw="${esc(u.username)}">reset password</button>
          <button class="danger small" data-userdel="${esc(u.username)}">delete</button>
        </td></tr>`).join('') : `<tr><td colspan="3" class="empty">no friend logins yet</td></tr>`;
    } catch (_) { /* signed out or not owner — the guard below handles the rest */ }
  }

  // Non-owners: this endpoint answers 403 → bounce back to the dashboard.
  (async () => {
    try {
      const me = await api('/api/me');
      chrome.setMe(me.username, me.role);
      if (me.role !== 'owner') { location.replace('dashboard.html'); return; }
      chrome.setBadge('ok', `${me.username} · owner`);
      loadUsers();
    } catch (_) { /* requireSession + api() already redirect on 401 */ }
  })();

  $('btnAddUser').addEventListener('click', async () => {
    const msg = $('userMsg');
    msg.className = 'msg';
    const username = $('newUser').value.trim();
    const password = $('newUserPass').value;
    if (!username || !password) { msg.textContent = 'username and password are required'; return; }
    if (password.length < 8) { msg.textContent = 'password needs 8+ characters'; return; }
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password }) });
      msg.className = 'msg good';
      msg.textContent = `created ${username} — send them the username, password and the panel link`;
      $('newUser').value = '';
      $('newUserPass').value = '';
      toast(`${username} can now sign in`, 'good');
      loadUsers();
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = `failed: ${e.message}`;
    }
  });

  $('userRows').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const msg = $('userMsg');
    msg.className = 'msg';
    try {
      if (btn.dataset.userpw) {
        const name = btn.dataset.userpw;
        const pw = prompt(`New password for ${name} (8+ chars):`);
        if (!pw) return;
        if (pw.length < 8) { msg.textContent = 'password needs 8+ characters'; return; }
        await api(`/api/users/${encodeURIComponent(name)}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) });
        msg.textContent = `password reset for ${name} — they were signed out`;
        toast(`${name}'s password was reset`, 'good');
      } else if (btn.dataset.userdel) {
        const name = btn.dataset.userdel;
        if (!confirmDanger(`Delete ${name}?\n\nOK = delete the user AND remove all their game accounts from the farm.\nCancel = go back.`)) return;
        const r = await api(`/api/users/${encodeURIComponent(name)}?accounts=remove`, { method: 'DELETE' });
        msg.textContent = `deleted ${name} and ${r.removedAccounts || 0} game account(s)`;
        toast(`${name} deleted`, 'good');
      }
      loadUsers();
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = `failed: ${e.message}`;
    }
  });
})();
