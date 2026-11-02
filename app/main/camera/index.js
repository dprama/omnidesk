// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Camera (docs/API.md camera.*, multi-device mode):
//   create({ peer, devices, log, allowMedia, settings, multi }) -> { get, setShared, on, watch, unwatch }
// One switch shares this computer's camera with every paired device; one camera
// runs at a time across the desk, and only while someone watches. A watcher sees
// it in a small always-on-top OmniDesk window. Signalling over the pairing peer
// channel, media over LAN-only WebRTC. See ./README.md.

const { createCamera } = require('./core');

function create({ peer = null, devices, log = () => {}, allowMedia = () => () => {}, settings, multi } = {}) {
  const electron = require('electron');
  const { app } = electron;
  const { createWindows } = require('./windows');

  const windows = createWindows({ electron, allowMedia, log, isPackaged: app.isPackaged });

  const getPeer = () => {
    if (typeof peer === 'function') return peer();
    if (peer) return peer;
    let mod;
    try { mod = require('../pairing/peer.js'); } catch { return null; }
    return (typeof mod.current === 'function' && mod.current()) || null;
  };
  const multiGet = () => {
    if (multi && typeof multi.get === 'function') return multi.get();
    if (typeof multi === 'function') return multi();
    return settings.get('multi');
  };

  const camera = createCamera({ log, getPeer, devices, settings, multi: multiGet, windows });

  // The camera light must go off on quit, crash or kill.
  app.on('before-quit', () => { try { camera.shutdown(); } finally { windows.closeAll(); } });

  return {
    get: () => camera.get(),
    setShared: (on) => camera.setShared(on),
    on: (cb) => camera.on(cb),
    watch: (deviceId) => camera.watch(deviceId),
    unwatch: (deviceId) => camera.unwatch(deviceId),
  };
}

module.exports = { create };
