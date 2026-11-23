'use strict';
// blacksmith.js — craft equipment from the materials wave hunting drops.
//
// The blacksmith page (blacksmith.php?gate=N) renders one .card per recipe:
//   info-btn  data-name / data-attack / data-defense / data-element
//   .reqs     .req[title="material name"] + .qty good|bad → "have/need"
//   .forge    <form method="POST" action="craft_item.php">
//               <input name="recipe_id" value="38">
//               <button class="forge-btn" [disabled]>Forge</button>
// Gates: 3 = Grakthar · 5 = Olympus · 0 = Events. The disabled Forge button
// (or any .qty.bad req) means the materials are not there yet — the crafter
// only ever POSTs recipes the page itself calls craftable, so the engine can
// never waste materials on a half-met recipe.
//
// Craft: POST /craft_item.php { recipe_id } — the reply is a full page, so
// success is read from its markers ("forged", "crafted", "success") vs error
// text ("not enough", "missing", "cannot", "error").
const { logger } = require('./util');

const CRAFT_GATES = [
  { gate: 3, label: 'Grakthar' },
  { gate: 5, label: 'Olympus' },
  { gate: 0, label: 'Events' },
];

function parseBlacksmithRecipes(html, gateLabel) {
  const text = String(html || '');
  const cards = text.split(/<div class="card/i).slice(1);
  const recipes = [];
  for (const card of cards) {
    const scope = card.slice(0, 6000);
    const idM = scope.match(/name=["']recipe_id["']\s+value=["'](\d+)["']/i)
      || scope.match(/value=["'](\d+)["']\s+name=["']recipe_id["']/i);
    if (!idM) continue;
    const nameM = scope.match(/data-name=["']([^"']+)["']/i) || scope.match(/class=["'][^"']*result-name["'][^>]*>([^<]+)</i);
    const atkM = scope.match(/data-attack=["'](\d+)["']/i) || scope.match(/Attack:\s*(\d+)/i);
    const defM = scope.match(/data-defense=["'](\d+)["']/i) || scope.match(/Defense:\s*(\d+)/i);
    // Requirement rows: title="material" ... class="qty good|bad">have/need<
    const reqs = [];
    const reqRe = /class=["']req[^"']*["'][^>]*title=["']([^"']+)["'][\s\S]{0,600}?class=["']qty\s+(good|bad)["'][^>]*>\s*(\d+)\s*\/\s*(\d+)/gi;
    let rm;
    while ((rm = reqRe.exec(scope)) !== null) {
      reqs.push({ name: rm[1].trim(), have: Number(rm[3]), need: Number(rm[4]), ok: rm[2] === 'good' });
    }
    const forgeBtn = scope.match(/class=["'][^"']*forge-btn[^"']*["'][^>]*>/i);
    const disabled = !!(forgeBtn && /\bdisabled\b/i.test(forgeBtn[0]));
    const craftable = !disabled && reqs.length > 0 && reqs.every((r) => r.ok);
    recipes.push({
      id: idM[1],
      name: nameM ? nameM[1].trim() : `recipe ${idM[1]}`,
      atk: atkM ? Number(atkM[1]) : 0,
      def: defM ? Number(defM[1]) : 0,
      gate: gateLabel || '',
      reqs,
      craftable,
      disabled,
    });
  }
  return recipes;
}

// Sweep every gate; the farm's materials come from all three.
async function scanBlacksmith(game) {
  const recipes = [];
  for (const g of CRAFT_GATES) {
    const res = await game.get(`/blacksmith.php?gate=${g.gate}`, { redirect: 'manual' });
    const found = parseBlacksmithRecipes(res.text, g.label);
    recipes.push(...found);
    await game.pace(700, 1500);
  }
  return recipes;
}

async function craftRecipe(game, recipeId) {
  const res = await game.postForm('/craft_item.php', { recipe_id: String(recipeId) }, {
    headers: { Referer: `${game.base}/blacksmith.php` },
  });
  const body = String(res.text || '');
  const head = body.slice(0, 4000);
  const okRe = /forged|successfully (?:forged|crafted|created)|craft(?:ed|ing)? success|you (?:created|crafted)/i;
  const errRe = /not enough|insufficient|missing (?:materials|items)|cannot (?:be )?(?:craft|forge)|failed|error/i;
  const httpOk = res.status >= 200 && res.status < 300;
  if (errRe.test(head)) {
    const msg = (head.match(/[^<>]{0,120}(?:not enough|insufficient|missing|cannot|failed|error)[^<>]{0,120}/i) || ['craft refused'])[0].trim();
    return { ok: false, message: msg.slice(0, 160), status: res.status };
  }
  return { ok: httpOk, message: okRe.test(head) ? 'forged' : `no explicit marker (HTTP ${res.status})`, status: res.status };
}

// One craft sweep: scan all gates, craft every craftable recipe (highest
// attack score first — the farm hunts with damage), capped per sweep.
async function blacksmithRound(game, opts = {}) {
  const maxCrafts = Number(opts.maxCrafts) || 4;
  const report = { scanned: 0, craftable: 0, crafted: [], refused: [], notes: [] };
  const recipes = await scanBlacksmith(game);
  report.scanned = recipes.length;
  const ready = recipes.filter((r) => r.craftable)
    .sort((a, b) => (b.atk * 3 + b.def) - (a.atk * 3 + a.def) || String(a.name).localeCompare(String(b.name)));
  report.craftable = ready.length;
  report.recipes = recipes.map((r) => ({ id: r.id, name: r.name, gate: r.gate, craftable: r.craftable, reqs: r.reqs.length, atk: r.atk, def: r.def }));
  for (const r of ready.slice(0, maxCrafts)) {
    const res = await craftRecipe(game, r.id);
    if (res.ok) {
      report.crafted.push({ id: r.id, name: r.name, message: res.message });
      logger.info(`blacksmith: forged ${r.name} (recipe ${r.id}) — ${res.message}`);
    } else {
      report.refused.push({ id: r.id, name: r.name, message: res.message });
      logger.warn(`blacksmith: recipe ${r.id} (${r.name}) refused: ${res.message}`);
    }
    await game.pace(800, 1600);
  }
  return report;
}

module.exports = { CRAFT_GATES, parseBlacksmithRecipes, scanBlacksmith, craftRecipe, blacksmithRound };
