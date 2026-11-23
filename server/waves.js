'use strict';
// waves.js — the gate/wave registry for precision wave farming.
//
// Every gate on https://demonicscans.org/gates.php serves its own
// active_wave.php?gate=X&wave=Y pages, and each gate/wave pair carries
// different monsters and values — the engine sweeps the pages below. The
// default list is the full gate map:
//
//   Gate 1        → gate=3 · waves 3 / 5 / 8
//   Gate 2 Olympus (olympus.php) → gate=5 · wave 9, then the named god gates:
//                   10 Hermes · 11 Artemis · 12 Poseidon · 13 Ares ·
//                   14 Apollo · 15 Athena · 16 Hera · 17 Zeus
//
// Override without touching code:
//   env  WAVE_PAGES="gate=3&wave=3|Gate 1 wave 1, gate=5&wave=17|Zeus gate"
//   file config/waves.json { "waves": [ { "path": "...", "label": "...",
//                                          "rewardCapLv": 300 } ] }
// Precedence: env > config/waves.json > built-in defaults.
//
// rewardCapLv (optional): the wave's "Rewards Up To LV X" level gate. Past
// that level the wave still drops gear and items but NO exp and gold — the
// divers' picker sinks such waves to the back of the rotation for accounts
// above the cap (gear hunting still possible via dive targets).
const fs = require('fs');
const path = require('path');

// Built-in default: the gate map as published on gates.php / olympus.php.
// Labels follow the game's own naming (Grakthar gate, Olympus hub wave, the
// named god domains — live-verified 2026-11 from the pages themselves).
const DEFAULT_WAVES = [
  { path: 'gate=3&wave=3',  label: 'Grakthar · wave 1' },
  { path: 'gate=3&wave=5',  label: 'Grakthar · wave 2' },
  { path: 'gate=3&wave=8',  label: 'Grakthar · wave 3' },
  { path: 'gate=5&wave=9',  label: 'Olympus · wave 1' },
  { path: 'gate=5&wave=10', label: 'Olympus · Hermes domain' },
  { path: 'gate=5&wave=11', label: 'Olympus · Artemis domain' },
  { path: 'gate=5&wave=12', label: 'Olympus · Poseidon domain' },
  { path: 'gate=5&wave=13', label: 'Olympus · Ares domain' },
  { path: 'gate=5&wave=14', label: 'Olympus · Apollo domain' },
  { path: 'gate=5&wave=15', label: 'Olympus · Athena domain' },
  { path: 'gate=5&wave=16', label: 'Olympus · Hera domain' },
  { path: 'gate=5&wave=17', label: 'Olympus · Zeus domain' },
];

// Accepts "gate=3&wave=3", "active_wave.php?gate=3&wave=3" — anything that
// ends in the two params the game's wave router needs.
function normalizePath(raw) {
  // Event waves use event=N&wave=M instead of gate=N&wave=M (the LevelUp
  // Looter's "Event: The Dragon Realm" source: active_wave.php?event=13&wave=116).
  const m = String(raw || '').match(/(?:gate|event)=(\d+)&wave=(\d+)/i);
  if (!m) return null;
  const kind = /event=(\d+)&wave/i.test(String(raw || '')) ? 'event' : 'gate';
  return `${kind}=${m[1]}&wave=${m[2]}`;
}

function labelFor(pathName, rawLabel) {
  const label = String(rawLabel || '').trim();
  if (label) return label;
  const m = pathName.match(/gate=(\d+)&wave=(\d+)/);
  return m ? `gate ${m[1]} · wave ${m[2]}` : pathName;
}

// Parse the WAVE_PAGES env format: "path|label, path|label, …" (label
// optional; a plain "gate=X&wave=Y" entry gets an auto label).
function parseEnvList(raw) {
  return String(raw || '')
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [p, ...rest] = chunk.split('|');
      const pathName = normalizePath(p);
      if (!pathName) return null;
      return { path: pathName, label: labelFor(pathName, rest.join('|')) };
    })
    .filter(Boolean);
}

function loadWavePages(envRaw) {
  const fromEnv = parseEnvList(envRaw || process.env.WAVE_PAGES || '');
  if (fromEnv.length) return fromEnv;

  try {
    const file = path.join(__dirname, '..', 'config', 'waves.json');
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed.waves)) {
        const fromFile = parsed.waves
          .map((w) => {
            const p = normalizePath(w && w.path);
            if (!p) return null;
            const cap = Number(w && w.rewardCapLv);
            return {
              path: p,
              label: labelFor(p, w.label),
              // 0/absent = cap unknown (the page never showed one) — the
              // picker treats that as "rewards flow" and keeps normal order.
              rewardCapLv: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0,
            };
          })
          .filter(Boolean);
        if (fromFile.length) return fromFile;
      }
    }
  } catch (_) { /* corrupt file → fall through to defaults */ }

  return DEFAULT_WAVES.map((w) => ({ ...w }));
}

module.exports = { DEFAULT_WAVES, parseEnvList, normalizePath, loadWavePages };
