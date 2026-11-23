'use strict';
// unit-test.js — fast checks for the store hardening and the manager's
// account-picking rules. No network, no game mock needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
// config.js (pulled in by the contract-floor section below) validates its
// env at require time — the unit tests never boot the server, so seed the
// minimum here (real env still wins).
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'unit-test-pass';
process.env.ADMIN_GAME_EMAIL = process.env.ADMIN_GAME_EMAIL || 'unit@test.invalid';
process.env.ADMIN_GAME_PASSWORD = process.env.ADMIN_GAME_PASSWORD || 'unit-test-pass';
process.env.AIO_SECRET_KEY = process.env.AIO_SECRET_KEY || 'k'.repeat(40);
const { Store } = require('../server/store');
const { WorkerManager } = require('../server/workers');

let failed = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (detail || '')}`);
  if (!ok) failed++;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aio-unit-'));
const KEY = 'k'.repeat(40);

// ── store: wrong key is caught at boot with a clear message ────────────────
{
  const dir = tmp();
  const s = new Store({ dataDir: dir, secretKey: KEY });
  s.addAccount({ nickname: 'a', email: 'a@x.io', password: 'pw1' });
  check('store round-trips a password', new Store({ dataDir: dir, secretKey: KEY }).getPassword(
    [...s.accounts.keys()][0]) === 'pw1');
  let msg = '';
  try { new Store({ dataDir: dir, secretKey: 'z'.repeat(40) }); } catch (e) { msg = e.message; }
  check('wrong AIO_SECRET_KEY is refused at boot with a clear message', /AIO_SECRET_KEY does not match/.test(msg), msg);
}

// ── store: a store written before key-check existed still opens ────────────
{
  const dir = tmp();
  const s = new Store({ dataDir: dir, secretKey: KEY });
  s.addAccount({ nickname: 'a', email: 'a@x.io', password: 'pw1' });
  const f = path.join(dir, 'accounts.enc');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete raw.keyCheck;
  fs.writeFileSync(f, JSON.stringify(raw));
  let ok = true;
  try { new Store({ dataDir: dir, secretKey: KEY }); } catch (_) { ok = false; }
  check('older store without a key-check upgrades in place', ok);
  let bad = '';
  try { new Store({ dataDir: dir, secretKey: 'z'.repeat(40) }); } catch (e) { bad = e.message; }
  check('...and still rejects a wrong key after the upgrade', /does not match/.test(bad), bad);
}

// ── store: corrupt file gives a readable error, not a stack trace ──────────
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'accounts.enc'), '{not json');
  let msg = '';
  try { new Store({ dataDir: dir, secretKey: KEY }); } catch (e) { msg = e.message; }
  check('corrupt accounts.enc → clear error', /unreadable/.test(msg), msg);
}

// ── store: files are owner-only; audit log rotates ─────────────────────────
{
  const dir = tmp();
  const s = new Store({ dataDir: dir, secretKey: KEY });
  s.audit('x', {});
  const mode = (f) => fs.statSync(path.join(dir, f)).mode & 0o777;
  check('accounts.enc is 0600', mode('accounts.enc') === 0o600, mode('accounts.enc').toString(8));
  check('audit.log is 0600', mode('audit.log') === 0o600, mode('audit.log').toString(8));
  fs.writeFileSync(path.join(dir, 'audit.log'), 'x'.repeat(5 * 1024 * 1024 + 10));
  s.audit('after', {});
  check('audit.log rotates past 5 MB', fs.existsSync(path.join(dir, 'audit.log.1'))
    && fs.statSync(path.join(dir, 'audit.log')).size < 1000);
}

// ── manager: user actions never land on the hidden fetcher ─────────────────
{
  const dir = tmp();
  const store = new Store({ dataDir: dir, secretKey: KEY });
  const cfg = { defaultSite: 'demonic', sites: [], adminGameEmail: 'f@x.io', adminGamePassword: 'p', adminGameNickname: 'core-fetcher' };
  const m = new WorkerManager({ store, cfg, bus: {}, bosses: [], caps: {}, bossCategories: {}, audit: () => {} });
  const mk = (id, startedAt, role) => ({
    account: { id, role }, stopFlag: false, reloginAfter: 0,
    state: { status: 'running', userId: '1', startedAt },
  });
  // Real store rows so ownership checks run against actual data.
  const fRow = store.addAccount({ nickname: 'f', email: 'f@x.io', password: 'p', role: 'admin', hidden: true });
  const aRow = store.addAccount({ nickname: 'a', email: 'a@x.io', password: 'p', owner: 'alice' });
  const bRow = store.addAccount({ nickname: 'b', email: 'b@x.io', password: 'p', owner: 'bob' });
  const lRow = store.addAccount({ nickname: 'legacy', email: 'l@x.io', password: 'p' }); // no owner = pre multi-user
  const owner = { username: 'boss', role: 'owner' };
  const alice = { username: 'alice', role: 'user' };
  m.adminIds.add(fRow.id);
  m.workers.set(fRow.id, mk(fRow.id, 1, 'admin')); // oldest, like the real fetcher
  m.workers.set(aRow.id, mk(aRow.id, 50, 'user'));
  m.workers.set(bRow.id, mk(bRow.id, 40, 'user'));  // older than alice's, but not hers
  m.workers.set(lRow.id, mk(lRow.id, 30, 'user'));
  check('default pick skips the older hidden fetcher', m.pickUserWorker(null, owner).worker.account.id === lRow.id);
  check('explicit fetcher id answers as no_such_account', m.pickUserWorker(fRow.id, owner).error === 'no_such_account');
  check("a user's default pick only considers their own accounts", m.pickUserWorker(null, alice).worker.account.id === aRow.id);
  check("a user cannot target someone else's account by id", m.pickUserWorker(bRow.id, alice).error === 'no_such_account');
  check('a user cannot touch an ownerless (legacy) account', m.pickUserWorker(lRow.id, alice).error === 'no_such_account');
  check('the owner can target any user account', m.pickUserWorker(bRow.id, owner).worker.account.id === bRow.id);
  check('no viewer = no access', m.pickUserWorker(aRow.id, null).error === 'no_such_account');
  m.workers.get(aRow.id).state.status = 'error';
  check('no user account healthy → no_healthy_account (fetcher not used)', m.pickUserWorker(null, alice).error === 'no_healthy_account');
}

// ── guild identity: parse / verify (the panel's guild code feature) ──────────
{
  const d = require('../server/dungeons');
  const hub = '<script>(function(){\n  const isLoggedIn  = true;\n  const guildId     = 32;\n})();</script>';
  check('parseGuildId reads the hub\u2019s guildId const', d.parseGuildId(hub) === '32');
  check('parseGuildId answers null without a guild', d.parseGuildId('<p>no guild</p>') === null);
  const dash = '<h1><span class="tag">[ DA ]</span>\n Dagorath Alliance</h1>';
  check('parseGuildIdentity splits tag + name off the dash h1',
    JSON.stringify(d.parseGuildIdentity(dash)) === JSON.stringify({ tag: 'DA', name: 'Dagorath Alliance' }));
  check('parseGuildIdentity handles a tagless h1',
    JSON.stringify(d.parseGuildIdentity('<h1>Solo Guild</h1>')) === JSON.stringify({ tag: null, name: 'Solo Guild' }));
  const g = { id: '32', tag: 'DA', name: 'Dagorath Alliance' };
  check('guildMatches: id / tag / bracketed tag / name (all case-insensitive)',
    d.guildMatches('32', g) && d.guildMatches('da', g) && d.guildMatches('[DA]', g)
      && d.guildMatches('  Dagorath Alliance ', g),
    '');
  check('guildMatches refuses a wrong code, empty code and missing guild',
    !d.guildMatches('DELULU', g) && !d.guildMatches('', g) && !d.guildMatches('32', null),
    '');
  // multi-guild: friends in OTHER guilds each scan their own identity, and a
  // mid-session guild switch must drop the old identity (a stale tag/name
  // would mislabel the panel and falsely verify the old guild's code).
  const switched = d.mergeGuild({ id: '32', tag: 'DA', name: 'Dagorath Alliance' }, { id: '41' });
  check('mergeGuild DROPS the old tag/name when the hub reports a different guild id',
    JSON.stringify(switched) === JSON.stringify({ id: '41', tag: null, name: null }),
    JSON.stringify(switched));
  const filled = d.mergeGuild({ id: '32', tag: 'DA' }, { id: '32', name: 'Dagorath Alliance' });
  check('mergeGuild gap-fills identity for the SAME guild (id + tag + name)',
    filled.id === '32' && filled.tag === 'DA' && filled.name === 'Dagorath Alliance',
    JSON.stringify(filled));
  const fromNull = d.mergeGuild(null, { id: '7', tag: 'XY', name: 'Exy' });
  const nullNext = d.mergeGuild(g, null);
  check('mergeGuild seeds from nothing and keeps the cache when a scan comes back empty',
    fromNull.id === '7' && nullNext && nullNext.id === '32' && nullNext.tag === 'DA',
    JSON.stringify({ fromNull, nullNext }));
}

// ── cube: STATE blob parsing (guild_dungeon_cube.php) ────────────────────────
{
  const d = require('../server/dungeons');
  const state = {
    faces: [{ ID: 1, FACE_KEY: 'front' }],
    nodes: [
      { id: 1, face_key: 'front', status: 'available', linked_location_id: 0, is_boss_gate: 0 },
      { id: 2, face_key: 'front', status: 'available', linked_location_id: 11, is_boss_gate: 0 },
      { id: 4, face_key: 'top', status: 'available', linked_location_id: 14, is_boss_gate: 1 },
    ],
    total_clears: 5,
  };
  const page = `<script>\n  const STATE = ${JSON.stringify(state)};\n</script>`;
  const parsed = d.parseCubeState(page);
  check('parseCubeState reads the STATE blob (nodes array)', parsed && parsed.nodes.length === 3);
  check('parseCubeState answers null on garbage / missing nodes',
    d.parseCubeState('<script>const STATE = {"faces":[]}</script>') === null && d.parseCubeState('nothing') === null);
}

// ── floor parsing: 2026-11 markup (bold-ellipsis name, statpills, healbox) ──
{
  const d = require('../server/dungeons');
  const floor = `
    <div class="healbox"><span class="pill">Dead</span><span class="muted">Revive in</span>
      <strong class="countdown" id="healCountdown">--:--:--</strong></div>
    <script>const reviveAtMs = 1795253122000;</script>
    <div class="mon " style="margin-bottom:10px;">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          <div class="row" style="gap:6px; margin-top:4px;">
            <span class="pill">not joined</span>
          </div>
          The Goblin Royal Vizier
        </div>
        <div class="muted" style="font-size:12px;margin-top:2px">1,044,892,421 / 80,000,000,000 HP</div>
        <div class="statrow">
          <div class="statpill" title="Monster Attack"><span class="k">ATK</span><span class="v">1,440</span></div>
          <div class="statpill" title="Monster Defense"><span class="k">DEF</span><span class="v">1,440</span></div>
          <div class="statpill" title="Experience per point of damage dealt"><span class="k">EXP/dmg</span><span class="v">0.0113</span></div>
        </div>
        <a class="btn" href="battle.php?dgmid=2662168&instance_id=17211">Fight</a>
      </div>
    </div>
    <div id="lootAllModal"><h2 class="lootall-title">Loot Collected</h2></div>`;
  const mobs = d.parseDungeonMobs(floor, '17211');
  const m = mobs[0] || {};
  check('2026-11 floor: bold-ellipsis name parsed (not the loot modal\u2019s title)',
    mobs.length === 1 && m.name === 'The Goblin Royal Vizier' && m.dgmid === '2662168',
    JSON.stringify(mobs));
  check('2026-11 floor: ATK / DEF / EXP-per-damage statpills parsed',
    m.atk === 1440 && m.def === 1440 && m.expPerDmg === 0.0113 && m.hp && m.hp.max === 80000000000,
    JSON.stringify({ atk: m.atk, def: m.def, expd: m.expPerDmg }));
  check('player-dead healbox detected with the revive timestamp',
    d.parsePlayerHealbox(floor).playerDead === true
      && d.parsePlayerHealbox(floor).reviveAtMs === 1795253122000);
  check('expectedBossExp prefers the card\u2019s EXP/dmg ratio over the hardcoded table',
    d.expectedBossExp('unknown boss', 10000, 0.0113) === Math.floor(10000 * 0.0113)
      && d.expectedBossExp('unknown boss', 10000, 0.0113) !== Math.floor(10000 * 0.01),
    String(d.expectedBossExp('unknown boss', 10000, 0.0113)));
}

// ── guild contract requirements + the per-mob damage floor ─────────────────
{
  const q = require('../server/quests');
  const combat = require('../server/combat');
  const cfgMod = require('../server/config');

  // Objective shorthand: the live board's kill lines carry a per-kill
  // minimum damage ("min 3m dmg") next to the monster name.
  const kill = q.parseRequirement('Kill 5 monster(s) · Monster: Lizardman Shadowclaw · min 3m dmg');
  check('parseRequirement: kill contract → count, monster (lowercased), min damage',
    kill && kill.kind === 'kill' && kill.kills === 5
      && kill.monster === 'lizardman shadowclaw' && kill.minDamage === 3000000,
    JSON.stringify(kill));
  const gather = q.parseRequirement('Gather 2x item(s) · Item: Goblin Essence');
  check('parseRequirement: gather contract → item + count',
    gather && gather.kind === 'gather' && gather.count === 2 && gather.item === 'goblin essence',
    JSON.stringify(gather));
  const skill = q.parseRequirement('Use 20 skills against monsters.');
  check('parseRequirement: skill contract → skills count',
    skill && skill.kind === 'skill' && skill.skills === 20, JSON.stringify(skill));
  const activeRow = q.parseRequirement('Kill 5 monster(s) · min 3,000,000 dmg');
  check('parseRequirement: the ACTIVE row shape (monster dropped, commas spelled out)',
    activeRow && activeRow.kind === 'kill' && activeRow.kills === 5
      && activeRow.monster === null && activeRow.minDamage === 3000000,
    JSON.stringify(activeRow));
  const fromDesc = q.parseRequirement('Huge numbers of Lizardman Shadowclaws are pouring out of the gate. Kill 5 Lizardman Shadowclaws while dealing at least 3m damage to each');
  check('parseRequirement: description form → monster recovered from the prose',
    fromDesc && fromDesc.kind === 'kill' && fromDesc.kills === 5
      && fromDesc.monster === 'lizardman shadowclaw' && fromDesc.minDamage === 3000000,
    JSON.stringify(fromDesc));
  const merged = q.rowRequirement({ objective: 'Kill 5 monster(s) · min 3,000,000 dmg', desc: 'Kill 5 Lizardman Shadowclaws while dealing at least 3m damage to each' });
  check('rowRequirement: ACTIVE row + description → full requirement (restart-mid-contract safe)',
    merged && merged.kind === 'kill' && merged.monster === 'lizardman shadowclaw' && merged.minDamage === 3000000,
    JSON.stringify(merged));
  check('parseRequirement: unknown lines answer null',
    q.parseRequirement('Do something entirely different.') === null, '');
  check('parseDamageShorthand: k/m/b shorthand and plain numbers',
    q.parseDamageShorthand('3m') === 3000000 && q.parseDamageShorthand('500k') === 500000
      && q.parseDamageShorthand('1.5b') === 1500000000 && q.parseDamageShorthand('1234') === 1234
      && q.parseDamageShorthand('2,500,000') === 2500000 && q.parseDamageShorthand('') === 0
      && q.parseDamageShorthand('nonsense') === 0, '');

  // minDamageFor: global floor → JSON per-name rules (last match wins, "*" =
  // catch-all) → the active contract's own rule adds on top for its monster.
  const cfgBase = { mobMinDamage: 0, mobMinDamageJson: { fallback: null, rules: [] } };
  check('minDamageFor: 0 everywhere with no config',
    combat.minDamageFor('anything', cfgBase) === 0 && combat.minDamageFor('anything', {}) === 0
      && combat.minDamageFor('anything', null) === 0, '');
  check('minDamageFor: the global MOB_MIN_DAMAGE floor applies to every mob',
    combat.minDamageFor('orc stone-rend', { ...cfgBase, mobMinDamage: 250000 }) === 250000, '');
  const cfgJson = {
    mobMinDamage: 0,
    mobMinDamageJson: cfgMod.parseMinDamageJson('{"*":0,"lizardman":"3m","troll ravager":2500000}'),
  };
  check('minDamageFor: JSON rules match by name substring, last match wins',
    combat.minDamageFor('Lizardman Shadowclaw', cfgJson) === 3000000
      && combat.minDamageFor('lizardman flamecaster', cfgJson) === 3000000
      && combat.minDamageFor('Troll Ravager', cfgJson) === 2500000
      && combat.minDamageFor('orc stone-rend', cfgJson) === 0,
    JSON.stringify(cfgJson.mobMinDamageJson));
  check('minDamageFor: the catch-all "*" is the JSON default',
    combat.minDamageFor('random critter', { mobMinDamage: 0, mobMinDamageJson: cfgMod.parseMinDamageJson('{"*":"50k"}') }) === 50000, '');
  const cfgQuest = { ...cfgBase, questReq: { kind: 'kill', monster: 'lizardman shadowclaw', minDamage: 3000000 } };
  check('minDamageFor: the ACTIVE contract raises the floor for its monster only',
    combat.minDamageFor('lizardman shadowclaw', cfgQuest) === 3000000
      && combat.minDamageFor('lizardman shadowclaw elder', cfgQuest) === 3000000
      && combat.minDamageFor('orc stone-rend', cfgQuest) === 0, '');
  check('minDamageFor: contract floor and global floor combine by MAX',
    combat.minDamageFor('lizardman shadowclaw', { ...cfgQuest, mobMinDamage: 5000000 }) === 5000000
      && combat.minDamageFor('orc stone-rend', { ...cfgQuest, mobMinDamage: 5000000 }) === 5000000, '');
  check('parseMinDamageJson: invalid JSON → empty spec, garbage shapes ignored',
    (() => { const s = cfgMod.parseMinDamageJson('not json'); return s.fallback === null && s.rules.length === 0; })()
      && (() => { const s = cfgMod.parseMinDamageJson('["a","b"]'); return s.rules.length === 0; })(), '');
}

// ── curl transport: the Cloudflare survival layer ──────────────────────────
{
  const http = require('http');
  const { curlAvailable, curlRequest, parseHeaderBlock } = require('../server/curl-transport');
  check('curl transport: binary detected on this host', curlAvailable() === true, '');
  check('curl transport: header block parser reads status + repeated set-cookie',
    (() => {
      const p = parseHeaderBlock('HTTP/2 200\r\ncontent-type: text/html\r\nset-cookie: a=1; Path=/\r\nset-cookie: b=2\r\n\r\nbody');
      return p.status === 200 && p.headers.get('content-type') === 'text/html' && p.setCookies.length === 2;
    })(), '');
  check('curl transport: HTTP/1.1 status line with reason phrase',
    parseHeaderBlock('HTTP/1.1 303 See Other\r\nlocation: /x\r\n\r\n').status === 303, '');
}

// The subprocess round-trip is async — the summary prints after it settles.
(async () => {
  {
    const http = require('http');
    const { curlRequest } = require('../server/curl-transport');
    // One real subprocess round-trip against a throwaway local server.
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'demon=42; Path=/' });
          res.end(JSON.stringify({ status: 'success', echo: body, cookie: req.headers.cookie || '' }));
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=abc; Path=/' });
      res.end('<html>ok</html>');
    });
    // Bind 127.0.0.1 explicitly — a dual-stack wildcard bind does not accept
    // IPv4 loopback connects in every sandbox (curl hangs on ::).
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const g = await curlRequest({ url: `http://127.0.0.1:${port}/page`, method: 'GET', headers: { 'User-Agent': 'unit-test' } });
      const p = await curlRequest({
        url: `http://127.0.0.1:${port}/post`, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'k=v' },
        body: 'a=1&b=two',
      });
      const j = JSON.parse(p.text);
      check('curl transport: GET reads status/body/set-cookie through the subprocess',
        g.status === 200 && g.text.includes('<html>ok</html>') && g.setCookies.some((c) => c.startsWith('session=abc')), JSON.stringify(g.setCookies));
      check('curl transport: POST body + cookies ride along (same jar semantics as fetch)',
        j.status === 'success' && j.echo === 'a=1&b=two' && j.cookie.includes('k=v')
          && p.setCookies.some((c) => c.startsWith('demon=42')), JSON.stringify({ echo: j.echo, cookie: j.cookie }));
    } catch (e) {
      check('curl transport: subprocess round-trip', false, e.message);
    } finally {
      srv.close();
    }
  }
// ── classes.js: the class system (classes.php) ───────────────────────────────
{
  const classes = require('../server/classes');
  // Live fixture 1 — CLASSED page (2026-11 scout, after the Mage pick).
  const classedHtml = '<div class="section-classes">You are already bound to a class. Below is your current path and its available skills.</div>'
    + '<div class="detail-class-name">Your class: Mage</div><a href="class_skill_tree.php">View Skill Tree</a>';
  const cls1 = classes.parseClassState(classedHtml);
  check('parseClassState: bound page → classed, current class Mage',
    cls1.classless === false && cls1.currentClass === 'Mage', JSON.stringify(cls1));
  // Live fixture 2 — CLASSLESS page (picker with confirm forms).
  const classlessHtml = '<a href="?class_id=1" class="class-strip"><div class="class-strip-name">Warrior</div></a>'
    + '<form method="post" class="confirm-form"><input type="hidden" name="choose_class_id" value="1">'
    + '<button class="btn-confirm">Confirm this Class</button></form>';
  const cls2 = classes.parseClassState(classlessHtml);
  check('parseClassState: picker page → classless, no current class',
    cls2.classless === true && cls2.currentClass === null, JSON.stringify(cls2));
  check('parseClassState: empty/unknown page → no opinion (null, null)',
    classes.parseClassState('').classless === null
      && classes.parseClassState('<h1>random</h1>').classless === null, '');
  // The optimal-pick resolver.
  check('resolvePick: auto resolves to Mage (best PvE damage per stamina: Fireball 4m @ 200 stam)',
    classes.resolvePick('auto').key === 'mage' && classes.resolvePick(undefined).key === 'mage', '');
  check('resolvePick: explicit keys pass through, off/garbage disable',
    classes.resolvePick('warrior').id === 1 && classes.resolvePick('cleric').id === 4
      && classes.resolvePick('off') === null && classes.resolvePick('nonsense') === null, '');
  // Catalog sanity: four base classes, all level 200, Mage tops the PvE table.
  check('class catalog: 4 base classes, Mage highest PvE skill, Cleric has none',
    classes.CLASSES.length === 4
      && classes.MIN_CLASS_LEVEL === 200
      && Math.max(...classes.CLASSES.map((c) => c.pveDamage)) === classes.CLASSES.find((c) => c.key === 'mage').pveDamage
      && classes.CLASSES.find((c) => c.key === 'cleric').pveSkill === null, '');
}
// ── skilltree.js: the class skill tree (class_skill_tree.php) ────────────────
{
  const skilltree = require('../server/skilltree');
  // Live fixture — the real page's embedded globals (2026-11 Mage scout),
  // including the config object's trailing `// ← NEW` comment and the \/
  // escapes the live markup carries.
  const page = '<h1>Mage — Skill Tree</h1>'
    + '<script>\n// Data from PHP\nwindow.SkillTreeData = [{"id":4,"name":"Fireball","unlock_level":1,"adv_points_req":0,"mana_cost":30,"stamina_cost":200,"flat_stam_dmg":20000,"owned":false,"level":0,"used_times":0,"max_level":2,"level_rules":[{"level":2,"times_used":0,"adv_points":2000,"flat_damage_stamina":30000}],"next_rule":{"level":2,"times_used":0,"adv_points":2000,"flat_damage_stamina":30000}},'
    + '{"id":5,"name":"Arcane Sacrifice","unlock_level":1,"adv_points_req":500,"stamina_cost":0,"flat_stam_dmg":0,"owned":false,"level":0,"used_times":0,"max_level":2,"level_rules":[],"next_rule":null},'
    + '{"id":16,"name":"Mana Shield","unlock_level":200,"adv_points_req":2000,"stamina_cost":0,"flat_stam_dmg":0,"owned":true,"level":1,"used_times":0,"max_level":1,"level_rules":[],"next_rule":null}];\n'
    + 'window.SkillTreeConfig = {\n  ajaxUrl: "\\/class_skill_tree.php",\n  className: "Mage",\n  totalSkills: 3,\n  ownedCount: 1,\n  advExp: 2500,\n  classPassive: "-50% def +25% attack" // ← NEW\n};\n</script>';
  const parsed = skilltree.parseSkillTree(page);
  check('parseSkillTree: class, wallet, owned count and 3 rows off the live globals',
    parsed.className === 'Mage' && parsed.points === 2500 && parsed.ownedCount === 1
      && Array.isArray(parsed.data) && parsed.data.length === 3,
    JSON.stringify({ cls: parsed.className, pts: parsed.points, n: parsed.data && parsed.data.length }));
  check('parseTreeConfig: \\/ escapes unescape + the trailing comment is survived',
    parsed.config && parsed.config.ajaxUrl === '/class_skill_tree.php'
      && /25%/.test(parsed.config.classPassive || ''),
    JSON.stringify(parsed.config));
  check('parseSkillTree: classless page (no globals) → data null (clean no-op signal)',
    skilltree.parseSkillTree('<div>choose a class first</div>').data === null, '');
  // Plan: damage skills first by the damage-per-stamina the next level buys,
  // maxed/mastery-gated skills drop out of the actionable plan.
  const order = skilltree.planOrder(parsed.data);
  check('planOrder: Fireball (damage) first, non-damage after by cost',
    JSON.stringify(order.map((s) => s.name)) === '["Fireball","Arcane Sacrifice","Mana Shield"]',
    JSON.stringify(order.map((s) => s.name)));
  const acts = order.map((s) => skilltree.nextActionFor(s));
  check('nextActionFor: unlock costs read from adv_points_req, maxed skills drop out',
    acts[0].action === 'unlock' && acts[0].cost === 0
      && acts[1].action === 'unlock' && acts[1].cost === 500
      && acts[2] === null, // Mana Shield lv 1/1 → nothing to do
    JSON.stringify(acts));
  // Mastery gate: a next_rule with times_used above used_times parks the skill.
  const mastery = skilltree.nextActionFor({
    owned: true, level: 1, used_times: 2, max_level: 3,
    next_rule: { level: 2, times_used: 5, adv_points: 1000 },
  });
  check('nextActionFor: mastery gate (needs battle uses) parks the level-up',
    mastery === null, JSON.stringify(mastery));
  // isDamageSkill: stamina-for-damage only — buffs with stamina_cost 0 rank last.
  check('isDamageSkill: Fireball yes, Arcane Sacrifice no',
    skilltree.isDamageSkill(parsed.data[0]) === true && skilltree.isDamageSkill(parsed.data[1]) === false, '');
}
// ── hunt.js: the quest hunt map (mob name → hosting wave) ────────────────────
{
  const hunt = require('../server/hunt');
  const os = require('os');
  const fs = require('fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-unit-'));
  hunt.initHuntMap(tmp);
  check('empty map answers null', hunt.findMobWave('anything') === null, '');
  hunt.rememberWaveMobs('gate=3&wave=5', ['Lizardman Shadowclaw', 'Gate Sentry']);
  check('rememberWaveMobs pins each name to the wave (normalized keys)',
    hunt.findMobWave('lizardman shadowclaw').wave === 'gate=3&wave=5'
      && hunt.findMobWave('gate sentry').wave === 'gate=3&wave=5', '');
  check('includes-matching: a contract shorthand finds the pinned wave',
    hunt.findMobWave('shadowclaw').wave === 'gate=3&wave=5', '');
  check('misses answer null (no false pins)', hunt.findMobWave('marsh crawler') === null, '');
  // The config/mobs.json seed: live-scraped rosters pin on the FIRST init,
  // so a diver/contract can steer immediately without a discovery sweep.
  check('the mobs.json seed pins scraped rosters (troll ravager → gate=3&wave=5)',
    hunt.findMobWave('troll ravager') && hunt.findMobWave('troll ravager').wave === 'gate=3&wave=5',
    JSON.stringify(hunt.findMobWave('troll ravager')));
  check('the seed covers boss names too (drakzareth → the wave-3 boss page)',
    hunt.findMobWave('drakzareth') && hunt.findMobWave('drakzareth').wave === 'gate=3&wave=8',
    JSON.stringify(hunt.findMobWave('drakzareth')));
  // Restart semantics: a fresh init re-reads the persisted JSON.
  hunt.initHuntMap(tmp);
  check('initHuntMap reloads the persisted map (survives restarts)',
    hunt.findMobWave('lizardman shadowclaw').wave === 'gate=3&wave=5', '');
  hunt.rememberWaveMobs('gate=5&wave=11', ['moonlit stag']);
  hunt.initHuntMap(tmp);
  check('re-remembering a name re-pins it to the newer wave',
    hunt.findMobWave('moonlit stag').wave === 'gate=5&wave=11', '');
  // Seed rows never land in the persisted learned map (data/hunt-map.json
  // stays purely live-learned) — the seed re-applies fresh at every boot.
  const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'hunt-map.json'), 'utf8'));
  check('persist() writes learned rows only (no seed rows in the file)',
    !persisted['troll ravager'] && !!persisted['gate sentry'],
    JSON.stringify(Object.keys(persisted).slice(0, 8)));
  // A live sighting REPLACES the seeded row (wave or trust upgrade).
  hunt.rememberWaveMobs('gate=9&wave=99', ['troll ravager']);
  check('a live sighting re-pins a seeded name to the newer wave',
    hunt.findMobWave('troll ravager').wave === 'gate=9&wave=99', '');
  hunt.initHuntMap(tmp);
  check('the live re-pin survives a restart (learned rows persist)',
    hunt.findMobWave('troll ravager').wave === 'gate=9&wave=99', '');
  // Demote: a pinned round that saw NO matching mob deletes the stale rows
  // (the probe/rotation takes over; the next sighting re-pins).
  check('demoteWave removes the stale pin rows for that wave',
    hunt.demoteWave('gate=9&wave=99', ['troll ravager']) === 1
      && hunt.findMobWave('troll ravager') === null, '');
  check('demoteWave leaves other waves and names untouched',
    hunt.findMobWave('gate sentry') !== null && hunt.demoteWave('gate=3&wave=5', ['troll ravager']) === 0, '');
  // Seed rows demote too — a wrong seed self-heals within the session
  // (the seed re-applies at the next boot; a live sighting re-pins first).
  hunt.initHuntMap(null); // fresh seed
  check('a seeded row answers with seed:true (hints probe, never hard-pins)',
    hunt.findMobWave('lizardman shadowclaw') && hunt.findMobWave('lizardman shadowclaw').seed === true, '');
  check('demoteWave clears the seeded row for a barren pinned wave',
    hunt.demoteWave('gate=3&wave=5', ['lizardman shadowclaw']) >= 1
      && (hunt.findMobWave('lizardman shadowclaw') === null
        || hunt.findMobWave('lizardman shadowclaw').wave !== 'gate=3&wave=5'), '');
  hunt.initHuntMap(null); // leave the shared map in in-memory mode
}

// ── wave scouting: data-expire → the bus rows' dies-in timer ───────────────
{
  const combat = require('../server/combat');
  const html = '<div class="monster-card" data-monster-id="555" data-expire="1795530781" data-name="goblin skirmisher">x</div>' +
    '<div class="monster-card" data-monster-id="556" data-name="no timer mob">y</div>' +
    '<div class="monster-card" data-monster-id="557" data-expire="12345" data-name="bogus timer">z</div>';
  const mobs = combat.parseWaveMonsters(html);
  const m1 = mobs.find((m) => m.id === '555');
  const m2 = mobs.find((m) => m.id === '556');
  const m3 = mobs.find((m) => m.id === '557');
  check('parseWaveMonsters reads data-expire into expiresAt (epoch sec → ms)',
    m1 && m1.expiresAt === 1795530781 * 1000, JSON.stringify(m1));
  check('a card without data-expire stays null (never fabricated)',
    m2 && m2.expiresAt === null, JSON.stringify(m2));
  check('a bogus data-expire (pre-2001 epoch) is ignored, not trusted',
    m3 && m3.expiresAt === null, JSON.stringify(m3));
  // Regression: a DEAD last card must not restart the scan (a failed exec
  // resets lastIndex to 0 — the loop used to rescan forever and OOM).
  const deadLast = combat.parseWaveMonsters(
    '<div class="monster-card" data-monster-id="1" data-expire="1795530781" data-name="alpha">a</div>' +
    '<div class="monster-card" data-monster-id="2" data-dead="1" data-name="beta">b</div>');
  check('a dead LAST card ends the scan (no rescan loop, 1 alive row)',
    deadLast.length === 1 && deadLast[0].id === '1', JSON.stringify(deadLast));
  const deadOnly = combat.parseWaveMonsters(
    '<div class="monster-card" data-monster-id="9" data-dead="1" data-name="ghost">g</div>');
  check('a page whose only card is dead answers zero rows (and returns)',
    deadOnly.length === 0, JSON.stringify(deadOnly));
}

// ── target bus: the sweep REPLACES stale mobs, carries failed waves ────────
{
  const { TargetBus } = require('../server/bus');
  const dir = tmp();
  const bus = new TargetBus({ dataDir: dir, fileName: 'bus-unit.json' });
  bus.publish({
    mobs: [
      { id: 1, name: 'a', wave: 'gate=3&wave=3', waveLabel: 'Grakthar · wave 1' },
      { id: 2, name: 'b', wave: 'gate=3&wave=5', waveLabel: 'Grakthar · wave 2' },
    ],
    failedWaves: [],
  });
  check('bus publish (failedWaves) seeds the live set', bus.snapshot().mobs.length === 2, '');
  // Second sweep: wave-1 still alive (mob 1 still there), wave-2 page now
  // shows a NEW instance (mob 3) — mob 2 must LEAVE the bus.
  bus.publish({
    mobs: [
      { id: 1, name: 'a', wave: 'gate=3&wave=3', waveLabel: 'Grakthar · wave 1' },
      { id: 3, name: 'c', wave: 'gate=3&wave=5', waveLabel: 'Grakthar · wave 2' },
    ],
    failedWaves: [],
  });
  const ids = bus.snapshot().mobs.map((m) => String(m.id)).sort().join(',');
  check('a replaced instance id leaves the bus on the next sweep (no dead-id haunting)',
    ids === '1,3', ids);
  // Third sweep: wave-1 fetch FAILED — its rows must be carried, not wiped,
  // while the re-checked wave still replaces.
  bus.publish({
    mobs: [{ id: 3, name: 'c', wave: 'gate=3&wave=5', waveLabel: 'Grakthar · wave 2' }],
    failedWaves: ['gate=3&wave=3'],
  });
  const ids2 = bus.snapshot().mobs.map((m) => String(m.id)).sort().join(',');
  check('rows from a failed wave fetch are carried to the next sweep',
    ids2 === '1,3', ids2);
  // first-seen foundAt survives replacements (the panel's "Found" age is honest)
  const first = bus.snapshot().mobs.find((m) => String(m.id) === '3');
  const before = first.foundAt;
  bus.publish({ mobs: [{ id: 3, name: 'c', wave: 'gate=3&wave=5', waveLabel: 'Grakthar · wave 2' }], failedWaves: [] });
  const again = bus.snapshot().mobs.find((m) => String(m.id) === '3');
  check('re-seen mobs keep their first-seen foundAt (bus sorts stay stable)',
    again.foundAt === before && again.lastSeenAt >= before, JSON.stringify(again));
  // Legacy callers (no failedWaves) still accumulate like before.
  const bus2 = new TargetBus({ dataDir: tmp(), fileName: 'bus-unit2.json' });
  bus2.publish({ mobs: [{ id: 9, name: 'x', wave: 'w' }] });
  bus2.publish({ mobs: [{ id: 10, name: 'y', wave: 'w' }] });
  check('legacy publish (no failedWaves) still accumulates',
    bus2.snapshot().mobs.length === 2, JSON.stringify(bus2.snapshot().mobs));
}

// ── pvp.js: the season board parser + matchmaking gating ────────────────────
{
  const pvp = require('../server/pvp');
  // OPEN season (the mock's markup — buttons on the page).
  const openHtml = `<div class="banner-title">The Total Eclipse PvP Season</div>` +
    `<div class="banner-pill"><strong>Leaderboard:</strong> <span>#3,262</span></div>` +
    `<div class="info-pill"><strong>Tier:</strong> <span>Novice</span></div>` +
    `<div class="info-pill"><strong>Tokens:</strong> <span>30</span></div>` +
    `<button class="js-matchmake" data-ladder="solo">Find Solo Match</button>` +
    `<button class="js-matchmake" data-ladder="party">Find Party Match</button>`;
  const open = pvp.parsePvpHome(openHtml);
  check('pvp board: open season parses season/rank/tier/tokens',
    open.season === 'The Total Eclipse PvP Season' && open.rank === 3262
      && open.tier === 'Novice' && open.tokens === 30,
    JSON.stringify(open));
  check('pvp board: open season flips both ladders open',
    open.soloOpen === true && open.partyOpen === true, JSON.stringify({ s: open.soloOpen, p: open.partyOpen }));
  // CLOSED season — the LIVE markup captured 2026-11-22 (season 4 ended).
  const closedHtml = `<div class="info-pill"><strong>Tier:</strong> <span>Novice</span></div>` +
    `<div class="info-pill"><strong>Tokens:</strong> <span>30</span></div>` +
    `<div class="info-pill"><strong>Season Ended:</strong> <span>Solo matchmaking is closed.</span></div>`;
  const closed = pvp.parsePvpHome(closedHtml);
  check('pvp board: closed season keeps tier/tokens but flips solo shut',
    closed.tier === 'Novice' && closed.tokens === 30 && closed.soloOpen === false
      && /closed/i.test(closed.closedMessage || ''),
    JSON.stringify(closed));
  // Battle page classification (the future fight engine's shape markers).
  const shape = pvp.classifyBattlePage('<title>PvP Battle</title><div class="battleDrawer">VS <span class="opponent">X</span></div>');
  check('battle page classifier sees the drawer + opponent markers',
    shape.isBattle === true && shape.title === 'PvP Battle' && shape.hasAttackSet === false,
    JSON.stringify(shape));
}

// ── equip.js: inventory parsing + equip-best selection (live wire format) ──
{
  const equip = require('../server/equip');
  // Byte-for-byte the shapes the live veyragame inventory renders (2026-11-22).
  const invHtml = `
  <div class="slot-box ">
    <div class="item-container"><img src="images/items/a.webp" alt="Hobgoblin Copper Spear"></div>
    <div class="label">
    weapon<br>
    🧪 Lv. 1<br>
    🔪 <span class="">20</span> ATK
    ·
    🛡️ <span class="">0</span> DEF
</div>
    <button class="btn" onclick="unequipItem(1)">Unequip</button>
  </div>
  <div class="slot-box ">
    <div class="item-container"><img src="images/items/b.webp" alt="Worn Boots"></div>
    <div class="label">
    boots<br>
    🧪 Lv. 1<br>
    🔪 <span class="">3</span> ATK
    ·
    🛡️ <span class="">2</span> DEF
</div>
    <button class="btn" onclick="unequipItem(4)">Unequip</button>
  </div>
  <div class="slot-box " id="equip-1275982260" data-equip="1" data-order="0" data-inv-id="1275982260"
  data-typee="weapon" data-item-type="weapon" data-item-group="weapon"
  data-atk="40"
  data-def="2">
    <div class="equipment-type-badge">Weapon</div>
    <img src="images/items/c.webp" alt="Mock Steel Sword">
    <div class="equipment-item-name">Mock Steel Sword</div>
    <button class="btn" onclick="showEquipModal(24, 'weapon', '1275982260')">Equip</button>
    <div style="margin-top:6px;">x2    </div>
  </div>
  <div class="slot-box " id="equip-777" data-equip="1" data-inv-id="777" data-typee="ring" data-atk="1" data-def="1">
    <div class="equipment-type-badge">Ring</div>
    <div class="equipment-item-name">Mock Band</div>
  </div>`;
  const inv = equip.parseInventory(invHtml);
  check('parseInventory reads the equipped slots (slot ids + label stats, Lv never mistaken for ATK)',
    inv.equipped.length === 2
      && inv.equipped[0].slotId === 1 && inv.equipped[0].slot === 'weapon'
      && inv.equipped[0].atk === 20 && inv.equipped[0].def === 0
      && inv.equipped[1].slotId === 4 && inv.equipped[1].slot === 'boots'
      && inv.equipped[1].atk === 3 && inv.equipped[1].def === 2,
    JSON.stringify(inv.equipped));
  check('parseInventory reads the bag rows (invId/typee/atk/def + qty suffix)',
    inv.bag.length === 2 && inv.bag[0].invId === '1275982260' && inv.bag[0].type === 'weapon'
      && inv.bag[0].atk === 40 && inv.bag[0].def === 2 && inv.bag[0].qty === 2
      && inv.bag[1].type === 'ring',
    JSON.stringify(inv.bag));
  check('slotFamily maps ring/ring 2 → ring and Class Weapon → classweapon',
    equip.slotFamily('ring') === 'ring' && equip.slotFamily('ring 2') === 'ring'
      && equip.slotFamily('Class Weapon') === 'classweapon' && equip.slotFamily('weapon') === 'weapon',
    JSON.stringify([equip.slotFamily('ring 2'), equip.slotFamily('Class Weapon')]));
  const best = equip.bestByType(inv.bag, 3, 1);
  check('bestByType picks the highest-score item per family',
    best.get('weapon').name === 'Mock Steel Sword' && best.get('ring').name === 'Mock Band',
    JSON.stringify([...best.keys()]));
  check('scoreItem weights attack over defense (atk 40 def 2 → 122)',
    equip.scoreItem({ atk: 40, def: 2 }, 3, 1) === 122,
    String(equip.scoreItem({ atk: 40, def: 2 }, 3, 1)));
  // element-aware scoring (the counter preference). The chart: THUNDER
  // counters NATURE; FIRE does not — so the THUNDER 39 piece beats the FIRE 40
  // one when a NATURE mob is the target, and loses without the preference.
  const invEl = equip.parseInventory(
    `<div class="slot-box " id="e1" data-equip="1" data-inv-id="900" data-typee="weapon" data-atk="40" data-def="0">` +
    `<div class="equipment-item-name">Ember Blade</div>` +
    `<button class="info-btn" data-name="Ember Blade" data-desc="A hot blade. ATK 40 DEF 0 🌟 Element: FIRE">i</button></div>` +
    `<div class="slot-box " id="e2" data-equip="1" data-inv-id="901" data-typee="weapon" data-atk="39" data-def="0">` +
    `<div class="equipment-item-name">Storm Sword</div>` +
    `<button class="info-btn" data-desc="Zappy. ATK 39 DEF 0 🌟 Element: THUNDER">i</button></div>`);
  check('parseInventory reads the item element off the info tooltip (FIRE vs THUNDER)',
    invEl.bag[0].element === 'FIRE' && invEl.bag[1].element === 'THUNDER',
    JSON.stringify(invEl.bag.map((b) => b.element)));
  check('scoreItem: counter-element gear gains the bonus (+10) and beats equal-ATK plain gear',
    equip.scoreItem({ atk: 40, def: 0, element: 'FIRE' }, 3, 1, ['LIGHT', 'VOID']) === 120
      && equip.scoreItem({ atk: 40, def: 0, element: 'LIGHT' }, 3, 1, ['LIGHT', 'VOID']) === 130
      && equip.scoreItem({ atk: 40, def: 0 }, 3, 1, ['LIGHT', 'VOID']) === 120,
    JSON.stringify([
      equip.scoreItem({ atk: 40, def: 0, element: 'FIRE' }, 3, 1, ['LIGHT', 'VOID']),
      equip.scoreItem({ atk: 40, def: 0, element: 'LIGHT' }, 3, 1, ['LIGHT', 'VOID']),
      equip.scoreItem({ atk: 40, def: 0 }, 3, 1, ['LIGHT', 'VOID'])]));
  const bestEl = equip.bestByType(invEl.bag, 3, 1, ['THUNDER']);
  check('bestByType: the counter-element item wins the family (THUNDER 39 beats FIRE 40)',
    bestEl.get('weapon').name === 'Storm Sword',
    JSON.stringify(bestEl.get('weapon')));
  const bestNoPref = equip.bestByType(invEl.bag, 3, 1);
  check('bestByType without a preference keeps pure score order (FIRE 40 wins)',
    bestNoPref.get('weapon').name === 'Ember Blade',
    JSON.stringify(bestNoPref.get('weapon')));
}

// ── blacksmith.js: recipe parsing (live card shape) ─────────────────────────
{
  const bs = require('../server/blacksmith');
  const smithHtml = `
  <div class="card ">
    <button type="button" class="info-btn" data-name="Ember Forged Scale Greaves"
      data-attack="60" data-defense="40" data-element="NONE">i</button>
    <div class="result-name">Ember Forged Scale Greaves</div>
    <div class="reqs">
      <div class="req hover-wrap" title="Scorched Scale Boots"><div class="qty bad">0/100</div></div>
      <div class="req hover-wrap" title="Small fire essence"><div class="qty good">10/10</div></div>
    </div>
    <div class="forge"><form method="POST" action="craft_item.php">
      <input type="hidden" name="recipe_id" value="38">
      <button class="forge-btn" disabled>Forge</button></form></div>
  </div>
  <div class="card ">
    <button type="button" class="info-btn" data-name="Emerald Warboots"
      data-attack="30" data-defense="12">i</button>
    <div class="result-name">Emerald Warboots</div>
    <div class="reqs">
      <div class="req hover-wrap" title="Emerald Shard"><div class="qty good">5/5</div></div>
    </div>
    <div class="forge"><form method="POST" action="craft_item.php">
      <input type="hidden" name="recipe_id" value="10">
      <button class="forge-btn">Forge</button></form></div>
  </div>`;
  const recipes = bs.parseBlacksmithRecipes(smithHtml, 'Grakthar');
  check('parseBlacksmithRecipes reads name/atk/def/reqs and the craftable verdict',
    recipes.length === 2
      && recipes[0].name === 'Ember Forged Scale Greaves' && recipes[0].atk === 60 && recipes[0].def === 40
      && recipes[0].craftable === false && recipes[0].reqs.length === 2
      && recipes[1].id === '10' && recipes[1].craftable === true,
    JSON.stringify(recipes));
}

// ── shop.js: merchant kinds (stamina/hp/mana; eggs and gear never) ──────────
{
  const shop = require('../server/shop');
  check('kindOf maps the ladder stock (stamina/hp/mana) and refuses eggs/gear',
    shop.kindOf('Small Stamina Potion') === 'stamina' && shop.kindOf('Full Hp Potion') === 'hp'
      && shop.kindOf('Mana Potion S') === 'mana' && shop.kindOf('Fenrir Egg') === null
      && shop.kindOf('Iron Sword') === null,
    JSON.stringify([shop.kindOf('Full Hp Potion'), shop.kindOf('Fenrir Egg')]));
  check('parseKinds defaults to stamina+hp+mana and narrows on demand',
    shop.parseKinds('').length === 3 && shop.parseKinds('stamina').length === 1,
    JSON.stringify(shop.parseKinds('')));
  const merch = shop.parseMerchant(
    `<span id="goldBalance">2,000</span>` +
    `<div class="card" data-merch-id="1" data-currency="gold" data-price="50" data-maxq="50" data-bought="0"><div class="name">Small Stamina Potion</div></div>` +
    `<div class="card" data-merch-id="2" data-currency="gold" data-price="5000" data-maxq="25" data-bought="0"><div class="name">Full Hp Potion</div></div>` +
    `<div class="card" data-merch-id="3" data-currency="gold" data-price="1000" data-maxq="1" data-bought="0"><div class="name">Fenrir Egg</div></div>`,
    'stamina,hp');
  check('parseMerchant kinds filter: stamina planned, unaffordable hp noted, egg silently skipped',
    merch.gold === 2000 && merch.lines.length === 1
      && merch.lines[0].qty === 40 && merch.lines[0].kind === 'stamina'
      && merch.notes.some((n) => /Full Hp Potion/.test(n) && /gold too low/.test(n)),
    JSON.stringify(merch));
}

// ── damage.js: the game's damage formula, element counters, hit math ───────
{
  const damage = require('../server/damage');
  // Goblin Skirmisher (Attack 0 / DEF 3 / PET DEF 1 / EQ DEF 1 / None / 0%)
  // vs a sample loadout (equip 1,000 · pet 200 · attack stat 5,000).
  const goblin = { attack: 0, defense: 3, petDefense: 1, eqDefense: 1, element: null, elementRate: 0 };
  const pred = damage.predictDamage(
    { equipAtk: 1000, petAtk: 200, attackStat: 5000, playerElement: null, playerElementRate: 0, staminaCost: 1 },
    goblin);
  check('formula: base = 225 + max(30,eq-def)·20 + max(30,pet-def)·20 + 1000·max(30,atk-def)^0.25',
    pred.base === 32592 && pred.total === 32592 && pred.parts.eqPart === 19980 && pred.parts.petPart === 3980,
    JSON.stringify(pred));
  check('formula: the max(30, …) floors hold every negative gap at 30 (3765 minimum hit)',
    damage.predictDamage({ equipAtk: 10, petAtk: 0, attackStat: 2 }, { defense: 30, petDefense: 3, eqDefense: 500 }).base === 3765
    && damage.predictDamage({ equipAtk: 10, petAtk: 0, attackStat: 2 }, { defense: 30, petDefense: 3, eqDefense: 500 }).floored.stat === true,
    JSON.stringify(damage.predictDamage({ equipAtk: 10, petAtk: 0, attackStat: 2 }, { defense: 30, petDefense: 3, eqDefense: 500 })));
  check('formula: stamina_cost multiplies the whole base (cost 2 → 65185)',
    damage.predictDamage({ equipAtk: 1000, petAtk: 200, attackStat: 5000, staminaCost: 2 }, goblin).base === 65185);
  check('counters: FIRE vs NATURE doubles the rate for the elemental part (270,000)',
    damage.counters('FIRE', 'NATURE') && damage.counters('fire', 'nature')
    && damage.predictDamage({ equipAtk: 0, petAtk: 0, attackStat: 0, playerElement: 'FIRE', playerElementRate: 100 },
      { defense: 0, eqDefense: 0, petDefense: 0, element: 'NATURE', elementRate: 20 }).elemental === 270000);
  check('counter chart: all seven elements counter exactly their two pairs',
    ['FIRE>NATURE', 'FIRE>FROST', 'NATURE>LIGHT', 'NATURE>VOID', 'FROST>WATER', 'FROST>THUNDER',
     'THUNDER>WATER', 'THUNDER>NATURE', 'WATER>FIRE', 'WATER>LIGHT', 'VOID>FIRE', 'VOID>THUNDER',
     'LIGHT>VOID', 'LIGHT>FROST'].every((p) => damage.counters(p.split('>')[0], p.split('>')[1]))
    && !damage.counters('FIRE', 'WATER') && !damage.counters('LIGHT', 'LIGHT'));
  check('elemental: a rate deficit never deals negative damage (clamped at 0)',
    damage.predictDamage({ equipAtk: 0, petAtk: 0, attackStat: 0, playerElement: 'FIRE', playerElementRate: 50 },
      { defense: 0, eqDefense: 0, petDefense: 0, element: null, elementRate: 80 }).elemental === 0);
  check('elemental: no counter, no doubling — WATER 100 vs NATURE 20 → 120,000',
    damage.predictDamage({ equipAtk: 0, petAtk: 0, attackStat: 0, playerElement: 'WATER', playerElementRate: 100 },
      { defense: 0, eqDefense: 0, petDefense: 0, element: 'NATURE', elementRate: 20 }).elemental === 120000);
  check('hitsFor rounds up and never divides by zero',
    damage.hitsFor(10000, 32592) === 1 && damage.hitsFor(100000, 32592) === 4 && damage.hitsFor(1000, 0) === 1000);
  check('avgHit averages only the positive forecasts',
    damage.avgHit([100, 200, 0, -5]) === 150 && damage.avgHit([]) === 0);
  check('counterOf lists the elements that counter a mob (NATURE → FIRE+THUNDER, None → none)',
    JSON.stringify(damage.counterOf('NATURE')) === JSON.stringify(['FIRE', 'THUNDER'])
      && damage.counterOf('nature').length === 2
      && damage.counterOf(null).length === 0 && damage.counterOf('None').length === 0,
    JSON.stringify([damage.counterOf('NATURE'), damage.counterOf('None')]));
}

// ── monster-stats.js: the battle page's "View Monster Stats" modal ──────────
{
  const monsterStats = require('../server/monster-stats');
  // The exact wire the real battle page embeds (Goblin Skirmisher sample).
  const html = `<div id="monsterStatsModal" class="battle-modal-backdrop">
    <div class="battle-modal-card"><div class="battle-modal-head"><h2>Goblin Skirmisher Stats</h2>
    <button type="button" class="battle-modal-close" onclick="closeMonsterStatsModal()">Close</button></div>
    <p class="battle-modal-copy">Detailed monster stats and resistance values for this battle.</p>
    <div class="monster-stats-grid">
    <div class="monster-stat-cell"><span class="label">Attack</span><strong>0</strong></div>
    <div class="monster-stat-cell"><span class="label">Defense</span><strong>3</strong></div>
    <div class="monster-stat-cell"><span class="label">Pet Defense</span><strong>1</strong></div>
    <div class="monster-stat-cell"><span class="label">Equipment Defense</span><strong>1</strong></div>
    <div class="monster-stat-cell"><span class="label">Element</span><strong>None</strong></div>
    <div class="monster-stat-cell"><span class="label">Element Rate</span><strong>0%</strong></div>
    <div class="monster-stat-cell"><span class="label">Rewards Up To</span><strong>LV 300</strong></div>
    <div class="monster-stat-cell resistance"><span class="label">Crit Rate Resistance</span><strong>0%</strong></div>
    <div class="monster-stat-cell resistance"><span class="label">Crit Damage Resistance</span><strong>0%</strong></div>
    <div class="monster-stat-cell resistance"><span class="label">Final Damage Resistance</span><strong>0%</strong></div>
    <div class="monster-stat-cell resistance"><span class="label">Passive Damage Resistance</span><strong>0%</strong></div>
    </div></div></div>`;
  const s = monsterStats.parseMonsterStats(html);
  check('modal parser reads every cell of the stats grid',
    s && s.name === 'Goblin Skirmisher' && s.attack === 0 && s.defense === 3 && s.petDefense === 1
    && s.eqDefense === 1 && s.element === null && s.elementLabel === 'None' && s.elementRate === 0
    && s.rewardsUpToLv === 300 && s.critRateRes === 0 && s.critDamageRes === 0
    && s.finalDamageRes === 0 && s.passiveDamageRes === 0,
    JSON.stringify(s));
  const elemental = monsterStats.parseMonsterStats(html
    .replace('<h2>Goblin Skirmisher Stats</h2>', '<h2>Frost Wisp Stats</h2>')
    .replace('<span class="label">Element</span><strong>None</strong>', '<span class="label">Element</span><strong>FROST</strong>')
    .replace('<span class="label">Element Rate</span><strong>0%</strong>', '<span class="label">Element Rate</span><strong>35%</strong>')
    .replace('<span class="label">Final Damage Resistance</span><strong>0%</strong>', '<span class="label">Final Damage Resistance</span><strong>12%</strong>'));
  check('modal parser normalizes elements and strips %/LV decorations',
    elemental && elemental.name === 'Frost Wisp' && elemental.element === 'FROST'
    && elemental.elementRate === 35 && elemental.finalDamageRes === 12,
    JSON.stringify(elemental));
  check('modal parser returns null off-modal pages', monsterStats.parseMonsterStats('<html>no modal</html>') === null);
  check('describe() renders the log chips', /DEF 3/.test(monsterStats.describe(s)) && /rewards ≤ LV 300/.test(monsterStats.describe(s)),
    monsterStats.describe(s));
}

// ── loadout.js: the player half of the formula (inventory / pets / stats) ───
{
  const loadout = require('../server/loadout');
  // inventory.php "Equipped Items — PvE Attack Set" (worn rows carry
  // unequipItem; bag rows carry showEquipModal and MUST NOT count).
  const inv = `<div class="section"><div class="section-title">🛡️ Equipped Items — PvE Attack Set</div><div class="grid">
    <div class="slot-box "><div class="label"> weapon<br> 🔪 <span class="">120</span> ATK · 🛡️ <span class="">0</span> DEF</div>
      <button class="btn" onclick="unequipItem(1)">Unequip</button></div>
    <div class="slot-box "><div class="label"> helmet<br> 🔪 <span class="">45</span> ATK · 🛡️ <span class="">30</span> DEF</div>
      <button class="btn" onclick="unequipItem(2)">Unequip</button></div>
    <div class="slot-box "><div class="label"> boots<br> 🔪 <span class="">0</span> ATK · 🛡️ <span class="">55</span> DEF</div>
      <button class="btn" onclick="unequipItem(4)">Unequip</button></div>
    </div></div>
    <div class="section"><div class="section-title">⚔️ Equipment</div><div class="grid">
    <div class="slot-box " data-inv-id="9"><div class="label">🔪 <span class="">9999</span> ATK · 🛡️ <span class="">0</span> DEF<br>
      <button class="btn" onclick="showEquipModal(24, 'weapon', '9')">Equip</button></div></div>
    </div></div>`;
  const eq = loadout.parseEquippedAtk(inv);
  check('parseEquippedAtk sums ONLY the worn set (bag rows never leak in)',
    eq.atk === 165 && eq.slots === 3, JSON.stringify(eq));
  const pets = `<div class="container"><h1>🐾 Pets Inventory</h1>
    <div class="section"><div class="section-title"> PvE Attack Team </div><div class="grid">
    <div class="slot-box pet-card" data-pet-inv-id="1"><div class="label"> 🧪 Lv. <span class="pet-level">7</span> &nbsp;|&nbsp; 🔪 <span class="pet-atk " data-attack>120</span> ATK</div></div>
    <div class="slot-box pet-card" data-pet-inv-id="2"><div class="label"> 🧪 Lv. <span class="pet-level">1</span> &nbsp;|&nbsp; 🔪 <span class="pet-atk " data-attack>95</span> ATK</div></div>
    </div></div>
    <div class="section"><div class="section-title"> Benched </div><div class="grid">
    <div class="slot-box pet-card" data-pet-inv-id="3"><div class="label"> 🔪 <span class="pet-atk " data-attack>9999</span> ATK</div></div>
    </div></div></div>`;
  const pet = loadout.parsePetAtk(pets);
  check('parsePetAtk sums ONLY the equipped attack team (benched pets excluded)',
    pet.atk === 215 && pet.pets === 2, JSON.stringify(pet));
  const st = loadout.parseStatsPage(
    `<span id="stamina_span">529</span> / 545  </span>` +
    `<script type="application/json" id="stats-state">{"csrf":"x","view":"y","user":{"STAT_POINTS":0,"ATTACK":120,"DEFENSE":120,"MAX_STAMINA":1370},"core":{"attack":120,"defense":120,"stamina":545}}</script>`);
  check('parseStatsPage reads core.attack + the live stamina bar',
    st.attackStat === 120 && st.stamina && st.stamina.cur === 529 && st.stamina.max === 1370,
    JSON.stringify(st));
  const elNone = loadout.parseStatsPage(
    `<dialog id="elements-pve"><div class="dialog-heading"><h2 id="element-title-pve">PvE Set: elemental sources</h2></div>` +
    `<p class="element-result">NONE &middot; 0%</p></dialog>`);
  check('parseStatsPage reads the PvE element dialog — NONE · 0% → no element',
    elNone.element === null && elNone.elementRate === 0, JSON.stringify({ el: elNone.element, r: elNone.elementRate }));
  const elFire = loadout.parseStatsPage(
    `<dialog id="elements-pve"><div class="dialog-heading"><h2 id="element-title-pve">PvE Set: elemental sources</h2></div>` +
    `<p class="element-result">FIRE &middot; 25%</p></dialog>`);
  check('parseStatsPage reads the PvE element dialog — FIRE · 25% → FIRE/25',
    elFire.element === 'FIRE' && elFire.elementRate === 25, JSON.stringify({ el: elFire.element, r: elFire.elementRate }));
}

// ── guilds: directory/detail parsers + the join flow (live-page fixtures) ───
{
  const guilds = require('../server/guilds');
  const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'guilds', f), 'utf8');

  const dir = guilds.parseGuildDirectory(fx('directory-p1.html'));
  check('parseGuildDirectory: cards + modes + capacity off the live page',
    dir.guilds.length === 24 && dir.total > 400
      && dir.guilds.some((g) => g.mode === 'open') && dir.guilds.some((g) => g.mode === 'application')
      && dir.guilds.some((g) => g.mode === 'full') && dir.guilds.every((g) => g.members > 0 && g.max >= g.members),
    JSON.stringify({ total: dir.total, n: dir.guilds.length }));
  const da = guilds.pickGuild(dir.guilds, 'DA');
  check('pickGuild: tag "DA" → Dagorath Alliance (open, 242/300)',
    da && da.guildId === 32 && da.name === 'Dagorath Alliance' && da.mode === 'open' && da.members === 242 && da.max === 300,
    JSON.stringify(da));
  check('pickGuild: bracketed tag + name + id all match',
    guilds.pickGuild(dir.guilds, '[EPHEME]').guildId === 462
      && guilds.pickGuild(dir.guilds, 'demon castle').guildId === 8
      && guilds.pickGuild(dir.guilds, '32').guildId === 32);

  const open = guilds.parseGuildDetail(fx('detail-open-2.html'));
  check('parseGuildDetail: open guild → identity + join_open form',
    open.guildId === 32 && open.tag === 'DA' && open.name === 'Dagorath Alliance'
      && open.mode === 'open' && open.members === 242 && open.max === 300
      && open.joinForm && open.joinForm.action === 'join_open' && !open.joinForm.needsNote
      && /^[0-9a-f]{32,}$/.test(open.joinForm.csrf) && open.joinForm.formId.length >= 16,
    JSON.stringify({ id: open.guildId, tag: open.tag, form: open.joinForm && open.joinForm.action }));
  const app = guilds.parseGuildDetail(fx('detail-application.html'));
  check('parseGuildDetail: application guild → apply form with optional note',
    app.guildId === 462 && app.tag === 'EPHEME' && app.name === 'Ephemera'
      && app.mode === 'application' && app.joinForm && app.joinForm.action === 'apply' && app.joinForm.needsNote,
    JSON.stringify({ tag: app.tag, form: app.joinForm && app.joinForm.action }));
  const full = guilds.parseGuildDetail(fx('detail-full.html'));
  check('parseGuildDetail: full guild → no form, full flag + note',
    full.guildId === 8 && full.members === 400 && full.max === 400 && full.full === true
      && full.joinForm === null && full.note === 'guild is full',
    JSON.stringify({ mem: `${full.members}/${full.max}`, full: full.full, note: full.note }));

  // The join flow end-to-end against a local http stand-in of the game:
  // search → detail (csrf form) → POST → the dash answers as a member.
  const http = require('http');
  const FORM = guilds.parseGuildDetail(fx('detail-open-2.html')).joinForm;
  const seen = { post: null };
  const srv = http.createServer((req, res) => {
    const url = req.url || '';
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      if (url.startsWith('/guild_join_create.php?q=')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fx('directory-p1.html'));
      } else if (url.startsWith('/guild_join_create.php?guild_id=32') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fx('detail-open-2.html'));
      } else if (url.startsWith('/guild_join_create.php?guild_id=32') && req.method === 'POST') {
        seen.post = Buffer.concat(body).toString();
        res.writeHead(302, { Location: '/guild_dash.php' });
        res.end();
      } else if (url.startsWith('/guild_dash.php')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><script>const guildId = 32;</script><h1>[DA] Dagorath Alliance</h1></body></html>');
      } else {
        res.writeHead(404); res.end('nope');
      }
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const { GameClient } = require('../server/game');
  const { CookieJar } = require('../server/jar');
  const game = new GameClient({
    gameBase: `http://127.0.0.1:${port}`, jar: new CookieJar(),
    cfg: { fastTest: true, jitterScale: 0, requestTimeoutMs: 8000 },
    label: 'guild-unit',
  });
  const result = await guilds.joinGuild(game, { code: 'DA' });
  check('joinGuild: search → form → POST → dash verifies the membership',
    result && result.ok === 'joined' && result.guild && String(result.guild.id) === '32' && result.guild.tag === 'DA',
    JSON.stringify(result));
  check('joinGuild: the POST carried the page\'s csrf + form_id + action',
    !!seen.post && seen.post.includes(`csrf=${FORM.csrf}`) && seen.post.includes(`form_id=${FORM.formId}`)
      && seen.post.includes('action=join_open') && seen.post.includes('guild_id=32'),
    String(seen.post).slice(0, 120));
  const miss = await guilds.joinGuild(game, { code: 'zzz-no-such-guild' });
  check('joinGuild: unknown code → not_found (no POST attempted)',
    miss && miss.ok === 'not_found', JSON.stringify(miss));
  srv.close();
}

  console.log(failed ? `\n✘ ${failed} unit check(s) failed` : '\n✔ all unit checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
