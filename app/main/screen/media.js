// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// The two renderer windows of a second-screen session, in their own in-memory
// session partition served from app://omnidesk-screen/ (files in ./viewer):
//   openSource(): hidden capture window, WebRTC offerer (gets media permission)
//   openViewer(): frameless full-screen window on the built-in display
// Both: sandbox, contextIsolation, no node, own preload exposing only
// window.omniScreen = { onCommand, send }.

const fs = require('node:fs');
const path = require('node:path');

const HOST = 'omnidesk-screen';
const ORIGIN = `app://${HOST}`;
const PARTITION = 'omnidesk-screen';
const CSP = "default-src 'self'; media-src 'self' blob:";
const ROOT = path.join(__dirname, 'viewer');
const FILES = new Map([
  ['/capture.html', 'text/html; charset=utf-8'], ['/viewer.html', 'text/html; charset=utf-8'],
  ['/capture.js', 'text/javascript; charset=utf-8'], ['/viewer.js', 'text/javascript; charset=utf-8'],
  ['/rtc-util.js', 'text/javascript; charset=utf-8'], ['/viewer.css', 'text/css; charset=utf-8'],
]);

function createMedia({ electron, allowMedia, log = () => {}, isPackaged = false }) {
  const { BrowserWindow, session, ipcMain, desktopCapturer, screen: electronScreen } = electron;
  const routes = new Map(); // webContents.id -> onMsg
  const mediaOk = new Set(); // webContents ids allowed to capture
  // Viewer windows: no capture, but the permission *check* for 'media' says yes. Without it
  // Chromium gathers WebRTC candidates on the default route only, which on a PC with a VPN
  // adapter is the VPN address, so the other computer on the LAN never gets an answer.
  const routesOk = new Set();
  let ses = null;

  function isOurUrl(u) { try { const x = new URL(u); return x.protocol === 'app:' && x.host === HOST; } catch { return false; } }

  function ensureSession() {
    if (ses) return ses;
    ses = session.fromPartition(PARTITION, { cache: false });
    ses.protocol.handle('app', async (req) => {
      const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
      let u; try { u = new URL(req.url); } catch { return new Response('Not found', { status: 404, headers }); }
      const type = u.host === HOST ? FILES.get(u.pathname) : null; // fixed allowlist, no path joins from input
      if (!type) return new Response('Not found', { status: 404, headers });
      try {
        const data = await fs.promises.readFile(path.join(ROOT, u.pathname.slice(1)));
        return new Response(data, { status: 200, headers: { ...headers, 'Content-Type': type } });
      } catch { return new Response('Not found', { status: 404, headers }); }
    });
    const decide = (wc, permission, url) => !!wc && mediaOk.has(wc.id) && (permission === 'media' || permission === 'display-capture') && isOurUrl(url || wc.getURL());
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const ok = decide(wc, permission, details && details.requestingUrl);
      if (!ok) log(`screen: permission denied: ${permission}`);
      cb(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => decide(wc, permission, origin && `${origin}/`)
      || (!!wc && routesOk.has(wc.id) && permission === 'media' && isOurUrl(origin ? `${origin}/` : wc.getURL())));
    if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(`${ORIGIN}/`) || d.url.startsWith('devtools:')) }));
    return ses;
  }

  ipcMain.on('omnidesk-screen:msg', (e, msg) => {
    const fn = routes.get(e.sender.id);
    if (!fn || !e.senderFrame || !isOurUrl(e.senderFrame.url)) return;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    try { fn(msg); } catch (err) { log(`screen: window message: ${err.message}`); }
  });

  function webPreferences(extra = {}) {
    return {
      partition: PARTITION,
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
      devTools: !isPackaged, backgroundThrottling: false, ...extra,
    };
  }

  // Returns { send(cmd), close() } once the page has loaded and said 'ready'.
  function open(win, file, onMsg, { capture }) {
    const wc = win.webContents;
    const id = wc.id;
    let closed = false;
    let revoke = () => {};
    if (capture) { mediaOk.add(id); revoke = allowMedia(wc) || (() => {}); } else routesOk.add(id);
    const handle = {
      send(cmd) { if (!closed && !wc.isDestroyed()) wc.send('omnidesk-screen:cmd', cmd); },
      close() {
        if (closed) return;
        closed = true;
        routes.delete(id); mediaOk.delete(id); routesOk.delete(id); try { revoke(); } catch { /* gone */ }
        if (!win.isDestroyed()) { try { wc.send('omnidesk-screen:cmd', { type: 'stop' }); } catch { /* gone */ } win.destroy(); }
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { handle.close(); reject(Object.assign(new Error('The screen window did not load.'), { code: 'window-timeout' })); }, 10000);
      routes.set(id, (msg) => {
        if (msg.type === 'ready') { clearTimeout(timer); resolve(handle); return; }
        if (msg.type === 'log') { log(`screen ${file}: ${String(msg.message).slice(0, 400)}`); return; }
        onMsg(msg);
      });
      wc.on('render-process-gone', (_e, d) => { if (!closed) { clearTimeout(timer); onMsg({ type: 'end', reason: `window crashed (${d.reason})` }); } });
      win.on('closed', () => { if (!closed) { closed = true; routes.delete(id); mediaOk.delete(id); routesOk.delete(id); onMsg({ type: 'end', reason: 'window closed' }); } });
      win.loadURL(`${ORIGIN}/${file}`).catch((e) => { clearTimeout(timer); handle.close(); reject(e); });
    });
  }

  async function findCaptureSource(displayId, timeoutMs = 6000) {
    const t0 = Date.now();
    const cantSee = () => Object.assign(new Error(process.platform === 'darwin'
      ? 'OmniDesk can\'t see the new display. Allow Screen Recording for OmniDesk in System Settings → Privacy & Security → Screen & System Audio Recording, then restart OmniDesk.'
      : 'OmniDesk can\'t capture the new display.'), { code: 'capture-failed' });
    for (;;) {
      let sources;
      // macOS without Screen Recording permission: "Failed to get sources."
      try { sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }); } catch (e) { log(`screen: getSources: ${e.message}`); throw cantSee(); }
      const s = sources.find((x) => String(x.display_id) === String(displayId));
      if (s) return s.id;
      if (Date.now() - t0 > timeoutMs) throw cantSee();
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function openSource(cfg, onMsg) {
    ensureSession();
    // Whether Chromium may use the GPU for video encoding here (else every codec is software).
    try { const g = electron.app.getGPUFeatureStatus(); log(`screen: gpu video_encode=${g.video_encode} gpu_compositing=${g.gpu_compositing}`); } catch { /* no app in tests */ }
    const win = new BrowserWindow({ show: false, width: 320, height: 200, skipTaskbar: true, focusable: false, title: 'OmniDesk capture', webPreferences: webPreferences() });
    const h = await open(win, 'capture.html', onMsg, { capture: true });
    h.send({ type: 'start', role: 'source', ...cfg });
    return h;
  }

  function builtInDisplay() {
    const all = electronScreen.getAllDisplays();
    return all.find((d) => d.internal) || electronScreen.getPrimaryDisplay();
  }

  async function openViewer(cfg, onMsg) {
    ensureSession();
    const d = builtInDisplay();
    const win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      show: false, frame: false, fullscreen: true, fullscreenable: true, backgroundColor: '#000000',
      autoHideMenuBar: true, title: 'OmniDesk second screen', webPreferences: webPreferences(),
    });
    // Esc twice (within 800 ms) or Ctrl+Alt+Shift+Q ends the session.
    let lastEsc = 0;
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const k = String(input.key || '').toLowerCase();
      if (k === 'q' && input.control && input.alt && input.shift) { e.preventDefault(); onMsg({ type: 'end', reason: 'user' }); return; }
      if (k === 'escape') {
        e.preventDefault();
        const now = Date.now();
        if (now - lastEsc < 800) onMsg({ type: 'end', reason: 'user' });
        lastEsc = now;
      }
    });
    const h = await open(win, 'viewer.html', onMsg, { capture: false });
    win.setBounds(d.bounds);
    win.setFullScreen(true);
    win.show();
    win.focus();
    h.send({ type: 'start', role: 'viewer', ...cfg });
    return h;
  }

  return { findCaptureSource, openSource, openViewer };
}

module.exports = { createMedia, CSP, ORIGIN };
