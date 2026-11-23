'use strict';
// NOTE: game logins are read from the environment — set DIVER1_EMAIL / DIVER1_PASSWORD,
// DIVER2_*, DIVER3_* before running. Never hardcode credentials in this repo.
// live-swarm-calibrate.js — the swarm engine's LIVE calibration run.
// Exercises the real engine modules end-to-end against the live game:
//
//   auth.login → combat.readAutoFarmStatus (+ disableAutoFarm if on)
//   → loadout.fetchLoadout (player half: equipAtk / petAtk / attackStat / stamina)
//   → wave page → combat.parseWaveCards → first alive mob
//   → monsterStats.get (the "View Monster Stats" modal, real parse)
//   → damage.predictDamage (the game's formula, real forecast)
//   → user_join_battle.php → TWO 1-stamina damage.php hits
//   → per-hit actual = Δ(totaldmgdealt)  →  accuracy vs the forecast
//
// Read-mostly: exactly TWO stamina points are spent (one calibration needs a
// per-hit DELTA, and a single cumulative number can't separate prior damage).
const path = require('path');
const ROOT = path.join('/home/z/my-project', 'aio-farm-improved');
const { GameClient } = require(path.join(ROOT, 'server', 'game.js'));
const { CookieJar } = require(path.join(ROOT, 'server', 'jar.js'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
const combat = require(path.join(ROOT, 'server', 'combat.js'));
const loadout = require(path.join(ROOT, 'server', 'loadout'));
const monsterStats = require(path.join(ROOT, 'server', 'monster-stats'));
const damage = require(path.join(ROOT, 'server', 'damage'));

const EMAIL = process.argv[2] || process.env.DIVER1_EMAIL;
const PASSWORD = process.argv[3] || process.env.DIVER1_PASSWORD;
const BASE = process.argv[4] || 'https://demonicscans.org';

async function main() {
  const jar = new CookieJar();
  const game = new GameClient({
    gameBase: BASE, jar,
    cfg: { fastTest: false, jitterScale: 1, requestTimeoutMs: 30000 },
    label: 'swarm-calibrate',
  });
  console.log(`[cal] login ${EMAIL} @ ${BASE}`);
  await auth.login(game, EMAIL, PASSWORD);
  console.log('[cal] login OK');

  // ── 1) the game's auto-farmer off (the REAL engine path) ──────────────────
  const before = await combat.readAutoFarmStatus(game);
  console.log(`[cal] auto-farm status: ok=${before.ok} enabled=${before.enabled}`);
  if (before.enabled) {
    const off = await combat.disableAutoFarm(game);
    const after = await combat.readAutoFarmStatus(game);
    console.log(`[cal] auto-farm PAUSED: toggle=${off} verified enabled=${after.enabled}`);
  }
  await game.pace(600, 1200);

  // ── 2) the player half (REAL fetchLoadout: stats + inventory + pets) ──────
  const player = await loadout.fetchLoadout(game, { force: true });
  console.log(`[cal] loadout: equipAtk=${player.equipAtk} petAtk=${player.petAtk} ` +
    `attackStat=${player.attackStat} element=${player.element || 'none'} ` +
    `stamina=${player.stamina ? `${player.stamina.cur}/${player.stamina.max}` : '?'}`);
  if (!player.stamina || player.stamina.cur < 2) throw new Error('not enough stamina for the calibration (need 2)');

  // ── 3) a live wave-1 mob ──────────────────────────────────────────────────
  jar.set('hide_dead_monsters', '1', 30 * 24 * 3600);
  const waveRes = await game.get('/active_wave.php?gate=3&wave=3', { redirect: 'manual' });
  const cards = combat.parseWaveCards(waveRes.text || '');
  const alive = cards.filter((c) => !c.dead);
  console.log(`[cal] Grakthar wave1 alive mobs: ${alive.length}; cards: ` +
    alive.slice(0, 5).map((c) => `${c.name}#${c.id}`).join(', '));
  if (!alive.length) throw new Error('no alive mobs on the wave page');
  const mob = alive[0];
  await game.pace(800, 1600);

  // ── 4) the monster half (REAL modal parse off the battle view) ────────────
  const got = await monsterStats.get(game, mob.id, { force: true });
  if (!got) throw new Error(`no monster-stats modal on the battle page of ${mob.name}#${mob.id}`);
  const monster = got.stats;
  console.log(`[cal] monster stats (${got.cached ? 'cached' : 'fresh'}): ${monsterStats.describe(monster)}`);
  await game.pace(800, 1600);

  // ── 5) the forecast (the game's damage formula) ───────────────────────────
  const forecast = damage.predictDamage({
    equipAtk: player.equipAtk,
    petAtk: player.petAtk,
    attackStat: player.attackStat,
    playerElement: player.element,
    playerElementRate: player.elementRate,
    staminaCost: 1,
  }, monster);
  console.log('[cal] forecast:', JSON.stringify(forecast, null, 2));
  console.log(`[cal] forecast total/hit ≈ ${forecast.total.toLocaleString('en-US')} — ` +
    `a 1,000,000 dmg quota needs ≈${Math.ceil(1e6 / Math.max(1, forecast.total))} hit(s)/account`);

  // ── 6) TWO real 1-stamina hits through the swarm's own endpoints ──────────
  const userId = await auth.getUserId(game); // the engine's resolver (cookie 'demon' → USER_ID → profile)
  console.log(`[cal] user_id=${userId}`);
  if (!userId) throw new Error('could not resolve user id');

  const join = await game.postForm('/user_join_battle.php', {
    id: String(mob.id), monster_id: String(mob.id), user_id: String(userId),
  });
  const joinText = (join.text || '').toLowerCase();
  if (joinText.includes('already dead') || joinText.includes("can't attack")) {
    throw new Error(`mob ${mob.id} not attackable (${joinText.slice(0, 120)})`);
  }
  console.log(`[cal] joined ${mob.name}#${mob.id}`);

  const hitDamage = [];
  for (let i = 0; i < 2; i++) {
    await game.pace(900, 1600);
    const res = await game.postForm('/damage.php', {
      monster_id: String(mob.id), skill_id: '0', stamina_cost: '1',
    });
    let json = {};
    try { json = JSON.parse(res.text); } catch (_) { /* non-JSON → report raw */ }
    if (json.status === 'error') {
      console.log(`[cal] hit ${i + 1}: server error — ${(json.message || '').slice(0, 160)}`);
      break;
    }
    const cumulative = Number(json.totaldmgdealt);
    if (typeof json.stamina !== 'undefined') game.noteStamina(json.stamina);
    hitDamage.push({ cumulative, staminaEcho: json.stamina, hp: json.hp && json.hp.value });
    console.log(`[cal] hit ${i + 1}: totaldmgdealt=${cumulative} staminaEcho=${json.stamina} mobHp=${json.hp && json.hp.value}`);
  }
  if (hitDamage.length < 2) throw new Error('calibration needs two successful hits');

  // ── 7) the verdict ────────────────────────────────────────────────────────
  const perHit = hitDamage[1].cumulative - hitDamage[0].cumulative;
  const acc = forecast.total > 0 ? Math.round((perHit / forecast.total) * 100) : 0;
  console.log('──────────────────────────────────────────────');
  console.log(`[cal] per-hit actual: ${perHit.toLocaleString('en-US')}  |  forecast: ${forecast.total.toLocaleString('en-US')}  |  accuracy: ${acc}%`);
  const sta = game.lastStamina;
  console.log(`[cal] stamina now: ${sta ? `${sta.cur}/${sta.max}` : '?'}`);
  // Crits push real hits ABOVE the base formula (the game's ×1.50 crit
  // multiplier + variance) — 100-210% is the healthy band; only a forecast
  // far ABOVE actual (over-promising) would break the quota math.
  console.log(acc >= 90 && acc <= 220
    ? '[cal] CALIBRATED ✓ — actual ≥ base forecast (crits only help); quota math is trustworthy'
    : '[cal] OFF-BAND — inspect the parts above (walls/element) before trusting quota math');
}

main().catch((e) => { console.error('[cal] FAILED:', e.message); process.exit(1); });
