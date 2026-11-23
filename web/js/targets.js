'use strict';
/* targets.js — the shared bus view: live boss targets, boss spawn timers
   (GET /api/spawns — the Boss Tracker data the old single-page panel never
   showed) and the gate/wave registry (GET /api/waves). */
(function () {
  const F = window.AioFarm;
  const { esc, fmtAge, api } = F;
  const $ = (id) => document.getElementById(id);

  if (!F.requireSession()) return;
  const chrome = F.initChrome('targets', {
    tagline: 'what the fetcher broadcasts & when bosses spawn',
  });

  let siteLabels = {};
  let lastMobs = []; // for the filter input
  let lastScoutInfo = { lastRun: 0, lastError: null }; // per selected site

  // ── Swarm attack state (checkbox swarm) ─────────────────────────────────
  // swarmSel: mob ids ticked in the live-mobs table (an instance per row);
  // swarmDungeon: guild-dungeon mob TYPES queued by name; swarmQuotaByName:
  // per-type damage overrides typed in the editor (falls back to the big
  // damage box). All wiped when a swarm starts.
  const swarmSel = new Map();
  const swarmDungeon = new Map();
  const swarmQuotaByName = new Map();
  let lastSwarmChips = []; // dungeon mob types the fleet last saw
  // Monster stats (the battle page's "View Monster Stats" modal) for the
  // ticked mob types — fetched per first-ticked instance id, cached here.
  const mobStatsCache = new Map(); // mobId → { at, data }

  function slugKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  }

  function quotaFor(kind, key) {
    if (swarmQuotaByName.has(kind + ':' + key)) return swarmQuotaByName.get(kind + ':' + key);
    return Math.max(1, Math.floor(Number($('swarmQuota').value) || 0));
  }

  function paintSwarmEditor() {
    const groups = new Map(); // nameKey → { key, name, count, firstId }
    for (const s of swarmSel.values()) {
      const key = slugKey(s.name) || 'unnamed';
      const g = groups.get(key) || { key, name: s.name || '(unnamed mob)', count: 0, firstId: s.id };
      g.count++;
      groups.set(key, g);
    }
    const rows = [];
    for (const g of groups.values()) {
      const val = swarmQuotaByName.has('w:' + g.key) ? swarmQuotaByName.get('w:' + g.key) : '';
      rows.push(`<div class="row" style="margin:2px 0">mob type <b>${esc(g.name)}</b> × ${g.count} instance(s)` +
        ` — damage <input type="number" min="1" class="swarmQuotaInput" data-kind="w" data-key="${esc(g.key)}"` +
        ` value="${esc(val)}" placeholder="the damage box above" style="width:150px">` +
        ` <span class="msChips meta" data-mobid="${esc(String(g.firstId || ''))}" data-kind="w" data-key="${esc(g.key)}"></span></div>`);
    }
    for (const [key, name] of swarmDungeon) {
      const val = swarmQuotaByName.has('d:' + key) ? swarmQuotaByName.get('d:' + key) : '';
      rows.push(`<div class="row" style="margin:2px 0">dungeon type <b>${esc(name)}</b>` +
        ` — damage <input type="number" min="1" class="swarmQuotaInput" data-kind="d" data-key="${esc(key)}"` +
        ` value="${esc(val)}" placeholder="the damage box above" style="width:150px">` +
        ` <button type="button" class="chip dim swarmDungeonDel" data-key="${esc(key)}">remove</button></div>`);
    }
    $('swarmEditor').innerHTML = rows.length ? rows.join('') : '—';
    const n = swarmSel.size + swarmDungeon.size;
    $('swarmSelMeta').textContent = n
      ? `${swarmSel.size} mob instance(s) ticked · ${swarmDungeon.size} dungeon type(s) queued`
      : 'nothing ticked yet — tick mobs in the list above';
    hydrateMobStats();
  }

  // ── Monster stats chips ("View Monster Stats" modal, per ticked type) ────
  // The panel asks the server for the mob's stat block + a fleet-average hit
  // forecast (the game's damage formula) so the quota input gets an honest
  // "≈N hits per account" hint before the swarm starts.
  function mobChipHtml(data, quota) {
    if (!data || !data.ok || !data.stats) return '';
    const s = data.stats;
    const bits = [
      `DEF ${Number(s.defense || 0).toLocaleString()}`,
      `EQ DEF ${Number(s.eqDefense || 0).toLocaleString()}`,
      `PET DEF ${Number(s.petDefense || 0).toLocaleString()}`,
      `${esc(s.elementLabel || 'None')}${s.elementRate ? ' ' + Number(s.elementRate) + '%' : ''}`,
    ];
    if (s.rewardsUpToLv) bits.push(`rewards ≤ LV ${Number(s.rewardsUpToLv).toLocaleString()}`);
    const avg = data.forecast && Number(data.forecast.avgHit) || 0;
    if (avg > 0 && quota > 0) bits.push(`≈${Math.ceil(quota / avg).toLocaleString()} hit(s)/account @ ≈${avg.toLocaleString()} dmg`);
    if (data.forecast && data.forecast.countered) bits.push('element countered ×2');
    return '· ' + bits.join(' · ');
  }

  function hydrateMobStats() {
    const site = $('targetSite').value || 'demonic';
    for (const span of [...document.querySelectorAll('#swarmEditor .msChips[data-mobid]')]) {
      const mobId = span.dataset.mobid;
      if (!mobId) continue;
      const quota = quotaFor(span.dataset.kind, span.dataset.key);
      const cached = mobStatsCache.get(mobId);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
        span.innerHTML = mobChipHtml(cached.data, quota);
        continue;
      }
      span.textContent = '· stats…';
      api('/api/monster-stats?site=' + encodeURIComponent(site) + '&mobId=' + encodeURIComponent(mobId))
        .then((data) => {
          mobStatsCache.set(mobId, { at: Date.now(), data });
          if (span.isConnected) span.innerHTML = mobChipHtml(data, quota);
        })
        .catch(() => { if (span.isConnected) span.textContent = ''; });
    }
  }

  function renderDungeonChips(names) {
    const list = Array.isArray(names) ? names : [];
    if (!list.length) {
      $('dungeonChips').textContent = 'no dungeon mobs seen yet — type a type above';
      return;
    }
    $('dungeonChips').innerHTML = 'seen on the floors: ' + list.map((n) => {
      const picked = swarmDungeon.has(slugKey(n));
      return `<button type="button" class="chip${picked ? '' : ' dim'} swarmChip" data-name="${esc(n)}">` +
        `${picked ? esc(n) + ' · queued' : '+ ' + esc(n)}</button>`;
    }).join(' ');
  }

  function syncSites(sites) {
    if (!Array.isArray(sites) || !sites.length) return;
    siteLabels = Object.fromEntries(sites.map((x) => [x.key, x.label]));
    const sel = $('targetSite');
    const have = [...sel.options].map((o) => o.value).join();
    if (have === sites.map((x) => x.key).join()) return;
    const cur = sel.value;
    sel.innerHTML = sites.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('');
    if (cur && siteLabels[cur]) sel.value = cur;
  }

  // Honest boss-table empty state: "scout dead" ≠ "no bosses alive right now".
  function bossEmptyMessage() {
    if (!lastScoutInfo.lastRun) {
      return 'the scout has not swept yet — it starts once an account on this site logs in';
    }
    if (lastScoutInfo.lastError) {
      return `last sweep errored: ${lastScoutInfo.lastError}`;
    }
    const age = fmtAge(lastScoutInfo.lastRun);
    return `no catalogue bosses are alive on the watched waves right now (last sweep ${age}) — ` +
      'every mob the pages DO show is in the live-mobs list below';
  }

  function renderTargets(snap) {
    const tbody = $('targetRows');
    const bosses = Object.entries(snap.bosses || {});
    const mobCount = (snap.mobs || []).length;
    const swept = lastScoutInfo.lastRun ? ` · last sweep ${fmtAge(lastScoutInfo.lastRun)}` : '';
    $('targetMeta').textContent =
      `fetcher: built-in admin account (hidden, fixed) · ${mobCount} live mobs on the bus` +
      (snap.intervalMs ? ` · sweeps every ${Math.round(snap.intervalMs / 1000)}s` : '') + swept;
    if (!bosses.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">${esc(bossEmptyMessage())}</td></tr>`;
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

  function renderMobs(snap) {
    lastMobs = snap.mobs || [];
    paintMobs();
  }

  // ── Swarm status view (the coordinator's queue + per-account progress) ────
  function renderSwarm(st) {
    const box = $('swarmStatus');
    if (!st || !st.ok) {
      box.innerHTML = '<span class="hint">swarm status unavailable</span>';
      return;
    }
    if (!st.targets || !st.targets.length) {
      box.innerHTML = '<span class="hint">no swarm yet — tick mobs above and press Swarm</span>';
      return;
    }
    const chip = st.status === 'running' ? '<span class="chip ok">swarming</span>'
      : st.status === 'complete' ? '<span class="chip ok">complete</span>'
        : st.status === 'stopped' ? '<span class="chip warn">stopped</span>'
          : `<span class="chip dim">${esc(st.status || 'idle')}</span>`;
    const cur = st.currentTarget;
    const intel = cur && cur.intel ? cur.intel : null;
    const intelBits = intel
      ? [
          intel.avgHit ? `≈${Number(intel.avgHit).toLocaleString()} dmg/hit` : null,
          intel.hitsLeft ? `≈${Number(intel.hitsLeft).toLocaleString()} hit(s) left` : null,
          intel.countered ? 'element countered ×2' : null,
          `DEF ${Number(intel.defense || 0).toLocaleString()} · EQ ${Number(intel.eqDefense || 0).toLocaleString()} · PET ${Number(intel.petDefense || 0).toLocaleString()}`,
          `${esc(intel.element || 'None')}${intel.elementRate ? ' ' + Number(intel.elementRate) + '%' : ''}`,
          intel.rewardsUpToLv ? `rewards ≤ LV ${Number(intel.rewardsUpToLv).toLocaleString()}` : null,
        ].filter(Boolean).join(' · ')
      : '';
    const curLine = cur
      ? `current target: <b>${esc(cur.name || `mob ${cur.mobId}`)}</b>${cur.kind === 'dungeon' ? ' <span class="chip dim">guild dungeon</span>' : ''} ` +
        `<code>${esc(cur.mobId || '—')}</code> — quota ${Number(cur.quota).toLocaleString()}` +
        (cur.mobDead ? ' · <span class="chip warn">instance dead — moving on</span>' : '') +
        (intelBits ? `<div class="meta">${intelBits}</div>` : '')
      : `queue empty — ${esc(st.status || 'idle')}`;
    const accounts = (st.accounts || []).map((a) => {
      const rec = a.byTarget && cur && a.byTarget[cur.key];
      const dmg = rec ? rec.damage : 0;
      const quota = cur ? cur.quota : 0;
      const pct = quota ? Math.min(100, Math.round((dmg / quota) * 100)) : 0;
      const done = rec && (rec.stopReason === 'SLAIN' || rec.stopReason === 'DEAD' || (quota && dmg >= quota));
      const waiting = rec && rec.lastStop === 'OUT_OF_STAMINA' && !done;
      const sta = a.stamina && Number.isFinite(Number(a.stamina.cur))
        ? (Number(a.stamina.cur) < 1
          ? ' <span class="chip warn">no stamina — waiting for a refill</span>'
          : ` <span class="chip dim" title="stats.php stamina bar">⚡ ${Number(a.stamina.cur).toLocaleString()} / ${Number(a.stamina.max || 0).toLocaleString()}</span>`)
        : (waiting ? ' <span class="chip warn">out of stamina</span>' : '');
      return `<div class="row" style="margin:3px 0">
        <span style="min-width:150px;display:inline-block">${esc(a.nickname)}${a.active ? '' : ' <span class="chip dim">offline</span>'}${sta}</span>
        <span style="flex:1;background:#e6e6ec;border-radius:4px;height:10px;position:relative;overflow:hidden;min-width:120px">
          <span style="position:absolute;top:0;bottom:0;left:0;width:${pct}%;background:${done ? '#2e9e5b' : '#4a7fd4'}"></span>
        </span>
        <span class="meta">${Number(dmg).toLocaleString()} / ${quota ? Number(quota).toLocaleString() : '—'}${rec && rec.stopReason ? ' · ' + esc(rec.stopReason) : ''}</span>
      </div>`;
    }).join('');
    const queue = (st.targets || []).map((t) => {
      const state = t.done ? '<span class="chip ok">done</span>'
        : (t.index === st.current ? '<span class="chip warn">attacking</span>' : '<span class="chip dim">queued</span>');
      const tIntel = t.intel && t.intel.avgHit ? ` <span class="chip dim">≈${Number(t.intel.avgHit).toLocaleString()}/hit</span>` : '';
      return `<tr>
        <td>${t.index + 1}</td>
        <td>${esc(t.name || `mob ${t.mobId}`)}${t.kind === 'dungeon' ? ' <span class="chip dim">dungeon</span>' : ''}${t.refilled ? ' <span class="chip dim">refill</span>' : ''}${tIntel}</td>
        <td><code>${esc(t.mobId || '—')}</code></td>
        <td>${esc(t.waveLabel || t.wave || '—')}</td>
        <td>${Number(t.quota).toLocaleString()}</td>
        <td>${Number(t.damage || 0).toLocaleString()}</td>
        <td>${state}${t.mobDead ? ' <span class="chip dim">mob died</span>' : ''}</td>
      </tr>`;
    }).join('');
    const log = (st.log || []).slice(-10).map((l) => `<div class="meta">${new Date(l.at).toLocaleTimeString()} — ${esc(l.msg)}</div>`).join('');
    box.innerHTML = `
      <div class="row" style="margin:4px 0">${chip}
        <span>${curLine}</span>
        <span class="meta">${st.mode === 'total' ? 'combined quotas' : 'per-account quotas'}${st.autoRefill ? ' · auto-refill on' : ''} · ${st.current}/${st.total} target(s) advanced · ${Number(st.totalDamage || 0).toLocaleString()} dmg banked</span>
      </div>
      <div>${accounts || '<span class="hint">no account joined the swarm yet</span>'}</div>
      <div class="tablewrap" style="margin-top:8px"><table>
        <thead><tr><th>#</th><th>Target</th><th>Mob ID</th><th>Wave</th><th>Quota</th><th>Banked</th><th>State</th></tr></thead>
        <tbody>${queue}</tbody>
      </table></div>
      <div style="margin-top:8px">${log || '<span class="hint">log empty</span>'}</div>`;
  }

  function paintMobs() {
    const tbody = $('mobRows');
    const q = ($('mobFilter').value || '').trim().toLowerCase();
    const rows = q
      ? lastMobs.filter((m) => `${m.name} ${m.waveLabel || ''} ${m.wave}`.toLowerCase().includes(q))
      : lastMobs;
    $('mobMeta').textContent = q
      ? `${rows.length} of ${lastMobs.length} mobs match “${q}”`
      : `${lastMobs.length} mobs${lastMobs.length >= 200 ? ' (bus cap)' : ''}`;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${lastMobs.length
        ? 'no mobs match the filter'
        : 'no live mobs on the bus yet — the sweep lists every mob it sees on the wave pages here'}</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((m) => {
      const dies = m.expiresAt ? fmtIn(m.expiresAt - Date.now()) : '—';
      const stale = m.expiresAt && m.expiresAt < Date.now();
      const picked = swarmSel.has(String(m.id));
      return `<tr>
        <td><input type="checkbox" class="mobPick" data-id="${esc(String(m.id))}" data-name="${esc(m.name || '')}" data-wave="${esc(m.wave || '')}" data-wavelabel="${esc(m.waveLabel || '')}"${picked ? ' checked' : ''}></td>
        <td>${esc(m.name || '(unnamed mob)')}</td>
        <td><code>${esc(m.id)}</code></td>
        <td>${esc(m.waveLabel || m.wave)}</td>
        <td>${fmtAge(m.foundAt)}</td>
        <td>${stale ? '<span class="chip dim">replaced</span>' : esc(dies)}</td>
        <td>${m.battleUrl ? `<a class="chip" href="${esc(m.battleUrl)}" target="_blank" rel="noopener" title="open battle.php — view only, no damage">view</a>` : '—'}</td>
      </tr>`;
    }).join('');
  }

  function fmtIn(ms) {
    if (!ms && ms !== 0) return '—';
    const s = Math.round(ms / 1000);
    if (s <= 0) return 'any moment';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 48) return `${Math.round(h / 24)}d`;
    return h ? `${h}h ${m}m` : (m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`);
  }

  function renderSpawns(data) {
    const grid = $('spawnGrid');
    const cards = data.cards || [];
    const scanned = data.at ? fmtAge(data.at) : 'never';
    $('spawnMeta').textContent =
      `last scan ${scanned} · phase gate ${data.phaseGate ? 'ON (48h bosses rest in phase 1)' : 'off'} · phase 2 begins ${data.phase2Hours || 24}h before death`;
    if (!cards.length) {
      grid.innerHTML = `<span class="hint">no spawn scan yet — the scout fills this in on its first sweep after an account logs in</span>`;
      return;
    }
    grid.innerHTML = cards.map((c) => {
      const aliveChip = c.alive
        ? (c.phase === 1 ? '<span class="chip warn">phase 1 — wait</span>'
          : (c.phase === 2 ? '<span class="chip ok">phase 2 — damage counts</span>'
            : '<span class="chip ok">alive</span>'))
        : '<span class="chip dim">down</span>';
      const when = c.alive
        ? (c.dieSec ? `dies in ${fmtIn((c.dieSec || 0) * 1000)}` : 'alive now')
        : `respawns in ${fmtIn(c.nextTs ? c.nextTs - Date.now() : null)}`;
      const dmg = c.youDmg ? Number(c.youDmg).toLocaleString() : '0';
      return `<div class="spawn">
        <div class="name">${esc(c.name)}</div>
        <div class="line">${aliveChip}<span>${esc(when)}</span></div>
        <div class="line"><span>your dmg</span><b>${esc(dmg)}</b></div>
        <div class="line"><span>mob id</span><b><code>${esc(c.monsterId || '—')}</code></b></div>
      </div>`;
    }).join('');
  }

  function renderWaves(data) {
    const tbody = $('waveRows');
    const capBits = [];
    capBits.push(`cap mode ${data.capMode || 'auto'}`);
    if (data.mobDamageCap) capBits.push(`last-resort cap ${Number(data.mobDamageCap).toLocaleString()}`);
    if (data.learnedCaps != null) capBits.push(`${data.learnedCaps} loot gates learned`);
    if (data.waveMobsPerRound) capBits.push(`${data.waveMobsPerRound} mobs/round`);
    $('waveMeta').textContent = capBits.join(' · ');
    const waves = data.waves || [];
    if (!waves.length) {
      tbody.innerHTML = `<tr><td colspan="2" class="empty">registry empty — check WAVE_PAGES / config/waves.json</td></tr>`;
      return;
    }
    tbody.innerHTML = waves.map((w) => `<tr>
      <td><code>${esc(w.path || w)}</code></td>
      <td>${esc(w.label || '')}</td>
    </tr>`).join('');
  }

  async function refresh() {
    try {
      const status = await api('/api/status');
      if (status.you) chrome.setMe(status.you.username, status.you.role);
      syncSites(status.sites);
      chrome.setBadge('ok', `${F.me.username ? F.me.username + ' · ' : ''}connected`);
      const site = $('targetSite').value || 'demonic';
      // Per-site sweep health drives the honest empty states below.
      const siteEntry = (status.sites || []).find((s) => s.key === site);
      lastScoutInfo = {
        lastRun: (siteEntry && siteEntry.scout && siteEntry.scout.lastRun) || 0,
        lastError: (siteEntry && siteEntry.scout && siteEntry.scout.lastError) || null,
      };
      const targets = await api('/api/targets?site=' + encodeURIComponent(site));
      targets.intervalMs = status.scout ? status.scout.intervalMs : 0;
      renderTargets(targets);
      renderMobs(targets);
      // Spawns + waves + fleet hunt are site-scoped too; failures here don't kill the page.
      api('/api/spawns?site=' + encodeURIComponent(site)).then(renderSpawns).catch(() => {});
      api('/api/waves?site=' + encodeURIComponent(site)).then(renderWaves).catch(() => {});
      api('/api/hunt?site=' + encodeURIComponent(site)).then(renderHunt).catch(() => {});
      api('/api/swarm?site=' + encodeURIComponent(site)).then((st) => {
        renderSwarm(st);
        lastSwarmChips = Array.isArray(st.dungeonMobNames) ? st.dungeonMobNames : [];
        renderDungeonChips(lastSwarmChips);
      }).catch(() => {});
    } catch (e) {
      chrome.setBadge('bad', e.message);
    }
  }

  // ── Fleet hunt (Divers pillar 1) ───────────────────────────────────────────
  async function sendHunt(mob) {
    const btn = mob === null ? $('huntStop') : $('huntGo');
    if (btn) btn.disabled = true;
    try {
      if (mob === null) {
        await api('/api/hunt?site=' + encodeURIComponent($('targetSite').value || 'demonic'), { method: 'DELETE' });
      } else {
        await api('/api/hunt?site=' + encodeURIComponent($('targetSite').value || 'demonic'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mob }),
        });
      }
      chrome.setBadge('ok', mob === null ? 'hunt stopped' : `fleet hunt: ${mob}`);
    } catch (e) {
      chrome.setBadge('bad', e.message);
    }
    if (btn) btn.disabled = false;
    refresh();
  }

  function renderHunt(data) {
    const meta = $('huntMeta');
    const list = $('huntAccounts');
    if (!data || !data.ok) {
      meta.textContent = '—';
      list.textContent = '';
      return;
    }
    const per = data.perAccount || [];
    const hunting = per.filter((a) => a.diveTargets);
    meta.textContent = data.mob
      ? `fleet target: ${data.mob} (${hunting.length}/${per.length} accounts armed)`
      : (hunting.length ? `${hunting.length}/${per.length} account(s) hunt their own targets — no fleet order` : 'no dive targets set on any account');
    list.textContent = per.length
      ? per.map((a) => `${a.nickname}: ${a.diveTargets || '—'}`).join('  ·  ')
      : 'no accounts on this site yet';
    if (data.mob && !$('huntMob').value) $('huntMob').value = data.mob;
  }

  $('huntGo').addEventListener('click', () => {
    const mob = ($('huntMob').value || '').trim();
    if (!mob) {
      chrome.setBadge('bad', 'type a mob name first (e.g. troll ravager)');
      return;
    }
    sendHunt(mob);
  });
  $('huntStop').addEventListener('click', () => {
    $('huntMob').value = '';
    sendHunt(null);
  });

  // ── Swarm attack handlers ───────────────────────────────────────────────
  $('mobTable').addEventListener('change', (ev) => {
    const box = ev.target.closest('.mobPick');
    if (!box) return;
    const id = String(box.dataset.id || '');
    if (!id) return;
    if (box.checked) {
      swarmSel.set(id, {
        id,
        name: box.dataset.name || '',
        wave: box.dataset.wave || '',
        waveLabel: box.dataset.wavelabel || '',
      });
    } else {
      swarmSel.delete(id);
    }
    paintSwarmEditor();
  });

  $('swarmEditor').addEventListener('input', (ev) => {
    const inp = ev.target.closest('.swarmQuotaInput');
    if (!inp) return;
    const k = (inp.dataset.kind === 'd' ? 'd:' : 'w:') + inp.dataset.key;
    const v = Math.floor(Number(inp.value));
    if (Number.isFinite(v) && v > 0) swarmQuotaByName.set(k, v);
    else swarmQuotaByName.delete(k);
    hydrateMobStats(); // the ≈hits hint follows the quota live (from cache)
  });

  $('swarmEditor').addEventListener('click', (ev) => {
    const del = ev.target.closest('.swarmDungeonDel');
    if (!del) return;
    swarmDungeon.delete(del.dataset.key);
    swarmQuotaByName.delete('d:' + del.dataset.key);
    paintSwarmEditor();
  });

  $('dungeonChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.swarmChip');
    if (!chip) return;
    const key = slugKey(chip.dataset.name);
    if (swarmDungeon.has(key)) swarmDungeon.delete(key);
    else swarmDungeon.set(key, String(chip.dataset.name || ''));
    paintSwarmEditor();
    renderDungeonChips(lastSwarmChips);
  });

  $('swarmDungeonAdd').addEventListener('click', () => {
    const name = ($('swarmDungeonName').value || '').trim();
    if (!name) {
      chrome.setBadge('bad', 'type a dungeon mob type first');
      return;
    }
    swarmDungeon.set(slugKey(name), name);
    $('swarmDungeonName').value = '';
    paintSwarmEditor();
    renderDungeonChips(lastSwarmChips);
  });

  async function startSwarm() {
    const targets = [];
    for (const s of swarmSel.values()) {
      targets.push({
        kind: 'wave',
        mobId: s.id,
        name: s.name,
        wave: s.wave,
        waveLabel: s.waveLabel,
        quota: quotaFor('w', slugKey(s.name)),
      });
    }
    for (const [key, name] of swarmDungeon) {
      targets.push({ kind: 'dungeon', name, quota: quotaFor('d', key) });
    }
    if (!targets.length) {
      chrome.setBadge('bad', 'tick some mobs or add a dungeon type first');
      return;
    }
    if (!Number($('swarmQuota').value) || Number($('swarmQuota').value) <= 0) {
      chrome.setBadge('bad', 'set the damage amount first');
      return;
    }
    const btn = $('swarmGo');
    btn.disabled = true;
    try {
      const out = await api('/api/swarm?site=' + encodeURIComponent($('targetSite').value || 'demonic'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets, mode: $('swarmMode').value, autoRefill: $('swarmRefill').checked }),
      });
      if (out.ok) {
        chrome.setBadge('ok', `swarm armed — ${targets.length} target(s), every account joins mob 1`);
        swarmSel.clear();
        swarmDungeon.clear();
        swarmQuotaByName.clear();
        paintSwarmEditor();
        paintMobs();
      } else {
        chrome.setBadge('bad', out.error || 'swarm refused');
      }
    } catch (e) {
      chrome.setBadge('bad', e.message);
    }
    btn.disabled = false;
    refresh();
  }

  $('swarmGo').addEventListener('click', startSwarm);

  $('swarmStop').addEventListener('click', async () => {
    const btn = $('swarmStop');
    btn.disabled = true;
    try {
      await api('/api/swarm?site=' + encodeURIComponent($('targetSite').value || 'demonic'), { method: 'DELETE' });
      chrome.setBadge('ok', 'swarm stopped — queue frozen');
    } catch (e) {
      chrome.setBadge('bad', e.message);
    }
    btn.disabled = false;
    refresh();
  });

  $('swarmClearSel').addEventListener('click', () => {
    swarmSel.clear();
    swarmDungeon.clear();
    swarmQuotaByName.clear();
    paintSwarmEditor();
    paintMobs();
    renderDungeonChips(lastSwarmChips);
  });

  $('targetSite').addEventListener('change', () => { mobStatsCache.clear(); refresh(); });
  $('mobFilter').addEventListener('input', paintMobs);
  F.startPolling(refresh, 15000);
})();
