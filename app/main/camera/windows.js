// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Camera windows, in their own in-memory session partition served from
// app://omnidesk-camera/ (files in ./viewer, plus the shared ../screen/viewer/rtc-util.js):
//   openCapture(): hidden capture window holding the one camera stream; one
//                  WebRTC offerer per watcher (the only window granted media)
//   openViewer():  small always-on-top window showing another device's camera
// Both: sandbox, contextIsolation, no node, own preload exposing only
// window.omniCamera = { onCommand, send }.
//   cameraAccess(): OS camera permission (macOS asks once; clear `why` on denial).

const fs = require('node:fs');
const path = require('node:path');

const HOST = 'omnidesk-camera';
const ORIGIN = `app://${HOST}`;
const PARTITION = 'omnidesk-camera';
const CSP = "default-src 'self'; media-src 'self' blob:";
const ROOT = path.join(__dirname, 'viewer');
const FILES = new Map([
  ['/capture.html', ['text/html; charset=utf-8', path.join(ROOT, 'capture.html')]],
  ['/viewer.html', ['text/html; charset=utf-8', path.join(ROOT, 'viewer.html')]],
  ['/capture.js', ['text/javascript; charset=utf-8', path.join(ROOT, 'capture.js')]],
  ['/viewer.js', ['text/javascript; charset=utf-8', path.join(ROOT, 'viewer.js')]],
  ['/viewer.css', ['text/css; charset=utf-8', path.join(ROOT, 'viewer.css')]],
  ['/rtc-util.js', ['text/javascript; charset=utf-8', path.join(__dirname, '..', 'screen', 'viewer', 'rtc-util.js')]],
]);

const DENIED_MAC = 'OmniDesk isn\'t allowed to use the camera. Allow it in System Settings → Privacy & Security → Camera, then try again.';
const DENIED_WIN = 'OmniDesk isn\'t allowed to use the camera. Allow it in Settings → Privacy & security → Camera, then try again.';

// Pure so it can be tested: status from systemPreferences.getMediaAccessStatus('camera').
async function checkAccess({ platform, getStatus, ask }) {
  if (platform !== 'darwin' && platform !== 'win32') return { ok: true };
  let status = 'unknown';
  try { status = getStatus(); } catch { status = 'unknown'; }
  if (status === 'granted' || status === 'unknown') return { ok: true };
  if (platform === 'darwin' && status === 'not-determined') {
    let granted = false;
    try { granted = await ask(); } catch { granted = false; }
    return granted ? { ok: true } : { ok: false, why: DENIED_MAC };
  }
  if (status === 'restricted') return { ok: false, why: 'Camera use is blocked on this computer by a device policy.' };
  return { ok: false, why: platform === 'darwin' ? DENIED_MAC : DENIED_WIN };
}

function createWindows({ electron, allowMedia = () => () => {}, log = () => {}, isPackaged = false }) {
  const { BrowserWindow, session, ipcMain, systemPreferences } = electron;
  const routes = new Map(); // webContents.id -> onMsg
  const mediaOk = new Set(); // webContents ids allowed to open the camera
  const open = new Set(); // every live window, closed on quit
  let ses = null;

  function isOurUrl(u) { try { const x = new URL(u); return x.protocol === 'app:' && x.host === HOST; } catch { return false; } }

  function ensureSession() {
    if (ses) return ses;
    ses = session.fromPartition(PARTITION, { cache: false });
    ses.protocol.handle('app', async (req) => {
      const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
      let u; try { u = new URL(req.url); } catch { return new Response('Not found', { status: 404, headers }); }
      const hit = u.host === HOST ? FILES.get(u.pathname) : null; // fixed allowlist, no path joins from input
      if (!hit) return new Response('Not found', { status: 404, headers });
      try {
        return new Response(await fs.promises.readFile(hit[1]), { status: 200, headers: { ...headers, 'Content-Type': hit[0] } });
      } catch { return new Response('Not found', { status: 404, headers }); }
    });
    // Video only: the capture window may never ask for the microphone or the screen.
    const decide = (wc, permission, url, details) => !!wc && mediaOk.has(wc.id) && permission === 'media' && isOurUrl(url || wc.getURL())
      && !(details && Array.isArray(details.mediaTypes) && details.mediaTypes.some((t) => t !== 'video'));
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const ok = decide(wc, permission, details && details.requestingUrl, details);
      if (!ok) log(`camera: permission denied: ${permission}`);
      cb(ok);
    });
    ses.setPermissionCheckHandler((wc, permission, origin) => decide(wc, permission, origin && `${origin}/`));
    if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
    ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(`${ORIGIN}/`) || d.url.startsWith('devtools:')) }));
    return ses;
  }

  ipcMain.on('omnidesk-camera:msg', (e, msg) => {
    const fn = routes.get(e.sender.id);
    if (!fn || !e.senderFrame || !isOurUrl(e.senderFrame.url)) return;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    try { fn(msg); } catch (err) { log(`camera: window message: ${err.message}`); }
  });

  function webPreferences() {
    return {
      partition: PARTITION,
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
      devTools: !isPackaged, backgroundThrottling: false,
    };
  }

  // Returns { send(cmd), close() } once the page has loaded and said 'ready'.
  function load(win, file, onMsg, { capture }) {
    const wc = win.webContents;
    const id = wc.id;
    let closed = false;
    let revoke = () => {};
    open.add(win);
    if (capture) { mediaOk.add(id); revoke = allowMedia(wc) || (() => {}); }
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    const forget = () => { closed = true; routes.delete(id); mediaOk.delete(id); open.delete(win); try { revoke(); } catch { /* gone */ } };
    const handle = {
      send(cmd) { if (!closed && !wc.isDestroyed()) wc.send('omnidesk-camera:cmd', cmd); },
      close() {
        if (closed) return;
        forget();
        if (!win.isDestroyed()) { try { wc.send('omnidesk-camera:cmd', { type: 'stop' }); } catch { /* gone */ } win.destroy(); }
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { handle.close(); reject(Object.assign(new Error('The camera window did not load.'), { code: 'window-timeout' })); }, 10000);
      routes.set(id, (msg) => {
        if (msg.type === 'ready') { clearTimeout(timer); resolve(handle); return; }
        if (msg.type === 'log') { log(`camera ${file}: ${String(msg.message).slice(0, 200)}`); return; }
        onMsg(msg);
      });
      wc.on('render-process-gone', (_e, d) => { if (!closed) { clearTimeout(timer); onMsg({ type: 'end', reason: `window crashed (${d.reason})` }); handle.close(); } });
      win.on('closed', () => { if (!closed) { forget(); onMsg({ type: 'end', reason: 'window closed' }); } });
      win.loadURL(`${ORIGIN}/${file}`).catch((e) => { clearTimeout(timer); handle.close(); reject(e); });
    });
  }

  async function openCapture(onMsg) {
    ensureSession();
    const win = new BrowserWindow({ show: false, width: 320, height: 240, skipTaskbar: true, focusable: false, title: 'OmniDesk camera', webPreferences: webPreferences() });
    return load(win, 'capture.html', onMsg, { capture: true });
  }

  async function openViewer({ title }, onMsg) {
    ensureSession();
    const win = new BrowserWindow({
      width: 400, height: 300, minWidth: 200, minHeight: 150, show: false, alwaysOnTop: true,
      fullscreenable: false, maximizable: false, autoHideMenuBar: true, backgroundColor: '#000000',
      title: `OmniDesk · ${String(title || 'Camera').slice(0, 80)}`, webPreferences: webPreferences(),
    });
    win.setAlwaysOnTop(true, 'floating');
    win.on('page-title-updated', (e) => e.preventDefault());
    const h = await load(win, 'viewer.html', (msg) => {
      if (msg.type === 'state' && msg.state === 'playing' && msg.width > 0 && msg.height > 0) {
        try { win.setAspectRatio(msg.width / msg.height); } catch { /* optional */ }
      }
      onMsg(msg);
    }, { capture: false });
    win.show();
    return h;
  }

  function cameraAccess() {
    return checkAccess({
      platform: process.platform,
      getStatus: () => systemPreferences.getMediaAccessStatus('camera'),
      ask: () => systemPreferences.askForMediaAccess('camera'),
    });
  }

  function closeAll() { for (const w of [...open]) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* gone */ } } open.clear(); }

  return { openCapture, openViewer, cameraAccess, closeAll };
}

module.exports = { createWindows, checkAccess, CSP, ORIGIN, FILES };
