'use strict';
// env.js — optional settings file for hosts whose "environment variables" panel
// doesn't reach the program (or that have none).
//
// Create a plain text file named  farm.env  (or .env) next to package.json ON
// THE SERVER (not in GitHub — both names are gitignored) with one NAME=value
// per line:
//
//   ADMIN_USERNAME=boss
//   ADMIN_PASSWORD=RiverLamp48GoatCloud7Pine
//
// Real environment variables always win over the file. No quotes needed, and
// characters like # $ ! are kept exactly as typed (nothing is shell-expanded).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const loaded = [];
for (const name of ['farm.env', '.env']) {
  const file = path.join(root, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2];
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') { process.env[m[1]] = val; n++; }
  }
  loaded.push(`${name} (${n} setting${n === 1 ? '' : 's'})`);
}
if (loaded.length) console.log(`[env] loaded ${loaded.join(', ')}`);
module.exports = { loaded };
