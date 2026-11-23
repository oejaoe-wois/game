'use strict';
// curl-test.js — the curl transport must round-trip awkward bytes intact and
// must not put secrets on curl's command line.
const http = require('http');
const { curlAvailable, curlRequest } = require('../server/curl-transport');
let failures = 0;
const check = (n, c, d) => { console.log(`${c ? '  PASS' : '  FAIL'}  ${n}${c ? '' : ' — ' + (d || '')}`); if (!c) failures++; };

(async () => {
  if (!curlAvailable()) { console.log('  SKIP  curl not installed here — fetch fallback is used'); return; }
  let seen = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen = { b, cookie: req.headers.cookie, x: req.headers['x-test'], m: req.method };
      res.setHeader('Set-Cookie', 'sid=abc; Path=/'); res.end('hello'); });
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/p?a=1&b=#x`;
  const nasty = 'P@ss"w\\ord#$!`\'%&=+ é';
  const r = await curlRequest({ url, method: 'POST', body: `email=a%40b.c&password=${encodeURIComponent(nasty)}&raw=${nasty}`,
    headers: { Cookie: 'PHPSESSID=s3cret"x\\y; z=1', 'X-Test': 'a "quoted" \\ value' } });
  check('request succeeds with status 200', r.status === 200 && r.text === 'hello', JSON.stringify(r.status));
  check('body with quotes/backslashes/#/$ arrives byte-for-byte', seen.b.endsWith(`raw=${nasty}`), JSON.stringify(seen.b));
  check('cookie header arrives intact', seen.cookie === 'PHPSESSID=s3cret"x\\y; z=1', seen.cookie);
  check('custom header arrives intact', seen.x === 'a "quoted" \\ value', seen.x);
  check('POST method used', seen.m === 'POST');
  check('Set-Cookie parsed back', r.setCookies.some((c) => c.startsWith('sid=abc')));
  const g = await curlRequest({ url, method: 'GET' });
  check('GET works and sends no body', g.status === 200 && seen.m === 'GET' && seen.b === '');
  srv.close();
})().then(() => { console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CURL CHECKS PASSED'); process.exit(failures ? 1 : 0); })
  .catch((e) => { console.log('  FAIL  ' + e.message); process.exit(1); });
