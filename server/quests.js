'use strict';
// quests.js — the Adventurers Guild contract board (adventurers_guild.php),
// which the farm ignored outside of potion shopping:
//
//   • Available contracts render as .quest-row cards with an
//     "Accept quest" button (onclick="acceptQuest(ID);"), an objective line
//     ("Kill 5 monster(s) · Monster: Lizardman Shadowclaw · min 3m dmg",
//     "Gather 2x item(s) · Item: Goblin Essence", "Use 20 skills…") and a
//     reward line ("100 AP • 10,000 Gold").
//   • ONE contract at a time: the game refuses a second accept with
//     "Finish or abandon your current quest first."
//   • The active contract shows Progress: X / Y plus a Give up button while
//     running; when the objective is met the same slot renders
//     finishQuest(ID) (turn in) — POST adventurers_finish_quest.php.
//   • Gather contracts may offer Donate buttons — donateGatherItem(quest,
//     itemId) → POST adventurers_donate_gather.php {quest_id, item_id};
//     the item is consumed from the inventory.
//
// The engine's wave farming supplies the kills, so kill contracts complete
// themselves: accept → farm → finish → collect. Gather contracts are only
// turned in when the donate button actually renders (i.e. the item is
// owned), and donating needs QUESTS_DONATE=1 (off by default — the item
// might be worth keeping).
//
// ── requirement parsing (2026-11 board) ──────────────────────────────────
// Kill contracts carry a PER-KILL minimum damage the board states right in
// the objective line:
//   "Kill 5 monster(s) · Monster: Lizardman Shadowclaw · min 3m dmg"
//   "Kill 5 monster(s) · Monster: Troll Ravager · min 3m dmg"
// A kill only COUNTS when the mob died with ≥ that much of YOUR damage on
// it — so the parser reads the monster name + "min <n>[kmb] dmg" out of the
// objective and the worker feeds it to the combat engines as the per-mob
// damage floor (see combat.minDamageFor / the wave + dungeon fights).
const { logger } = require('./util');

// "3m" → 3,000,000 · "500k" → 500,000 · "1.5b" → 1,500,000,000 · "1234" → 1234
// Commas are welcome (the ACTIVE contract's objective spells the number out:
// "min 3,000,000 dmg").
function parseDamageShorthand(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  // Commas are thousand separators here ("3,000,000"); a dot is a decimal
  // point ("1.5b").
  const s = String(v || '').trim().toLowerCase().replace(/[\s_,]/g, '');
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1;
  return Math.floor(parseFloat(m[1]) * mult);
}

// Objective line → {kind, kills, monster, minDamage} | {kind:'skill', skills}
// | {kind:'gather', item, count} | null.
// Two shapes are parsed:
//   available row: "Kill 5 monster(s) · Monster: Lizardman Shadowclaw · min 3m dmg"
//   ACTIVE row:    "Kill 5 monster(s) · min 3,000,000 dmg"  (monster gone)
// The active shape dropped the monster name — the row's description carries
// it ("Kill 5 Lizardman Shadowclaws while dealing at least 3m damage to
// each"), so a description form is parsed too and rowRequirement falls back
// to it.
function parseRequirement(objective) {
  const obj = String(objective || '').replace(/\s+/g, ' ').trim();
  if (!obj) return null;
  let m = obj.match(/^kill\s+([\d,]+)\s+monster/i);
  if (m) {
    const req = { kind: 'kill', kills: parseInt(m[1].replace(/,/g, ''), 10) || 0, monster: null, minDamage: 0 };
    const mm = obj.match(/monster:\s*([\w '\-]+?)(?:\s*·|$)/i);
    if (mm) req.monster = mm[1].trim().toLowerCase();
    const dm = obj.match(/min\s+([\d,.]+\s*[kmb]?)\s*dmg/i);
    if (dm) req.minDamage = parseDamageShorthand(dm[1]);
    return req;
  }
  // Description form: "Huge numbers of Lizardman Shadowclaws are pouring out
  // of the gate. Kill 5 Lizardman Shadowclaws while dealing at least 3m
  // damage to each" — the kill sentence sits mid-prose, the name runs to the
  // while/and/comma boundary and the prose plural ("Shadowclaws") is trimmed
  // to the mob's real name.
  m = obj.match(/kill\s+([\d,]+)\s+([\w '\-]+?)(?:\s+while|\s+and\b|,|\s+—)[\s\S]{0,220}?([\d,.]+\s*[kmb]?)\s*damage/i);
  if (m) {
    let name = m[2].trim().toLowerCase().replace(/\s+/g, ' ');
    if (name.endsWith('s') && !name.endsWith('ss')) name = name.slice(0, -1);
    return {
      kind: 'kill',
      kills: parseInt(m[1].replace(/,/g, ''), 10) || 0,
      monster: name,
      minDamage: parseDamageShorthand(m[3]),
    };
  }
  m = obj.match(/^use\s+([\d,]+)\s+skill/i);
  if (m) return { kind: 'skill', skills: parseInt(m[1].replace(/,/g, ''), 10) || 0 };
  m = obj.match(/^gather\s+([\d,]+)x?\s*item/i);
  if (m) {
    const req = { kind: 'gather', count: parseInt(m[1].replace(/,/g, ''), 10) || 0, item: null };
    const im = obj.match(/item:\s*([\w '\-]+?)(?:\s*·|$)/i);
    if (im) req.item = im[1].trim().toLowerCase();
    return req;
  }
  return null;
}

// Split the quest list at .quest-row boundaries and classify each row.
function parseQuestRows(html) {
  const text = String(html || '');
  const re = /<div[^>]*class=["'][^"']*quest-row[^"']*["'][^>]*>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : undefined);
    const title = (chunk.match(/class=["'][^"']*quest-main-title[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/div>/i) || [])[1];
    const desc = (chunk.match(/class=["'][^"']*quest-main-desc[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/div>/i) || [])[1];
    const objective = (chunk.match(/class=["'][^"']*quest-req-text[^"']*["'][^>]*>\s*([\s\S]*?)\s*<\/span>/i) || [])[1];
    const reward = (chunk.match(/class=["'][^"']*quest-reward["'][^>]*>\s*([\s\S]*?)\s*<\/div>/i) || [])[1];
    const rank = (chunk.match(/quest-tag[^>]*>\s*Rank:?\s*([^<]+)</i) || [])[1];
    const progressM = chunk.match(/class=["'][^"']*quest-progress[^"']*["'][^>]*>[\s\S]{0,120}?([\d,]+)\s*\/\s*([\d,]+)/i);
    const clean = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    const row = {
      title: clean(title),
      objective: clean(objective),
      desc: clean(desc),
      reward: clean(reward),
      rank: clean(rank),
      progress: progressM ? { cur: parseInt(progressM[1].replace(/,/g, ''), 10), max: parseInt(progressM[2].replace(/,/g, ''), 10) } : null,
      acceptId: null, finishId: null, giveUpId: null, donateIds: [],
    };
    for (const mm of chunk.matchAll(/acceptQuest\((\d+)/g)) row.acceptId = mm[1];
    for (const mm of chunk.matchAll(/finishQuest\((\d+)/g)) row.finishId = mm[1];
    for (const mm of chunk.matchAll(/giveUpQuest\((\d+)/g)) row.giveUpId = mm[1];
    for (const mm of chunk.matchAll(/donateGatherItem\((\d+),\s*(\d+)/g)) {
      row.donateIds.push({ questId: mm[1], itemId: mm[2] });
    }
    if (row.acceptId || row.finishId || row.giveUpId || row.donateIds.length) rows.push(row);
  }
  return rows;
}

// Active contract = the row with a Give up / Finish / Donate control.
// Available contracts = rows with an Accept button.
function classify(rows) {
  const active = rows.find((r) => r.finishId || r.giveUpId || r.donateIds.length) || null;
  const available = rows.filter((r) => r.acceptId);
  return { active, available };
}

function isKillQuest(row) {
  return /^kill\b/i.test(row.objective || '') || /^use\b/i.test(row.objective || '');
}

// A row's parsed requirement — kill/skill contracts ride the farm, gather
// contracts need inventory items. The ACTIVE row's objective drops the
// monster name ("Kill 5 monster(s) · min 3,000,000 dmg"), so the row's
// description ("Kill 5 Lizardman Shadowclaws while dealing at least 3m…")
// fills it in — the restart-mid-contract case keeps the floor armed.
function rowRequirement(row) {
  let req = parseRequirement(row.objective);
  if (req && req.kind === 'kill' && !req.monster && row.desc) {
    const fromDesc = parseRequirement(row.desc);
    if (fromDesc && fromDesc.kind === 'kill' && fromDesc.monster) {
      req = {
        ...req,
        monster: fromDesc.monster,
        minDamage: req.minDamage || fromDesc.minDamage,
      };
    }
  }
  if (!req || req.kind === 'gather') return null;
  return req; // kill + skill contracts are actionable by farming
}

async function acceptQuest(game, questId) {
  const res = await game.postForm('/adventurers_accept_quest.php', { quest_id: String(questId) });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
  const ok = json.status === 'ok';
  return { ok, message: String(json.message || json._raw || '').slice(0, 160) };
}

async function finishQuest(game, questId) {
  const res = await game.postForm('/adventurers_finish_quest.php', { quest_id: String(questId) });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
  const ok = json.status === 'ok';
  return { ok, message: String(json.message || json._raw || '').slice(0, 160) };
}

async function donateGather(game, questId, itemId) {
  const res = await game.postForm('/adventurers_donate_gather.php', {
    quest_id: String(questId),
    item_id: String(itemId),
  });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
  const ok = json.status === 'ok';
  return { ok, message: String(json.message || json._raw || '').slice(0, 160) };
}

// One guild-contract round:
//   1. Finish a completed active contract (turn in, collect AP/gold).
//   2. Donate toward an active gather contract — only when the game itself
//      rendered a Donate button (item owned) and QUESTS_DONATE=1.
//   3. Accept the next contract when idle. Kill/skill contracts first —
//      the wave farm completes those without any extra work. Gather
//      contracts are accepted only as a last resort (they stall the slot
//      until the items drop or the player donates by hand).
async function guildQuestRound(game, opts = {}) {
  const donateEnabled = opts.donate !== false;
  const acceptEnabled = opts.accept !== false;
  const report = { active: null, available: 0, finished: null, donated: [], accepted: null, notes: [] };
  let html = '';
  try {
    const res = await game.get('/adventurers_guild.php', { redirect: 'manual' });
    html = res.text || '';
  } catch (e) {
    report.notes.push(`guild page failed: ${e.message}`);
    return report;
  }
  const { active, available } = classify(parseQuestRows(html));
  report.available = available.length;
  if (active) {
    report.active = { id: active.finishId || active.giveUpId || (active.donateIds[0] && active.donateIds[0].questId) || null,
      title: active.title, objective: active.objective, progress: active.progress };
    const req = rowRequirement(active);
    if (req) report.requirement = { ...req, title: active.title };
  }

  // 1. Turn in a completed contract.
  if (active && active.finishId) {
    await game.pace(600, 1400);
    const r = await finishQuest(game, active.finishId);
    report.finished = { id: active.finishId, title: active.title, ok: r.ok, message: r.message };
    // The page changed — the next round picks a fresh contract.
    return report;
  }

  // 2. Donate toward a gather contract (each Donate button = one owned item).
  if (active && active.donateIds.length && donateEnabled) {
    for (const d of active.donateIds) {
      await game.pace(600, 1400);
      try {
        const r = await donateGather(game, d.questId, d.itemId);
        report.donated.push({ questId: d.questId, itemId: d.itemId, ok: r.ok, message: r.message });
        if (!r.ok) break; // one refusal means the rest will refuse too
      } catch (e) {
        report.donated.push({ questId: d.questId, itemId: d.itemId, ok: false, message: e.message });
        break;
      }
    }
    return report;
  }

  // 3. Idle → accept the next contract. Kill/skill quests ride the wave farm;
  //    gather quests need inventory items, so they go last.
  if (!active && acceptEnabled && available.length) {
    const sorted = [...available].sort((a, b) => Number(isKillQuest(b)) - Number(isKillQuest(a)));
    const pick = sorted[0];
    await game.pace(600, 1400);
    const r = await acceptQuest(game, pick.acceptId);
    report.accepted = { id: pick.acceptId, title: pick.title, objective: pick.objective, ok: r.ok, message: r.message };
    const req = rowRequirement(pick);
    if (req) report.requirement = { ...req, title: pick.title };
    if (!r.ok) report.notes.push(r.message);
  }
  return report;
}

module.exports = { parseQuestRows, classify, isKillQuest, parseRequirement, parseDamageShorthand, rowRequirement, acceptQuest, finishQuest, donateGather, guildQuestRound };
