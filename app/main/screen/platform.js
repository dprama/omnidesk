// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Per-OS source side: can this computer gain a display, and create/remove it.
//   can()                         -> { extendThis, showHere, why? }
//   createDisplay({width,height,refresh}) -> { displayId (Electron display.id as string), remove(), onGone(cb) }
//   cleanupLeftovers(), killAllSync()

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function macMajor(release = os.release()) {
  // Darwin 20 = macOS 11, Darwin 24 = macOS 15.
  const d = parseInt(String(release).split('.')[0], 10);
  return Number.isFinite(d) ? d - 9 : 0;
}

function createPlatform({ electron, log = () => {}, isPackaged = false, resourcesPath = '', userData = '', platform = process.platform }) {
  const { screen: electronScreen, systemPreferences } = electron;
  const markerFile = userData ? path.join(userData, 'screen-virtual-display.json') : '';
  let mac = null;
  let vdd = null;

  if (platform === 'darwin') {
    const { createMacHelper, defaultHelperPath } = require('./mac-helper');
    mac = createMacHelper({ helperPath: defaultHelperPath({ isPackaged, resourcesPath }), log });
  } else if (platform === 'win32') {
    const { createVdd } = require('./windows-vdd');
    vdd = createVdd({ log });
  }

  function screenPermission() {
    try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
  }

  function can() {
    const showHere = electronScreen.getAllDisplays().length > 0;
    const res = { extendThis: false, showHere };
    if (platform === 'darwin') {
      if (macMajor() < 11) res.why = 'Extending this Mac needs macOS 11 or later.';
      else if (!mac.available()) res.why = 'The OmniDesk display helper is missing from this install. Reinstall OmniDesk.';
      else {
        const p = screenPermission();
        if (p === 'denied' || p === 'restricted') {
          res.why = 'OmniDesk needs Screen Recording permission. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart OmniDesk.';
        } else res.extendThis = true; // 'granted', or 'not-determined' (macOS asks on first start)
      }
    } else if (platform === 'win32') {
      const st = vdd.installed();
      if (!st.installed) res.why = st.why;
      else res.extendThis = true;
    } else {
      res.why = 'Extending this computer works on Windows and macOS. Linux can still show another computer\'s screen.';
    }
    if (!showHere && !res.why) res.why = 'No display found on this computer.';
    return res;
  }

  function setMarker(on) {
    if (!markerFile) return;
    try { if (on) fs.writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString() })); else fs.rmSync(markerFile, { force: true }); } catch { /* best effort */ }
  }

  // Wait for a display that wasn't there before (Windows: the VDD monitor).
  function waitForNewDisplay(before, { width, height }, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const fresh = electronScreen.getAllDisplays().filter((d) => !before.has(d.id));
        const px = (d) => [Math.round(d.size.width * d.scaleFactor), Math.round(d.size.height * d.scaleFactor)];
        const exact = fresh.find((d) => { const [w, h] = px(d); return w === width && h === height; });
        const pick = exact || fresh.find((d) => /vdd|virtual/i.test(d.label || '')) || fresh[0];
        if (pick) return resolve(pick);
        if (Date.now() - t0 > timeoutMs) return reject(Object.assign(new Error('The virtual display did not appear.'), { code: 'display-missing' }));
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  async function createDisplay({ width, height, refresh }) {
    if (platform === 'darwin') {
      const d = await mac.create({ width, height, refresh });
      return { displayId: d.displayId, remove: () => d.remove(), onGone: (cb) => d.onExit(() => cb()) };
    }
    if (platform === 'win32') {
      const before = new Set(electronScreen.getAllDisplays().map((d) => d.id));
      setMarker(true);
      try {
        await vdd.enable({ width, height, refresh });
        const disp = await waitForNewDisplay(before, { width, height });
        log(`virtual display ${disp.id} label="${disp.label || ''}" ${disp.size.width}x${disp.size.height}@${disp.scaleFactor}`);
        const gone = new Set();
        const onRemoved = (_e, x) => { if (x && x.id === disp.id) for (const cb of [...gone]) { try { cb(); } catch { /* ignore */ } } };
        electronScreen.on('display-removed', onRemoved);
        return {
          displayId: String(disp.id),
          remove: async () => {
            electronScreen.removeListener('display-removed', onRemoved);
            try { await vdd.disable(); } finally { setMarker(false); }
          },
          onGone: (cb) => { gone.add(cb); },
        };
      } catch (e) {
        await vdd.disable().catch(() => {});
        setMarker(false);
        throw e;
      }
    }
    throw Object.assign(new Error('Extending this computer is not supported on this OS.'), { code: 'unsupported' });
  }

  // After a crash on Windows the VDD monitor may still be on.
  async function cleanupLeftovers() {
    if (platform !== 'win32' || !markerFile || !fs.existsSync(markerFile)) return;
    log('turning off a virtual display left over from the last run');
    try { await vdd.disable(); } catch (e) { log(`leftover cleanup: ${e.message}`); }
    setMarker(false);
  }

  function killAllSync() {
    if (mac) mac.killAll();
    if (vdd && markerFile && fs.existsSync(markerFile)) vdd.disableSync();
  }

  return { can, createDisplay, cleanupLeftovers, killAllSync, screenPermission };
}

module.exports = { createPlatform, macMajor };
