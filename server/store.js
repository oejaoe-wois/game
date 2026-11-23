'use strict';
// store.js — encrypted credential store + append-only audit log.
//
// Passwords are sealed with AES-256-GCM. The key comes from scrypt of
// AIO_SECRET_KEY with a random per-store salt. Plaintext NEVER touches disk —
// only {iv, tag, ciphertext} per account. The panel host (Wispbyte) can read
// files, but without the env key the ciphertext is useless.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { logger, maskEmail, randomId } = require('./util');

const STORE_VERSION = 1;
const AUDIT_MAX_BYTES = 5 * 1024 * 1024; // rotate audit.log past 5 MB
const KEY_CHECK_TEXT = 'aio-farm-key-check';

function deriveKey(secret, salt) {
  return crypto.scryptSync(String(secret), salt, 32);
}

function encryptRow(key, password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decryptRow(key, row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(row.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

class Store {
  constructor({ dataDir, secretKey }) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'accounts.enc');
    this.auditFile = path.join(dataDir, 'audit.log');
    this.accounts = new Map(); // id -> { id, nickname, email, createdAt, ...enc }
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
    this.key = deriveKey(secretKey, this.salt);
    this.verifyKey();
  }

  // Detect a changed/wrong AIO_SECRET_KEY at boot with a clear message,
  // instead of every login failing later with an opaque GCM error.
  verifyKey() {
    if (this.keyCheck) {
      try {
        if (decryptRow(this.key, this.keyCheck) !== KEY_CHECK_TEXT) throw new Error('mismatch');
      } catch (_) {
        throw new Error(
          'AIO_SECRET_KEY does not match the key this data/ folder was encrypted with. ' +
          'Restore the original key, or delete data/accounts.enc and re-add the accounts.'
        );
      }
      return;
    }
    // Older store (or brand new): seal the check value now. For an older
    // store with accounts, prove the key works on the first row first.
    const first = this.accounts.values().next().value;
    if (first && first.enc) {
      try { decryptRow(this.key, first.enc); } catch (_) {
        throw new Error('AIO_SECRET_KEY does not match the key this data/ folder was encrypted with.');
      }
    }
    this.keyCheck = encryptRow(this.key, KEY_CHECK_TEXT);
    this.save();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      this.salt = crypto.randomBytes(16);
      this.save();
      return;
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw.salt !== 'string') throw new Error('missing salt');
    } catch (e) {
      throw new Error(
        `data/accounts.enc is unreadable (${e.message}). Fix or delete it — ` +
        'a copy of the broken file was NOT made, so back it up first if you need it.'
      );
    }
    this.salt = Buffer.from(raw.salt, 'base64');
    this.keyCheck = raw.keyCheck || null;
    for (const row of raw.accounts || []) this.accounts.set(row.id, row);
  }

  save() {
    const payload = {
      v: STORE_VERSION,
      salt: this.salt.toString('base64'),
      keyCheck: this.keyCheck || undefined,
      accounts: [...this.accounts.values()],
    };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // role: 'user' (default, panel-visible) | 'admin' (the built-in fetcher).
  // hidden rows never appear in list() — the masked API view — while
  // internalRows() keeps them so their worker still runs.
  // An account is unique per (site, email): the same login can exist on two
  // game sites as two independent accounts. Rows saved before multi-site
  // support have no `site` and count as the default site ('demonic').
  // `owner` is the panel username that added the account. Rows saved before
  // multi-user support have no owner and belong to the main admin.
  // `guildCode` (optional) is the game guild this account should fight for —
  // tag, name or numeric id ("[DA]", "Dagorath Alliance", "32"). It is not a
  // secret: the engine verifies it against the session's own guild before the
  // account swings at guild dungeon mobs, and the panel shows the verdict.
  // `classPick` (optional) is this account's class-system policy for
  // classes.php: 'auto' (default — take the optimal farming class once
  // level 200+) | 'mage' | 'warrior' | 'hunter' | 'cleric' | 'off'. The
  // game's class choice is permanent, so 'off' is always respected.
  // `diveTargets` (optional) is this DIVER's mob list — the specific mobs
  // the user wants the account to hunt ("goblin skirmisher, troll ravager").
  // Not a secret; the diver attacks those mobs first on every wave it
  // sweeps (and ONLY those while DIVE_ONLY=1). Cleared with an empty value.
  addAccount({ nickname, email, password, role, hidden, site, owner, guildCode, classPick, diveTargets }) {
    const emailNorm = String(email).trim().toLowerCase();
    const siteKey = String(site || 'demonic');
    const existing = [...this.accounts.values()].find(
      (a) => a.email === emailNorm && (a.site || 'demonic') === siteKey
    );
    const id = existing ? existing.id : randomId('acc');
    const enc = encryptRow(this.key, String(password));
    // Re-adding an email is "fix my password" — and "fix my guild code".
    // A blank field keeps the stored code; a new value replaces it.
    const code = guildCode === undefined
      ? (existing ? existing.guildCode : undefined)
      : String(guildCode).trim().slice(0, 64) || undefined;
    // Same re-add semantics as the guild code: blank keeps the stored pick,
    // a value replaces it.
    const pickRaw = classPick === undefined
      ? (existing ? existing.classPick : undefined)
      : String(classPick).trim().toLowerCase();
    const pick = pickRaw && ['auto', 'mage', 'warrior', 'hunter', 'cleric', 'off'].includes(pickRaw)
      ? pickRaw : undefined;
    // Same re-add semantics as the class pick: blank keeps the stored dive
    // list, a value replaces it (divers.js parseDiveTargets is applied at
    // read time by the worker — the raw string is stored here).
    const dive = diveTargets === undefined
      ? (existing ? existing.diveTargets : undefined)
      : String(diveTargets).trim().slice(0, 300) || undefined;
    const row = {
      id,
      nickname: String(nickname || emailNorm.split('@')[0]).slice(0, 40),
      email: emailNorm,
      site: siteKey,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: existing ? Date.now() : undefined,
      role: role || (existing ? existing.role : 'user'),
      owner: existing && existing.owner ? existing.owner : (owner || undefined),
      hidden: hidden != null ? !!hidden : !!(existing && existing.hidden),
      guildCode: code,
      classPick: pick,
      diveTargets: dive,
      enc,
    };
    if (!row.guildCode) delete row.guildCode;
    if (!row.classPick) delete row.classPick;
    if (!row.diveTargets) delete row.diveTargets;
    this.accounts.set(id, row);
    this.save();
    return row;
  }

  // Look up one row without decrypting anything (internal use).
  find(id) {
    const a = this.accounts.get(id);
    return a ? { id: a.id, email: a.email, site: a.site || 'demonic', owner: a.owner || null, role: a.role || 'user', hidden: !!a.hidden, guildCode: a.guildCode || null, classPick: a.classPick || null, diveTargets: a.diveTargets || null } : null;
  }

  // The same (site, email) login, if it is already on the farm.
  findByLogin(email, site) {
    const emailNorm = String(email).trim().toLowerCase();
    const siteKey = String(site || 'demonic');
    const a = [...this.accounts.values()].find((x) => x.email === emailNorm && (x.site || 'demonic') === siteKey);
    return a ? this.find(a.id) : null;
  }

  // Hand an account to another panel user (used when a friend is deleted).
  reassign(id, owner) {
    const row = this.accounts.get(id);
    if (!row) return false;
    row.owner = owner;
    this.save();
    return true;
  }

  // Patch an account's farming policy in place: classPick (the per-account
  // classes.php policy — 'auto' | a class key | 'off'), guildCode and/or
  // diveTargets (the diver's mob list). Only provided fields change; null
  // clears a value, undefined keeps it. The class choice itself is permanent
  // in the GAME — this only re-points the engine's policy, and 'off' is
  // always honoured.
  updateAccount(id, patch = {}) {
    const row = this.accounts.get(id);
    if (!row) return null;
    if (patch.classPick !== undefined) {
      if (patch.classPick === null || patch.classPick === '') {
        delete row.classPick;
      } else {
        const pick = String(patch.classPick).trim().toLowerCase();
        if (!['auto', 'mage', 'warrior', 'hunter', 'cleric', 'off'].includes(pick)) {
          return { error: 'classPick must be auto, mage, warrior, hunter, cleric or off' };
        }
        row.classPick = pick === 'auto' ? undefined : pick;
        if (!row.classPick) delete row.classPick;
      }
    }
    if (patch.guildCode !== undefined) {
      if (patch.guildCode === null || patch.guildCode === '') delete row.guildCode;
      else row.guildCode = String(patch.guildCode).trim().slice(0, 64) || undefined;
      if (!row.guildCode) delete row.guildCode;
    }
    if (patch.diveTargets !== undefined) {
      if (patch.diveTargets === null || patch.diveTargets === '') delete row.diveTargets;
      else row.diveTargets = String(patch.diveTargets).trim().slice(0, 300) || undefined;
      if (!row.diveTargets) delete row.diveTargets;
    }
    row.updatedAt = Date.now();
    this.save();
    return this.find(id);
  }

  removeAccount(id) {
    const had = this.accounts.delete(id);
    if (had) this.save();
    return had;
  }

  getPassword(id) {
    const row = this.accounts.get(id);
    if (!row) throw new Error('account not found');
    return decryptRow(this.key, row.enc);
  }

  has(id) {
    return this.accounts.has(id);
  }

  // Masked view for API responses — no emails, no password material, and
  // hidden rows (the built-in fetcher) are excluded so panel users cannot
  // see, count or target that account.
  list() {
    return [...this.accounts.values()]
      .filter((a) => !a.hidden)
      .map((a) => ({
        id: a.id,
        nickname: a.nickname,
        emailMasked: maskEmail(a.email),
        site: a.site || 'demonic',
        owner: a.owner || null,
        guildCode: a.guildCode || null,
        classPick: a.classPick || null,
        diveTargets: a.diveTargets || null,
        createdAt: a.createdAt,
      }));
  }

  // Full rows only for internal use (workers), never serialized to the API.
  // Carries role/hidden so the manager can pin the fetcher and filter views.
  internalRows() {
    return [...this.accounts.values()].map((a) => ({
      id: a.id,
      nickname: a.nickname,
      email: a.email,
      site: a.site || 'demonic',
      role: a.role || 'user',
      owner: a.owner || null,
      hidden: !!a.hidden,
      guildCode: a.guildCode || null,
      classPick: a.classPick || null,
      diveTargets: a.diveTargets || null,
    }));
  }

  // The built-in admin fetcher row (role 'admin'), if seeded.
  adminRow(site) {
    return [...this.accounts.values()].find(
      (a) => a.role === 'admin' && (a.site || 'demonic') === (site || 'demonic')
    ) || null;
  }

  audit(action, detail) {
    const entry = { ts: new Date().toISOString(), action, ...(detail || {}) };
    try {
      try {
        if (fs.statSync(this.auditFile).size > AUDIT_MAX_BYTES) {
          fs.renameSync(this.auditFile, this.auditFile + '.1'); // keep one old file
        }
      } catch (_) { /* no audit file yet */ }
      fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (e) {
      logger.warn(`audit write failed: ${e.message}`);
    }
  }
}

module.exports = { Store };
