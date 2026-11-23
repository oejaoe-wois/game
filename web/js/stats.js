'use strict';
/* stats.js — the stat-allocation page. POST /api/stats/allocate supports two
   modes; the old single-page panel only ever used "plan". Both are here:
   · plan    {plan:{attack,defense,stamina}}        — spend fixed amounts
   · targets {targets:{attack,defense,stamina}}     — spend up to goals    */
(function () {
  const F = window.AioFarm;
  const { esc, api, toast } = F;
  const $ = (id) => document.getElementById(id);

  if (!F.requireSession()) return;
  const chrome = F.initChrome('stats', {
    tagline: 'spend banked stat points & track attributes',
  });

  let accounts = [];
  let lastInfo = null;

  function renderPicker() {
    const sel = $('statAccount');
    const current = sel.value;
    sel.innerHTML = '<option value="">oldest healthy account</option>' +
      accounts.map((a) =>
        `<option value="${esc(a.id)}"${a.id === current ? ' selected' : ''}>${esc(a.nickname)} (${esc(a.status)})</option>`
      ).join('');
  }

  function renderStatsTable() {
    const tbody = $('statRows');
    if (!accounts.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${F.isOwner()
        ? 'no accounts on the farm yet' : 'you have no accounts on the farm yet'}</td></tr>`;
      return;
    }
    tbody.innerHTML = accounts.map((a) => {
      const s = a.stats || {};
      return `<tr>
        <td>${esc(a.nickname)}</td>
        <td><span class="chip ${a.status === 'running' ? 'ok' : 'warn'}">${esc(a.status)}</span></td>
        <td class="num">${s.points != null ? Number(s.points).toLocaleString() : '—'}</td>
        <td class="num">${s.attack ?? '—'}</td>
        <td class="num">${s.defense ?? '—'}</td>
        <td class="num">${s.staminaMax != null ? Number(s.staminaMax).toLocaleString() : '—'}</td>
      </tr>`;
    }).join('');
  }

  function renderInfo(info) {
    if (!info) return;
    lastInfo = info;
    const p = info.configuredPlan || {};
    const t = info.configuredTargets || {};
    $('statMeta').textContent =
      `server STAT_PLAN: attack ${p.attack || 0} · defense ${p.defense || 0} · stamina ${p.stamina || 0}` +
      ` · auto-allocate ${info.autoAllocate ? 'ON (once per session when points cover it)' : 'off'}` +
      ` · STAT_TARGETS: attack ${t.attack || 0} · defense ${t.defense || 0} · stamina ${t.stamina || 0}` +
      ` · targets auto ${info.targetsAuto ? 'ON (spends fresh level-up points toward the goals)' : 'off'}`;
    // Pre-fill from the server config while the inputs are untouched.
    const pre = [
      ['statAttack', p.attack], ['statDefense', p.defense], ['statStamina', p.stamina],
      ['tgtAttack', t.attack], ['tgtDefense', t.defense], ['tgtStamina', t.stamina],
    ];
    for (const [id, val] of pre) {
      const el = $(id);
      if (el && !el.value && val) el.value = String(val);
    }
  }

  function read3(prefix) {
    const ids = prefix === 'stat'
      ? ['statAttack', 'statDefense', 'statStamina']
      : ['tgtAttack', 'tgtDefense', 'tgtStamina'];
    return { attack: Number($(ids[0]).value) || 0, defense: Number($(ids[1]).value) || 0, stamina: Number($(ids[2]).value) || 0 };
  }

  async function refresh() {
    try {
      const status = await api('/api/status');
      if (status.you) chrome.setMe(status.you.username, status.you.role);
      accounts = status.accounts || [];
      chrome.setBadge('ok', `${F.me.username ? F.me.username + ' · ' : ''}connected · ${accounts.length} account(s)`);
      renderPicker();
      renderStatsTable();
      api('/api/stats').then(renderInfo).catch(() => {});
    } catch (e) {
      chrome.setBadge('bad', e.message);
    }
  }

  $('statMode').addEventListener('change', () => {
    const mode = $('statMode').value;
    $('planFields').hidden = mode !== 'plan';
    $('targetFields').hidden = mode !== 'targets';
  });

  $('btnAllocate').addEventListener('click', async () => {
    const msg = $('statMsg');
    const mode = $('statMode').value;
    const body = {};
    if ($('statAccount').value) body.accountId = $('statAccount').value;
    const values = read3(mode === 'plan' ? 'stat' : 'tgt');
    if (values.attack + values.defense + values.stamina <= 0) {
      msg.className = 'msg bad';
      msg.textContent = mode === 'plan'
        ? 'enter at least one amount'
        : 'enter at least one goal';
      return;
    }
    body[mode] = values; // api.js reads `plan` / `targets`
    const btn = $('btnAllocate');
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = mode === 'plan'
      ? 'allocating… (large plans post one chunk per 100/50/5/1)'
      : 'spending toward the goals… (server truth is re-read after every chunk)';
    try {
      const r = await api('/api/stats/allocate', { method: 'POST', body: JSON.stringify(body) });
      const rep = r.report || {};
      msg.className = 'msg ' + (rep.ok ? 'good' : 'bad');
      msg.textContent = rep.ok
        ? `applied ${Number(rep.applied || 0).toLocaleString()} points` +
          (rep.pointsLeft != null ? ` — ${Number(rep.pointsLeft).toLocaleString()} left on the account` : '') +
          (mode === 'targets' && rep.reason === 'targets_reached' ? ' — targets reached' : '')
        : `refused: ${rep.reason || 'failed'}`;
      if (rep.ok) toast(`allocated ${Number(rep.applied || 0).toLocaleString()} points`, 'good');
      refresh();
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = `refused: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  F.startPolling(refresh, 15000);
})();
