'use strict';
// jar.js — minimal per-account cookie jar ("Firefox container" at HTTP level).
//
// One instance per account. Every GameClient request sends `Cookie` from this
// jar and stores any Set-Cookie headers from the response. Expiry is honoured
// (expires= / max-age=); everything else is treated as a session cookie.
class CookieJar {
  constructor() {
    this.map = new Map(); // name -> { value, expiresAt: number|null }
  }

  static parseSetCookie(header) {
    // "name=value; Path=/; Expires=Wdy, DD Mon YYYY HH:MM:SS GMT; Max-Age=3600"
    const firstSemi = header.indexOf(';');
    const pair = firstSemi === -1 ? header : header.slice(0, firstSemi);
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return null;

    let expiresAt = null;
    const rest = firstSemi === -1 ? '' : header.slice(firstSemi + 1).toLowerCase();
    const maxAge = rest.match(/max-age\s*=\s*(-?\d+)/);
    const expires = rest.match(/expires\s*=\s*([^;]+)/);
    if (maxAge) {
      const secs = Number(maxAge[1]);
      expiresAt = secs <= 0 ? 0 : Date.now() + secs * 1000;
    } else if (expires) {
      const t = Date.parse(expires[1].trim());
      expiresAt = Number.isFinite(t) ? t : null;
    }
    return { name, value, expiresAt };
  }

  store(rawHeaders) {
    const list = Array.isArray(rawHeaders) ? rawHeaders : [rawHeaders];
    for (const header of list) {
      if (!header) continue;
      const parsed = CookieJar.parseSetCookie(header);
      if (!parsed) continue;
      if (parsed.expiresAt === 0) {
        this.map.delete(parsed.name); // deletion cookie
      } else {
        this.map.set(parsed.name, { value: parsed.value, expiresAt: parsed.expiresAt });
      }
    }
  }

  // Drop expired cookies; keep the rest.
  sweep() {
    const now = Date.now();
    for (const [name, c] of this.map) {
      if (c.expiresAt !== null && c.expiresAt <= now) this.map.delete(name);
    }
  }

  header() {
    this.sweep();
    return [...this.map.entries()]
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
  }

  get(name) {
    this.sweep();
    const c = this.map.get(name);
    return c ? c.value : null;
  }

  set(name, value, maxAgeSeconds) {
    this.map.set(name, {
      value: String(value),
      expiresAt: maxAgeSeconds ? Date.now() + maxAgeSeconds * 1000 : null,
    });
  }

  clear() {
    this.map.clear();
  }

  names() {
    this.sweep();
    return [...this.map.keys()];
  }
}

module.exports = { CookieJar };
