'use strict';
// dailies-test.js — the missed-game sweep: achievements + collections claims,
// Adventurers Guild contracts (accept → farm → finish → donate) and the
// Dragon Realm event daily contracts, plus the manual kill-loot hook that
// feeds the event's hunting dailies.
//
// Run: node test/dailies-test.js

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 8995;
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (detail || '')}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockApi(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: MOCK_PORT, method, path: pathName,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve({}); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(fn, timeoutMs, everyMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let val;
    try { val = await fn(); } catch (_) { val = null; }
    if (val) return val;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const DAY = new Date().toISOString().slice(0, 10);

async function main() {
  const mock = spawn('node', [path.join(__dirname, 'mock-game.js'), String(MOCK_PORT)], { stdio: 'pipe' });
  let mockLog = '';
  mock.stdout.on('data', (d) => { mockLog += d.toString(); });
  mock.stderr.on('data', (d) => { mockLog += d.toString(); });
  try {
    await waitFor(async () => {
      try { return (await mockApi('GET', '/__mock/state')).stamina != null; } catch (_) { return false; }
    }, 10000, 250, 'mock game');

    const { GameClient } = require(path.join(ROOT, 'server', 'game.js'));
    const { CookieJar } = require(path.join(ROOT, 'server', 'jar.js'));
    const auth = require(path.join(ROOT, 'server', 'auth.js'));
    const claims = require(path.join(ROOT, 'server', 'claims.js'));
    const quests = require(path.join(ROOT, 'server', 'quests.js'));
    const events = require(path.join(ROOT, 'server', 'events.js'));
    const battlepass = require(path.join(ROOT, 'server', 'battlepass.js'));
    const combat = require(path.join(ROOT, 'server', 'combat.js'));

    const cfg = {
      fastTest: true, jitterScale: 1, requestTimeoutMs: 20000,
      paceMinMs: 10, paceMaxMs: 30, waveHitDelayMs: 20,
      mobCapMode: 'fixed', mobDamageCap: 999999, waveLootKills: true,
    };
    const jar = new CookieJar();
    const game = new GameClient({ gameBase: `http://127.0.0.1:${MOCK_PORT}`, jar, cfg, label: 'dailies-test' });
    await auth.login(game, 'unit.tester@example.com', 'unitpass1');
    const uid = '103';

    // ── Achievements + collections claims ───────────────────────────────────
    await mockApi('POST', '/__mock/state', { resetDailies: uid });
    console.log('· claims (achievements + collections)');

    // Parser honesty first: disabled buttons are never parsed as claimable.
    const cardsHtml = '<div class="card" data-ach-id="11"><button class="btn claim-btn">Claim</button></div>' +
      '<div class="card" data-ach-id="12"><button class="btn claim-btn" disabled>Claim</button></div>';
    const ids = claims.parseClaimCards(cardsHtml, 'data-ach-id');
    check('claim parser skips disabled Claim buttons', JSON.stringify(ids) === '["11"]', JSON.stringify(ids));
    const csrfHtml = "body: new URLSearchParams({ach_id:id,csrf:\"abcdef0123456789abcdef0123456789\"})";
    check('page csrf is read from the page\u2019s own claim script',
      claims.parsePageCsrf(csrfHtml, 'ach_id') === 'abcdef0123456789abcdef0123456789',
      claims.parsePageCsrf(csrfHtml, 'ach_id'));

    const report = await claims.claimsRound(game);
    check('claim sweep claims every ready achievement (11 + 13)', report.achievements.claimed === 2
      && JSON.stringify(report.achievements.ids.sort()) === '["11","13"]', JSON.stringify(report.achievements));
    check('claim sweep claims every ready collection (21 + 23)', report.collections.claimed === 2
      && JSON.stringify(report.collections.ids.sort()) === '["21","23"]', JSON.stringify(report.collections));
    let st = await mockApi('GET', '/__mock/state');
    check('mock registered the achievements as claimed', JSON.stringify((st.claims[uid] || {}).ach) === '["11","13"]', JSON.stringify(st.claims[uid]));
    check('mock registered the collections as claimed', JSON.stringify((st.claims[uid] || {}).col) === '["21","23"]', JSON.stringify(st.claims[uid]));

    const again = await claims.claimsRound(game);
    check('second sweep claims nothing (already claimed, zero failures)',
      again.claimed === 0 && again.failed === 0, JSON.stringify({ claimed: again.claimed, failed: again.failed }));
    check('disabled (unearned) cards were never attempted', (st.claims[uid] || {}).ach.indexOf('12') === -1
      && (st.claims[uid] || {}).col.indexOf('22') === -1, JSON.stringify(st.claims[uid]));

    // ── Adventurers Guild contracts ─────────────────────────────────────────
    console.log('· adventurers guild contracts');
    await mockApi('POST', '/__mock/state', { resetDailies: uid });

    // Parser: available rows vs the active contract.
    const page1 = await game.get('/adventurers_guild.php');
    const rows = quests.parseQuestRows(page1.text);
    const killRows = rows.filter((r) => r.acceptId && quests.isKillQuest(r));
    check('guild page parses quest rows with accept buttons', rows.length === 3 && killRows.length === 2
      && rows.every((r) => r.title && r.objective && r.rank), JSON.stringify(rows.map((r) => r.title)));
    check('active contract is null while idle', quests.classify(rows).active === null);

    const r1 = await quests.guildQuestRound(game, { accept: true, donate: false });
    check('idle worker accepts the first KILL contract (not the gather one)',
      r1.accepted && r1.accepted.ok && r1.accepted.id === '3', JSON.stringify(r1.accepted));
    st = await mockApi('GET', '/__mock/state');
    check('mock shows the contract accepted', (st.quests[uid] || {}).accepted === 3, JSON.stringify(st.quests[uid]));

    // Accepting while one is active must be refused by the game.
    const r2 = await quests.guildQuestRound(game, { accept: true, donate: false });
    check('active contract blocks a second accept (engine does not try)',
      r2.accepted === null && r2.active && String(r2.active.id) === '3', JSON.stringify({ accepted: r2.accepted, active: r2.active }));

    // Wave farming supplies the kill progress — simulate the 5 manual hits.
    await mockApi('POST', '/__mock/state', { setQuest: { uid, accepted: 3, progress: 5 } });
    const r3 = await quests.guildQuestRound(game, { accept: true, donate: false });
    check('completed contract is turned in (finishQuest)',
      r3.finished && r3.finished.ok && r3.finished.id === '3', JSON.stringify(r3.finished));
    st = await mockApi('GET', '/__mock/state');
    check('mock shows the contract finished', JSON.stringify((st.quests[uid] || {}).finished) === '[3]'
      && (st.quests[uid] || {}).accepted === null, JSON.stringify(st.quests[uid]));
    check('turn-in pays the AP reward', (st.guildPoints[uid] || 0) >= 2100, JSON.stringify(st.guildPoints));

    // Gather contract: donate only fires with QUESTS_DONATE=1, then turn-in.
    await mockApi('POST', '/__mock/state', { setQuest: { uid, accepted: 4, progress: 0 } });
    const r4 = await quests.guildQuestRound(game, { accept: true, donate: false });
    check('gather contract is NOT donated when QUESTS_DONATE is off',
      r4.donated.length === 0 && r4.active && String(r4.active.id) === '4', JSON.stringify(r4));
    const r5 = await quests.guildQuestRound(game, { accept: true, donate: true });
    check('gather contract donates the two owned items',
      r5.donated.length === 2 && r5.donated.every((d) => d.ok), JSON.stringify(r5.donated));
    const r6 = await quests.guildQuestRound(game, { accept: true, donate: true });
    check('fully donated gather contract is turned in', r6.finished && r6.finished.ok && r6.finished.id === '4', JSON.stringify(r6.finished));
    st = await mockApi('GET', '/__mock/state');
    check('both contracts finished overall', JSON.stringify((st.quests[uid] || {}).finished) === '[3,4]', JSON.stringify(st.quests[uid]));

    // ── Event daily contracts (Dragon Realm sanctuary board) ────────────────
    console.log('· event daily contracts');
    await mockApi('POST', '/__mock/state', { resetDailies: uid });

    const ids2 = events.parseEventIds('<a href="/event_page.php?event=13">e</a><a href="/event_page.php?event=13&amp;x=1">e</a>');
    check('event discovery reads unique ids off the dashboard', JSON.stringify(ids2) === '["13"]', JSON.stringify(ids2));
    const panelUrl = events.parsePanelUrl('<script type="application/json">{"locations":[],"panelUrl":"\\/event_page.php?event=13\\u0026map=23"}</script>');
    check('panelUrl is decoded from the event page config', panelUrl === '/event_page.php?event=13&map=23', panelUrl);

    const e1 = await events.eventDailiesRound(game);
    const ev1 = e1.events[0] || {};
    check('event round finds the live event', ev1.id === '13' && !!ev1.board, JSON.stringify(e1));
    check('board progress feed is parsed (3 contracts)', (ev1.board && ev1.board.cards.length === 3)
      && ev1.board.cards[0].label === '3 / 15', JSON.stringify(ev1.board && ev1.board.cards.map((c) => c.label)));
    check('dispatch contract submitted with the board\u2019s csrf',
      ev1.submitted.length === 1 && ev1.submitted[0].ok, JSON.stringify(ev1.submitted));
    st = await mockApi('GET', '/__mock/state');
    check('mock registered the dispatch for quest|day',
      JSON.stringify((st.events[uid] || {}).dispatch) === JSON.stringify([`${2304}|${DAY}`]), JSON.stringify(st.events[uid]));

    const e2 = await events.eventDailiesRound(game);
    const ev2 = e2.events[0] || {};
    check('same-day re-run does not double-submit', (ev2.submitted.length === 0)
      || (ev2.submitted.length === 1 && ev2.submitted[0].ok === false), JSON.stringify(ev2.submitted));

    // ── Manual kill-loot hook (feeds the hunting dailies) ───────────────────
    console.log('· manual kill-loot hook');
    await mockApi('POST', '/__mock/state', { uid, stamina: 500 });

    const noLoot = await combat.waveFarmRound({
      game, userId: uid,
      cfg: { ...cfg, waveLootKills: false, waveMobsPerRound: 1 },
      wave: { label: 'Gate 1 wave 2', path: 'gate=3&wave=5' },
      onEvent: () => {},
    });
    check('kill-loot hook off: kills are NOT looted (WAVE_LOOT_KILLS=0)',
      noLoot.slain >= 1 && noLoot.looted === 0, JSON.stringify({ slain: noLoot.slain, looted: noLoot.looted }));
    st = await mockApi('GET', '/__mock/state');
    check('no loot POST reached the game while the hook is off', st.lastLootPost === null, JSON.stringify(st.lastLootPost));

    await mockApi('POST', '/__mock/state', { uid, stamina: 500 });
    // The first mob died in the previous round — use wave 8's fresh mobs.
    const withLoot = await combat.waveFarmRound({
      game, userId: uid,
      cfg: { ...cfg, waveLootKills: true, waveMobsPerRound: 1 },
      wave: { label: 'Gate 1 wave 3', path: 'gate=3&wave=8' },
      onEvent: () => {},
    });
    check('kill-loot hook on: every SLAIN mob is looted once',
      withLoot.slain >= 1 && withLoot.looted === withLoot.slain, JSON.stringify({ slain: withLoot.slain, looted: withLoot.looted }));
    st = await mockApi('GET', '/__mock/state');
    const lp = st.lastLootPost || {};
    check('loot POST matches the game\u2019s own Loot button shape (instance_id 0 + dgmid)',
      lp.instance_id === '0' && lp.dgmid != null && lp.monster_id != null && lp.user_id === uid, JSON.stringify(lp));

    // ── Battle Pass (battle_pass.php) ────────────────────────────────────
    console.log('· battle pass');
    await mockApi('POST', '/__mock/state', { resetDailies: uid, bpSeason: false });

    // Season off = the page the engine will hit until the next season drops.
    const off = await battlepass.battlePassRound(game);
    check('no season live: the round is a clean no-op',
      off.active === false && off.claimed === 0 && off.quests.length === 0
        && off.notes.some((n) => /no battle pass season/i.test(n)), JSON.stringify(off));
    check('inactive page is detected before any parsing',
      battlepass.isInactive('<h2>No Battle Pass season available.</h2>') === true
        && battlepass.isInactive('<div>Season 4 is live</div>') === false);

    // Season on: two dailies + one already-reached tier reward.
    await mockApi('POST', '/__mock/state', { bpSeason: true, setBp: { uid, stamina: 0, damage: 0, claimed: [] } });
    const bpPage = await game.get('/battle_pass.php');
    const bpRows = battlepass.summarize(battlepass.parseQuestRows(bpPage.text));
    check('season page parses the two dailies + the tier reward',
      bpRows.quests.length === 2 && bpRows.claimReady.length === 1 && bpRows.claimReady[0].id === '201'
        && bpRows.quests[0].progress && bpRows.quests[0].progress.cur === 0,
      JSON.stringify({ quests: bpRows.quests.map((q) => ({ t: q.title, p: q.progress })), ready: bpRows.claimReady }));
    check('csrf + endpoint + body field are read off the page\u2019s own script',
      /^[0-9a-f]{32}$/.test(battlepass.parseCsrf(bpPage.text) || '')
        && battlepass.parseEndpoint(bpPage.text).endpoint === 'battle_pass_claim.php'
        && battlepass.parseEndpoint(bpPage.text).field === 'quest_id',
      JSON.stringify({ csrf: battlepass.parseCsrf(bpPage.text), ep: battlepass.parseEndpoint(bpPage.text) }));
    const bpHint = battlepass.questHint(bpRows.quests);
    check('hint: lizard keyword + 300,000 damage + 500 stamina needs',
      bpHint.needDamage === 300000 && bpHint.needStamina === 500
        && bpHint.keywords.includes('lizard') && bpHint.incomplete === true, JSON.stringify(bpHint));
    check('a stamina-only quest yields NO keywords (nothing to steer toward)',
      battlepass.questHint([{ objective: 'Spend 500 Stamina today', progress: { cur: 0, max: 500 } }]).keywords.length === 0);

    // Wave priority: remembered matching waves first, unknown next, dead
    // (non-matching) last — stable inside each bucket.
    const wlist = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    const wmem = new Map([['b', 'match'], ['a', 'nomatch']]);
    check('wave memory orders match > unknown > nomatch (stable)',
      JSON.stringify(battlepass.orderWaves(wlist, wmem).map((w) => w.path)) === '["b","c","a"]');

    // Tier reward claims immediately; the open dailies stay put.
    const bpR1 = await battlepass.battlePassRound(game);
    check('tier reward is claimed while both dailies are still open',
      bpR1.active === true && bpR1.claimed === 1, JSON.stringify({ claimed: bpR1.claimed, messages: bpR1.messages }));

    // Farming feeds the dailies: stamina spend + lizard damage count.
    await mockApi('POST', '/__mock/state', { uid, stamina: 500 });
    const bpFarm = await combat.waveFarmRound({
      game, userId: uid,
      cfg: { ...cfg, bpKeywords: ['lizard'], waveMobsPerRound: 4 },
      wave: { label: 'BP lizard wave', path: 'gate=3&wave=6' },
      onEvent: () => {},
    });
    check('quest mobs are attacked FIRST on a mixed wave page',
      bpFarm.matched === 1 && Object.keys(bpFarm.caps)[0] === 'lizardman shadowclaw'
        && bpFarm.attacked >= 2,
      JSON.stringify({ matched: bpFarm.matched, order: Object.keys(bpFarm.caps), attacked: bpFarm.attacked }));
    st = await mockApi('GET', '/__mock/state');
    check('wave farming feeds the season dailies (stamina spent + lizard damage)',
      (st.battlePass[uid] || {}).stamina >= 16 && (st.battlePass[uid] || {}).damage >= 1000,
      JSON.stringify(st.battlePass[uid]));

    // Quests complete → claims fire and the hint reports done.
    await mockApi('POST', '/__mock/state', { setBp: { uid, stamina: 500, damage: 300000 } });
    const bpR2 = await battlepass.battlePassRound(game);
    check('both completed dailies are claimed and the hint reports done',
      bpR2.claimed === 2 && bpR2.hint && bpR2.hint.incomplete === false,
      JSON.stringify({ claimed: bpR2.claimed, hint: bpR2.hint }));
    st = await mockApi('GET', '/__mock/state');
    check('mock registered all three rewards claimed',
      JSON.stringify((st.battlePass[uid] || {}).claimed) === '["201","101","102"]', JSON.stringify(st.battlePass[uid]));
    const bpR3 = await battlepass.battlePassRound(game);
    check('next round claims nothing (claimed rows render disabled)',
      bpR3.claimed === 0, JSON.stringify({ claimed: bpR3.claimed, messages: bpR3.messages }));

    // Season ends → back to a clean no-op (the worker also drops the hint).
    await mockApi('POST', '/__mock/state', { bpSeason: false });
    const off2 = await battlepass.battlePassRound(game);
    check('season over: the round is a clean no-op again', off2.active === false && off2.claimed === 0, JSON.stringify(off2));

    // ── Class skill tree (class_skill_tree.php) ──────────────────────────
    console.log('· class skill tree');
    const skilltree = require(path.join(ROOT, 'server', 'skilltree.js'));
    const hunt = require(path.join(ROOT, 'server', 'hunt.js'));
    const fsMod = require('fs');
    const osMod = require('os');
    await mockApi('POST', '/__mock/state', {
      resetDailies: uid, resetClasses: { uid }, resetTree: { uid }, setTree: { uid, ap: 0 },
    });

    // Classless session: the game serves the "choose a class first" page —
    // no SkillTreeData → the round is a clean no-op.
    const noTree = await skilltree.upgradeRound(game, {});
    check('classless account: tree round is a clean no-op (zero POSTs)',
      noTree.unlocked.length === 0 && noTree.leveled.length === 0 && noTree.spent === 0
        && noTree.notes.some((n) => /no skill tree/i.test(n)),
      JSON.stringify(noTree));

    // Bind Mage through the game's own confirm form, then read the tree.
    await game.postForm('/classes.php', { choose_class_id: '2' });
    const treePage = await game.get('/class_skill_tree.php');
    const parsed = skilltree.parseSkillTree(treePage.text);
    check('tree parser reads the class + AP wallet + 3 skill rows',
      parsed.className === 'Mage' && parsed.points === 0 && Array.isArray(parsed.data) && parsed.data.length === 3,
      JSON.stringify({ className: parsed.className, points: parsed.points, n: parsed.data && parsed.data.length }));
    check('config parser survives the live page\u2019s trailing // comment',
      parsed.config && parsed.config.ajaxUrl === '/class_skill_tree.php'
        && /25%/.test(parsed.config.classPassive || ''),
      JSON.stringify(parsed.config));
    check('catalog ranking: damage skills first, page order kept inside ties',
      JSON.stringify(skilltree.planOrder(parsed.data).map((s) => s.name)) === '["Fireball","Arcane Sacrifice","Mana Shield"]',
      JSON.stringify(skilltree.planOrder(parsed.data).map((s) => s.name)));

    // The farm classes' first damage skill unlocks FREE — at a 0 AP wallet.
    const tr0 = await skilltree.upgradeRound(game, {});
    check('free unlock: Fireball binds at 0 AP (no wallet, no problem)',
      tr0.unlocked.length === 1 && tr0.unlocked[0].name === 'Fireball' && tr0.pointsLeft === 0,
      JSON.stringify({ unlocked: tr0.unlocked, left: tr0.pointsLeft, notes: tr0.notes }));
    st = await mockApi('GET', '/__mock/state');
    check('mock registered the unlock (owned {4: level 1})',
      st.trees && st.trees[uid] && st.trees[uid].owned && st.trees[uid].owned['4'] && st.trees[uid].owned['4'].level === 1,
      JSON.stringify(st.trees && st.trees[uid]));

    // AP from the guild contracts buys levels — damage first.
    await mockApi('POST', '/__mock/state', { setTree: { uid, ap: 2500 } });
    const tr1 = await skilltree.upgradeRound(game, {});
    check('damage-first spending: Fireball → lv 2 (2000 AP), then Arcane Sacrifice unlocked (500 AP)',
      tr1.leveled.length === 1 && tr1.leveled[0].name === 'Fireball' && tr1.leveled[0].level === 2
        && tr1.unlocked.length === 1 && tr1.unlocked[0].name === 'Arcane Sacrifice',
      JSON.stringify({ leveled: tr1.leveled, unlocked: tr1.unlocked }));
    check('wallet drained 2500 → 0 and reported', tr1.pointsStart === 2500 && tr1.pointsLeft === 0,
      JSON.stringify({ start: tr1.pointsStart, left: tr1.pointsLeft }));

    // Empty wallet → nothing affordable → clean no-op (no blind POSTs).
    const tr2 = await skilltree.upgradeRound(game, {});
    check('empty wallet: nothing spent, nothing POSTed',
      tr2.spent === 0 && tr2.unlocked.length === 0 && tr2.leveled.length === 0,
      JSON.stringify({ spent: tr2.spent, refused: tr2.refused, notes: tr2.notes }));

    // The tree POST surface answers refusals without throwing (bad action).
    const bad = await skilltree.treePost(game, 'bogus_action', 4);
    check('tree POST surfaces the game\u2019s refusal JSON as a plain result',
      bad.ok === false && !!bad.error, JSON.stringify(bad));

    // Reserve: pricey levels are skipped while cheap unlocks still happen.
    await mockApi('POST', '/__mock/state', { resetTree: { uid } });
    await mockApi('POST', '/__mock/state', { setTree: { uid, ap: 2500 } });
    const tr3 = await skilltree.upgradeRound(game, { reserve: 1500 });
    check('reserve keeps AP banked: both cheap unlocks fire, the 2000 AP level-up is skipped',
      tr3.unlocked.length === 2 && tr3.leveled.length === 0 && tr3.pointsLeft === 2000,
      JSON.stringify({ unlocked: tr3.unlocked.map((u) => u.name), leveled: tr3.leveled, left: tr3.pointsLeft }));

    // Spend cap: maxSpends bounds the POSTs per round.
    await mockApi('POST', '/__mock/state', { resetTree: { uid } });
    await mockApi('POST', '/__mock/state', { setTree: { uid, ap: 9000 } });
    const tr4 = await skilltree.upgradeRound(game, { maxSpends: 2 });
    check('maxSpends caps the round (2 POSTs, rest waits for the next)',
      tr4.spent === 2 && tr4.notes.some((n) => /spend cap/i.test(n)),
      JSON.stringify({ spent: tr4.spent, notes: tr4.notes }));

    // Char-level gate: a level-150 account never POSTs the level-200 skill —
    // the client parks it BEFORE spending a request.
    const jarLow = new CookieJar();
    const gameLow = new GameClient({ gameBase: `http://127.0.0.1:${MOCK_PORT}`, jar: jarLow, cfg, label: 'dailies-low' });
    await auth.login(gameLow, 'low.lvl@example.com', 'lowpass1'); // uid 106, level 150
    await gameLow.postForm('/classes.php', { choose_class_id: '2' });
    const trLow = await skilltree.upgradeRound(gameLow, { level: 150 });
    check('char-level gate: Mana Shield (unlock_level 200) is skipped without a POST',
      trLow.skipped.some((s) => s.id === 16 && /char level 200/.test(s.reason)) && trLow.unlocked.every((u) => u.name !== 'Mana Shield'),
      JSON.stringify({ skipped: trLow.skipped, unlocked: trLow.unlocked.map((u) => u.name) }));
    st = await mockApi('GET', '/__mock/state');
    check('the gated skill never reached the game', !(st.lastTreePost && st.lastTreePost['106']
      && st.lastTreePost['106'].skillId === '16'), JSON.stringify(st.lastTreePost));

    // Cleric parity: diver-shaped tree (Heal free, four skills).
    const jarCl = new CookieJar();
    const gameCl = new GameClient({ gameBase: `http://127.0.0.1:${MOCK_PORT}`, jar: jarCl, cfg, label: 'dailies-cleric' });
    await auth.login(gameCl, 'guild.tester@example.com', 'guildpass1'); // uid 104
    await gameCl.postForm('/classes.php', { choose_class_id: '4' });
    const clPage = await gameCl.get('/class_skill_tree.php');
    const clParsed = skilltree.parseSkillTree(clPage.text);
    check('cleric tree parses (4 skills, Heal is the free unlock)',
      clParsed.className === 'Cleric' && clParsed.data.length === 4
        && skilltree.planOrder(clParsed.data)[0].name === 'Heal',
      JSON.stringify({ cls: clParsed.className, order: skilltree.planOrder(clParsed.data).map((s) => s.name) }));
    const trCl = await skilltree.upgradeRound(gameCl, {});
    check('cleric round unlocks Heal free (no damage skill to rank first — still zero cost)',
      trCl.unlocked.length === 1 && trCl.unlocked[0].name === 'Heal',
      JSON.stringify(trCl.unlocked));

    // ── Quest hunt (hunt.js + wave steering) ──────────────────────────────
    console.log('· quest hunt');
    // Pure map semantics on an isolated data dir.
    const tmpHunt = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'hunt-map-'));
    hunt.initHuntMap(tmpHunt);
    hunt.rememberWaveMobs('gate=3&wave=6', ['lizardman shadowclaw', 'gate sentry']);
    check('hunt map pins the hosting wave (exact + case-insensitive)',
      hunt.findMobWave('Lizardman Shadowclaw') && hunt.findMobWave('Lizardman Shadowclaw').wave === 'gate=3&wave=6',
      JSON.stringify(hunt.findMobWave('Lizardman Shadowclaw')));
    check('shorthand names match too ("shadowclaw" → the pinned wave)',
      hunt.findMobWave('shadowclaw') && hunt.findMobWave('shadowclaw').wave === 'gate=3&wave=6',
      JSON.stringify(hunt.findMobWave('shadowclaw')));
    check('unknown mobs answer null', hunt.findMobWave('marsh crawler') === null, String(hunt.findMobWave('marsh crawler')));
    hunt.initHuntMap(tmpHunt); // restart semantics: reload from data/hunt-map.json
    check('hunt map survives a restart (persisted to the data dir)',
      hunt.findMobWave('gate sentry') && hunt.findMobWave('gate sentry').wave === 'gate=3&wave=6',
      JSON.stringify(hunt.findMobWave('gate sentry')));
    hunt.initHuntMap(null); // back to in-memory for the farm-flow checks

    // Wave rounds teach the map passively — any parsed wave page records its
    // mob names, dead or alive.
    check('pre-round: cinder hound is unknown', !hunt.findMobWave('cinder hound'), String(hunt.findMobWave('cinder hound')));
    await mockApi('POST', '/__mock/state', { uid, stamina: 300 });
    await combat.waveFarmRound({
      game, userId: uid,
      cfg: { ...cfg, waveLootKills: false, waveMobsPerRound: 1 },
      wave: { label: 'Gate 1 wave 2', path: 'gate=3&wave=5' },
      onEvent: () => {},
    });
    check('wave rounds teach the map (gate=3&wave=5 → cinder hound)',
      hunt.findMobWave('cinder hound') && hunt.findMobWave('cinder hound').wave === 'gate=3&wave=5',
      JSON.stringify(hunt.findMobWave('cinder hound')));

    // Worker steering, borrowed pickNextWave on a lightweight fixture (the
    // method only touches cfg/questReq/huntProbes/index/waveCursor/state).
    const { AccountWorker } = require(path.join(ROOT, 'server', 'workers.js'));
    const W = [
      { path: 'gate=3&wave=3', label: 'w1' },
      { path: 'gate=3&wave=5', label: 'w2' },
      { path: 'gate=3&wave=8', label: 'w3' },
    ];
    const fixture = (over = {}) => ({
      cfg: { wavePages: W, guildQuests: { hunt: true }, battlePass: { wavePriority: true } },
      questReq: null, huntProbes: new Map(), index: 0, waveCursor: 0,
      bpHint: null, bpWaveMemory: new Map(), diveTargets: [],
      state: { quests: {}, level: 0, dive: {} },
      waveRegistry() { return this.cfg.wavePages; }, // reward-cap steering reads the registry
      ...over,
    });
    const plain = AccountWorker.prototype.pickNextWave.call(fixture());
    check('no contract: plain round-robin (first registry wave)', plain.path === 'gate=3&wave=3', plain.path);

    // Armed kill contract + pinned map → straight to the hosting wave.
    hunt.rememberWaveMobs('gate=3&wave=8', ['kobold chieftain']);
    const pinnedFixture = fixture({ questReq: { kind: 'kill', monster: 'kobold chieftain', minDamage: 1000, kills: 3, title: 'Kobold Cull' } });
    const pinnedW = AccountWorker.prototype.pickNextWave.call(pinnedFixture);
    check('armed kill contract: the picker goes straight to the pinned wave',
      pinnedW.path === 'gate=3&wave=8', pinnedW.path);
    check('huntInfo reports the pin (monster + wave + pinned)',
      pinnedFixture.state.quests.huntInfo && pinnedFixture.state.quests.huntInfo.pinned === true
        && pinnedFixture.state.quests.huntInfo.wave === 'w3'
        && pinnedFixture.state.quests.huntInfo.monster === 'kobold chieftain',
      JSON.stringify(pinnedFixture.state.quests.huntInfo));

    // Unknown mob → probe: fresh pages first, one per round, until pinned.
    hunt.initHuntMap(null);
    const probeF = fixture({ questReq: { kind: 'kill', monster: 'dire swamp beast', kills: 2 } });
    const p1 = AccountWorker.prototype.pickNextWave.call(probeF);
    const p2 = AccountWorker.prototype.pickNextWave.call(probeF);
    check('unpinned contract probes UNVISITED pages first (w1 then w2)',
      p1.path === 'gate=3&wave=3' && p2.path === 'gate=3&wave=5',
      JSON.stringify([p1.path, p2.path]));
    check('probe state tracks the visited pages', probeF.huntProbes.get('dire swamp beast').size === 2,
      String(probeF.huntProbes.get('dire swamp beast').size));
    check('probe huntInfo reads pinned=false + probed count',
      probeF.state.quests.huntInfo.pinned === false && probeF.state.quests.huntInfo.probed === 2,
      JSON.stringify(probeF.state.quests.huntInfo));
    // The mob turns up on w3 → the map pins the hunt mid-probe.
    hunt.rememberWaveMobs('gate=3&wave=8', ['dire swamp beast']);
    const p3 = AccountWorker.prototype.pickNextWave.call(probeF);
    check('mid-probe pin: the next round drives straight to the hosting wave',
      p3.path === 'gate=3&wave=8' && probeF.state.quests.huntInfo.pinned === true,
      JSON.stringify({ wave: p3.path, info: probeF.state.quests.huntInfo }));

    // QUESTS_HUNT=0 → plain round-robin even with an armed kill contract.
    const offHunt = AccountWorker.prototype.pickNextWave.call(fixture({
      questReq: { kind: 'kill', monster: 'kobold chieftain', kills: 3 },
      cfg: { wavePages: W, guildQuests: { hunt: false }, battlePass: { wavePriority: false } },
    }));
    check('QUESTS_HUNT=0: no steering (plain round-robin)', offHunt.path === 'gate=3&wave=3', offHunt.path);

    // DIVE STEERING: a diver's named targets pin their hosting waves via the
    // hunt map — seeded from config/mobs.json (troll ravager → gate=3&wave=5)
    // — and the picker goes straight there, rotating across multiple pins.
    hunt.initHuntMap(null); // fresh map + seed for the dive checks
    const diver = fixture({ diveTargets: ['troll ravager'] });
    const dv1 = AccountWorker.prototype.pickNextWave.call(diver);
    check('dive targets pin their seeded hosting wave (troll ravager → w2)',
      dv1.path === 'gate=3&wave=5', JSON.stringify(dv1));
    check('the pin lands on the diver state (pinnedWave + count)',
      diver.state.dive.pinnedWave === 'w2' && diver.state.dive.pinCount === 1,
      JSON.stringify(diver.state.dive));
    // Unknown target → no pin → plain round-robin, dive state reset.
    const roam = fixture({ diveTargets: ['marsh crawler'] });
    const rv1 = AccountWorker.prototype.pickNextWave.call(roam);
    check('unknown dive target keeps the round-robin (roaming)',
      rv1.path === 'gate=3&wave=3' && roam.state.dive.pinnedWave === null,
      `${rv1.path} · ${JSON.stringify(roam.state.dive)}`);
    // Multi-target divers rotate across ALL their pinned pages.
    hunt.rememberWaveMobs('gate=3&wave=8', ['marsh crawler']); // teach the second pin
    const multi = fixture({ diveTargets: ['troll ravager', 'marsh crawler'] });
    const mv1 = AccountWorker.prototype.pickNextWave.call(multi);
    const mv2 = AccountWorker.prototype.pickNextWave.call(multi);
    const mv3 = AccountWorker.prototype.pickNextWave.call(multi);
    check('multi-target diver rotates across both pinned pages',
      multi.state.dive.pinCount === 2
      && [mv1.path, mv2.path].sort().join('|') === 'gate=3&wave=5|gate=3&wave=8'
      && mv3.path === mv1.path,
      `${mv1.path} → ${mv2.path} → ${mv3.path}`);
    // A live-armed kill contract still outranks the dive pins.
    hunt.rememberWaveMobs('gate=3&wave=3', ['goblin shaman']);
    const both = fixture({
      diveTargets: ['troll ravager'],
      questReq: { kind: 'kill', monster: 'goblin shaman', kills: 2 },
    });
    const b1 = AccountWorker.prototype.pickNextWave.call(both);
    check('an armed kill contract outranks the dive pins',
      b1.path === 'gate=3&wave=3', b1.path);

    // SEEDED CONTRACT ROWS: the mobs.json seed (lizardman shadowclaw →
    // gate=3&wave=5) is a HINT, never a hard pin — a wrong seed must not
    // trap a contract on a barren page. The probe visits the seeded page
    // FIRST, then falls back to the registry scan; a live sighting there
    // upgrades the row to a verified pin.
    hunt.initHuntMap(null); // fresh seed
    const seededC = fixture({ questReq: { kind: 'kill', monster: 'lizardman shadowclaw', kills: 5 } });
    const s1 = AccountWorker.prototype.pickNextWave.call(seededC);
    check('a seeded contract row is probed, not hard-pinned (pinned=false)',
      s1.path === 'gate=3&wave=5' && seededC.state.quests.huntInfo.pinned === false,
      JSON.stringify({ path: s1.path, info: seededC.state.quests.huntInfo }));
    const s2 = AccountWorker.prototype.pickNextWave.call(seededC);
    check('after the seeded probe the scan continues (next registry page)',
      s2.path === 'gate=3&wave=3' && seededC.state.quests.huntInfo.probed === 2,
      JSON.stringify({ path: s2.path, info: seededC.state.quests.huntInfo }));
    // The live sighting on ANOTHER page re-pins the hunt over the seed.
    hunt.rememberWaveMobs('gate=3&wave=8', ['lizardman shadowclaw']);
    const s3 = AccountWorker.prototype.pickNextWave.call(seededC);
    check('a live sighting anywhere hard-pins the contract (learned beats seed)',
      s3.path === 'gate=3&wave=8' && seededC.state.quests.huntInfo.pinned === true,
      JSON.stringify({ path: s3.path, info: seededC.state.quests.huntInfo }));
  } finally {
    mock.kill('SIGKILL');
  }

  console.log(failures === 0 ? '\nALL DAILIES CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  if (failures) {
    console.log('--- mock log tail ---\n' + mockLog.slice(-1200));
    process.exit(1);
  }
}

main().catch((e) => { console.error('dailies-test FAILED:', e); process.exit(1); });
