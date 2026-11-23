'use strict';
// equip.js — "equip best": parse inventory.php, compare every equipped slot
// with the bag's best item of the same type and wear the upgrades.
//
// Live wire (veyragame.com inventory page, 2026-11-22):
//   Bag rows      .slot-box[data-equip="1"] carrying
//                 data-inv-id / data-typee / data-atk / data-def and
//                 .equipment-item-name (qty suffix "x2" = stack size).
//   Equipped rows .slot-box with onclick="unequipItem(N)" — the .label's
//                 first line is the slot name (weapon, helmet, armor, boots,
//                 gloves, amulet, ring, ring 2, Class Weapon) and the
//                 label's ATK/DEF spans carry the worn stats.
//   Equip         POST /inventory_ajax.php
//                 action=equip_item&inv_id=<bag inv id>&slot_id=0&set=attack
//                 → body "OK" (anything else is an alert for the user).
//                 slot_id=0 is exactly what the game's own equip modal sends
//                 for every non-ring item: the server places the item in the
//                 set's natural slot for its type.
//
// The `set` query selects the gear set (attack = PvE Attack, defense =
// PvP Defense, pvp_attack). The farm hunts with the PvE set, so that is the
// default; a ring upgrade goes to ring slot 1 (slot_id=0 server default).
const { logger } = require('./util');
const { normalizeElement } = require('./damage');

const DEFAULT_SET = 'attack';

// Slot-type families: an equipped slot name maps to the bag's data-typee.
// "ring 2" and "ring" both feed the ring family; "Class Weapon" has its own
// family (class items never mix with regular weapons).
function slotFamily(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return '';
  if (n === 'ring' || n === 'ring 2') return 'ring';
  if (n === 'class weapon') return 'classweapon';
  return n;
}

// Score an item: attack counts more than defense by default (the farm's
// damage — kill speed, wave EXP/hour — comes from ATK; DEF only lowers the
// heal-potion bill). EQUIP_ATK_WEIGHT / EQUIP_DEF_WEIGHT override.
//
// preferElements (optional, array of element names): the elements that COUNTER
// the mob being hunted. A bag item wearing one of them scores a flat bonus
// (EQUIP_ELEMENT_BONUS, default 10 ≈ 3.3 ATK) — a counter-element piece beats
// an equal-ATK non-elemental one and covers a small ATK deficit, but never
// outranks a decisively stronger item.
const ELEMENT_BONUS_DEFAULT = 10;
function scoreItem(item, atkWeight, defWeight, preferElements, elementBonus) {
  let s = (Number(item.atk) || 0) * (atkWeight || 3) + (Number(item.def) || 0) * (defWeight || 1);
  const want = Array.isArray(preferElements) ? preferElements.filter(Boolean) : (preferElements ? [preferElements] : []);
  if (want.length && item && item.element && want.includes(item.element)) {
    s += Math.max(1, Number(elementBonus) || ELEMENT_BONUS_DEFAULT);
  }
  return s;
}

// Split the page at every .slot-box opening tag and classify the chunk:
// an unequip button → equipped slot; data-equip="1" → a bag item.
function parseInventory(html) {
  const text = String(html || '');
  const chunks = text.split(/<div class="slot-box/i).slice(1);
  const equipped = [];
  const bag = [];
  for (const chunk of chunks) {
    const scope = chunk.slice(0, 3500); // a card never needs more than this
    if (/unequipItem\(\s*(\d+)\s*\)/.test(scope)) {
      const slotId = Number((scope.match(/unequipItem\(\s*(\d+)\s*\)/) || [])[1]);
      const label = scope.match(/<div class="label">\s*([^<]+?)\s*<br>/i);
      const nameM = scope.match(/alt="([^"]+)"/);
      // The label renders "🔪 <span>20</span> ATK · 🛡️ <span>0</span> DEF" —
      // anchor on the span directly before the ATK/DEF keyword ("Lv. 1" sits
      // earlier in the same label and must never be mistaken for ATK).
      const atkM = scope.match(/<span[^>]*>\s*(\d+)\s*<\/span>\s*ATK/i) || scope.match(/(\d+)\s*<\/span>\s*ATK/i) || scope.match(/ATK:\s*(\d+)/i);
      const defM = scope.match(/<span[^>]*>\s*(\d+)\s*<\/span>\s*DEF/i) || scope.match(/(\d+)\s*<\/span>\s*DEF/i) || scope.match(/DEF:\s*(\d+)/i);
      equipped.push({
        slotId,
        slot: label ? label[1].trim().toLowerCase() : (nameM ? nameM[1].trim().toLowerCase() : ''),
        name: nameM ? nameM[1].trim() : '',
        atk: atkM ? Number(atkM[1]) : 0,
        def: defM ? Number(defM[1]) : 0,
      });
      continue;
    }
    if (/data-equip=["']1["']/.test(scope) && /data-inv-id=["'](\d+)["']/.test(scope)) {
      const invId = (scope.match(/data-inv-id=["'](\d+)["']/) || [])[1];
      const type = (scope.match(/data-typee=["']([^"']*)["']/) || [])[1] || '';
      const atk = Number((scope.match(/data-atk=["'](\d+)["']/) || [])[1]) || 0;
      const def = Number((scope.match(/data-def=["'](\d+)["']/) || [])[1]) || 0;
      const nameM = scope.match(/class=["'][^"']*equipment-item-name["'][^>]*>([^<]+)</i) || scope.match(/alt="([^"]+)"/);
      const qtyM = scope.match(/x(\d+)\s*<\/div>/i);
      // The info button's tooltip carries the element ("🌟 Element: NONE" /
      // "🌟 Element: FIRE"). Equipped slots have no data-desc — their element
      // is only known from stats.php's equipment table, so worn items are
      // treated as non-elemental for the counter preference.
      const descM = scope.match(/data-desc="([^"]*)"/);
      const elM = descM ? descM[1].match(/Element:\s*([A-Za-z]+)/) : null;
      bag.push({
        invId,
        type: String(type).toLowerCase().trim(),
        name: nameM ? nameM[1].trim() : '',
        atk, def,
        element: normalizeElement(elM ? elM[1] : null), // null for NONE/unknown
        qty: qtyM ? Number(qtyM[1]) : 1,
      });
    }
  }
  return { equipped, bag };
}

// Best bag item per type family (score desc, name asc as the tiebreak).
function bestByType(bag, atkWeight, defWeight, preferElements, elementBonus) {
  const best = new Map(); // family -> item
  for (const item of bag || []) {
    const fam = slotFamily(item.type);
    if (!fam || !item.invId) continue;
    const cur = best.get(fam);
    if (!cur || scoreItem(item, atkWeight, defWeight, preferElements, elementBonus) > scoreItem(cur, atkWeight, defWeight, preferElements, elementBonus)) {
      best.set(fam, item);
    }
  }
  return best;
}

// The equip POST — the game's own modal body. "OK" is the only success mark.
async function equipItem(game, invId, set) {
  const res = await game.postForm('/inventory_ajax.php', {
    action: 'equip_item',
    inv_id: String(invId),
    slot_id: '0',
    set: String(set || DEFAULT_SET),
  }, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${game.base}/inventory.php?set=${encodeURIComponent(set || DEFAULT_SET)}`,
    },
  });
  const body = String(res.text || '').trim();
  const ok = res.status >= 200 && res.status < 300 && /^OK$/i.test(body);
  return { ok, body: body.slice(0, 120), status: res.status };
}

// Read inventory.php for a set and wear every strictly-better bag item.
// opts.preferElements (array, e.g. damage.counterOf('NATURE') → ['LIGHT','VOID'])
// biases the scoring toward counter-element gear for the mob being hunted.
// Returns { ok, equipped: n, improved: [{slot, from, to, gained}], skipped: [...], notes }.
async function equipBest(game, opts = {}) {
  const set = String(opts.set || DEFAULT_SET);
  const atkWeight = Number(opts.atkWeight) || 3;
  const defWeight = Number(opts.defWeight) || 1;
  const maxEquips = Number(opts.maxEquips) || 8;
  const preferElements = Array.isArray(opts.preferElements)
    ? opts.preferElements.map((e) => normalizeElement(e)).filter(Boolean)
    : (opts.preferElement ? [normalizeElement(opts.preferElement)].filter(Boolean) : []);
  const elementBonus = Number(opts.elementBonus) || ELEMENT_BONUS_DEFAULT;
  const report = { ok: true, set, equipped: 0, preferElements, improved: [], skipped: [], notes: [] };

  const res = await game.get(`/inventory.php?set=${encodeURIComponent(set)}`, { redirect: 'manual' });
  const inv = parseInventory(res.text);
  if (!inv.bag.length && !inv.equipped.length) {
    report.ok = false;
    report.notes.push('inventory page unreadable (logged in?)');
    return report;
  }
  const best = bestByType(inv.bag, atkWeight, defWeight, preferElements, elementBonus);
  // Best worn score per family (two rings → the better one defends its slot).
  const wornBest = new Map();
  for (const e of inv.equipped) {
    const fam = slotFamily(e.slot);
    if (!fam) continue;
    const s = scoreItem(e, atkWeight, defWeight);
    wornBest.set(fam, Math.max(wornBest.get(fam) || 0, s));
  }
  for (const [fam, item] of best.entries()) {
    const worn = wornBest.get(fam) || 0;
    const gain = scoreItem(item, atkWeight, defWeight, preferElements, elementBonus) - worn;
    if (gain <= 0) {
      report.skipped.push({ slot: fam, item: item.name, reason: `worn score ${worn} already ≥ bag score` });
      continue;
    }
    if (report.equipped >= maxEquips) {
      report.skipped.push({ slot: fam, item: item.name, reason: 'per-round equip cap' });
      continue;
    }
    const r = await equipItem(game, item.invId, set);
    if (r.ok) {
      report.equipped++;
      report.improved.push({
        slot: fam,
        from: `score ${worn}`,
        to: `${item.name}${item.element ? ` [${item.element}]` : ''} (score ${scoreItem(item, atkWeight, defWeight, preferElements, elementBonus)})`,
        gained: gain,
      });
      logger.debug(`equip: ${item.name}${item.element ? ` [${item.element}]` : ''} → ${fam} (score +${gain})`);
    } else {
      report.skipped.push({ slot: fam, item: item.name, reason: `equip refused: ${r.body || `HTTP ${r.status}`}` });
    }
    await game.pace(600, 1400);
  }
  if (report.equipped) {
    logger.info(`equip: wore ${report.equipped} upgrade(s) on the ${set} set` +
      (preferElements.length ? ` (counter preference: ${preferElements.join('/')})` : ''));
  }
  return report;
}

module.exports = { parseInventory, bestByType, scoreItem, slotFamily, equipItem, equipBest, DEFAULT_SET };
