// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// File clipboard (app/main/files/README.md):
//   create({ peer, devices, engine, log, settings })
//     -> { start(), stop(), get(), set(patch), history(), onItem(cb) }
// Copy files on one computer, paste them on the other. Transfer runs over the
// paired peer channel; received files land in <temp>/OmniDesk/clip-<id>/.

const path = require('node:path');
const { createFiles } = require('./core');
const { createPlatform } = require('./platform');
const { parseDecision } = require('../engine/decisions');

function create({ peer, devices, engine, log = () => {}, settings } = {}) {
  if (!peer || !devices || !settings) throw new Error('files.create needs peer, devices and settings');
  const { app, clipboard } = require('electron');
  return createFiles({
    peer,
    devices,
    engine,
    log,
    settings,
    parseDecision,
    platform: createPlatform({ clipboard }),
    tempRoot: path.join(app.getPath('temp'), 'OmniDesk'),
  });
}

module.exports = { create };
