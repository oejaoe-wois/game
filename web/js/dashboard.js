'use strict';
/* dashboard.js — the read-mostly overview. Status + targets every 15 s while
   the tab is visible. Management actions live on their own pages. */
(function () {
  const F = window.AioFarm;
  const { esc, fmtAge, fmtK, vitalsCell, STATUS_COLORS, session, api, toast } = F;
  const $ = (id) => document.getElementById(id);

  if (!F.requireSession()) return;
  const chrome = F.initChrome('dashboard');

  let siteLabels = {};

  function setBadge(state, label) { chrome.setBadge(state, label); }

  function renderTiles(status, accounts) {
    const running = accounts.filter((a) => a.status === 'running').length;
    $('tileRunning').textContent = `${running} / ${accounts.length}`;
    $('tileRunning').className = 'v' + (running ? ' ok' : (accounts.length ? ' bad' : ''));
    $('tileAccounts').textContent = String(accounts.length);
    const farmEl = $('tileFarm');
    farmEl.textContent = status.farmEnabled === false ? 'paused' : 'on';
    farmEl.className = 'v' + (status.farmEnabled === false ? ' bad' : ' ok');
    const expSum = accounts.reduce((n, a) => n + (Number(a.exp && a.exp.gained) || 0), 0);
    $('tileExp').innerHTML = `${fmtK(expSum)} <small>exp</small>`;
    $('tileScout').textContent = fmtAge(status.scout && status.scout.lastRun);
    const up = Math.round((status.uptimeSec || 0) / 60);
    $('tileUptime').textContent = up >= 60 ? `${Math.floor(up / 60)}h ${up % 60}m` : `${up}m`;
  }

  function renderFarmToggle(enabled) {
    const b = $('farmToggle');
    b.hidden = !F.isOwner(); // one switch for the whole farm → owner only
    const on = enabled !== false;
    b.dataset.on = on ? '1' : '0';
    b.textContent = on ? 'farm: ON — pause' : 'farm: PAUSED — resume';
  }

  function renderMeta(status, accounts) {
    const siteBits = (status.sites || [])
      .map((x) => `${x.label}: ${x.active ? `${x.accounts} acct` : 'idle'}`)
      .join(' · ');
    let line = `scout last run ${fmtAge(status.scout && status.scout.lastRun)}` +
      (status.scout && status.scout.lastError ? ` · scout error: ${status.scout.lastError}` : '') +
      ` · farm ${status.farmEnabled === false ? 'paused' : 'active'}`;
    if (siteBits) line += ` · ${siteBits}`;
    $('metaLine').textContent = line;
    setBadge('ok', `${F.me.username ? F.me.username + ' · ' : ''}connected · ` +
      `${accounts.filter((a) => a.status === 'running').length}/${accounts.length} running`);
  }

  function renderAccounts(accounts) {
    const tbody = $('acctRows');
    if (!accounts || !accounts.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${F.isOwner()
        ? 'no accounts on the farm yet — add one on the Accounts page'
        : 'you have no accounts on the farm yet — add one on the Accounts page'}</td></tr>`;
      return;
    }
    const STALE_MS = 10 * 60 * 1000;
    tbody.innerHTML = accounts.map((a) => {
      const color = STATUS_COLORS[a.status] || 'warn';
      const now = a.runningWave ? `wave: ${a.runningWave}`
        : (a.runningBoss || (a.farmConfiguredAt ? 'auto-farm' : 'idle'));
      const stale = a.lastActionAt && (Date.now() - a.lastActionAt > STALE_MS);
      const lastAct = a.lastActionAt ? `${fmtAge(a.lastActionAt)}${stale ? ' · quiet' : ''}` : '—';
      const expCell = a.exp && (a.exp.gained || a.exp.percent != null)
        ? `+${(a.exp.gained || 0).toLocaleString()}${a.exp.percent != null ? ` · ${a.exp.percent}%` : ''}`
        : '—';
      const ownerBit = F.isOwner() && a.owner ? ` <span class="hint">· ${esc(a.owner)}</span>` : '';
      return `<tr>
        <td>${esc(a.nickname)}${ownerBit}<br><span class="hint">${esc(a.emailMasked)}</span></td>
        <td>${esc(siteLabels[a.site] || a.site || '—')}</td>
        <td><span class="chip ${color}">${esc(a.status)}</span>${a.lastError ? `<br><span class="hint" style="color:var(--bad)">${esc(String(a.lastError).slice(0, 90))}</span>` : ''}</td>
        <td class="num">${a.level || '—'}</td>
        <td class="num">${esc(expCell)}</td>
        <td class="num">${esc(vitalsCell(a.vitals))}</td>
        <td>${esc(String(now))}</td>
        <td class="${stale ? 'stale' : ''}">${esc(lastAct)}</td>
      </tr>`;
    }).join('');
  }

  function renderTargets(snap) {
    const tbody = $('targetRows');
    const bosses = Object.entries(snap.bosses || {});
    $('scoutLine').textContent = `${(snap.mobs || []).length} live mobs on the bus` +
      (snap.intervalMs ? ` · scout sweeps every ${Math.round(snap.intervalMs / 1000)}s` : '');
    if (!bosses.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">no boss targets published yet — the scout runs once an account is logged in</td></tr>`;
      return;
    }
    tbody.innerHTML = bosses.map(([key, t]) => `<tr>
      <td>${esc(t.name)}</td>
      <td><code>${esc(t.monsterId)}</code></td>
      <td>${esc(t.waveLabel || t.wave)}</td>
      <td>${fmtAge(t.foundAt)}</td>
      <td>${t.battleUrl ? `<a class="chip" href="${esc(t.battleUrl)}" target="_blank" rel="noopener" title="open battle.php — view only, no damage">view</a>` : '—'}</td>
    </tr>`).join('');
  }

  function syncSites(sites) {
    if (!Array.isArray(sites) || !sites.length) return;
    siteLabels = Object.fromEntries(sites.map((x) => [x.key, x.label]));
  }

  async function refresh() {
    try {
      const status = await api('/api/status');
      if (status.you) chrome.setMe(status.you.username, status.you.role);
      const accounts = status.accounts || [];
      syncSites(status.sites);
      renderTiles(status, accounts);
      renderFarmToggle(status.farmEnabled);
      renderMeta(status, accounts);
      renderAccounts(accounts);
      const targets = await api('/api/targets');
      targets.intervalMs = status.scout ? status.scout.intervalMs : 0;
      renderTargets(targets);
    } catch (e) {
      setBadge('bad', e.message);
    }
  }

  $('farmToggle').addEventListener('click', async () => {
    const b = $('farmToggle');
    const next = b.dataset.on === '1' ? false : true;
    b.disabled = true;
    try {
      await api('/api/farm', { method: 'POST', body: JSON.stringify({ enabled: next }) });
      renderFarmToggle(next);
      toast(next ? 'farm resumed' : 'farm paused', 'good');
    } catch (e) {
      toast(e.message, 'bad');
    }
    b.disabled = false;
  });

  F.startPolling(refresh, 15000);
})();
