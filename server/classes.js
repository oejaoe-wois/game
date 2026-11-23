'use strict';
// classes.js — the class system (classes.php): detect, decide, pick.
//
// Live-verified on demonicscans.org (2026-11, account LV 318 classless):
//   • CLASSED state   — classes.php says "You are already bound to a class."
//     and renders "Your class: Mage" + a View Skill Tree link
//     (class_skill_tree.php). No choose form anywhere on the page.
//   • CLASSLESS state — four base-class strips (Warrior/Mage/Hunter/Cleric),
//     a Class Preview panel (passive, requirements, skill tree) and a
//     confirm form per class: <input name="choose_class_id" value="N">.
//     POST /classes.php choose_class_id=N → 302 → the class is bound
//     ("This choice may be permanent" — the game never unbinds).
//   • Requirement     — every base class: Character level ≥ 200.
//   • Advanced classes live at advanced_classes.php (locked until the base
//     tree progresses; skills unlock with Adv. points, not farm actions).
//
// Why MAGE is the default optimal pick for farm accounts (PvE skill damage
// per one 200-stamina cast — the unit the wave farm spends):
//     Mage  Fireball        4,000,000 + 10% ATK   (passive: +25% ATK, -50% DEF)
//     Hunter Back Stab      2,700,000 + 30% def pen
//     Warrior Ironclad      1,000,000              (passive: +30% HP)
//     Cleric — no PvE damage skill at all (pure PvP support + heal passive)
// Fireball meets the guild contracts' "min 3m dmg per kill" floors in ONE
// cast and the +25% ATK passive speeds every ladder hit, which is exactly
// what questing + leveling accounts want. Override freely:
//   env CLASS_AUTO_PICK = auto | mage | warrior | hunter | cleric | off
//   per-account classPick (panel/API) wins over the env default.
const auth = require('./auth');

const CLASS_IDS = { warrior: 1, mage: 2, hunter: 3, cleric: 4 };

// The live class catalog (classes.php previews, 2026-11). pveDamage is the
// flat PvE skill damage of the first, cheapest-to-unlock damage skill — the
// number that matters for farming.
const CLASSES = [
  {
    id: 1, key: 'warrior', name: 'Warrior',
    passive: '+30% HP',
    pveSkill: 'Ironclad Strike', pveDamage: 1000000, stamCost: 200,
    note: 'tankiest passive; weakest PvE skill of the three damage classes',
  },
  {
    id: 2, key: 'mage', name: 'Mage',
    passive: '+25% attack, -50% defense',
    pveSkill: 'Fireball', pveDamage: 4000000, stamCost: 200,
    note: 'best PvE damage per stamina + ATK passive — the farm default',
  },
  {
    id: 3, key: 'hunter', name: 'Hunter',
    passive: '+20% crit damage, -30% defense',
    pveSkill: 'Back Stab', pveDamage: 2700000, stamCost: 200,
    note: 'middle PvE skill; crit passive shines in PvP',
  },
  {
    id: 4, key: 'cleric', name: 'Cleric',
    passive: 'auto-heal 0.03% max HP per stamina used',
    pveSkill: null, pveDamage: 0, stamCost: 0,
    note: 'no PvE damage skill — PvP support/sustain only; never auto-picked',
  },
];

const MIN_CLASS_LEVEL = 200; // "Character level ≥ 200" on every base class

// classes.php → { classless, currentClass }.
// Classed marker (live markup): "You are already bound to a class." plus
// "Your class: Mage". Classless marker: name="choose_class_id" inputs.
function parseClassState(html) {
  const text = String(html || '');
  if (!text) return { classless: null, currentClass: null };
  if (/name=["']choose_class_id["']/.test(text)) {
    return { classless: true, currentClass: null };
  }
  // Tag-stripped "Your class: Mage" (the phrase is split across elements
  // sometimes — match both the element form and the plain-text form).
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = plain.match(/Your class:\s*([A-Za-z]+)/i);
  if (m) return { classless: false, currentClass: m[1].trim() };
  if (/already bound to a class/i.test(plain)) {
    return { classless: false, currentClass: null };
  }
  return { classless: null, currentClass: null }; // page shape unknown
}

// Resolve a user preference ('auto'|key|'off') to a class object or null.
function resolvePick(pref) {
  const p = String(pref || 'auto').trim().toLowerCase();
  if (p === 'off' || p === 'none' || p === 'false' || p === '0') return null;
  if (p === 'auto' || p === '' || p === 'optimal') {
    return CLASSES.find((c) => c.key === 'mage'); // the ranked default
  }
  return CLASSES.find((c) => c.key === p) || null;
}

// POST the confirm form. The game answers 302 (bound) — verify below.
async function chooseClass(game, classId) {
  const res = await game.postForm('/classes.php', { choose_class_id: String(classId) });
  return { status: res.status, ok: res.status >= 200 && res.status < 400 };
}

// One class round — safe to call on every login and after level-ups:
//   1. Read classes.php. Classed → report and stop (zero writes).
//   2. Classless + pick 'off' → report and stop.
//   3. Classless → level check (auth.getPlayerLevel). Under MIN_CLASS_LEVEL
//      → 'low-level' (the picker retries on later rounds after level-ups).
//   4. POST choose_class_id → re-read classes.php to confirm the binding.
// Never throws for game-level refusals; notes explain every skip.
async function ensureClass(game, opts = {}) {
  const report = {
    checkedAt: Date.now(),
    classless: null, currentClass: null, level: null,
    action: 'checked', picked: null, notes: [],
  };
  const pref = opts.pick !== undefined ? opts.pick : 'auto';
  const resolved = resolvePick(pref);
  if (!resolved && String(pref || '').toLowerCase() !== 'auto') {
    report.action = 'off';
    report.notes.push('class pick disabled');
    return report;
  }
  let res;
  try {
    res = await game.get('/classes.php', { redirect: 'manual' });
  } catch (e) {
    report.notes.push(`classes.php failed: ${e.message}`);
    return report;
  }
  if (res.status === 302 && /game_login|signout/i.test(res.location || '')) {
    report.notes.push('not logged in');
    return report;
  }
  const state = parseClassState(res.text);
  report.classless = state.classless;
  report.currentClass = state.currentClass;
  if (state.classless === false) {
    report.action = 'classed';
    return report;
  }
  if (state.classless !== true) {
    report.notes.push('classes.php shape unknown — skipped');
    return report;
  }
  if (!resolved) {
    report.action = 'off';
    return report;
  }
  const level = await auth.getPlayerLevel(game);
  report.level = level;
  const minLevel = Number(opts.minLevel) > 0 ? Number(opts.minLevel) : MIN_CLASS_LEVEL;
  if (level > 0 && level < minLevel) {
    report.action = 'low-level';
    report.notes.push(`level ${level} < ${minLevel} — every base class needs level ${minLevel}`);
    return report;
  }
  if (level === 0) {
    report.notes.push('level unknown — skipped this round');
    return report;
  }
  await game.pace(600, 1400);
  const pick = await chooseClass(game, resolved.id);
  await game.pace(600, 1400);
  let after = { classless: null, currentClass: null };
  try {
    const verify = await game.get('/classes.php', { redirect: 'manual' });
    after = parseClassState(verify.text);
  } catch (_) { /* verification is best-effort */ }
  const bound = after.classless === false
    && (!after.currentClass || after.currentClass.toLowerCase() === resolved.name.toLowerCase());
  report.picked = { id: resolved.id, key: resolved.key, name: resolved.name, ok: bound };
  report.action = bound ? 'picked' : (pick.ok ? 'picked' : 'failed');
  if (!bound && pick.ok) report.notes.push('POST accepted but the page did not confirm — verified next round');
  if (!pick.ok) report.notes.push(`choose POST status ${pick.status}`);
  return report;
}

// One-line reason for a pick (panel + audit logs).
function rationale(key) {
  const c = CLASSES.find((x) => x.key === key);
  return c ? c.note : 'optimal for farming';
}

module.exports = {
  CLASS_IDS, CLASSES, MIN_CLASS_LEVEL,
  parseClassState, resolvePick, chooseClass, ensureClass, rationale,
};
