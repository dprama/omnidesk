// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Exposes exactly window.omnidesk (docs/API.md), frozen. ipcRenderer itself is
// never exposed. Calls go to ipcMain.handle('omnidesk:<area>.<method>'); events
// arrive on 'omnidesk:event' as (topic, payload).

const { contextBridge, ipcRenderer } = require('electron');

function call(name, ...args) {
  return ipcRenderer.invoke(`omnidesk:${name}`, ...args).then((res) => {
    if (res && res.ok) return res.value;
    const err = (res && res.error) || { code: 'internal', message: 'Something went wrong inside OmniDesk.' };
    return Promise.reject({ code: String(err.code), message: String(err.message) });
  });
}

const subscribers = new Map(); // topic -> Set<cb>

ipcRenderer.on('omnidesk:event', (_event, topic, payload) => {
  const set = subscribers.get(topic);
  if (!set) return;
  for (const cb of [...set]) {
    try { cb(payload); } catch (e) { console.error(e); }
  }
});

// Subscribe; the current value (if the topic has one) is delivered first.
function subscribe(topic, cb) {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  let active = true;
  let live = false;
  const queue = [];
  const wrapped = (v) => { if (!active) return; if (live) cb(v); else queue.push(v); };
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add(wrapped);
  call('topic.current', topic)
    .then((v) => { if (active && v !== null && v !== undefined && !queue.length) cb(v); })
    .catch(() => {})
    .finally(() => { live = true; for (const v of queue.splice(0)) if (active) cb(v); });
  return () => {
    active = false;
    const set = subscribers.get(topic);
    if (set) set.delete(wrapped);
  };
}

const fn = (name) => (...args) => call(name, ...args);
const on = (topic) => (cb) => subscribe(topic, cb);

const api = {
  app: {
    info: fn('app.info'),
    openExternal: fn('app.openExternal'),
    logs: { tail: fn('app.logs.tail'), onLine: on('logs.line') },
  },
  status: { get: fn('status.get'), on: on('status') },
  devices: { list: fn('devices.list'), on: on('devices'), rename: fn('devices.rename'), forget: fn('devices.forget') },
  mouse: { get: fn('mouse.get'), set: fn('mouse.set'), onCursor: on('mouse.cursor'), onDecision: on('mouse.decision') },
  layout: { get: fn('layout.get'), set: fn('layout.set') },
  clipboard: { get: fn('clipboard.get'), set: fn('clipboard.set'), history: fn('clipboard.history'), onItem: on('clipboard.item') },
  screen: { get: fn('screen.get'), start: fn('screen.start'), stop: fn('screen.stop'), on: on('screen') },
  camera: { get: fn('camera.get'), setShared: fn('camera.setShared'), on: on('camera'), watch: fn('camera.watch'), unwatch: fn('camera.unwatch') },
  connection: {
    onFound: on('connection.found'),
    pairStart: fn('connection.pairStart'),
    pairEnter: fn('connection.pairEnter'),
    pairCancel: fn('connection.pairCancel'),
    setLink: fn('connection.setLink'),
  },
  multi: { get: fn('multi.get'), set: fn('multi.set') },
  feedback: { systemInfo: fn('feedback.systemInfo'), send: fn('feedback.send') },
  tip: { open: fn('tip.open') },
};

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

contextBridge.exposeInMainWorld('omnidesk', deepFreeze(api));
