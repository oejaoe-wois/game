'use strict';
/* accounts.js — add / relogin / remove game accounts, plus the on-demand
   potion-shop sweep (POST /api/shop/stamina). Same endpoints as the old
   single-page panel; every action stays scoped to the signed-in caller. */
(function () {
  const F = window.AioFarm;
  const { esc, fmtAge, fmtK, vitalsCell, STATUS_COLORS, session, api, toast, confirmDanger } = F;
  const $ = (id) => document.getElementById(id);

  if (!F.requireSession()) return;
  const chrome = F.initChrome('accounts', {
    tagline: 'add, relogin and remove account containers',
  });

  let siteLabels = {};
  let accounts = [];

  function setBadge(state, label) { chrome.setBadge(state, label); }

  function syncSites(sites) {
    if (!Array.isArray(sites) || !sites.length) return;
    siteLabels = Object.fromEntries(sites.map((x) => [x.key, x.label]));
    const sel = $('accSite');
    const have = [...sel.options].map((o) => o.value).join();
    if (have === sites.map((x) => x.key).join()) return;
    const cur = sel.value;
    sel.innerHTML = sites.map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('');
    if (cur && siteLabels[cur]) sel.value = cur;
  }

  function hitsCell(a) {
    const bits = [];
    if (a.bossHits) bits.push(`${a.bossHits}b`);
    if (a.waveHits) bits.push(`${a.waveHits}w`);
    if (a.dungeonRounds) bits.push(`${a.dungeonRounds}d`);
    if (a.corpsesLooted) bits.push(`${a.corpsesLooted}☠`);
    if (a.reactions && a.reactions.reacts) bits.push(`${a.reactions.reacts}rx`);
    // The missed-game sweep: manual kill loots, claim sweeps, guild
    // contracts finished, event dispatch contracts submitted.
    if (a.waveLooted) bits.push(`${a.waveLooted}loot`);
    if (a.claims && a.claims.claimed) bits.push(`${a.claims.claimed}cl`);
    if (a.quests && a.quests.finished) bits.push(`${a.quests.finished}q`);
    // The hunt state rides the quests cell: while a kill contract is armed
    // the picker pins/probes the hosting wave (quests.huntInfo).
    if (a.quests && a.quests.huntInfo && a.quests.huntInfo.monster) {
      const h = a.quests.huntInfo;
      bits.push(`hunt:${h.pinned ? esc(h.wave || 'pinned') : `probe ${h.probed || 0}`}`);
    }
    // Diver telemetry: the named targets + the picker's pin (the wave the
    // hunt map steers this diver to) + what the session bought the targets.
    if (a.dive && a.dive.targets && a.dive.targets.length) {
      const d = a.dive;
      const fleet = a.diveBus && a.diveBus.attacked ? ` (+${a.diveBus.attacked} fleet)` : '';
      bits.push(`dive ${d.attacked || 0}/${d.targets.length}t${fleet}${d.pinnedWave ? ` → ${esc(d.pinnedWave)}` : ' (roaming)'}`);
    }
    // Gear keep-up: equip-best + blacksmith (Divers' gear rounds).
    if (a.equip && a.equip.equipped) bits.push(`${a.equip.equipped}eq`);
    if (a.blacksmith && a.blacksmith.crafted) bits.push(`${a.blacksmith.crafted}forged`);
    if (a.events && a.events.submitted) bits.push(`${a.events.submitted}ev`);
    if (a.battlePass && a.battlePass.claimed) bits.push(`${a.battlePass.claimed}bp`);
    // PvP season ladder (Divers pillar 3): matches made + tokens left, or
    // the season's closed notice when matchmaking is shut.
    if (a.pvp && a.pvp.checkedAt) {
      bits.push(`pvp${a.pvp.matches ? ` ${a.pvp.matches}m` : ''}${a.pvp.closed ? ' (closed)' : ` · ${a.pvp.tokens != null ? a.pvp.tokens + 'tk' : ''}`}`);
    }
    return bits.length ? bits.join(' · ') : '—';
  }

  function renderAccounts() {
    const tbody = $('acctRows');
    if (!accounts.length) {
      tbody.innerHTML = `<tr><td colspan="14" class="empty">${F.isOwner()
        ? 'no accounts on the farm yet — add the first one above'
        : 'you have no accounts on the farm yet — add one above'}</td></tr>`;
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
      const ptsCell = a.stats && a.stats.points != null
        ? `${a.stats.points.toLocaleString()} · A${a.stats.attack ?? '—'} D${a.stats.defense ?? '—'} S${a.stats.staminaMax ?? '—'}`
        : '—';
      // Guild cell: the game-reported tag/name (from the dungeon hub + dash)
      // plus the panel code's verdict — ✓ matches, ✗ wrong guild, ? unknown.
      let guildCell = '—';
      const g = a.guild;
      const label = g && (g.tag || g.name) ? `${g.tag ? '[' + esc(g.tag) + '] ' : ''}${g.name ? esc(g.name) : ''}`.trim() : '';
      if (g && label) {
        const mark = g.verified === true ? '<span class="chip ok">✓</span> '
          : g.verified === false ? '<span class="chip bad">✗</span> '
          : '<span class="chip warn">?</span> ';
        guildCell = `${mark}${label}${g.id ? ` <span class="hint">#${esc(String(g.id))}</span>` : ''}`;
      } else if (a.guildCode) {
        guildCell = `${esc(a.guildCode)} <span class="hint">· pending</span>`;
      }
      // Class cell: the bound base class (or what the picker decided —
      // waiting for level 200 / disabled / picked just now), the per-account
      // policy selector (auto / a class / off — PATCHed live) and the skill
      // tree progress (AP wallet + spends).
      let classCell = '—';
      const ci = a.classInfo;
      if (ci && ci.currentClass) {
        classCell = `${esc(ci.currentClass)}${ci.action === 'picked' ? ' <span class="chip ok">new</span>' : ''}`;
      } else if (ci && ci.action === 'low-level') {
        classCell = `<span class="hint">waits · lvl ${ci.level ?? '?'} / 200</span>`;
      } else if (ci && ci.action === 'off') {
        classCell = '<span class="hint">off</span>';
      } else if (ci && ci.classless) {
        classCell = '<span class="hint">classless</span>';
      }
      const policy = a.classPick || 'auto';
      const policySel = `<select data-classpick="${esc(a.id)}" class="statselect xsmall" ` +
        `title="per-account class policy — auto picks the optimal class at level 200; the game's choice is permanent">` +
        [
          ['auto', 'auto · optimal'], ['mage', 'Mage'], ['warrior', 'Warrior'],
          ['hunter', 'Hunter'], ['cleric', 'Cleric'], ['off', 'off — never'],
        ].map(([v, label]) =>
          `<option value="${v}"${policy === v ? ' selected' : ''}>${label}</option>`).join('') +
        `</select>`;
      const st = a.skillTree;
      const treeBit = st && (st.className || st.unlocked || st.leveled)
        ? `<div class="hint">tree${st.className ? ' · ' + esc(st.className) : ''}` +
          `${st.points != null ? ` · ${st.points} AP` : ''}` +
          `${st.unlocked ? ` · +${st.unlocked} skill(s)` : ''}` +
          `${st.leveled ? ` · ${st.leveled} level-up(s)` : ''}</div>`
        : '';
      classCell = `${policySel}<div>${classCell}</div>${treeBit}`;
      const ownerBit = F.isOwner() && a.owner ? ` <span class="hint">· ${esc(a.owner)}</span>` : '';
      return `<tr>
        <td>${esc(a.nickname)}${ownerBit}</td>
        <td>${esc(siteLabels[a.site] || a.site || '—')}</td>
        <td>${esc(a.emailMasked)}</td>
        <td>${guildCell}</td>
        <td>${classCell}</td>
        <td><span class="chip ${color}">${esc(a.status)}</span></td>
        <td class="num">${a.level || '—'}</td>
        <td class="num">${esc(expCell)}</td>
        <td class="num">${esc(ptsCell)}</td>
        <td class="num">${esc(vitalsCell(a.vitals))}</td>
        <td class="num">${esc(hitsCell(a))}</td>
        <td>${esc(String(now))}</td>
        <td class="${stale ? 'stale' : ''}">${esc(lastAct)}</td>
        <td class="err">${esc(a.lastError || '')}</td>
        <td class="actions">
          <button data-relogin="${esc(a.id)}" class="ghost small" title="drop this session and log in again">relogin</button>
          <button data-shop="${esc(a.id)}" class="ghost small" title="buy stamina potions now">potions</button>
          <button data-remove="${esc(a.id)}" class="danger small" title="stop the worker and destroy the stored password">remove</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderAccountPicker() {
    const sel = $('shopAccount');
    const current = sel.value;
    sel.innerHTML = '<option value="">oldest healthy account</option>' +
      accounts.map((a) => `<option value="${esc(a.id)}"${a.id === current ? ' selected' : ''}>${esc(a.nickname)} (${esc(a.status)})</option>`).join('');
  }

  async function refresh() {
    try {
      const status = await api('/api/status');
      if (status.you) chrome.setMe(status.you.username, status.you.role);
      syncSites(status.sites);
      accounts = status.accounts || [];
      const running = accounts.filter((a) => a.status === 'running').length;
      setBadge('ok', `${F.me.username ? F.me.username + ' · ' : ''}connected · ${running}/${accounts.length} running`);
      renderAccounts();
      renderAccountPicker();
    } catch (e) {
      setBadge('bad', e.message);
    }
  }

  // ── add account ───────────────────────────────────────────────────────────
  $('addForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const msg = $('addMsg');
    msg.className = 'msg';
    msg.textContent = '';
    const email = $('accEmail').value.trim();
    const password = $('accPass').value;
    const nickname = $('accNick').value.trim() || email.split('@')[0];
    const guildCode = $('accGuild').value.trim();
    const classPick = $('accClass') ? $('accClass').value : '';
    if (!email || !password) { msg.textContent = 'email and password are required'; return; }
    $('btnAdd').disabled = true;
    msg.textContent = 'adding…';
    try {
      await api('/api/accounts', {
        method: 'POST',
        body: JSON.stringify({
          nickname, email, password,
          site: $('accSite').value || undefined,
          guildCode: guildCode || undefined,
          classPick: classPick || undefined,
        }),
      });
      msg.className = 'msg good';
      msg.textContent = `added — the farm will log ${nickname} in after the stagger delay`;
      $('accEmail').value = '';
      $('accPass').value = '';
      $('accNick').value = '';
      $('accGuild').value = '';
      toast(`${nickname} added to the farm`, 'good');
      refresh();
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = `failed: ${e.message}`;
    } finally {
      $('btnAdd').disabled = false;
    }
  });

  // ── row actions (delegated) ───────────────────────────────────────────────
  $('acctRows').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.relogin || btn.dataset.remove || btn.dataset.shop;
    if (!id) return;
    const account = accounts.find((a) => a.id === id);
    const name = account ? account.nickname : id;

    if (btn.dataset.remove && !confirmDanger(
      `Remove ${name} from the farm?\n\nIts worker stops and the stored password is destroyed.`)) return;
    btn.disabled = true;
    try {
      if (btn.dataset.relogin) {
        await api(`/api/accounts/${id}/relogin`, { method: 'POST', body: '{}' });
        toast(`${name}: relogin started`, 'good');
      } else if (btn.dataset.remove) {
        await api(`/api/accounts/${id}`, { method: 'DELETE' });
        toast(`${name} removed`, 'good');
      } else if (btn.dataset.shop) {
        toast(`${name}: sweeping the potion shops…`);
        const r = await api('/api/shop/stamina', { method: 'POST', body: JSON.stringify({ accountId: id }) });
        const bits = [];
        if (r.merchant) bits.push(`merchant ${r.merchant.bought || 0}`);
        if (r.guild) bits.push(`guild ${r.guild.bought || 0}`);
        if (r.damon) bits.push(`Damon ${r.damon.bought || 0}`);
        toast(`${name}: sweep done — ${r.bought || 0} potion(s)${bits.length ? ` (${bits.join(', ')})` : ''}`, 'good', 6000);
      }
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
    btn.disabled = false;
  });

  // ── per-account class policy (delegated change on the row selects) ────────
  // PATCH /api/accounts/<id> {classPick} — the running worker re-reads the
  // policy every class round; the game's own choice stays permanent.
  $('acctRows').addEventListener('change', async (ev) => {
    const sel = ev.target.closest('select[data-classpick]');
    if (!sel) return;
    const id = sel.dataset.classpick;
    const account = accounts.find((a) => a.id === id);
    const name = account ? account.nickname : id;
    try {
      await api(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ classPick: sel.value }) });
      toast(`${name}: class policy → ${sel.value || 'auto'}${sel.value === 'off' ? ' (never pick)' : ''}`, 'good');
    } catch (e) {
      toast(e.message, 'bad');
      refresh();
    }
  });

  // ── potion-shop sweep (picked or oldest healthy account) ──────────────────
  $('btnShop').addEventListener('click', async () => {
    const msg = $('shopMsg');
    const btn = $('btnShop');
    const body = {};
    if ($('shopAccount').value) body.accountId = $('shopAccount').value;
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'sweeping merchant → guild → Damon… (large shops can take a while)';
    try {
      const r = await api('/api/shop/stamina', { method: 'POST', body: JSON.stringify(body) });
      msg.className = 'msg good';
      msg.textContent = r.ok
        ? `sweep done — ${r.bought || 0} potion(s) bought` +
          (r.spent != null ? `, ${Number(r.spent).toLocaleString()} spent` : '')
        : `refused: ${r.reason || r.error || 'failed'}`;
      if (r.ok) toast('potion-shop sweep done', 'good');
      refresh();
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = `refused: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  $('togglePass').addEventListener('click', () => {
    const el = $('accPass');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('togglePass').textContent = el.type === 'password' ? 'show' : 'hide';
  });

  F.startPolling(refresh, 15000);
})();
