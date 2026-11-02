// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// OmniDesk main process: one secure window, the window.omnidesk handlers and
// the deskflow-core supervisor.
//   --smoke-test  load the window, print window.omnidesk keys, quit.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, protocol, session, shell, screen: electronScreen } = require('electron');

const { createLogger } = require('./log');
const { createSettings } = require('./settings');
const security = require('./security');
const router = require('./router');
const { EngineSupervisor } = require('./engine/supervisor');
const { createApi } = require('./api');

const SMOKE = process.argv.includes('--smoke-test');
const BG = '#0c0e13';

// userData folder name "OmniDesk", fixed forever. Smoke tests use a temp folder.
app.setName('OmniDesk');
app.setPath('userData', SMOKE ? fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-smoke-')) : path.join(app.getPath('appData'), 'OmniDesk'));

security.registerScheme(protocol);

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

let allowMediaRef = () => () => {};
// Hook for the screen agent: grant camera/mic/screen capture to a webContents.
function allowMedia(webContents) { return allowMediaRef(webContents); }
module.exports = { allowMedia };

function rendererRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'renderer') : path.join(__dirname, '..', 'renderer');
}

function main() {
  const userData = app.getPath('userData');
  const log = createLogger({ dir: path.join(userData, 'logs'), echo: SMOKE || !app.isPackaged });
  const settings = createSettings({ dir: userData, log });
  let win = null;

  log(`OmniDesk ${app.getVersion()} starting (${process.platform}-${process.arch}, electron ${process.versions.electron}${app.isPackaged ? '' : ', dev'})`);

  const windows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  function broadcast(topic, payload) {
    for (const w of windows()) {
      const wc = w.webContents;
      if (!wc.isDestroyed() && wc.getURL().startsWith('app://omnidesk/')) wc.send('omnidesk:event', topic, payload);
    }
  }

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    const sec = security.createSecurity({
      app, session, shell, log,
      allowHosts: () => {
        const hosts = ['github.com'];
        for (const k of ['siteUrl', 'repoUrl']) { try { hosts.push(new URL(settings.get(k)).hostname); } catch { /* skip */ } }
        return [...new Set(hosts)];
      },
    });
    allowMediaRef = sec.allowMedia;
    security.handleProtocol(protocol, rendererRoot());

    const engine = new EngineSupervisor({
      log,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      repoRoot: path.join(__dirname, '..', '..'),
      userData,
    });

    const getScreens = () => electronScreen.getAllDisplays().map((d) => {
      const b = process.platform === 'win32' ? electronScreen.dipToScreenRect(null, d.bounds) : d.bounds;
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });

    const api = createApi({ settings, log, engine, shell, security: sec, broadcast, getScreens });
    router.register(ipcMain, api.methods, { log });
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      electronScreen.on(ev, () => {
        api.devices.changed();
        if (api.applyEngineConfig()) engine.restart(settings.get('engine').role).catch(() => {});
        api.monitorsChanged();
      });
    }

    // Order: settings -> engine supervisor -> devices (createApi) -> pairing ->
    // peer channel -> discovery -> screen -> camera -> files.
    api.startModules();

    win = createWindow();

    if (SMOKE) return smokeTest(win, engine, log, api);

    api.startPolling();
    api.syncRole({ restart: false }); // server or client, before the first start
    api.applyEngineConfig();
    const role = settings.get('engine').role;
    if (role === 'server' || role === 'client') engine.start(role).catch((e) => log.error(`engine start: ${e.message}`));
    else log('engine off by settings');

    let quitting = false;
    app.on('before-quit', (e) => {
      if (quitting) return;
      quitting = true;
      e.preventDefault();
      api.stop();
      settings.flush();
      engine.stop().finally(() => app.quit());
    });
  });

  app.on('window-all-closed', () => app.quit());

  function createWindow() {
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';
    const w = new BrowserWindow({
      width: 1200,
      height: 780,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: 'OmniDesk',
      backgroundColor: BG,
      ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
      ...(isWin ? { titleBarStyle: 'hidden', titleBarOverlay: { color: BG, symbolColor: '#e8eaf0', height: 36 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    w.once('ready-to-show', () => { if (!SMOKE) w.show(); });
    w.on('closed', () => { if (win === w) win = null; });
    w.loadURL('app://omnidesk/index.html');
    return w;
  }
}

async function smokeTest(win, engine, log, api) {
  const out = (s) => process.stdout.write(s + '\n');
  const fail = (msg) => { out(`SMOKE FAIL ${msg}`); app.exit(1); };
  // OMNIDESK_SMOKE_ENGINE_MS: how long to keep a real engine running (default 1500).
  const engineMs = Math.min(Math.max(parseInt(process.env.OMNIDESK_SMOKE_ENGINE_MS, 10) || 1500, 500), 60000);
  const timer = setTimeout(() => fail('timeout'), 30000 + engineMs);
  try {
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    const keys = await win.webContents.executeJavaScript(`(() => {
      const o = window.omnidesk;
      if (!o) return null;
      const walk = (v, p) => Object.keys(v).flatMap((k) => typeof v[k] === 'function' ? [p + k] : walk(v[k], p + k + '.'));
      return { frozen: Object.isFrozen(o) && Object.isFrozen(o.app), keys: walk(o, ''), ipc: typeof window.ipcRenderer, req: typeof window.require };
    })()`);
    if (!keys) return fail('window.omnidesk missing');
    out(`SMOKE omnidesk keys (${keys.keys.length}): ${keys.keys.join(', ')}`);
    out(`SMOKE frozen=${keys.frozen} ipcRenderer=${keys.ipc} require=${keys.req}`);
    const status = await win.webContents.executeJavaScript('window.omnidesk.status.get()');
    out(`SMOKE status ${JSON.stringify(status)}`);
    const err = await win.webContents.executeJavaScript("window.omnidesk.connection.pairStart().then(() => 'resolved', (e) => JSON.stringify(e))");
    out(`SMOKE pairStart -> ${err}`);
    const bad = await win.webContents.executeJavaScript("window.omnidesk.mouse.set({ cooldownMs: 'x' }).then(() => 'resolved', (e) => e.code)");
    out(`SMOKE mouse.set(bad) -> ${bad}`);
    const first = await win.webContents.executeJavaScript('new Promise((r) => { const u = window.omnidesk.status.on((s) => { u(); r(typeof s.role); }); })');
    out(`SMOKE status.on first value role type=${first}`);
    out(`SMOKE modules ${JSON.stringify(api.modules())}`);
    if (engine.binary) {
      let hello = null;
      engine.ipc.once('connected', (info) => { hello = info; });
      // Like a normal start: write the server config first (a real run rewrites
      // it on its next start, so the temp path does not stick).
      api.applyEngineConfig();
      await engine.start('server');
      const until = Date.now() + engineMs;
      while (Date.now() < until && !hello) await new Promise((r) => setTimeout(r, 200));
      out(`SMOKE ipc hello ${hello ? JSON.stringify(hello) : 'none (engine not answering)'}`);
      if (hello) out(`SMOKE monitors? -> ${await engine.query('monitors?', 'monitors').catch((e) => `error ${e.message}`)}`);
      await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())));
      await engine.stop();
    } else {
      out(`SMOKE engine not found: ${engine.status().reason}`);
    }
    const startLines = log.tail(1000).filter((l) => / start mode=/.test(l));
    out(`SMOKE start lines: ${startLines.length ? startLines.join(' | ') : '(none, engine binary missing)'}`);
    clearTimeout(timer);
    out('SMOKE OK');
    app.exit(0);
  } catch (e) {
    fail(e && e.stack ? e.stack : String(e));
  }
}
