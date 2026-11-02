// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Isolated test window: serves the renderer with the mock backend and drives Google Chrome
// over the DevTools protocol (zero dependencies; Node has fetch + WebSocket).
//
// node app/test/run.mjs --page mouse [--page layout ...|--all] [--scenario default]
//   [--shots app/test/shots/<agent>] [--phone] [--reduced-motion] [--cmd "turn off clipboard"]
//   [--headed] [--timeout 20000] [--root <renderer dir>] [--a11y]
//
// --a11y: keyboard-only walkthrough per page (Tab order, every visible control reachable, focus
// visible, names, Space/Enter operate a switch, Esc closes the command bar), then a leak check:
// visits every page 3 times and fails if live subscriptions, intervals, timeouts, animation
// frames or document/window listeners grow between rounds.
//
// Prints a JSON summary; exits 1 on any console error, exception, CSP violation, failed
// request or horizontal overflow. Each run has its own Chrome profile and debugging port.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, RENDERER_DIR } from './serve.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ALL = ['home', 'mouse', 'layout', 'clipboard', 'screen', 'camera', 'connection', 'devices', 'tip', 'feedback', 'about'];
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 400, height: 860 };

// ---------- args ----------
const argv = process.argv.slice(2);
const opts = { pages: [], cmds: [], scenario: 'default', shots: null, phone: false, reduced: false, headed: false, timeout: 20000, root: RENDERER_DIR, a11y: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]; const v = () => argv[++i];
  if (a === '--page') opts.pages.push(v());
  else if (a === '--all') opts.pages.push(...ALL);
  else if (a === '--scenario') opts.scenario = v();
  else if (a === '--shots') opts.shots = v();
  else if (a === '--phone') opts.phone = true;
  else if (a === '--reduced-motion') opts.reduced = true;
  else if (a === '--cmd') opts.cmds.push(v());
  else if (a === '--headed') opts.headed = true;
  else if (a === '--a11y') opts.a11y = true;
  else if (a === '--timeout') opts.timeout = Number(v()) || 20000;
  else if (a === '--root') opts.root = resolve(v());
  else if (a === '--help' || a === '-h') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(6, 13).join('\n')); process.exit(0); }
  else { console.error(`Unknown option ${a}`); process.exit(2); }
}
opts.pages = [...new Set(opts.pages)];
if (!opts.pages.length) opts.pages = opts.headed ? ['home'] : [];
if (!opts.pages.length) { console.error('Give --page <id> (repeatable) or --all.'); process.exit(2); }
if (!existsSync(CHROME)) { console.error(`Chrome not found at ${CHROME} (set CHROME_PATH).`); process.exit(2); }
const shotsDir = resolve(opts.shots || mkdtempSync(join(tmpdir(), 'omnidesk-shots-')));
mkdirSync(shotsDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- server + Chrome ----------
const srv = await startServer({ root: opts.root });
const profile = mkdtempSync(join(tmpdir(), 'omnidesk-chrome-'));
const chromeArgs = [
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
  '--password-store=basic', '--use-mock-keychain', `--window-size=${DESKTOP.width},${DESKTOP.height + 80}`,
];
if (!opts.headed) chromeArgs.push('--headless=new', '--hide-scrollbars', '--mute-audio');
chromeArgs.push('about:blank');
const chrome = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
let chromeExited = false;
chrome.on('exit', () => { chromeExited = true; });

async function cleanup() {
  try { ws && ws.close(); } catch {}
  if (!chromeExited) chrome.kill();
  await srv.close().catch(() => {});
  await sleep(200);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
  if (!port) await sleep(100);
}
if (!port) { await cleanup(); console.error('Chrome did not start.'); process.exit(2); }

let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(100);
}
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

// ---------- CDP plumbing ----------
let msgId = 0;
const pending = new Map();
const waiters = [];
let cur = null; // per-page collector
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  for (const w of waiters.slice()) if (w.method === m.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m.params); }
  if (!cur) return;
  const p = m.params || {};
  switch (m.method) {
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails;
      cur.errors.push('exception: ' + ((d.exception && d.exception.description) || d.text) + (d.url ? ` (${d.url.replace(srv.url, '')}:${d.lineNumber + 1})` : ''));
      break;
    }
    case 'Runtime.consoleAPICalled':
      if (p.type === 'error' || p.type === 'assert') {
        const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (text.startsWith('CSP violation: ')) cur.csp.push(text); else cur.errors.push('console.error: ' + text);
      }
      if (p.type === 'warning' || p.type === 'warn') cur.warnings.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
      break;
    case 'Log.entryAdded': {
      const en = p.entry;
      if (/Content Security Policy/i.test(en.text) || en.source === 'security') cur.csp.push(en.text);
      else if (en.level === 'error' && en.source !== 'network') cur.errors.push('log: ' + en.text);
      break;
    }
    case 'Network.responseReceived':
      if (p.response.status >= 400) cur.failedRequests.push(`${p.response.status} ${p.response.url.replace(srv.url, '')}`);
      break;
    case 'Network.loadingFailed':
      if (!p.canceled && p.errorText !== 'net::ERR_ABORTED') cur.failedRequests.push(`${p.errorText} ${cur.urls.get(p.requestId) || p.requestId}`);
      break;
    case 'Network.requestWillBeSent':
      cur.urls.set(p.requestId, p.request.url.replace(srv.url, ''));
      if (!p.request.url.startsWith(srv.url) && !/^(data|blob|about|chrome):/.test(p.request.url)) cur.failedRequests.push('external request: ' + p.request.url);
      break;
  }
});
const send = (method, params = {}) => new Promise((r, j) => {
  const i = ++msgId;
  const t = setTimeout(() => { pending.delete(i); j(new Error(`CDP timeout: ${method}`)); }, opts.timeout);
  pending.set(i, (m) => { clearTimeout(t); m.error ? j(new Error(`${method}: ${m.error.message}`)) : r(m.result); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const waitEvent = (method, ms) => new Promise((resolve) => {
  const w = { method, resolve };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const viewport = async (v, mobile) => {
  await send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(shotsDir, name + '.png');
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  return f;
};
const key = async (k, code, vk, modifiers = 0, text) => {
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
};

async function load(url) {
  await send('Page.navigate', { url: 'about:blank' });
  const loaded = waitEvent('Page.loadEventFired', opts.timeout);
  await send('Page.navigate', { url });
  if (!(await loaded)) throw new Error(`page did not load within ${opts.timeout}ms`);
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeout) {
    const ready = await evalJs(`document.readyState === 'complete' && !!document.body && document.body.innerText.trim().length > 0`).catch(() => false);
    if (ready) { await sleep(900); return; }
    await sleep(100);
  }
  throw new Error(`page did not render within ${opts.timeout}ms`);
}
const overflow = () => evalJs(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`);
const TOASTS = `(() => { const sel = '.toast';
  const els = [...document.querySelectorAll(sel)].filter((e) => !e.parentElement || !e.parentElement.closest(sel));
  return [...new Set(els.map((e) => e.innerText.trim()).filter(Boolean))]; })()`;

// ---------- run ----------
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
// live counters of timers, frames and global listeners (read by the --a11y leak check)
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const L = { iv: new Set(), to: new Set(), raf: new Set(), ls: new Map() };
  const w = window, si = w.setInterval, ci = w.clearInterval, st = w.setTimeout, ct = w.clearTimeout, ra = w.requestAnimationFrame, ca = w.cancelAnimationFrame;
  w.setInterval = function (f, ms, ...a) { const h = si.call(w, f, ms, ...a); L.iv.add(h); return h; };
  w.clearInterval = function (h) { L.iv.delete(h); return ci.call(w, h); };
  w.setTimeout = function (f, ms, ...a) { let h; h = st.call(w, function () { L.to.delete(h); return typeof f === 'function' ? f.apply(this, arguments) : undefined; }, ms, ...a); L.to.add(h); return h; };
  w.clearTimeout = function (h) { L.to.delete(h); return ct.call(w, h); };
  w.requestAnimationFrame = function (f) { let h; h = ra.call(w, (t) => { L.raf.delete(h); f(t); }); L.raf.add(h); return h; };
  w.cancelAnimationFrame = function (h) { L.raf.delete(h); return ca.call(w, h); };
  for (const [name, tgt] of [['window', w], ['document', document]]) {
    const add = tgt.addEventListener, rem = tgt.removeEventListener;
    const key = (t, f, o) => name + ':' + t + ':' + (typeof o === 'boolean' ? o : !!(o && o.capture));
    tgt.addEventListener = function (t, f, o) { const k = key(t, f, o); let s = L.ls.get(k); if (!s) L.ls.set(k, s = new Set()); s.add(f); return add.call(this, t, f, o); };
    tgt.removeEventListener = function (t, f, o) { const s = L.ls.get(key(t, f, o)); if (s) s.delete(f); return rem.call(this, t, f, o); };
  }
  Object.defineProperty(w, '__leak', { value: () => {
    let ls = 0; L.ls.forEach((s) => { ls += s.size; });
    const m = w.__omnideskMock && w.__omnideskMock.subscriptions ? w.__omnideskMock.subscriptions() : { total: -1, byChannel: {} };
    return { subs: m.total, byChannel: m.byChannel, intervals: L.iv.size, timeouts: L.to.size, frames: L.raf.size, listeners: ls };
  } });
})();` });
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `document.addEventListener('securitypolicyviolation', (e) => console.error('CSP violation: ' + e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline') + ' at ' + (e.sourceFile || '') + ':' + e.lineNumber), true);`,
});
if (opts.reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

// ---------- keyboard walkthrough (--a11y) ----------
const FOCUS_INFO = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return null;
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  const name = (e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(' ').map((id) => (document.getElementById(id) || {}).textContent || '').join(' ') || e.innerText || e.value || e.title || (e.labels && e.labels[0] && e.labels[0].innerText) || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 || cs.boxShadow !== 'none';
  if (!e.dataset.kbId) e.dataset.kbId = String(Math.random()).slice(2, 10);
  return { id: e.dataset.kbId, tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), name, x: Math.round(r.x), y: Math.round(r.y),
    visible: r.width > 0 && r.height > 0, focusVisible: e.matches(':focus-visible'), ring, area: e.closest('#stack') ? 'page' : e.closest('#cmd') ? 'cmd' : 'shell' };
})()`;
const FOCUSABLES = `(() => {
  const sel = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role=button], [role=switch], [role=tab], [role=radio], [role=checkbox], [role=option], [role=slider]';
  return [...document.querySelectorAll(sel)].filter((e) => {
    if (e.disabled || e.closest('[inert]') || e.closest('[hidden]') || e.closest('[aria-hidden=true]') && e.tabIndex < 0) return false;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden') return false;
    if (e.matches('[role=option]') && e.closest('#cmd')) return false;
    return true;
  }).map((e) => {
    if (!e.dataset.kbId) e.dataset.kbId = String(Math.random()).slice(2, 10);
    const native = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(e.tagName);
    const name = (e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(' ').map((id) => (document.getElementById(id) || {}).textContent || '').join(' ') || e.innerText || e.value || e.title || e.getAttribute('placeholder') || (e.labels && e.labels[0] && e.labels[0].innerText) || '').trim();
    return { id: e.dataset.kbId, tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), name: name.slice(0, 60), tabIndex: e.tabIndex, native,
      roving: e.tabIndex < 0 };
  });
})()`;
const tab = (shift = false) => key('Tab', 'Tab', 9, shift ? 8 : 0);

async function keyboardWalk(id) {
  const out = { stops: 0, unreached: [], noName: [], noRing: [], notFocusable: [], switchOperable: null, escClosesCmd: null, order: [] };
  await evalJs(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); true`);
  await evalJs(`(document.querySelector('#main') || document.body).scrollTop = 0; true`);
  // start from the top of the document
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 }).catch(() => {});
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 }).catch(() => {});
  await evalJs(`document.activeElement && document.activeElement.blur(); true`);
  const all = await evalJs(FOCUSABLES);
  const seen = new Map();
  let first = null;
  for (let i = 0; i < 160; i++) {
    await tab();
    await sleep(30);
    const f = await evalJs(FOCUS_INFO);
    if (!f) continue;
    if (first && f.id === first) break;              // wrapped around
    if (!first) first = f.id;
    if (seen.has(f.id)) continue;
    seen.set(f.id, f);
    out.order.push(`${f.area}:${f.role || f.tag}:${f.name}`);
    if (!f.name) out.noName.push(`${f.tag}${f.role ? '[' + f.role + ']' : ''}`);
    if (f.visible && !f.ring) out.noRing.push(`${f.tag} "${f.name}"`);
  }
  out.stops = seen.size;
  // pages may re-render controls (new nodes, same control): compare by role + name too
  const sig = (c) => `${c.tag}|${c.role}|${c.name}`;
  const seenSig = new Set([...seen.values()].map(sig));
  const rovingGroups = new Set();
  for (const c of all) {
    if (seen.has(c.id) || seenSig.has(sig(c))) continue;
    if (c.roving) { rovingGroups.add(c.role || c.tag); continue; }     // roving tabindex: reached with arrow keys
    out.unreached.push(`${c.tag}${c.role ? '[' + c.role + ']' : ''} "${c.name}"`);
  }
  for (const c of all) if (!c.native && c.tabIndex < 0 && !c.roving) out.notFocusable.push(`${c.tag}[${c.role}] "${c.name}"`);
  // controls that get re-rendered while idle must keep keyboard focus
  await evalJs(`(() => { window.__churn = new Map(); const sel = 'a[href],button,input,select,textarea,[tabindex]';
    window.__churnMo = new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes) {
      if (n.nodeType !== 1) continue; for (const e of [n, ...n.querySelectorAll(sel)]) if (e.matches(sel) && !e.disabled) {
        const k = (e.getAttribute('aria-label') || e.innerText || '').trim(); if (k) window.__churn.set(k, (window.__churn.get(k) || 0) + 1); } } });
    window.__churnMo.observe(document.querySelector('#stack'), { childList: true, subtree: true }); return true; })()`);
  await sleep(3000);
  const churn = await evalJs(`(() => { window.__churnMo.disconnect(); return [...window.__churn.keys()]; })()`);
  out.focusLost = [];
  for (const name of churn.slice(0, 12)) {
    const ok = await evalJs(`(() => { const e = [...document.querySelectorAll('#stack .sheet.front a[href],#stack .sheet.front button,#stack .sheet.front input,#stack .sheet.front [tabindex]')]
      .find((x) => !x.disabled && (x.getAttribute('aria-label') || x.innerText || '').trim() === ${JSON.stringify(name)}); if (!e) return null; e.focus(); return document.activeElement === e; })()`);
    if (!ok) continue;
    await sleep(2500);
    const still = await evalJs(`(() => { const a = document.activeElement; return !!a && a !== document.body && a.closest('#stack') !== null; })()`);
    if (!still) out.focusLost.push(name);
  }
  // a switch on the page responds to Space
  const sw = await evalJs(`(() => { const s = [...document.querySelectorAll('#stack .sheet.front [role=switch]')].find((e) => !e.disabled && e.getBoundingClientRect().width > 0);
    if (!s) return null; s.focus(); return s.getAttribute('aria-checked'); })()`);
  if (sw != null) {
    await key(' ', 'Space', 32, 0, ' ');
    await sleep(500);
    const after = await evalJs(`document.activeElement && document.activeElement.getAttribute('aria-checked')`);
    out.switchOperable = after != null && after !== sw;
    if (out.switchOperable) { await key(' ', 'Space', 32, 0, ' '); await sleep(500); }
  }
  // Esc closes the command bar and gives focus back
  await evalJs(`(() => { const b = document.querySelector('#stack .sheet.front button, #stack .sheet.front a[href]'); if (b) b.focus(); return true; })()`);
  const before = await evalJs(FOCUS_INFO);
  await key('k', 'KeyK', 75, 2);
  await sleep(400);
  const open = await evalJs(`(() => { const s = document.querySelector('#cmd'); return !!s && !!s.offsetParent && document.activeElement && !!document.activeElement.closest('#cmd'); })()`);
  await tab(); await sleep(50);
  const trapped = await evalJs(`!!(document.activeElement && document.activeElement.closest('#cmd'))`);
  await key('Escape', 'Escape', 27);
  await sleep(500);
  const closed = await evalJs(`(() => { const s = document.querySelector('#cmd'); return !s || !s.offsetParent || s.closest('[hidden]') !== null; })()`);
  const back = await evalJs(FOCUS_INFO);
  out.afterEsc = await evalJs(`document.activeElement ? document.activeElement.tagName + '#' + document.activeElement.id + '.' + document.activeElement.className : 'none'`);
  out.escClosesCmd = open && trapped && closed && (!before || (back && back.id === before.id));
  if (!out.escClosesCmd) out.cmdDetail = { open, trapped, closed, before: before && before.name, back: back && back.name, afterEsc: out.afterEsc };
  return out;
}

async function leakCheck() {
  const rounds = [];
  await viewport(DESKTOP, false);
  await load(pageUrl('home'));
  for (let r = 0; r < 3; r++) {
    for (const id of [...ALL.slice(1), 'home']) {
      await evalJs(`location.hash = ${JSON.stringify('#' + id)}; true`);
      await sleep(700);
    }
    await sleep(1200);
    rounds.push(await evalJs(`window.__leak()`));
  }
  const grew = [];
  for (const k of ['subs', 'intervals', 'listeners']) if (rounds[2][k] > rounds[0][k]) grew.push(`${k} ${rounds.map((x) => x[k]).join(' -> ')}`);
  // timeouts and frames fluctuate; allow a little jitter but no steady growth
  for (const k of ['timeouts', 'frames']) if (rounds[2][k] > rounds[0][k] + 3 && rounds[1][k] > rounds[0][k]) grew.push(`${k} ${rounds.map((x) => x[k]).join(' -> ')}`);
  return { rounds, grew };
}

const suffix = (opts.scenario !== 'default' ? '-' + opts.scenario : '') + (opts.reduced ? '-rm' : '');
const pageUrl = (id) => `${srv.url}/${opts.scenario !== 'default' ? `?mock-scenario=${encodeURIComponent(opts.scenario)}` : ''}#${id}`;
const results = [];
for (const id of opts.pages) {
  cur = { page: id, errors: [], warnings: [], csp: [], failedRequests: [], overflow: [], shots: [], cmds: [], urls: new Map() };
  try {
    await viewport(DESKTOP, false);
    await load(pageUrl(id));
    if (!(await evalJs(`typeof window.omnidesk === 'object'`))) cur.errors.push('mock backend (window.omnidesk) not loaded');
    const o = await overflow();
    if (o.scrollWidth > o.innerWidth) cur.overflow.push(`desktop scrollWidth ${o.scrollWidth} > ${o.innerWidth}`);
    cur.shots.push(await shot(`${id}${suffix}-desktop`));

    for (const [i, c] of opts.cmds.entries()) {
      await key('k', 'KeyK', 75, 2);
      await sleep(350);
      const opened = await evalJs(`!!document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)`);
      await send('Input.insertText', { text: c });
      await sleep(350);
      await key('Enter', 'Enter', 13, 0, '\r');
      await sleep(900);
      const toasts = await evalJs(TOASTS);
      cur.cmds.push({ cmd: c, commandBarOpened: opened, toast: toasts.join(' | ') || null });
      if (!opened) cur.errors.push(`command bar did not open on Ctrl+K for "${c}"`);
      cur.shots.push(await shot(`${id}${suffix}-cmd${i + 1}`));
      await key('Escape', 'Escape', 27);
    }

    if (opts.phone) {
      await viewport(PHONE, true);
      await load(pageUrl(id));
      const p = await overflow();
      const meta = await evalJs(`!!document.querySelector('meta[name=viewport]')`);
      if (!meta) cur.overflow.push('phone: no <meta name="viewport">, so the page renders at desktop width');
      else if (p.innerWidth > PHONE.width) cur.overflow.push(`phone: content is wider than ${PHONE.width}px, the viewport grew to ${p.innerWidth}px`);
      if (p.scrollWidth > p.innerWidth) cur.overflow.push(`phone scrollWidth ${p.scrollWidth} > ${p.innerWidth}`);
      cur.shots.push(await shot(`${id}${suffix}-phone`));
    }

    if (opts.a11y) {
      await viewport(DESKTOP, false);
      await load(pageUrl(id));
      const k = await keyboardWalk(id);
      cur.keyboard = k;
      if (k.unreached.length) cur.errors.push(`keyboard: not reachable with Tab: ${k.unreached.join(', ')}`);
      if (k.noName.length) cur.errors.push(`keyboard: controls without a name: ${k.noName.join(', ')}`);
      if (k.noRing.length) cur.errors.push(`keyboard: no visible focus on: ${k.noRing.join(', ')}`);
      if (k.notFocusable.length) cur.errors.push(`keyboard: custom controls not focusable: ${k.notFocusable.join(', ')}`);
      if (k.focusLost.length) cur.errors.push(`keyboard: focus lost when the page re-renders: ${k.focusLost.join(', ')}`);
      if (k.switchOperable === false) cur.errors.push('keyboard: Space did not toggle a switch');
      if (!k.escClosesCmd) cur.errors.push(`keyboard: command bar / Esc: ${JSON.stringify(k.cmdDetail)}`);
    }
  } catch (e) {
    cur.errors.push('runner: ' + e.message);
  }
  await sleep(150);
  const r = cur; cur = null;
  delete r.urls;
  r.errors = [...new Set(r.errors)]; r.csp = [...new Set(r.csp)]; r.failedRequests = [...new Set(r.failedRequests)];
  r.ok = !r.errors.length && !r.csp.length && !r.failedRequests.length && !r.overflow.length;
  results.push(r);
}

if (opts.a11y) {
  cur = { page: 'leak-check', errors: [], warnings: [], csp: [], failedRequests: [], overflow: [], shots: [], cmds: [], urls: new Map() };
  try {
    const l = await leakCheck();
    cur.leak = l;
    if (l.grew.length) cur.errors.push('leak: ' + l.grew.join('; '));
  } catch (e) { cur.errors.push('runner: ' + e.message); }
  const r = cur; cur = null; delete r.urls;
  r.ok = !r.errors.length && !r.csp.length && !r.failedRequests.length;
  results.push(r);
}

const summary = {
  ok: results.every((r) => r.ok), scenario: opts.scenario, reducedMotion: opts.reduced, phone: opts.phone,
  root: opts.root, shots: shotsDir, pages: results,
};
console.log(JSON.stringify(summary, null, 2));

if (opts.headed) {
  await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  cur = { page: 'headed', errors: [], warnings: [], csp: [], failedRequests: [], overflow: [], shots: [], cmds: [], urls: new Map() };
  await send('Page.navigate', { url: pageUrl(opts.pages[0]) });
  console.error(`Test window open at ${pageUrl(opts.pages[0])}. Close Chrome or press Ctrl+C to finish.`);
  await new Promise((r) => (chromeExited ? r() : chrome.once('exit', r)));
}
await cleanup();
process.exit(summary.ok ? 0 : 1);
