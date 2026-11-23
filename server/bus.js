'use strict';
// bus.js — the shared "everyone attack this mob" target bus.
//
// The scout worker publishes what it discovered (boss instances matched by
// name + every live generic mob id on the wave pages). Farmer workers read
// the snapshot each cycle. State persists to targets.json (no secrets here),
// so a restart keeps the last known targets until the scout refreshes.
const fs = require('fs');
const path = require('path');

const TTL_MS = 2 * 60 * 60 * 1000; // targets older than 2h are dropped

class TargetBus {
  constructor({ dataDir, fileName }) {
    this.file = path.join(dataDir, fileName || 'targets.json');
    this.state = {
      version: 1,
      updatedAt: 0,
      lastScoutRun: 0,
      lastScoutError: null,
      // bossKey -> { monsterId, name, wave, foundAt }
      bosses: {},
      // [{ id, name, wave, foundAt }]
      mobs: [],
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (raw && typeof raw === 'object') this.state = { ...this.state, ...raw };
      }
    } catch (_) { /* corrupt file → start fresh */ }
  }

  save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (_) { /* best effort */ }
  }

  prune() {
    const now = Date.now();
    for (const [key, t] of Object.entries(this.state.bosses)) {
      if (now - t.foundAt > TTL_MS) delete this.state.bosses[key];
    }
    // Rows replaced per sweep carry lastSeenAt — TTL against the last time
    // the scout actually saw the mob, not when it was first discovered.
    this.state.mobs = this.state.mobs.filter((m) => now - (m.lastSeenAt || m.foundAt) <= TTL_MS);
  }

  publish({ bosses = [], mobs = [], failedWaves = null }) {
    const now = Date.now();
    for (const b of bosses) {
      if (!b.key || !b.monsterId) continue;
      this.state.bosses[b.key] = {
        monsterId: String(b.monsterId),
        name: b.name || b.key,
        wave: b.wave || '',
        waveLabel: b.waveLabel || '',
        battleUrl: b.battleUrl || '',
        // Spawn-phase intel (48h auto-die bosses): the Boss Tracker rule —
        // phase 1 = damage doesn't count yet, phase 2 = hit it now.
        spawnPhase: b.spawnPhase != null ? b.spawnPhase : null,
        nextDieMs: b.nextDieMs != null ? b.nextDieMs : null,
        remainingMs: b.remainingMs != null ? b.remainingMs : null,
        foundAt: now,
      };
    }
    // The scout publishes the union of ONE full sweep (every registry wave).
    // With failedWaves (an array of wave paths whose fetch threw this sweep)
    // the mob list is REPLACED by that sweep's live set plus the rows from
    // the waves we could not re-check — a mob killed on the page disappears
    // from the bus on the next sweep instead of haunting farmers for 2h.
    // Legacy callers (no failedWaves) keep the old accumulate behaviour.
    if (Array.isArray(failedWaves)) {
      const failed = new Set(failedWaves);
      const carried = this.state.mobs.filter((m) => failed.has(m.wave));
      const seen = new Set();
      const fresh = [];
      for (const m of mobs) {
        const id = String(m.id || m);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const old = this.state.mobs.find((x) => String(x.id) === id);
        fresh.push({
          id,
          name: m.name || '',
          wave: m.wave || '',
          waveLabel: m.waveLabel || '',
          battleUrl: m.battleUrl || '',
          // The instance's server-side auto-die epoch (ms) — the panel's
          // "dies in" countdown. Carried rows keep theirs via the spread.
          expiresAt: m.expiresAt || null,
          foundAt: old ? old.foundAt : now,   // first-seen age for the panel
          lastSeenAt: now,
        });
      }
      for (const m of carried) {
        if (seen.has(m.id)) continue; // a carried wave can still overlap
        seen.add(m.id);
        fresh.push({ ...m, lastSeenAt: now });
      }
      // Freshest discoveries first — same order the panel shows.
      fresh.sort((a, b) => (b.lastSeenAt || b.foundAt) - (a.lastSeenAt || a.foundAt) || (b.foundAt - a.foundAt));
      this.state.mobs = fresh;
    } else {
      const seen = new Set(this.state.mobs.map((m) => String(m.id)));
      for (const m of mobs) {
        const id = String(m.id || m);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        this.state.mobs.push({
          id,
          name: m.name || '',
          wave: m.wave || '',
          waveLabel: m.waveLabel || '',
          battleUrl: m.battleUrl || '',
          expiresAt: m.expiresAt || null,
          foundAt: now,
        });
      }
      this.state.mobs.sort((a, b) => b.foundAt - a.foundAt);
    }
    // Cap the generic mob list — freshest entries win.
    if (this.state.mobs.length > 200) this.state.mobs.length = 200;
    this.prune();
    this.state.updatedAt = now;
    this.save();
  }

  markScoutRun(err) {
    this.state.lastScoutRun = Date.now();
    this.state.lastScoutError = err ? String(err.message || err) : null;
    this.save();
  }

  snapshot() {
    this.prune();
    return {
      bosses: { ...this.state.bosses },
      mobs: [...this.state.mobs],
      lastScoutRun: this.state.lastScoutRun,
      lastScoutError: this.state.lastScoutError,
      updatedAt: this.state.updatedAt,
    };
  }

  // API view (already public info — no masking needed).
  apiView() {
    return this.snapshot();
  }
}

module.exports = { TargetBus };
