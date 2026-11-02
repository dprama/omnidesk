// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
// Tiny headless-Chrome renderer over the DevTools protocol (CDP).
// No npm dependencies: uses Node's built-in WebSocket (Node >= 22) and child_process.
// Used by build/dmg/render.mjs and build/icons/make.mjs.
//
// Chrome is found via $CHROME_PATH, then the usual install locations per OS.
// Network is switched off for every page: everything rendered must be local.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function which(cmd) {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' })
      .split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}

export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ],
    win32: [
      `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    linux: [],
  }[process.platform] || [];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const p = which(c);
    if (p) return p;
  }
  throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
}

export async function launch() {
  const bin = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'omnidesk-render-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb',
    '--font-render-hinting=none', '--allow-file-access-from-files',
  ];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start in 30 s')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`Chrome exited (${code}): ${buf}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const waitFor = (method, sessionId) => new Promise((resolve) => {
    const l = (msg) => {
      if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
        listeners.delete(l); resolve(msg.params);
      }
    };
    listeners.add(l);
  });

  async function screenshot({ url, html, width, height, scale = 1, transparent = false, out }) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Page.enable');
    await s('Network.enable');
    await s('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    if (transparent) await s('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    let tmpFile;
    if (html) {
      tmpFile = join(profile, `page-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
      writeFileSync(tmpFile, html);
      url = 'file://' + tmpFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:');
    }
    const loaded = waitFor('Page.loadEventFired', sessionId);
    await s('Page.navigate', { url });
    await loaded;
    // Wait for web fonts and two frames so everything is painted.
    await s('Runtime.evaluate', {
      expression: 'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))',
      awaitPromise: true,
    });
    const { data } = await s('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    await send('Target.closeTarget', { targetId });
    const buf = Buffer.from(data, 'base64');
    if (out) writeFileSync(out, buf);
    return buf;
  }

  async function close() {
    try { await send('Browser.close'); } catch { /* already gone */ }
    ws.close();
    await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.on('exit', r); setTimeout(r, 3000); });
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may hold locks */ }
  }

  return { screenshot, close };
}

// Read width/height from a PNG header.
export function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
