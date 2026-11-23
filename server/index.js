'use strict';
// index.js — aio-farm entry point.
//
// Boots: config → encrypted store → target bus → boss catalogue → worker
// manager (one container per account) → scout → admin API. Zero dependencies.
const config = require('./config');
const { logger, setLogLevel, maskEmail, setWebhook, notify } = require('./util');
const { Store } = require('./store');
const { UserStore } = require('./users');
const { WorkerManager } = require('./workers');
const { createServer } = require('./api');
const { loadBossList, DEFAULT_CAPS, getBossCategory } = require('./bosses');

setLogLevel(config.logLevel);

async function main() {
  logger.info(
    `aio-farm booting — sites=${config.sites.map((x) => `${x.key}:${x.base}`).join(', ')} port=${config.port} jitter=${config.jitterScale}x · ` +
    `${config.wavePages.length} wave pages · precision mode · mob cap ${config.mobDamageCap} · ` +
    `fetcher=${config.adminGameEmail ? 'built-in admin (hidden, fixed)' : 'NONE — every account fights, scout rides the oldest healthy worker'}`
  );

  const store = new Store({ dataDir: config.dataDir, secretKey: config.secretKey });
  const bosses = loadBossList(config);
  const bossCategories = Object.fromEntries(bosses.map((b) => [b.key, getBossCategory(b.key)]));
  // Warn early if a stale env var is still set — fetching is fixed now.
  if (config.scoutNickname) {
    logger.warn('SCOUT_NICKNAME is ignored — fetching is fixed: the built-in admin fetcher when ADMIN_GAME_EMAIL is set, otherwise the oldest healthy worker');
  }

  setWebhook(config.discordWebhookUrl);

  // Audit everything to disk; push the "you should know" events to Discord
  // too (only when DISCORD_WEBHOOK_URL is set — fire-and-forget, best effort).
  const NOTIFY_ACTIONS = new Set(['login_fail', 'session_lost', 'account_degraded']);
  const audit = (action, detail) => {
    store.audit(action, detail);
    if (NOTIFY_ACTIONS.has(action)) {
      const parts = Object.entries(detail || {})
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${String(v).slice(0, 120)}`);
      notify(`[aio-farm] ${action} — ${parts.join(' · ')}`).catch(() => {});
    }
  };

  const manager = new WorkerManager({
    store,
    cfg: config,
    bosses,
    caps: DEFAULT_CAPS,
    bossCategories,
    audit,
  });

  const users = new UserStore({
    dataDir: config.dataDir,
    ownerUsername: config.adminUsername,
    ownerPassword: config.adminPassword,
  });
  logger.info(`panel logins: owner "${users.owner}" + ${users.list().length} friend login(s)`);

  const server = createServer({ cfg: config, manager, users });

  await new Promise((resolve) => server.listen(config.port, resolve));
  logger.info(`panel + admin API listening on :${config.port} (panel at /, token required for /api/*, CORS ${config.allowedOrigins.length ? config.allowedOrigins.join(',') : 'any-origin'})`);

  const stored = store.list();
  logger.info(
    `loaded ${stored.length} user account(s): ` +
    `${stored.map((a) => `${a.nickname}(${a.emailMasked})`).join(', ') || 'none — add one via the front page or POST /api/accounts'}` +
    (config.adminGameEmail
      ? ` · the built-in admin fetcher is seeded separately (hidden from all listings)`
      : ` · no fetcher account — every listed account fights and the scout rides the workers`)
  );

  manager.startAll(); // every site with accounts starts in parallel, each with its own (optional) fetcher + scout

  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandledRejection: ${reason && reason.message ? reason.message : reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.message}`);
  });

  const shutdown = async () => {
    logger.info('shutting down…');
    for (const ctx of manager.sites.values()) ctx.scout.stop();
    for (const w of manager.workers.values()) w.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error(`fatal boot error: ${e.message}`);
  process.exit(1);
});
