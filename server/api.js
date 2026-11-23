'use strict';
// api.js — the admin HTTP API + the built-in panel file server. Zero deps.
//
// Panel login is a USERNAME + PASSWORD (not a secret key): POST /api/login
// {username, password} → {ok, token}. The token is a random 64-hex session
// kept in memory with a TTL (SESSION_TTL_HOURS, default 7 days) — restarting
// the server logs every panel out. Every /api/* route then accepts
//   X-Admin-Token: <session token>   (or)   Authorization: Bearer <token>
// If the optional legacy ADMIN_TOKEN env is still set, it keeps working as a
// master token for curl/scripts. CORS is restricted to ALLOWED_ORIGINS when
// set. Responses never contain full emails or any password material.
//
// Everything that is NOT /api/* or /healthz is served from web/ — the same
// multi-page panel you can deploy on Vercel. Serving it here means the farm
// works with ONE process and ONE URL (open https://server/ and sign in);
// the static files carry no secrets, so no auth is needed to download them.
// A small allow-list + a resolve-based traversal guard keep it boring.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { logger, safeEqual, maskEmail } = require('./util');
const { viewBattle } = require('./combat');
const monsterStats = require('./monster-stats');
const damage = require('./damage');
const loot = require('./loot');
const divers = require('./divers');

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const MAX_BODY = 16 * 1024;

// ── Static panel serving (web/) ──────────────────────────────────────────────
const WEB_DIR = path.join(__dirname, '..', 'web');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Resolve a URL path to a file inside WEB_DIR, or null when the request
// escapes the panel folder (../, encoded slashes, absolute, …). Extension
// allow-list means a stray data/ or secrets/ file can never be served.
function resolveStatic(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(String(urlPath || '/'));
  } catch (_) {
    return null;
  }
  if (clean.includes('\0') || clean.includes('\\')) return null;
  if (!clean.startsWith('/') || clean.includes('/..') || clean.includes('../')) return null;
  if (clean === '/') clean = '/index.html';
  const abs = path.resolve(WEB_DIR, `.${clean}`);
  if (abs !== WEB_DIR && !abs.startsWith(WEB_DIR + path.sep)) return null;
  if (!STATIC_TYPES[path.extname(abs).toLowerCase()]) return null;
  return abs;
}

function serveStatic(req, res, urlPath) {
  const file = resolveStatic(urlPath);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('not found');
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[ext],
      // Panel files are tiny; html never caches, assets revalidate every
      // time so a redeploy is live on the next reload (no stale-JS window).
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

// Naive per-IP rate limiter: 120 requests / minute (API is admin-only).
function rateLimiter() {
  const hits = new Map(); // ip -> {count, resetAt}
  return (ip) => {
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60 * 1000 };
      hits.set(ip, entry);
    }
    entry.count++;
    if (hits.size > 5000) hits.clear(); // memory guard
    return entry.count <= 120;
  };
}

// Session store for the username+password login. Tokens live in memory only
// (never persisted) so changing the password or restarting kills them all.
function createSessions({ ttlMs }) {
  const map = new Map(); // token -> {expiresAt, username, createdAt}
  return {
    issue(username, role) {
      if (map.size > 1000) this.sweep();
      const token = crypto.randomBytes(32).toString('hex');
      map.set(token, { username, role: role || 'user', createdAt: Date.now(), expiresAt: Date.now() + ttlMs });
      return token;
    },
    // Kill every live session of one person (user deleted / password reset).
    revokeUser(username) {
      const lc = String(username).toLowerCase();
      for (const [t, s] of map) if (s.username.toLowerCase() === lc) map.delete(t);
    },
    valid(token) {
      const s = token && map.get(String(token));
      if (!s) return null;
      if (s.expiresAt <= Date.now()) { map.delete(String(token)); return null; }
      return s;
    },
    revoke(token) { return map.delete(String(token)) || !!token; },
    sweep() {
      const now = Date.now();
      for (const [t, s] of map) if (s.expiresAt <= now) map.delete(t);
    },
    count() { this.sweep(); return map.size; },
  };
}

function createServer({ cfg, manager, users }) {
  const allowRate = rateLimiter();
  const sessions = createSessions({ ttlMs: cfg.sessionTtlMs });
  // Strict little limiter for the login route itself: 8 tries / 5 min / IP.
  const loginHits = new Map();
  function loginAllowed(ip) {
    const now = Date.now();
    let e = loginHits.get(ip);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + 5 * 60 * 1000 }; loginHits.set(ip, e); }
    e.count++;
    if (loginHits.size > 2000) loginHits.clear();
    return e.count <= 8;
  }

  function corsHeaders(origin) {
    const list = cfg.allowedOrigins;
    let allow = null;
    if (!list.length) allow = origin || '*'; // token still required
    else if (list.includes(origin)) allow = origin;
    return allow
      ? {
          'Access-Control-Allow-Origin': allow,
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Max-Age': '600',
          'Vary': 'Origin',
        }
      : {};
  }

  function send(res, status, obj, extraHeaders) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { ...JSON_HEADERS, ...(extraHeaders || {}) });
    res.end(body);
  }

  async function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        if (tooBig) return;
        size += c.length;
        if (size > MAX_BODY) {
          tooBig = true;
          chunks.length = 0;
          reject(new Error('payload too large')); // body is drained, not destroyed, so the 4xx can be sent
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    const cors = corsHeaders(origin);
    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
    const path = url.pathname;
    // ?site=veyra picks a site for the read endpoints (default: the main site).
    const siteKey = url.searchParams.get('site') || cfg.defaultSite;
    const siteCtx = () => manager.site(siteKey);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }

    // Public liveness probe (no auth) — handy for uptime pings.
    if (path === '/healthz') {
      return send(res, 200, { ok: true, ts: Date.now() }, cors);
    }

    let ip = req.socket.remoteAddress || 'unknown';
    if (cfg.trustProxy) {
      // The LAST X-Forwarded-For entry is the one our own proxy appended, so
      // a visitor cannot forge it to dodge the login lockout.
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (xff.length) ip = xff[xff.length - 1];
    }
    if (!allowRate(ip)) {
      return send(res, 429, { ok: false, error: 'rate limited' }, cors);
    }

    // ── Panel login: username + password → session token ──────────────────
    if (req.method === 'POST' && path === '/api/login') {
      if (!loginAllowed(ip)) {
        return send(res, 429, { ok: false, error: 'too many login attempts — wait 5 minutes' }, cors);
      }
      let body = {};
      try { body = await readJson(req); } catch (_) { /* fallthrough to rejection */ }
      const username = String(body.username || '');
      const password = String(body.password || '');
      const who = users.verify(username, password); // owner (env) or a friend's own login
      if (!who) {
        logger.warn(`api: failed panel login (ip ${ip.replace(/::ffff:/, '')})`);
        return send(res, 401, { ok: false, error: 'wrong username or password' }, cors);
      }
      const token = sessions.issue(who.username, who.role);
      logger.info(`api: panel login ok — ${who.username} (${who.role}) from ${ip.replace(/::ffff:/, '')}, sessions ${sessions.count()}`);
      return send(res, 200, {
        ok: true, token, username: who.username, role: who.role,
        ttlHours: Math.round(cfg.sessionTtlMs / 3600000),
      }, cors);
    }
    if (req.method === 'POST' && path === '/api/logout') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      sessions.revoke(req.headers['x-admin-token'] || bearer);
      return send(res, 200, { ok: true }, cors);
    }

    // Auth gate for everything else under /api/: a login session token, or
    // the optional legacy master ADMIN_TOKEN env for curl/scripts.
    if (path.startsWith('/api/')) {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const token = String(req.headers['x-admin-token'] || bearer || '');
      const session = sessions.valid(token);
      const isMaster = cfg.adminToken && safeEqual(token, cfg.adminToken);
      if (!session && !isMaster) {
        return send(res, 401, { ok: false, error: 'not signed in — POST /api/login first' }, cors);
      }
      // Who is asking. The legacy master token acts as the owner.
      const viewer = session
        ? { username: session.username, role: session.role }
        : { username: users.owner, role: 'owner' };
      const isOwner = viewer.role === 'owner';
      const ownerOnly = () => send(res, 403, { ok: false, error: 'owner only' }, cors);

      try {
        // ── Who am I ──────────────────────────────────────────────────────
        if (req.method === 'GET' && path === '/api/me') {
          return send(res, 200, { ok: true, username: viewer.username, role: viewer.role }, cors);
        }

        // ── Panel users (owner only) ──────────────────────────────────────
        // GET    /api/users                      list friends + how many accounts each runs
        // POST   /api/users {username,password} create a login
        // POST   /api/users/<name>/password {password}   reset it (kills their sessions)
        // DELETE /api/users/<name>?accounts=remove|keep  delete the login (and optionally their accounts)
        if (path === '/api/users' || path.startsWith('/api/users/')) {
          if (!isOwner) return ownerOnly();
          if (req.method === 'GET' && path === '/api/users') {
            const counts = {};
            for (const r of manager.store.internalRows()) {
              if (r.hidden || !r.owner) continue;
              counts[r.owner.toLowerCase()] = (counts[r.owner.toLowerCase()] || 0) + 1;
            }
            return send(res, 200, {
              ok: true,
              owner: users.owner,
              users: users.list().map((u) => ({ ...u, accounts: counts[u.username.toLowerCase()] || 0 })),
            }, cors);
          }
          if (req.method === 'POST' && path === '/api/users') {
            const body = await readJson(req);
            const created = users.add(body.username, body.password);
            manager.audit('user_created', { user: created.username, by: viewer.username });
            return send(res, 200, { ok: true, user: created }, cors);
          }
          const m = path.match(/^\/api\/users\/([^/]+)(\/password)?$/);
          if (m) {
            const name = decodeURIComponent(m[1]);
            if (req.method === 'POST' && m[2]) {
              const body = await readJson(req);
              users.setPassword(name, body.password);
              sessions.revokeUser(name);
              manager.audit('user_password_reset', { user: name, by: viewer.username });
              return send(res, 200, { ok: true }, cors);
            }
            if (req.method === 'DELETE' && !m[2]) {
              if (users.isOwnerName(name)) return send(res, 400, { ok: false, error: 'the owner cannot be deleted' }, cors);
              const had = users.remove(name);
              sessions.revokeUser(name);
              let removedAccounts = 0;
              // Default: their game accounts stop farming and are deleted with
              // them (the stored passwords are destroyed). ?accounts=keep hands
              // them to the owner instead.
              const mode = url.searchParams.get('accounts') === 'keep' ? 'keep' : 'remove';
              const theirs = manager.store.internalRows().filter((r) => !r.hidden && r.owner && r.owner.toLowerCase() === name.toLowerCase());
              for (const r of theirs) {
                if (mode === 'remove') { await manager.removeAccount(r.id); removedAccounts++; }
                else manager.store.reassign(r.id, users.owner);
              }
              manager.audit('user_deleted', { user: name, by: viewer.username, accounts: mode, count: theirs.length });
              return send(res, 200, { ok: had, removedAccounts, kept: mode === 'keep' ? theirs.length : 0 }, cors);
            }
          }
          return send(res, 404, { ok: false, error: 'unknown endpoint' }, cors);
        }

        // ── Accounts ──────────────────────────────────────────────────────
        if (req.method === 'POST' && path === '/api/accounts') {
          const body = await readJson(req);
          const email = String(body.email || '').trim().toLowerCase();
          const password = String(body.password || '');
          const nickname = String(body.nickname || '').trim() || email.split('@')[0];
          // Optional guild code: the game guild this account should fight
          // for — tag ("[DA]" / "DA"), full name, or numeric id. The engine
          // verifies it against the session's own guild before dungeon runs.
          const guildCode = String(body.guildCode || '').trim().slice(0, 64);
          // Optional class-system policy for classes.php: 'auto' (default —
          // take the optimal farming class at level 200+) | 'mage' |
          // 'warrior' | 'hunter' | 'cleric' | 'off'. Permanent in-game.
          const classPick = String(body.classPick || '').trim().toLowerCase();
          if (classPick && !['auto', 'mage', 'warrior', 'hunter', 'cleric', 'off'].includes(classPick)) {
            return send(res, 400, { ok: false, error: 'classPick must be auto, mage, warrior, hunter, cleric or off' }, cors);
          }
          // Optional DIVER target list: the specific mobs this account should
          // hunt ("goblin skirmisher, troll ravager") — matched as name
          // substrings on every wave/event page the account sweeps.
          const diveTargets = String(body.diveTargets || '').trim().slice(0, 300);
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return send(res, 400, { ok: false, error: 'invalid email' }, cors);
          }
          if (password.length < 1 || password.length > 200) {
            return send(res, 400, { ok: false, error: 'missing password' }, cors);
          }
          const site = String(body.site || cfg.defaultSite);
          if (!cfg.siteByKey(site)) {
            return send(res, 400, { ok: false, error: `unknown site — use one of: ${cfg.sites.map((x) => x.key).join(', ')}` }, cors);
          }
          const row = await manager.addAccount({ nickname, email, password, site, viewer, guildCode, classPick, diveTargets });
          return send(res, 200, { ok: true, account: row }, cors);
        }

        if (req.method === 'DELETE' && /^\/api\/accounts\/[\w-]+$/.test(path)) {
          const id = path.split('/').pop();
          if (manager.isAdminAccountId(id)) {
            // The built-in fetcher is infrastructure — it cannot be removed.
            return send(res, 403, { ok: false, error: 'the built-in fetcher account cannot be removed' }, cors);
          }
          const had = await manager.removeAccount(id, viewer);
          return send(res, 200, { ok: true, removed: had }, cors);
        }

        // PATCH /api/accounts/<id> {classPick?, guildCode?, diveTargets?} —
        // re-point a running account's farming policy. The GAME class choice
        // is permanent; this only changes what the engine does from now on
        // ('auto' = take the optimal class at level 200+, a class key =
        // force that class at 200+, 'off' = never pick). diveTargets = the
        // diver's mob list — live, the very next wave round hunts the new
        // targets.
        if (req.method === 'PATCH' && /^\/api\/accounts\/[\w-]+$/.test(path)) {
          const id = path.split('/').pop();
          const body = await readJson(req);
          const patch = {};
          if (body.classPick !== undefined) {
            const pick = String(body.classPick || '').trim().toLowerCase();
            if (pick && !['auto', 'mage', 'warrior', 'hunter', 'cleric', 'off'].includes(pick)) {
              return send(res, 400, { ok: false, error: 'classPick must be auto, mage, warrior, hunter, cleric, off or empty to clear' }, cors);
            }
            patch.classPick = pick || null; // empty string clears the override
          }
          if (body.guildCode !== undefined) {
            patch.guildCode = String(body.guildCode || '').trim().slice(0, 64) || null;
          }
          if (body.diveTargets !== undefined) {
            patch.diveTargets = String(body.diveTargets || '').trim().slice(0, 300) || null;
          }
          const out = manager.updateAccount(id, patch, viewer);
          if (out && out.error) {
            const status = /no_such_account/.test(out.error) ? 404 : 400;
            return send(res, status, { ok: false, error: out.error }, cors);
          }
          return send(res, 200, { ok: true, account: out.account }, cors);
        }

        if (req.method === 'POST' && /^\/api\/accounts\/[\w-]+\/relogin$/.test(path)) {
          const id = path.split('/')[3];
          const ok = await manager.relogin(id, viewer);
          return send(res, ok ? 200 : 404, { ok }, cors);
        }

        // ── Designated fetcher — FIXED to the built-in admin account ────────
        // It fetches for every account added and cannot be reassigned,
        // cleared or removed; the API only ever shows it as "built-in fetcher".
        if (req.method === 'POST' && path === '/api/scout') {
          if (!isOwner) return ownerOnly(); // infrastructure setting — owner only
          const body = await readJson(req);
          const id = body.accountId ? String(body.accountId) : null;
          if (!id) {
            return send(res, 403, {
              ok: false,
              error: 'the fetcher designation cannot be cleared — it is the built-in admin account',
            }, cors);
          }
          if (!manager.isAdminAccountId(id)) {
            return send(res, 403, {
              ok: false,
              error: 'fetching is fixed to the built-in admin fetcher — it cannot be reassigned',
            }, cors);
          }
          const result = manager.setScoutAccount(id);
          return send(res, 200, { ok: true, scoutAccount: result }, cors);
        }

        // ── Status & targets ──────────────────────────────────────────────
        if (req.method === 'GET' && path === '/api/status') {
          const st = manager.status(viewer);
          return send(res, 200, {
            ok: true,
            you: { username: viewer.username, role: viewer.role },
            uptimeSec: Math.round(process.uptime()),
            ...st,
            scout: {
              lastRun: manager.site(cfg.defaultSite).bus.snapshot().lastScoutRun,
              lastError: manager.site(cfg.defaultSite).bus.snapshot().lastScoutError,
              intervalMs: cfg.scoutIntervalMs,
            },
          }, cors);
        }

        if (req.method === 'GET' && path === '/api/targets') {
          const ctx = siteCtx();
          if (!ctx) return send(res, 200, { ok: true, site: siteKey, active: false, bosses: {}, mobs: [], scoutSavedIds: null }, cors);
          return send(res, 200, {
            ok: true,
            site: siteKey,
            ...ctx.bus.apiView(),
            scoutSavedIds: ctx.scout.savedIds(),
          }, cors);
        }

        // ── View-only battle peek (battle.php?id=… — zero stamina) ────────
        if (req.method === 'GET' && /^\/api\/battle\/\d+$/.test(path)) {
          const monsterId = path.split('/').pop();
          const client = manager.getScoutClient(siteKey);
          if (!client) {
            return send(res, 409, { ok: false, error: 'no logged-in account available to peek with' }, cors);
          }
          const view = await viewBattle(client, monsterId);
          return send(res, 200, { ok: true, monsterId, ...view }, cors);
        }

        // ── Monster stats (the battle page's "View Monster Stats" modal) ──
        // GET /api/monster-stats?site=&mobId= — the mob TYPE's stat block
        // (Defense / Pet Defense / Equipment Defense / Element / Element
        // Rate / Rewards Up To LV / resistances) plus a fleet-average hit
        // forecast from the game's own damage formula, so the swarm editor
        // can show "≈N hits per account" for the typed quota.
        if (req.method === 'GET' && path === '/api/monster-stats') {
          const mobId = (url.searchParams.get('mobId') || '').trim();
          if (!/^\d+$/.test(mobId)) {
            return send(res, 400, { ok: false, error: 'mobId must be numeric' }, cors);
          }
          const client = manager.getScoutClient(siteKey);
          if (!client) {
            return send(res, 409, { ok: false, error: 'no logged-in account available to peek with' }, cors);
          }
          const seen = await monsterStats.get(client, mobId);
          if (!seen) {
            return send(res, 200, { ok: false, error: 'no monster stats modal on that battle page' }, cors);
          }
          const fleet = manager.fleetLoadout(siteKey);
          let forecast = null;
          if (fleet) {
            const pred = damage.predictDamage({
              equipAtk: fleet.equipAtk,
              petAtk: fleet.petAtk,
              attackStat: fleet.attackStat,
              staminaCost: 1,
            }, seen.stats);
            forecast = { avgHit: pred.total, base: pred.base, elemental: pred.elemental, countered: pred.countered, fleet };
          }
          return send(res, 200, { ok: true, mobId, stats: seen.stats, cached: seen.cached, describe: monsterStats.describe(seen.stats), forecast }, cors);
        }

        // ── Gate/wave registry the precision farmers round-robin over ─────
        if (req.method === 'GET' && path === '/api/waves') {
          // The registry view: config waves (with their rewardCapLv) PLUS the
          // event waves the divers discovered dynamically, plus whatever caps
          // the scout learned live from the pages' reward banners.
          const learned = (() => {
            try {
              const ctxW = siteCtx();
              return ctxW && ctxW.scout ? ctxW.scout.learnedRewardCaps() : {};
            } catch (_) { return {}; }
          })();
          const baseWaves = (cfg.siteByKey(siteKey) || {}).wavePages || cfg.wavePages;
          const eventWaves = divers.storedEventWaves()
            .filter((w) => !baseWaves.some((b) => b.path === w.path))
            .map((w) => ({ path: w.path, label: w.label, rewardCapLv: 0 }));
          return send(res, 200, {
            ok: true,
            capMode: cfg.mobCapMode,
            mobDamageCap: cfg.mobDamageCap,
            learnedCaps: loot.learnedCapCount(),
            waveMobsPerRound: cfg.waveMobsPerRound,
            site: siteKey,
            waves: [...baseWaves, ...eventWaves].map((w) => ({
              ...w,
              rewardCapLv: (w.rewardCapLv > 0 ? w.rewardCapLv : 0)
                || Number(learned[w.path]) || 0,
            })),
          }, cors);
        }

        // ── Stat allocation (allocatePlan port) ───────────────────────────
        // POST /api/stats/allocate {accountId?, plan?:{attack,defense,stamina}}
        // plan omitted → the configured STAT_PLAN is used. Response carries
        // the full per-stat report (chunks applied, resyncs, points left).
        if (req.method === 'POST' && path === '/api/stats/allocate') {
          const body = await readJson(req);
          const read3 = (o) => (o && typeof o === 'object' ? {
            attack: Number(o.attack) || 0,
            defense: Number(o.defense) || 0,
            stamina: Number(o.stamina) || 0,
          } : null);
          const targets = read3(body.targets);
          const plan = body.mode !== 'targets' ? read3(body.plan) : null;
          if (targets) {
            if (targets.attack + targets.defense + targets.stamina <= 0) {
              return send(res, 400, { ok: false, error: 'empty targets — give attack/defense/stamina goals' }, cors);
            }
            const report = await manager.allocateTargets(
              body.accountId ? String(body.accountId) : null,
              targets,
              viewer,
            );
            return send(res, report.ok ? 200 : 409, { ok: report.ok, error: report.reason, report }, cors);
          }
          if (plan && plan.attack + plan.defense + plan.stamina <= 0) {
            return send(res, 400, { ok: false, error: 'empty plan — give attack/defense/stamina amounts' }, cors);
          }
          const report = await manager.allocateStats(
            body.accountId ? String(body.accountId) : null,
            plan,
            viewer,
          );
          return send(res, report.ok ? 200 : 409, { ok: report.ok, error: report.reason, report }, cors);
        }

        // GET /api/stats — per-account stat snapshot (points + attributes).
        if (req.method === 'GET' && path === '/api/stats') {
          const st = manager.status(viewer);
          return send(res, 200, {
            ok: true,
            autoAllocate: cfg.statAutoAllocate,
            configuredPlan: cfg.statPlan,
            targetsAuto: cfg.statTargetsAuto,
            configuredTargets: cfg.statTargets,
            accounts: st.accounts.map((a) => ({
              id: a.id,
              nickname: a.nickname,
              status: a.status,
              stats: a.stats,
            })),
          }, cors);
        }

        // GET /api/spawns — the scout's last auto-summon scan: alive flags,
        // next-spawn timestamps, 48h phases and per-boss "You:" damage.
        if (req.method === 'GET' && path === '/api/spawns') {
          return send(res, 200, {
            ok: true,
            phaseGate: cfg.bossPhaseGate,
            phase2Hours: cfg.bossPhase2Hours,
            site: siteKey,
            at: siteCtx() ? siteCtx().scout.lastSpawns.at : 0,
            cards: siteCtx() ? siteCtx().scout.lastSpawns.cards : [],
          }, cors);
        }

        // POST /api/shop/stamina {accountId?} — sweep merchant, guild shop and
        // Damon's potion shop on one account (default: oldest healthy).
        if (req.method === 'POST' && path === '/api/shop/stamina') {
          const body = await readJson(req);
          const result = await manager.buyStaminaPotions(
            body.accountId ? String(body.accountId) : null,
            viewer,
          );
          return send(res, result.ok ? 200 : 409, result, cors);
        }

        // ── Fleet hunt (Divers pillar 1) ────────────────────────────────────
        // GET    /api/hunt?site=…            → the mob the site's accounts hunt
        // POST   /api/hunt   {mob, site?}    → "attack all <mob>": the SAME dive
        //        targets land on every accessible account of the site, live —
        //        each account's next cycle bus-dives the matching mob ids and
        //        keeps hunting them on their pinned wave pages. mob="" clears.
        // DELETE /api/hunt?site=…            → clear the hunt.
        if (path === '/api/hunt') {
          const site = url.searchParams.get('site') || siteKey;
          if (req.method === 'GET') {
            return send(res, 200, manager.fleetHuntStatus(site, viewer), cors);
          }
          if (req.method === 'POST' || req.method === 'DELETE') {
            const body = req.method === 'DELETE' ? {} : await readJson(req);
            const mob = req.method === 'DELETE' ? '' : body.mob;
            const result = manager.fleetHunt(site, mob, viewer);
            if (result.error) return send(res, 400, { ok: false, error: result.error }, cors);
            return send(res, 200, result, cors);
          }
        }

        // ── Swarm attack (checkbox swarm) ─────────────────────────────────
        // GET    /api/swarm?site= — the coordinator's status view (queue,
        //          current target, per-account damage, log) + the dungeon
        //          mob types the fleet last saw (quick-pick chips).
        // POST   /api/swarm { site?, targets: [{kind?, mobId?, name?, quota}],
        //          mode?: 'per_account'|'total', autoRefill? } — arm a new
        //          swarm job (replaces a running one).
        // DELETE /api/swarm?site= — stop the running swarm, freeze the queue.
        if (path === '/api/swarm') {
          const site = url.searchParams.get('site') || siteKey;
          if (req.method === 'GET') {
            const st = manager.swarmStatus(site);
            st.dungeonMobNames = manager.dungeonMobNames(site);
            // The coordinator is shared by the whole site: its per-account
            // roster and log name EVERYONE's accounts, so friends don't get them.
            if (!isOwner) { st.accounts = []; st.log = []; }
            return send(res, 200, st, cors);
          }
          // One swarm per site drives EVERY account on it, so starting or
          // stopping it is an owner decision, not a friend's.
          if ((req.method === 'POST' || req.method === 'DELETE') && !isOwner) return ownerOnly();
          if (req.method === 'POST') {
            const body = await readJson(req);
            const result = manager.swarmStart(site, body, viewer);
            return send(res, result.ok ? 200 : 400, result, cors);
          }
          if (req.method === 'DELETE') {
            return send(res, 200, manager.swarmStop(site, viewer), cors);
          }
        }

        // POST /api/equip {accountId?, preferElement?} — run equip-best NOW
        // on one account (default: oldest healthy user account of the
        // caller's). preferElement ("FIRE") biases scoring toward gear whose
        // element counters that mob's element.
        if (req.method === 'POST' && path === '/api/equip') {
          const body = await readJson(req);
          const result = await manager.equipNow(
            body.accountId ? String(body.accountId) : null,
            viewer,
            body.preferElement || body.preferElements || null,
          );
          return send(res, result.ok === false && result.reason ? 409 : 200, result, cors);
        }

        // POST /api/blacksmith/craft {accountId?} — run a blacksmith craft
        // sweep NOW on one account (default: oldest healthy user account).
        if (req.method === 'POST' && path === '/api/blacksmith/craft') {
          const body = await readJson(req);
          const result = await manager.craftBlacksmith(
            body.accountId ? String(body.accountId) : null,
            viewer,
          );
          return send(res, result.ok === false && result.reason ? 409 : 200, result, cors);
        }

        // ── Farm switch ───────────────────────────────────────────────────
        if (req.method === 'POST' && path === '/api/farm') {
          // One switch for the whole farm (everyone's accounts), so owner only.
          if (!isOwner) return ownerOnly();
          const body = await readJson(req);
          manager.farmEnabled = body.enabled !== false;
          return send(res, 200, { ok: true, farmEnabled: manager.farmEnabled }, cors);
        }

        return send(res, 404, { ok: false, error: 'unknown endpoint' }, cors);
      } catch (e) {
        logger.error(`api error on ${req.method} ${path}: ${e.message}`);
        const status = e.message === 'payload too large' ? 413 : 400;
        return send(res, status, { ok: false, error: e.message }, cors);
      }
    }

    // Anything else: the panel itself (web/) — sign-in page at /, one page
    // per concern (dashboard / accounts / targets / stats / users). The
    // files are static and carry no secrets. Served from the same process
    // so the farm needs no separate hosting; ALLOWED_ORIGINS stays optional
    // because same-origin panel calls never trigger CORS at all.
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, path);
    }
    return send(res, 404, { ok: false, error: 'unknown endpoint' }, cors);
  });

  return server;
}

module.exports = { createServer };
