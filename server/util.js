'use strict';
// util.js — small shared helpers: logging, sleeps, jitter, masking, token compare.
const crypto = require('crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = 'info';
function setLogLevel(level) {
  if (LEVELS[level]) currentLevel = level;
}

function log(level, msg, meta) {
  if (!LEVELS[level] || LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (meta !== undefined) {
    try { console.log(line, JSON.stringify(meta)); } catch (_) { console.log(line); }
  } else {
    console.log(line);
  }
}

const logger = {
  debug: (m, meta) => log('debug', m, meta),
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, Number.isFinite(ms) ? Math.max(0, ms) : 0));

// Random integer in [min, max), multiplied by the global jitter scale.
// NaN-proof: a caller that passes a missing config value must never produce
// setTimeout(NaN) — the wait degrades to ~0 instead of a Node warning.
function jitter(minMs, maxMs, scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const lo = Number.isFinite(minMs) ? minMs : 0;
  const hi = Number.isFinite(maxMs) ? maxMs : lo;
  const base = lo + Math.random() * Math.max(1, hi - lo);
  return Math.round(base * s);
}

// a****b@domain.tld — never leak full emails or passwords through the API.
function maskEmail(email) {
  const raw = String(email || '');
  const at = raw.indexOf('@');
  if (at <= 0) return '***';
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return `${local[0]}***${local.length > 1 ? local[local.length - 1] : ''}@${domain}`;
}

function maskPassword() {
  return '••••••••';
}

// Constant-time string compare for the admin token.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) {
    // Same work either way; compare against self to burn the time.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function randomId(prefix) {
  return `${prefix || 'id'}_${crypto.randomBytes(6).toString('hex')}`;
}

// ── Optional push notifications (Discord webhook) ───────────────────────────
let webhookUrl = '';
function setWebhook(url) {
  webhookUrl = String(url || '').trim();
}

// Fire-and-forget: notifications must never crash or slow the farm.
async function notify(text) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(text).slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) { /* webhook down — ignore */ }
}

module.exports = {
  logger, setLogLevel, sleep, jitter,
  maskEmail, maskPassword, safeEqual, randomId,
  setWebhook, notify,
};
