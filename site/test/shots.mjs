// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Serves site/ from 127.0.0.1 and drives headless Google Chrome over the DevTools protocol
// (same approach as app/test/run.mjs, zero dependencies). For every page, at 1280x800 and
// 400x860: console errors, exceptions, CSP violations, failed or unexpected requests and
// horizontal overflow; screenshots go to site/test/shots/.
//
// node site/test/shots.mjs [--scenario live|win-x64|mac-arm|android] [--reduced-motion] [--headed]
//   live     real call to api.github.com (404 until the repo exists): checks the fallback.
//   win-x64  api.github.com answered from test/fixtures/release.json, Windows x64 browser.
//   mac-arm  same fixture, Apple silicon Mac browser (Rosetta note).
//   android  same fixture, a phone: the button goes to the file list.
// Exits 1 on any problem.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = join(HERE, 'shots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGES = ['index.html', 'download.html', 'privacy.html'];
const VIEWS = { desktop: { width: 1280, height: 800, mobile: false }, phone: { width: 400, height: 860, mobile: true } };
const API = 'https://api.github.com/repos/dprama/omnidesk/releases/latest';

const argv = process.argv.slice(2);
const opts = { scenario: 'live', reduced: false, headed: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--scenario') opts.scenario = argv[++i];
  else if (argv[i] === '--reduced-motion') opts.reduced = true;
  else if (argv[i] === '--headed') opts.headed = true;
  else { console.error(`Unknown option ${argv[i]}`); process.exit(2); }
}
const SCEN = {
  live: null,
  'win-x64': { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Windows', architecture: 'x86', navPlatform: 'Win32', mobile: false },
  'mac-arm': { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'macOS', architecture: 'arm', navPlatform: 'MacIntel', mobile: false },
  android: { ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', platform: 'Android', architecture: 'arm', navPlatform: 'Linux armv8l', mobile: true },
};
if (!(opts.scenario in SCEN)) { console.error(`Unknown scenario ${opts.scenario}`); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME}`); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- static server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT + sep) || file.includes(`${sep}test${sep}`) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---------- Chrome ----------
const profile = mkdtempSync(join(tmpdir(), 'omnidesk-site-'));
const args = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--disable-component-update', '--password-store=basic', '--use-mock-keychain', '--window-size=1280,880'];
if (!opts.headed) args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
args.push('about:blank');
const chrome = spawn(CHROME, args, { stdio: 'ignore' });
let ws;
async function cleanup() {
  try { ws && ws.close(); } catch {}
  chrome.kill();
  server.close();
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
let port = 0;
for (let i = 0; i < 100 && !port; i++) { try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {} if (!port) await sleep(100); }
if (!port) { await cleanup(); console.error('Chrome did not start'); process.exit(2); }
for (let i = 0; i < 50 && !ws; i++) {
  try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const pg = list.find((t) => t.type === 'page'); if (pg) ws = new WebSocket(pg.webSocketDebuggerUrl); } catch {}
  if (!ws) await sleep(100);
}
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

let id = 0; const pending = new Map(); const waiters = []; let cur = null;
const fixture = readFileSync(join(HERE, 'fixtures', 'release.json'), 'utf8');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  for (const w of waiters.slice()) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m.params); }
  const p = m.params || {};
  if (m.method === 'Fetch.requestPaused') {
    // Answer the GitHub API from the fixture, like GitHub would (CORS included).
    send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: Buffer.from(fixture).toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }] }).catch(() => {});
    return;
  }
  if (!cur) return;
  switch (m.method) {
    case 'Runtime.exceptionThrown': cur.errors.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)); break;
    case 'Runtime.consoleAPICalled': {
      const t = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error' || p.type === 'assert') (t.startsWith('CSP violation: ') ? cur.csp : cur.errors).push(t);
      break;
    }
    case 'Log.entryAdded': {
      const en = p.entry;
      if (/Content Security Policy/i.test(en.text) || en.source === 'security') cur.csp.push(en.text);
      else if (en.level === 'error' && en.source !== 'network') cur.errors.push('log: ' + en.text);
      break;
    }
    case 'Network.requestWillBeSent': {
      const u = p.request.url;
      if (u.startsWith(API)) cur.api.push(u);
      else if (!u.startsWith(ORIGIN) && !/^(data|blob|about|chrome):/.test(u)) cur.failed.push('unexpected request: ' + u);
      cur.urls.set(p.requestId, u);
      break;
    }
    case 'Network.responseReceived':
      if (p.response.url.startsWith(API)) cur.apiStatus = p.response.status;
      else if (p.response.status >= 400) cur.failed.push(`${p.response.status} ${p.response.url}`);
      break;
    case 'Network.loadingFailed': {
      const u = cur.urls.get(p.requestId) || '';
      if (u.startsWith(API)) cur.apiStatus = p.errorText;
      else if (!p.canceled) cur.failed.push(`${p.errorText} ${u}`);
      break;
    }
  }
});
function send(method, params = {}) {
  return new Promise((r, j) => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); j(new Error('CDP timeout ' + method)); }, 20000);
    pending.set(i, (m) => { clearTimeout(t); m.error ? j(new Error(`${method}: ${m.error.message}`)) : r(m.result); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
const waitEvent = (method, ms) => new Promise((resolve) => { const w = { method, resolve }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms); });
const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + r.exceptionDetails.text); return r.result.value; };

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + ' at ' + (e.sourceFile || '') + ':' + e.lineNumber), true);` });
if (opts.reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const sc = SCEN[opts.scenario];
if (sc) {
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.github.com/*', requestStage: 'Request' }] });
  await send('Emulation.setUserAgentOverride', { userAgent: sc.ua, platform: sc.navPlatform,
    userAgentMetadata: { brands: [{ brand: 'Chromium', version: '141' }], fullVersionList: [], platform: sc.platform, platformVersion: '15.0.0', architecture: sc.architecture, model: '', mobile: sc.mobile, bitness: '64', wow64: false } });
}

const suffix = (opts.scenario !== 'live' ? '-' + opts.scenario : '') + (opts.reduced ? '-rm' : '');
const results = [];
for (const page of PAGES) {
  for (const [vname, v] of Object.entries(VIEWS)) {
    cur = { page, view: vname, errors: [], csp: [], failed: [], api: [], apiStatus: null, overflow: null, button: null, shots: [], urls: new Map() };
    try {
      await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile });
      await send('Emulation.setTouchEmulationEnabled', { enabled: v.mobile, maxTouchPoints: v.mobile ? 5 : 1 });
      await send('Page.navigate', { url: 'about:blank' });
      await send('Runtime.evaluate', { expression: 'try{sessionStorage.clear()}catch{}' }).catch(() => {});
      const loaded = waitEvent('Page.loadEventFired', 20000);
      await send('Page.navigate', { url: `${ORIGIN}/${page}` });
      if (!(await loaded)) throw new Error('page did not load');
      await evalJs('document.fonts.ready.then(() => true)');
      // Give the GitHub request time to settle (live: real network).
      for (let i = 0; i < 60; i++) { if (await evalJs(`!!document.documentElement.dataset.dlState || !document.querySelector('[data-dl]')`)) break; await sleep(150); }
      await sleep(700);
      const o = await evalJs(`({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight,
        wide: [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1 && !e.closest('.tabs-wrap,.sky,.sprite'); }).slice(0, 5).map((e) => e.tagName + '.' + e.className) })`);
      cur.overflow = o.sw > o.iw ? `scrollWidth ${o.sw} > ${o.iw} (${o.wide.join(', ')})` : null;
      cur.button = await evalJs(`(() => { const a = document.querySelector('[data-dl]'); if (!a) return null;
        const t = (s) => { const e = document.querySelector(s); return e && !e.hidden ? e.textContent.trim() : null; };
        return { state: document.documentElement.dataset.dlState || null, link: a.getAttribute("href"), label: t('[data-dl-label]'), meta: t('[data-dl-meta]'), note: t('[data-dl-note]') }; })()`);
      const base = `${page.replace('.html', '')}${suffix}-${vname}`;
      let r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(SHOTS, base + '.png'), Buffer.from(r.data, 'base64')); cur.shots.push(base + '.png');
      if (opts.scenario === 'live' && !opts.reduced) {
        r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: v.width, height: Math.min(o.h, 16000), scale: 1 } });
        writeFileSync(join(SHOTS, base + '-full.png'), Buffer.from(r.data, 'base64')); cur.shots.push(base + '-full.png');
        await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile });
      }
    } catch (e) { cur.errors.push('runner: ' + e.message); }
    await sleep(100);
    const res = cur; cur = null; delete res.urls;
    res.errors = [...new Set(res.errors)]; res.csp = [...new Set(res.csp)]; res.failed = [...new Set(res.failed)]; res.api = res.api.length;
    res.ok = !res.errors.length && !res.csp.length && !res.failed.length && !res.overflow;
    results.push(res);
  }
}
const ok = results.every((r) => r.ok);
console.log(JSON.stringify({ ok, scenario: opts.scenario, reducedMotion: opts.reduced, shots: SHOTS, results }, null, 2));
await cleanup();
process.exit(ok ? 0 : 1);
