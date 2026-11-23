'use strict';
// shop.js — the stamina potion buy-all (port of the Veyra Potion shop /
// "Stamina" tab, HTTP core only). Three shops, the exact requests the game's
// own purchase buttons send:
//
//   Merchant            GET  /merchant.php
//                       cards .card[data-merch-id] carry data-currency,
//                       data-price, data-maxq, data-bought; gold balance in
//                       #goldBalance. Buy: POST /merchant_buy.php
//                       { merch_id, qty } → JSON { status: 'success' }
//   Adventurer's Guild  GET  /adventurers_guild.php
//                       .adv-shop-row: name .adv-shop-item-name, buy button
//                       onclick buyShopItem(<id>), stock "N / M remaining",
//                       price .adv-shop-price; points pill "Your Points".
//                       Buy: POST /adventurers_shop_buy.php { shop_item_id }
//                       → JSON { status: 'ok' }, ONE item per request.
//   Damon's Potion Shop GET  /olympus_damon_buy.php?action=state
//                       JSON { status:'success', gold,
//                              offers:[{key,name,price,weekly_limit,bought,
//                                       remaining,…}] }
//                       Buy: POST /olympus_damon_buy.php { offer, qty }
//
// Gem prices, unlimited-stock and sold-out rows are never bulk-bought — the
// same guard rails the extension applies.
//
// Kinds (POTION_BUY_KINDS, default "stamina,hp,mana"): the merchant carries
// every consumable the hunt ladders drink — Small/Full/Adventurer Stamina
// (stamina), Full HP Potion (hp), Mana Potion S (mana) — and the sweep buys
// each requested kind with the SAME gold budget (stamina first, then hp,
// then mana). Eggs/treats/guild permissions are never bought: no ladder
// drinks them.
const { logger, sleep } = require('./util');

const STAMINA_RE = /stamina/i;
const HP_RE = /hp potion|health potion|healing potion/i;
const MANA_RE = /mana potion/i;

// Which kind a merchant row is (null = never auto-buy).
function kindOf(name) {
  const n = String(name || '').toLowerCase();
  if (MANA_RE.test(n)) return 'mana';
  if (HP_RE.test(n)) return 'hp';
  if (STAMINA_RE.test(n)) return 'stamina';
  return null;
}

function parseKinds(raw) {
  const list = String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : ['stamina', 'hp', 'mana'];
}

function parseNum(s) {
  const n = parseInt(String(s == null ? '' : s).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// ── Merchant ─────────────────────────────────────────────────────────────────
// Chunk the page at each card opening tag so a card's name never leaks from a
// neighbour (same closest-card semantics as combat.parseWaveCards).
// kinds = which potion kinds to include (default stamina+hp+mana; the old
// callers pass nothing → all three, matching the hunt ladders' needs).
function parseMerchant(html, kinds) {
  const text = String(html || '');
  const goldM = text.match(/id="goldBalance"[^>]*>([\d,]+)/i);
  const gold = goldM ? parseInt(goldM[1].replace(/,/g, ''), 10) : 0;
  const lines = [];
  const notes = [];
  const re = /<[^>]*data-merch-id=["'](\d+)["'][^>]*>/gi;
  let m;
  const marks = [];
  while ((m = re.exec(text)) !== null) marks.push({ index: m.index, id: m[1], tag: m[0] });
  for (let i = 0; i < marks.length; i++) {
    const block = text.slice(marks[i].index, i + 1 < marks.length ? marks[i + 1].index : undefined);
    const nameM = block.match(/class=["'][^"']*name["'][^>]*>([^<]+)</i) || block.match(/<h[1-6][^>]*>([^<]+)</i);
    const name = nameM ? nameM[1].trim() : `merch ${marks[i].id}`;
    const kind = kindOf(name);
    if (!kind || !(parseKinds(kinds)).includes(kind)) continue;
    const currency = (block.match(/data-currency=["']([^"']*)["']/i) || [])[1] || '';
    const price = parseNum((block.match(/data-price=["']([^"']*)["']/i) || [])[1]);
    const maxq = parseNum((block.match(/data-maxq=["']([^"']*)["']/i) || [])[1]);
    const bought = parseNum((block.match(/data-bought=["']([^"']*)["']/i) || [])[1]);
    const rem = maxq > 0 ? maxq - bought : 0;
    if (currency && currency.toLowerCase() !== 'gold') { notes.push(`${name}: sold for ${currency}, skipped`); continue; }
    if (maxq <= 0) { notes.push(`${name}: no stock limit, skipped`); continue; }
    if (rem <= 0) { notes.push(`${name}: sold out for today`); continue; }
    const q = price > 0 ? Math.min(rem, Math.floor(gold / price)) : rem;
    if (q < 1) { notes.push(`${name}: ${rem} left, gold too low (${price})`); continue; }
    lines.push({ shop: 'merchant', id: marks[i].id, name, kind, qty: q, price, rem });
  }
  return { gold, lines, notes };
}

async function scanMerchant(game, kinds) {
  const res = await game.get('/merchant.php', { redirect: 'manual' });
  const parsed = parseMerchant(res.text, kinds);
  if (!parsed.gold && !parsed.lines.length && !res.text.includes('data-merch-id')) {
    throw new Error('could not read the merchant page (logged in?)');
  }
  return parsed;
}

async function buyMerchantLine(game, line) {
  const res = await game.postForm('/merchant_buy.php', {
    merch_id: String(line.id),
    qty: String(line.qty),
  });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { /* non-JSON */ }
  const ok = String(json.status || '').trim() === 'success';
  return { ok, message: String(json.message || '').trim() };
}

// ── Adventurer's Guild shop ──────────────────────────────────────────────────
function parseGuildShop(html) {
  const text = String(html || '');
  const section = text.match(/class=["'][^"']*adv-shop-section[^"']*["'][^>]*>([\s\S]*?)(?:class=["'][^"']*adv-shop-section|$)/i);
  const body = section ? section[1] : text;
  const pointsM = body.match(/Your Points[\s\S]{0,240}?<span[^>]*>([\d,]+)/i);
  const points = pointsM ? parseInt(pointsM[1].replace(/,/g, ''), 10) : 0;
  const lines = [];
  const notes = [];
  const rows = body.split(/class=["'][^"']*adv-shop-row[^"']*["']/i);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const nameM = row.match(/class=["'][^"']*adv-shop-item-name[^"']*["'][^>]*>([^<]+)</i);
    const name = nameM ? nameM[1].trim() : `guild item ${i}`;
    if (!STAMINA_RE.test(name)) continue;
    const idM = row.match(/buyShopItem\(\s*(\d+)/i);
    const limitM = row.match(/(\d+)\s*\/\s*(\d+)\s*remaining/i);
    const priceM = row.match(/class=["'][^"']*adv-shop-price[^"']*["'][^>]*>([^<]+)</i);
    const price = parseNum(priceM ? priceM[1] : '0');
    if (!idM) { notes.push(`${name}: sold out`); continue; }
    if (!limitM) { notes.push(`${name}: no stock limit shown, skipped`); continue; }
    const rem = parseInt(limitM[1], 10);
    const q = price > 0 ? Math.min(rem, Math.floor(points / price)) : rem;
    if (q < 1) { notes.push(`${name}: ${rem} left, points too low (${price})`); continue; }
    lines.push({ shop: 'guild', id: idM[1], name, qty: q, price, rem });
  }
  return { points, lines, notes };
}

async function scanGuildShop(game) {
  const res = await game.get('/adventurers_guild.php', { redirect: 'manual' });
  const parsed = parseGuildShop(res.text);
  if (!res.text.includes('adv-shop')) throw new Error('could not find the guild shop on the page');
  return parsed;
}

// One item per request (the game's own buy button sends one at a time).
async function buyGuildLine(game, line, gapMs) {
  let bought = 0;
  let message = '';
  for (let i = 0; i < line.qty; i++) {
    const res = await game.postForm('/adventurers_shop_buy.php', { shop_item_id: String(line.id) });
    let json = {};
    try { json = JSON.parse(res.text); } catch (_) { /* non-JSON */ }
    if (json && json.status === 'ok') {
      bought++;
    } else {
      message = String((json && json.message) || 'purchase failed').trim();
      break;
    }
    await sleep(gapMs);
  }
  return { bought, message };
}

// ── Damon's Potion Shop (Olympus) ────────────────────────────────────────────
async function damonState(game) {
  const res = await game.get('/olympus_damon_buy.php?action=state', {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { /* non-JSON */ }
  if (!json || json.status !== 'success') {
    throw new Error(String((json && json.message) || `could not read Damon's shop (HTTP ${res.status})`));
  }
  return json;
}

function planDamon(state, goldBudget) {
  let left = Number.isFinite(goldBudget) ? goldBudget : parseNum(state.gold);
  const lines = [];
  const notes = [];
  for (const o of state.offers || []) {
    const name = String(o.name || '');
    if (!STAMINA_RE.test(name)) continue;
    const price = parseNum(o.price);
    const weekly = parseNum(o.weekly_limit);
    const bought = parseNum(o.bought);
    if (weekly <= 0) { notes.push(`${name}: no weekly limit, skipped`); continue; }
    const rem = Math.max(0, o.remaining != null ? parseNum(o.remaining) : weekly - bought);
    if (rem <= 0) { notes.push(`${name}: weekly limit reached`); continue; }
    const q = price > 0 ? Math.min(rem, Math.floor(left / price)) : rem;
    if (q < 1) { notes.push(`${name}: ${rem} left this week, gold too low (${price})`); continue; }
    left -= q * price;
    lines.push({ shop: 'damon', id: String(o.key), name, qty: q, price, rem, boughtBefore: bought });
  }
  return { lines, notes };
}

async function buyDamonLine(game, line) {
  const res = await game.postForm('/olympus_damon_buy.php', {
    offer: String(line.id),
    qty: String(line.qty),
  }, { headers: { Accept: 'application/json' } });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { /* non-JSON */ }
  // The reply carries the updated offers — compare bought counts like the
  // extension does (the only honest proof of how many actually landed).
  const after = (json.offers || []).find((o) => String(o.key) === String(line.id));
  const got = after
    ? Math.max(0, parseNum(after.bought) - line.boughtBefore)
    : (json.status === 'success' ? line.qty : 0);
  return { ok: got > 0, got, message: String(json.message || '').trim() };
}

// ── Orchestrator: sweep every shop, Merchant gold budget first ───────────────
// Returns a summary the worker can audit:
//   { bought, spent, merchant:{bought,spent,…}, guild:{…}, damon:{…}, notes[] }
async function buyAllStaminaPotions(game, opts = {}) {
  const gapMs = opts.fastTest ? 5 : 180;
  const kinds = parseKinds(opts.kinds || 'stamina,hp,mana');
  const summary = {
    bought: 0,
    spent: 0,
    merchant: { attempted: 0, bought: 0, spent: 0 },
    guild: { attempted: 0, bought: 0, spent: 0 },
    damon: { attempted: 0, bought: 0, spent: 0 },
    notes: [],
  };

  // 1) Merchant (gold) — the extension's scan→buy with the running budget.
  // The page snapshot's gold goes stale the moment the first line lands, so
  // every line is re-aimed at the RUNNING budget before its POST: the game
  // answers "not enough gold" for short buys and the sweep would stop early
  // (a later, cheaper kind would never be tried).
  let goldLeft = null;
  try {
    const merch = await scanMerchant(game, kinds);
    goldLeft = merch.gold;
    summary.notes.push(...merch.notes);
    for (const line of merch.lines) {
      if (goldLeft != null && line.price > 0) {
        const affordable = Math.floor(goldLeft / line.price);
        if (affordable < 1) {
          summary.notes.push(`merchant: ${line.name}: skipped, gold left ${goldLeft} < price ${line.price}`);
          continue;
        }
        if (affordable < line.qty) line.qty = affordable;
      }
      summary.merchant.attempted += line.qty;
      const r = await buyMerchantLine(game, line);
      if (r.ok) {
        summary.merchant.bought += line.qty;
        summary.merchant.spent += line.qty * line.price;
        if (goldLeft != null) goldLeft -= line.qty * line.price;
      } else {
        summary.notes.push(`merchant: ${line.name}: ${r.message}`);
        if (/not enough/i.test(r.message)) break;
      }
    }
  } catch (e) {
    summary.notes.push(`merchant: ${e.message}`);
  }

  // 2) Guild shop (points, one per call).
  try {
    const guild = await scanGuildShop(game);
    summary.notes.push(...guild.notes);
    for (const line of guild.lines) {
      summary.guild.attempted += line.qty;
      const r = await buyGuildLine(game, line, gapMs);
      summary.guild.bought += r.bought;
      summary.guild.spent += r.bought * line.price;
      if (r.message) summary.notes.push(`guild: ${line.name}: ${r.message}`);
      if (r.bought < line.qty) break;
    }
  } catch (e) {
    summary.notes.push(`guild: ${e.message}`);
  }

  // 3) Damon — fresh state (the merchant may have just spent the gold).
  try {
    const state = await damonState(game);
    const plan = planDamon(state, goldLeft != null ? goldLeft : undefined);
    summary.notes.push(...plan.notes);
    for (const line of plan.lines) {
      summary.damon.attempted += line.qty;
      const r = await buyDamonLine(game, line);
      summary.damon.bought += r.got;
      summary.damon.spent += r.got * line.price;
      if (!r.ok || r.got < line.qty) {
        if (r.message) summary.notes.push(`damon: ${line.name}: ${r.message}`);
        break;
      }
    }
  } catch (e) {
    summary.notes.push(`damon: ${e.message}`);
  }

  summary.bought = summary.merchant.bought + summary.guild.bought + summary.damon.bought;
  summary.spent = summary.merchant.spent + summary.guild.spent + summary.damon.spent;
  logger.debug(`shop: bought ${summary.bought} stamina potions (spent ${summary.spent})`);
  return summary;
}

// ── Auto-battle potion caps (the LevelUp Looter's post-level-up step) ────────
// The wave page carries a "Max Large/Full Stamina Potions to use" setting
// (the auto-battle's per-fight potion budget, shown as "Used: N" next to a
// number input and a Save button). After a level-up the engine can raise it
// so the in-game auto-battle may drink more per fight.
//
// HTTP flow (the DOM script clicks save; we speak the form directly):
//   GET the wave page → find the form block whose text matches the kind
//   (max large stamina pot… / max full stamina pot…) → read the number input's
//   name + current value → POST the form's action with ALL its fields
//   (hidden ones included), the target field bumped by `amount`.
const FSP_RE = /max\s+full\s+stamina\s+pot(?:ion)?s?\s+to\s+use|full\s+stam(?:ina)?\s+pots?/i;
const LSP_RE = /max\s+large\s+stamina\s+pot(?:ion)?s?\s+to\s+use|large\s+stam(?:ina)?\s+pots?/i;

function parsePotionCapForm(html, kind) {
  const text = String(html || '');
  const labelRe = kind === 'fsp' ? FSP_RE : LSP_RE;
  // Candidate form blocks (anything that carries the label and an input).
  const formM = text.match(/<form[^>]*>[\s\S]{0,3000}?<\/form>/gi) || [text];
  for (const block of formM) {
    if (!labelRe.test(block)) continue;
    const actionM = block.match(/action=["']([^"']+)["']/i);
    // The FIRST number input AFTER this kind's label (each label row carries
    // its own input — LSP row then FSP row on the real page).
    const labelM = labelRe.exec(block);
    const after = block.slice(labelM.index + labelM[0].length);
    const inputM = after.match(/<input[^>]*name=["']([^"']+)["'][^>]*value=["'](\d+)["'][^>]*>/i);
    if (!inputM) continue;
    const pick = { name: inputM[1], value: parseInt(inputM[2], 10) || 0 };
    // Hidden fields ride along (csrf tokens etc.).
    const hidden = {};
    const hidRe = /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
    let hm;
    while ((hm = hidRe.exec(block)) !== null) hidden[hm[1]] = hm[2];
    const hidRe2 = /<input[^>]*value=["']([^"']*)["'][^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
    while ((hm = hidRe2.exec(block)) !== null) hidden[hm[2]] = hm[1];
    return { action: actionM ? actionM[1] : '/active_wave.php', field: pick.name, currentValue: pick.value, hidden };
  }
  return null;
}

async function raiseAutoBattlePotionCap(game, kind, amount, wavePath) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (n <= 0) return { ok: false, reason: 'amount_zero' };
  const path = wavePath || (game.cfg && game.cfg.wavePages && game.cfg.wavePages[0] && game.cfg.wavePages[0].path) || 'gate=3&wave=3';
  const res = await game.get(`/active_wave.php?${path}`, { redirect: 'manual' });
  const form = parsePotionCapForm(res.text, kind);
  if (!form) return { ok: false, reason: 'setting_not_found' };
  const fields = { ...form.hidden };
  fields[form.field] = String(form.currentValue + n);
  // The form posts back to the wave page itself (action attr when present).
  const target = form.action && form.action.includes('active_wave.php')
    ? form.action.replace(/^\//, '/')
    : `/active_wave.php?${path}`;
  const post = await game.postForm(`${target}${target.includes('?') ? '&' : '?'}_t=${Date.now()}`, fields, {
    headers: { Referer: `${game.base}/active_wave.php?${path}` },
  });
  const ok = post.status >= 200 && post.status < 300
    && !/invalid|error|failed|not found/i.test(String(post.text || '').slice(0, 300));
  logger.debug(`shop: potion cap ${kind} +${n} → ${form.field}=${fields[form.field]} (HTTP ${post.status})`);
  return { ok, field: form.field, from: form.currentValue, to: form.currentValue + n };
}

module.exports = {
  STAMINA_RE,
  HP_RE,
  MANA_RE,
  kindOf,
  parseKinds,
  parseMerchant,
  scanMerchant,
  buyMerchantLine,
  parseGuildShop,
  scanGuildShop,
  buyGuildLine,
  damonState,
  planDamon,
  buyDamonLine,
  buyAllStaminaPotions,
  parsePotionCapForm,
  raiseAutoBattlePotionCap,
};
