// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Second screen (app/main/INTERFACES.md):
//   create({ engine, log, allowMedia }) -> { get, start, stop, on }
// Both directions: this computer gains a virtual monitor that is streamed to a
// paired laptop (source), or this laptop shows another computer's virtual
// monitor full screen (target). Signalling runs over the pairing peer channel
// (app/main/pairing/peer.js), media over LAN-only WebRTC.

const { createScreen } = require('./core');

function create({ engine, log = () => {}, allowMedia = () => () => {} } = {}) {
  void engine; // edge-crossing pause is derived by main from the sessions in screen.on
  const electron = require('electron');
  const { app } = electron;
  const { createPlatform } = require('./platform');
  const { createMedia } = require('./media');

  const platform = createPlatform({
    electron, log, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, userData: app.getPath('userData'),
  });
  const media = createMedia({ electron, allowMedia, log, isPackaged: app.isPackaged });

  const getPeer = () => {
    let mod;
    try { mod = require('../pairing/peer.js'); } catch { return null; }
    return (typeof mod.current === 'function' && mod.current()) || null;
  };

  const screen = createScreen({ log, platform, media, getPeer });

  platform.cleanupLeftovers().catch(() => {});
  // Always remove the virtual display on quit, crash or kill.
  app.on('before-quit', () => { screen.stopAll().catch(() => {}); });
  // Never leave a virtual monitor behind across sleep: stop before the lid closes.
  try { electron.powerMonitor.on('suspend', () => { screen.stopAll('this computer went to sleep').catch(() => {}); }); } catch (e) { log(`screen: powerMonitor: ${e.message}`); }
  process.on('exit', () => platform.killAllSync());

  return {
    get: () => screen.get(),
    start: (opts) => screen.start(opts),
    stop: (id) => screen.stop(id),
    on: (cb) => screen.on(cb),
  };
}

module.exports = { create };
