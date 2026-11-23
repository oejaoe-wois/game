'use strict';
// guilds.js — guild auto-join ("accept guilds"): put a guild-less account
// into the guild its panel code names, so the fleet shares guild dungeons,
// contracts and the AP loop.
//
// Live-verified flow (2026-11-23, pages saved under scripts/guild-join-probe/):
//
//   GET  /guild_join_create.php              the directory ("The guild
//                                            registry") — .gd-card rows:
//                                            badge ("Open recruitment" /
//                                            "Application" / "Full"), tag,
//                                            name, "N / M members".
//                                            GET ?q=<term> narrows the list.
//   GET  /guild_join_create.php?guild_id=N   the detail page. A guild-less
//                                            viewer on a joinable guild gets
//                                            ONE .gd-action-form:
//                                              csrf, form_id, guild_id,
//                                              action=join_open  (+button
//                                              "Join this guild")   → instant
//                                              action=apply      (+optional
//                                              "answers" textarea ≤1000 chars,
//                                              button "Send application") →
//                                              leader approves later
//                                            A FULL guild renders NO form plus
//                                            "This guild is currently full."
//                                            A MEMBER sees only the member
//                                            search form (no csrf form).
//   POST /guild_join_create.php?guild_id=N   {csrf, form_id, guild_id,
//                                            action, answers?} — the game
//                                            answers with the refreshed page.
//
// Verification is authoritative, never cosmetic: after a successful POST the
// engine re-probes guild_dash.php (dungeons.fetchOwnGuild) — the dash is the
// game's own answer to "what guild am I in".
const { logger } = require('./util');
const dungeons = require('./dungeons');

// ── parsers ───────────────────────────────────────────────────────────────────
// "Open recruitment" → open · "Application" → application · "Full" → full ·
// anything else → closed (invite-only, hidden, whatever the game invents).
function normalizeMode(badge) {
  const b = String(badge || '').toLowerCase();
  if (b.includes('open recruitment')) return 'open';
  if (b.includes('application')) return 'application';
  if (b.includes('full')) return 'full';
  return 'closed';
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

// One directory card: badge, tag, name, capacity, guild id.
function parseGuildCard(chunk) {
  const badgeM = chunk.match(/class="gd-badge">([^<]+)</);
  const tagM = chunk.match(/class="gd-tag">\s*\[?([A-Z0-9]{1,8})\]?\s*</);
  const nameM = chunk.match(/<h2>\s*<a[^>]*guild_join_create\.php\?guild_id=(\d+)[^>]*>([\s\S]*?)<\/a>/);
  const capM = chunk.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*members/);
  if (!nameM) return null;
  const num = (s) => Number(String(s || '').replace(/,/g, '')) || 0;
  return {
    guildId: Number(nameM[1]),
    name: nameM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    tag: tagM ? tagM[1] : null,
    mode: normalizeMode(badgeM ? badgeM[1] : ''),
    members: capM ? num(capM[1]) : null,
    max: capM ? num(capM[2]) : null,
  };
}

// The directory page: every .gd-card plus the "N guilds" header count.
function parseGuildDirectory(html) {
  const clean = stripTags(html);
  const cards = [];
  const seen = new Set();
  for (const m of clean.matchAll(/<article class="gd-card[\s\S]*?<\/article>/g)) {
    const card = parseGuildCard(m[0]);
    if (card && !seen.has(card.guildId)) {
      seen.add(card.guildId);
      cards.push(card);
    }
  }
  const totalM = clean.match(/(\d[\d,]*)\s*guilds\s*</i);
  return { total: totalM ? Number(totalM[1].replace(/,/g, '')) : cards.length, guilds: cards };
}

// The detail page for ONE guild (guild-less viewer): identity, capacity,
// the join/apply form when one is offered, and the full/closed notes.
function parseGuildDetail(html) {
  const clean = stripTags(html);
  const text = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const out = { guildId: null, tag: null, name: null, mode: 'closed', members: null, max: null, joinForm: null, full: false, note: null };

  const idM = clean.match(/guild_join_create\.php\?guild_id=(\d+)/);
  if (idM) out.guildId = Number(idM[1]);
  // The .gd-profile header carries the whole identity in one block:
  //   <p class="gd-tag">[F2P]</p><h2>F2P</h2><p>380 / 450 members &middot; Open recruitment</p>
  const profM = clean.match(
    /<p class="gd-tag">\s*\[?([A-Z0-9]{1,8})\]?\s*<\/p>\s*<h2>([\s\S]{0,120}?)<\/h2>\s*<p>\s*([^<]{0,160})<\/p>/
  );
  if (profM) {
    out.tag = profM[1];
    out.name = profM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const line = profM[3];
    const num = (s) => Number(String(s || '').replace(/[,&nbsp;]/g, '').replace(/,/g, '')) || 0;
    const capM = line.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*members/);
    if (capM) {
      out.members = num(capM[1]);
      out.max = num(capM[2]);
      const modePart = line.slice(capM.index + capM[0].length).replace(/&middot;/g, ' ').trim();
      if (modePart) out.mode = normalizeMode(modePart);
    }
  }
  if (out.mode === 'closed') {
    const badgeM = clean.match(/class="gd-badge">([^<]+)</);
    if (badgeM) out.mode = normalizeMode(badgeM[1]);
  }
  if (/This guild is currently full/i.test(text) || (out.members != null && out.max != null && out.members >= out.max)) out.full = true;

  // The join/apply form: the one .gd-action-form carrying a csrf token.
  for (const m of clean.matchAll(/<form[^>]*class="[^"]*gd-action-form[^"]*"[^>]*>[\s\S]*?<\/form>/g)) {
    const f = m[0];
    const csrf = (f.match(/name="csrf"\s+value="([^"]+)"/) || (f.match(/name="csrf"[^>]*value="([^"]+)"/)) || [])[1];
    const formId = (f.match(/name="form_id"\s+value="([^"]+)"/) || [])[1];
    const gid = (f.match(/name="guild_id"\s+value="([^"]+)"/) || [])[1];
    const action = (f.match(/name="action"\s+value="([^"]+)"/) || [])[1];
    if (!csrf || !formId || !gid || !action) continue;
    out.joinForm = {
      csrf, formId, guildId: Number(gid), action,
      needsNote: /<textarea[^>]*name="answers"/i.test(f),
    };
    break;
  }
  if (!out.joinForm && out.full) out.note = 'guild is full';
  else if (!out.joinForm) out.note = 'no join form offered';
  return out;
}

// ── actions ───────────────────────────────────────────────────────────────────
// Search the directory for the panel's guild code: matches the tag ("DA" /
// "[DA]"), the exact name, or the numeric id. Returns the card or null.
function pickGuild(cards, code) {
  const c = String(code || '').trim().toLowerCase().replace(/^\[+|\]+$/g, '').trim();
  if (!c) return null;
  const num = /^\d+$/.test(c) ? Number(c) : null;
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^\[+|\]+$/g, '').trim();
  return cards.find((g) => num != null && g.guildId === num)
    || cards.find((g) => g.tag && norm(g.tag) === c)
    || cards.find((g) => norm(g.name) === c)
    || null;
}

// Search + pick in one step (GET ?q= narrows the directory; a code like
// "demon castle" or "DA" lands on the right card within page 1 for the
// fleets' guilds — the q search covers the whole registry server-side).
async function findGuild(game, code) {
  const res = await game.get(`/guild_join_create.php?q=${encodeURIComponent(String(code).trim())}`, { redirect: 'manual' });
  if (game.looksLikeLogin(res.text)) return null;
  const dir = parseGuildDirectory(res.text);
  return pickGuild(dir.guilds, code);
}

// Join (or apply to) the best-matching guild for `code`. Nothing is posted
// unless a live join form is on the page — a member viewer, a full guild or a
// closed recruitment simply answer a verdict instead.
//   → { ok: 'joined'|'applied', guild:{id,tag,name} }      success
//   → { ok: 'full'|'closed'|'not_found'|'already_member'|'error', error }
async function joinGuild(game, { code, note } = {}) {
  const card = await findGuild(game, code);
  if (!card) return { ok: 'not_found', error: `no directory match for "${code}"` };
  await game.pace(800, 1500);
  const det = await game.get(`/guild_join_create.php?guild_id=${card.guildId}`, { redirect: 'manual' });
  if (game.looksLikeLogin(det.text)) return { ok: 'error', error: 'session lost on the detail page' };
  const page = parseGuildDetail(det.text);
  if (page.full || page.mode === 'full') return { ok: 'full', error: `${page.name || card.name} is full (${page.members}/${page.max})` };
  if (!page.joinForm) return { ok: 'closed', error: `${page.name || card.name}: ${page.note}` };

  const body = {
    csrf: page.joinForm.csrf,
    form_id: page.joinForm.formId,
    guild_id: String(page.joinForm.guildId),
    action: page.joinForm.action,
  };
  if (page.joinForm.needsNote) body.answers = String(note || '').slice(0, 1000);
  await game.pace(800, 1500);
  await game.postForm(`/guild_join_create.php?guild_id=${page.joinForm.guildId}`, body);

  // Authoritative verification: the dash is the game's answer to "whose
  // member am I now". Applied-but-pending keeps answering guild-less.
  await game.pace(800, 1500);
  const fresh = await dungeons.fetchOwnGuild(game);
  if (fresh && (fresh.id != null || fresh.tag || fresh.name)) {
    return { ok: page.joinForm.action === 'apply' ? 'applied_verified' : 'joined', guild: fresh };
  }
  if (page.joinForm.action === 'apply') {
    return { ok: 'applied', guild: { id: page.guildId, tag: page.tag, name: page.name } };
  }
  return { ok: 'error', error: 'join POST sent but the dash still reports no guild' };
}

// One-line human summary for logs / audit rows.
function describe(result) {
  if (!result) return 'no attempt';
  if (result.ok === 'joined') {
    const g = result.guild || {};
    return `joined${g.tag ? ` [${g.tag}]` : ''}${g.name ? ` ${g.name}` : ''}`;
  }
  if (result.ok === 'applied' || result.ok === 'applied_verified') {
    const g = result.guild || {};
    return `application sent to${g.tag ? ` [${g.tag}]` : ''}${g.name ? ` ${g.name}` : ''} — waiting for the leader`;
  }
  return `${result.ok}: ${result.error || ''}`;
}

module.exports = {
  normalizeMode, parseGuildCard, parseGuildDirectory, parseGuildDetail,
  pickGuild, findGuild, joinGuild, describe,
};
