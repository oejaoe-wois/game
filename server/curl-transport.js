'use strict';
// curl-transport.js — Cloudflare survival for the farm's HTTP voice.
//
// 2026-11: the game fronted every page with a Cloudflare managed challenge.
// Node's fetch (undici) is TLS-fingerprinted and gets a 403 "Just a moment…"
// no matter which User-Agent it wears, while curl's own TLS stack passes the
// same edge untouched (login, hub, floors — everything, verified live).
// So the engine speaks curl when it can:
//
//   • one async curl child process per request (the event loop keeps
//     spinning while it runs — the panel never stalls on it),
//   • feed it THIS account's Cookie header and parse every Set-Cookie back
//     into the jar exactly like the fetch path did,
//   • redirect:'manual' semantics (no -L — login POSTs rely on reading the
//     303, the callers follow redirects themselves).
//
// CURL_TRANSPORT=auto (default) uses curl when the binary exists and falls
// back to fetch otherwise; 'curl' forces curl (missing binary throws);
// 'fetch' keeps the old pure-Node path.

const { spawn } = require('child_process');

let availability = null; // null = unchecked, true/false = cached

function curlAvailable() {
  if (availability === null) {
    try {
      // Sync check is fine here: it runs once, before any server traffic.
      const { spawnSync } = require('child_process');
      const r = spawnSync('curl', ['--version'], { encoding: 'utf8', timeout: 5000 });
      availability = !r.error && r.status === 0;
    } catch (_) {
      availability = false;
    }
  }
  return availability;
}

// Strip whatever the runtime gives us down to "name: value" lines curl sent.
function parseHeaderBlock(block) {
  const headers = new Map();
  const setCookies = [];
  let status = 0;
  const lines = String(block || '').split(/\r?\n/);
  // "HTTP/2 200" / "HTTP/1.1 303 See Other" — the LAST status line wins when
  // a proxy inserted a 1xx first.
  for (const ln of lines) {
    const sm = ln.match(/^HTTP\/[\d.]+\s+(\d{3})\b/i);
    if (sm) status = parseInt(sm[1], 10);
  }
  for (const ln of lines) {
    const idx = ln.indexOf(':');
    if (idx <= 0) continue;
    const name = ln.slice(0, idx).trim().toLowerCase();
    const value = ln.slice(idx + 1).trim();
    if (name === 'set-cookie') setCookies.push(value);
    else headers.set(name, value);
  }
  return { status, headers, setCookies };
}

// curl config-file quoting: inside "..." only \\ \" \t \n \r \v are escapes.
function cfgQuote(v) {
  return '"' + String(v)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') + '"';
}

// One curl request. Returns {status, headers, setCookies, text} with the
// same shape game.js' fetch path produces (headers: .get(name)).
//
// SECURITY: the URL, this account's Cookie header and the login POST body
// (which holds the game password) go to curl through its stdin as a config
// file (-K -). On the command line they would be visible to every process on
// the machine via `ps`.
async function curlRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 25000 }) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const cfg = [
    'silent', 'show-error', 'include', 'compressed', 'path-as-is',
    `max-time = ${sec}`,
    `request = ${method === 'POST' ? 'POST' : 'GET'}`,
  ];
  if (body) cfg.push(`data-raw = ${cfgQuote(body)}`);
  for (const [k, v] of Object.entries(headers)) {
    if (v == null || v === '') continue;
    cfg.push(`header = ${cfgQuote(`${k}: ${v}`)}`);
  }
  cfg.push(`url = ${cfgQuote(url)}`);
  const args = ['-K', '-'];

  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // curl may exit before reading it all
    child.stdin.end(cfg.join('\n') + '\n');
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`curl transport: timed out after ${sec}s — ${url.slice(0, 120)}`)); }
    }, sec * 1000 + 5000);

    child.stdout.on('data', (c) => { stdout = Buffer.concat([stdout, c]); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); } // ENOENT etc
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split >= 0 ? text.slice(0, split) : '';
      const bodyText = split >= 0 ? text.slice(split + 4) : text;
      const { status, headers: resHeaders, setCookies } = parseHeaderBlock(head);
      if (!status) {
        // curl wrote an error to stderr (-S) — surface it as a network
        // failure, not a fake 0.
        reject(new Error(`curl transport: no status line (exit ${code})${stderr ? ` — ${stderr.trim().slice(0, 160)}` : ''}`));
        return;
      }
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: {
          get: (name) => resHeaders.get(String(name).toLowerCase()) || null,
          // The fetch-API shape game.js reads for content-type sniffing.
          getSetCookie: () => setCookies,
        },
        setCookies,
        text: bodyText,
        via: 'curl',
      });
    });
  });
}

module.exports = { curlAvailable, curlRequest, parseHeaderBlock };
