// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Device list: this device (live facts) + paired devices (persisted in
// settings.devices, written by pairing through upsert()). Runtime fields
// (online, ping, battery, link) live in memory.

const os = require('node:os');
const { EventEmitter } = require('node:events');
const { ApiError } = require('../errors');
const { cleanComputerName } = require('../engine/paths');
const system = require('./system');

const LINK_TYPES = ['ethernet', 'wifi', 'usb', 'bluetooth'];

function cleanRect(r) {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
}

class DeviceStore extends EventEmitter {
  constructor({ settings, getScreens, getSharing, engineName }) {
    super();
    this.settings = settings;
    this.getScreens = getScreens; // () => Rect[] for this device
    this.getSharing = getSharing; // () => sharing flags for this device
    this.engineNameOfThis = engineName; // () => string
    this.runtime = new Map(); // id -> { online, pingMs, battery, link }
    this.osVersion = os.release();
    system.osVersion().then((v) => { this.osVersion = v; this.changed(); }).catch(() => {});
  }

  rt(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { online: false, pingMs: null, battery: null, link: null });
    return this.runtime.get(id);
  }

  stored() { return this.settings.get('devices') || {}; }

  thisDevice() {
    const saved = this.stored().this || {};
    const r = this.rt('this');
    return {
      id: 'this',
      name: saved.name || os.hostname().replace(/\.local$/, ''),
      os: system.osName(),
      osVersion: this.osVersion,
      arch: system.arch(),
      thisDevice: true,
      online: true,
      paired: true,
      lastSeen: null,
      link: null,
      battery: r.battery,
      screens: this.getScreens().map(cleanRect),
      sharing: this.getSharing(),
    };
  }

  toDevice(d) {
    const r = this.rt(d.id);
    const link = r.link || d.link || null;
    return {
      id: d.id,
      name: d.name || d.id,
      os: ['windows', 'macos', 'linux'].includes(d.os) ? d.os : 'linux',
      osVersion: d.osVersion || '',
      arch: d.arch === 'arm64' ? 'arm64' : 'x64',
      thisDevice: false,
      online: !!r.online,
      paired: d.paired !== false,
      lastSeen: r.online ? null : d.lastSeen || null,
      link: link ? { type: LINK_TYPES.includes(link.type) ? link.type : 'wifi', pingMs: r.pingMs, available: (link.available || [link.type]).filter((x) => LINK_TYPES.includes(x)) } : null,
      battery: r.battery || d.battery || null,
      screens: (d.screens || []).map(cleanRect),
      sharing: { mouse: true, clipboard: true, screen: false, camera: false, ...(d.sharing || {}) },
    };
  }

  list() {
    const stored = this.stored();
    return [this.thisDevice(), ...Object.values(stored).filter((d) => d && d.id && d.id !== 'this').map((d) => this.toDevice(d))];
  }

  get(id) { return this.list().find((d) => d.id === id) || null; }

  // Internal record (has engineName, host) for engine config / ping.
  record(id) {
    if (id === 'this') return { id: 'this', engineName: this.engineNameOfThis(), screens: this.thisDevice().screens };
    const d = this.stored()[id];
    if (!d) return null;
    return { ...d, engineName: d.engineName || cleanComputerName(d.name) || d.id };
  }

  records() { return this.list().map((d) => this.record(d.id)).filter(Boolean); }

  idForEngineName(name) {
    if (!name) return null;
    const lower = String(name).toLowerCase();
    return this.records().find((r) => String(r.engineName).toLowerCase() === lower)?.id || null;
  }

  // For pairing/discovery: add or update a paired device.
  upsert(partial) {
    if (!partial || typeof partial.id !== 'string' || partial.id === 'this') throw new Error('upsert needs a device id');
    const all = this.stored();
    all[partial.id] = { ...(all[partial.id] || {}), ...partial };
    this.settings.set('devices', all);
    this.changed();
    return this.get(partial.id);
  }

  rename(id, name) {
    const clean = String(name).trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > 64) throw new ApiError('bad-name', 'Use a name between 1 and 64 characters.');
    const all = this.stored();
    if (id !== 'this' && !all[id]) throw new ApiError('not-found', 'That device is not paired.');
    all[id] = { ...(all[id] || { id }), id, name: clean };
    this.settings.set('devices', all);
    this.changed();
    return this.get(id);
  }

  forget(id) {
    if (id === 'this') throw new ApiError('bad-args', 'This device can’t be forgotten.');
    const all = this.stored();
    if (!all[id]) throw new ApiError('not-found', 'That device is not paired.');
    delete all[id];
    this.settings.set('devices', all);
    this.runtime.delete(id);
    const layout = this.settings.get('layout') || {};
    const placements = layout.placements || {};
    if (placements[id]) { delete placements[id]; this.settings.set('layout', { ...layout, placements }); }
    this.changed();
    this.emit('forgotten', id);
    return true;
  }

  setOnline(id, online) {
    if (id === 'this') return;
    const r = this.rt(id);
    if (r.online === !!online) return;
    r.online = !!online;
    if (!online) {
      const all = this.stored();
      if (all[id]) { all[id].lastSeen = new Date().toISOString(); this.settings.set('devices', all); }
      r.pingMs = null;
    }
    this.changed();
  }

  setRuntime(id, patch) {
    Object.assign(this.rt(id), patch);
    this.changed();
  }

  changed() { this.emit('change'); }
}

module.exports = { DeviceStore, LINK_TYPES };
