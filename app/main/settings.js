// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// App settings, persisted as JSON in <userData>/settings.json (userData folder
// is "OmniDesk"). Engine settings live in the engine's own Deskflow.conf.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  schema: 1,
  engine: { role: 'server', serverHost: '' },
  mouse: { enabled: true, cooldownMs: 300, arrivalGuardMs: 250, lockHotkey: 'Ctrl+Alt+L', locked: false },
  clipboard: { enabled: true, maxFileMB: 100, files: true },
  layout: { placements: {} },
  multi: { enabled: false },
  camera: { shared: false },
  devices: {},
  links: {},
  repoUrl: 'https://github.com/dprama/omnidesk',
  siteUrl: 'https://dprama.github.io/omnidesk/',
  tipUrl: 'https://github.com/sponsors/dprama',
});

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

function createSettings({ dir, log } = {}) {
  const file = dir ? path.join(dir, 'settings.json') : null;
  let data = structuredClone(DEFAULTS);
  if (file) {
    try {
      data = merge(data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      if (e.code !== 'ENOENT' && log) log.warn(`settings unreadable, using defaults: ${e.message}`);
    }
  }
  const listeners = new Set();
  let timer = null;

  function flush() {
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (log) log.error(`settings save failed: ${e.message}`);
    }
  }

  return {
    file,
    get(key) { return structuredClone(key ? data[key] : data); },
    // set(key, value) replaces; patch(key, partial) deep-merges.
    set(key, value) {
      data[key] = structuredClone(value);
      if (!timer) timer = setTimeout(flush, 50);
      for (const cb of listeners) cb(key);
      return structuredClone(data[key]);
    },
    patch(key, partial) { return this.set(key, merge(data[key], partial)); },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    flush() { if (timer) { clearTimeout(timer); } flush(); },
  };
}

module.exports = { createSettings, DEFAULTS, merge };
