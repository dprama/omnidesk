// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Fake engine / devices / settings for pairing and peer tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function fakeDevice(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omnidesk-${label}-`));
  const tlsDir = path.join(dir, 'tls');
  const engine = {
    paths: {
      settingsDir: dir, tlsDir,
      certificate: path.join(tlsDir, 'deskflow.pem'),
      trustedServers: path.join(tlsDir, 'trusted-servers'),
      trustedClients: path.join(tlsDir, 'trusted-clients'),
    },
    readSetting: (k) => (k === 'core/computerName' ? `${label}-engine` : null),
  };
  const store = {};
  const devices = Object.assign(new EventEmitter(), {
    thisDevice: () => ({ name: `Device ${label}`, os: 'macos', osVersion: '15.1', arch: 'arm64', screens: [{ x: 0, y: 0, w: 1920, h: 1080 }] }),
    upsert(rec) { store[rec.id] = { ...(store[rec.id] || {}), ...rec }; devices.emit('change'); return store[rec.id]; },
    record: (id) => store[id] || null,
    list: () => Object.values(store).map((d) => ({ ...d, thisDevice: false, paired: d.paired !== false })),
    store,
  });
  const data = {};
  const settings = {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; return v; },
    patch: (k, v) => { data[k] = { ...(data[k] || {}), ...v, ...(v.fingerprints ? { fingerprints: { ...((data[k] || {}).fingerprints || {}), ...v.fingerprints } } : {}) }; return data[k]; },
    data,
  };
  const lines = [];
  const log = (m) => lines.push(String(m));
  log.warn = log;
  log.error = log;
  log.lines = lines;
  return { dir, engine, devices, settings, log, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

module.exports = { fakeDevice, waitFor };
