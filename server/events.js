'use strict';
// events.js — the Dragon Realm event dailies (and any future event that
// ships the same sanctuary panel), which the farm completely missed:
//
//   The dashboard links live events as /event_page.php?event=N. Each event
//   page embeds "panelUrl":"/event_page.php?event=N&map=M" — the JSON panel
//   API base. panel=sanctuary:board is the Fountain Noticeboard: TEN daily
//   contracts, rewards reset at server midnight (Dragon Silver / Gold /
//   Dragoncall Coins):
//
//     • Hunting / damage contracts — progress accrues from MANUAL hits and
//       MANUAL loots ("Auto-Farm and Auto-Loot do not count"). The engine
//       joins + slashes every mob itself (never the game's auto-farm) and,
//       since the waveLootKills hook, loots each kill the way the game's own
//       Loot button does — so these contracts fill in the background. The
//       board is read for the progress feed and audited.
//     • Supply contracts — "Deliver 5 X. Items are consumed on turn-in."
//       No claim form on the board; turn-in happens at the NPC with items in
//       the bag — skipped (spends items, needs inventory mapping).
//     • Dispatch contracts — a roleplay choice ("What makes the rescue
//       complete?") rendered as forms [{action:'sc_daily', hidden:{quest,
//       day, answer}}]. Submitting ONE choice completes the contract for
//       that day; every option is a valid answer. The engine submits the
//       first form, once per quest+day (the hidden fields are re-read from
//       the board each run, so a new day re-arms automatically).
//
// The POST mirrors the game's own sanctuary.js: POST to the panel URL with
// {action, ...hidden, revision, request, csrf} and Accept: application/json
// (revision = the board's revision const, request = a random 32-byte hex
// idempotency key; missing either → "Invalid action. Reload this page.").
// Anything that 404s or answers non-JSON ("No Battle Pass season
// available") is a clean no-op — events rotate, absence is normal.
const { logger } = require('./util');
const crypto = require('crypto');

// Live event ids from the dashboard's event cards.
function parseEventIds(html) {
  const ids = [];
  for (const m of String(html || '').matchAll(/event_page\.php\?event=(\d+)/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// "panelUrl":"/event_page.php?event=13\u0026map=23" — decode JSON escapes.
function parsePanelUrl(html) {
  const m = String(html || '').match(/"panelUrl"\s*:\s*"([^"]+)"/i);
  if (!m) return null;
  return m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

async function fetchJson(game, pathname) {
  const res = await game.get(pathname, { redirect: 'manual', headers: { Accept: 'application/json' } });
  let json = null;
  try { json = JSON.parse(res.text); } catch (_) { return null; }
  return json;
}

// Flatten the board into a progress feed + the submit-ready dispatch forms.
function parseBoard(json) {
  const panel = json && json.panel;
  if (!panel) return null;
  const cards = (panel.cards || []).map((c) => ({
    title: c.title || '',
    label: c.label || '',
    progress: Number(c.progress) || 0,
    forms: (c.forms || []).filter((f) => f && f.action),
  }));
  return {
    title: panel.title || '',
    note: String(panel.note || '').slice(0, 240),
    wallet: Number(panel.wallet) || 0,
    csrf: panel.csrf || null,
    // revision + request ride along on every sc_* POST (the game's own
    // sanctuary.js sends revision: String(panel.revision) and a random
    // 32-byte hex request id; missing either → "Invalid action.").
    revision: String(panel.revision != null ? panel.revision : 0),
    cards,
    // Board-level forms exist on some views; submit those too.
    forms: (panel.forms || []).filter((f) => f && f.action),
  };
}

// Submit one dispatch form — the game's own sc_daily POST: the form's
// hidden fields (quest/day/answer), the action, the panel revision, a
// random request id (the game's idempotency key) and the csrf — exactly
// what sanctuary.js builds in pending.body before post(current,panel,body).
async function submitForm(game, panelUrl, form, csrf, revision) {
  const body = {
    ...(form.hidden || {}),
    action: form.action,
    revision: String(revision != null ? revision : 0),
    request: crypto.randomBytes(32).toString('hex'),
    csrf,
  };
  const res = await game.postForm(panelUrl, body, { headers: { Accept: 'application/json' } });
  let json = {};
  try { json = JSON.parse(res.text); } catch (_) { json = { _raw: String(res.text || '').slice(0, 120) }; }
  const ok = json.status === 'ok' || json.status === 'success';
  return { ok, message: String(json.message || json._raw || '').slice(0, 160) };
}

// One event-dailies round for one event id. Reads the board, submits every
// ready dispatch contract, returns the progress feed for the dashboard.
async function eventRound(game, eventId) {
  const report = { id: eventId, panelUrl: null, board: null, submitted: [], notes: [] };
  let html = '';
  try {
    const res = await game.get(`/event_page.php?event=${eventId}`, { redirect: 'manual' });
    html = res.text || '';
  } catch (e) {
    report.notes.push(`event page failed: ${e.message}`);
    return report;
  }
  const panelUrl = parsePanelUrl(html);
  report.panelUrl = panelUrl;
  if (!panelUrl) {
    report.notes.push('no panel API on this event page');
    return report;
  }
  const json = await fetchJson(game, `${panelUrl}&panel=sanctuary:board`);
  if (!json || json.status !== 'ok' || !json.panel) {
    report.notes.push('no daily board (event inactive or panel absent)');
    return report;
  }
  const board = parseBoard(json);
  report.board = { title: board.title, note: board.note, wallet: board.wallet, cards: board.cards };
  if (!board.csrf) {
    report.notes.push('board has no csrf');
    return report;
  }

  // Dispatch contracts: one choice per quest+day, first form wins. A quest
  // id may render several valid answers — submitting more than one would
  // bounce "already submitted", so dedupe on the hidden quest field.
  const forms = [];
  const seenQuests = new Set();
  for (const card of board.cards) {
    for (const f of card.forms) {
      if (!/^sc_/.test(f.action)) continue;
      const key = (f.hidden && (f.hidden.quest != null ? `q:${f.hidden.quest}` : null))
        || `a:${f.action}:${card.title}`;
      if (seenQuests.has(key)) continue;
      seenQuests.add(key);
      forms.push({ from: card.title, form: f });
    }
  }
  forms.push(...board.forms.map((f) => ({ from: board.title, form: f })));
  for (const { from, form } of forms) {
    await game.pace(700, 1600);
    try {
      const r = await submitForm(game, panelUrl, form, board.csrf, board.revision);
      report.submitted.push({ action: form.action, quest: form.hidden && form.hidden.quest, from, ok: r.ok, message: r.message });
      if (!r.ok) break; // a lock/refusal means the rest will refuse too
    } catch (e) {
      report.submitted.push({ action: form.action, from, ok: false, message: e.message });
      break;
    }
  }
  logger.debug(`events: event ${eventId} — ${report.submitted.length} dispatch forms handled`);
  return report;
}

// Discover live events from the dashboard and run each one.
async function eventDailiesRound(game) {
  let dash;
  try {
    dash = await game.get('/game_dash.php', { redirect: 'manual' });
  } catch (e) {
    return { events: [], notes: [`dashboard failed: ${e.message}`] };
  }
  const ids = parseEventIds(dash.text);
  const out = { events: [], notes: [] };
  for (const id of ids.slice(0, 4)) {
    await game.pace(900, 2000);
    try {
      out.events.push(await eventRound(game, id));
    } catch (e) {
      out.notes.push(`event ${id}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { parseEventIds, parsePanelUrl, parseBoard, submitForm, eventRound, eventDailiesRound };
