'use strict';
// users.js — panel logins (who may sign in to the front page).
//
// Two kinds of people:
//   • the OWNER  — ADMIN_USERNAME / ADMIN_PASSWORD from env. Sees every
//     account, can pause the farm and manage the other users.
//   • USERS      — your friends. Created by the owner (panel or API), each
//     with their own username + password. They only ever see and control
//     the game accounts THEY added.
//
// User passwords are stored as salted scrypt hashes in data/users.json —
// never plaintext, never reversible. (Game passwords are a different thing:
// those live AES-encrypted in accounts.enc because the farm must replay them.)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeEqual } = require('./util');

const NAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASS = 8;
const MAX_PASS = 200;

function hashPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, 'base64') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

class UserStore {
  constructor({ dataDir, ownerUsername, ownerPassword }) {
    this.file = path.join(dataDir, 'users.json');
    this.owner = String(ownerUsername || 'admin').trim();
    this.ownerPassword = String(ownerPassword || '');
    this.users = new Map(); // lowercased username -> {username, salt, hash, createdAt}
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const u of raw.users || []) this.users.set(u.username.toLowerCase(), u);
    } catch (e) {
      throw new Error(`data/users.json is unreadable (${e.message}). Fix or delete it.`);
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, users: [...this.users.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  isOwnerName(username) {
    return String(username || '').trim().toLowerCase() === this.owner.toLowerCase();
  }

  // → { username, role } or null. Always does the hashing work so a wrong
  // username and a wrong password take about the same time.
  verify(username, password) {
    const name = String(username || '').trim();
    const pass = String(password || '');
    // Owner (env credentials).
    if (this.isOwnerName(name)) {
      const ok = safeEqual(pass, this.ownerPassword);
      return ok ? { username: this.owner, role: 'owner' } : null;
    }
    const u = this.users.get(name.toLowerCase());
    const probe = hashPassword(pass, u ? u.salt : crypto.randomBytes(16).toString('base64'));
    if (!u) return null;
    const ok = safeEqual(probe.hash, u.hash);
    return ok ? { username: u.username, role: 'user' } : null;
  }

  list() {
    return [...this.users.values()].map((u) => ({ username: u.username, createdAt: u.createdAt }));
  }

  has(username) {
    return this.isOwnerName(username) || this.users.has(String(username || '').trim().toLowerCase());
  }

  add(username, password) {
    const name = String(username || '').trim();
    const pass = String(password || '');
    if (!NAME_RE.test(name)) throw new Error('username must be 3–32 characters: letters, numbers, . _ -');
    if (pass.length < MIN_PASS || pass.length > MAX_PASS) throw new Error(`password must be ${MIN_PASS}–${MAX_PASS} characters`);
    if (this.has(name)) throw new Error('that username is already taken');
    const { salt, hash } = hashPassword(pass);
    const row = { username: name, salt, hash, createdAt: Date.now() };
    this.users.set(name.toLowerCase(), row);
    this.save();
    return { username: row.username, createdAt: row.createdAt };
  }

  setPassword(username, password) {
    const key = String(username || '').trim().toLowerCase();
    const u = this.users.get(key);
    if (!u) throw new Error('no such user');
    const pass = String(password || '');
    if (pass.length < MIN_PASS || pass.length > MAX_PASS) throw new Error(`password must be ${MIN_PASS}–${MAX_PASS} characters`);
    Object.assign(u, hashPassword(pass));
    this.save();
    return true;
  }

  remove(username) {
    const had = this.users.delete(String(username || '').trim().toLowerCase());
    if (had) this.save();
    return had;
  }
}

module.exports = { UserStore };
