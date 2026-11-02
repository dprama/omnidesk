// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// createApi wiring with fake engine / modules: status counts, module start
// order, monitor layouts over the peer channel, second-screen pause, clipboard merge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApi, clipFromEngine, formatMonitors } = require('./index');
const { createSettings } = require('../settings');

const tick = () => new Promise((r) => setImmediate(r));

function fakeLog() {
  const lines = [];
  const f = (m) => lines.push(m);
  f.warn = f; f.error = f; f.child = () => f; f.tail = () => lines; f.onLine = () => () => {};
  f.lines = lines;
  return f;
}

function fakeEngine() {
  const e = new EventEmitter();
  e.binary = '/fake/deskflow-core';
  e.sent = [];
  e.serverConfigs = [];
  e.st = { running: true, mode: 'server', ipcConnected: true, version: '1', helperPath: e.binary, reason: '' };
  e.status = () => ({ ...e.st });
  e.readSetting = (k) => (k === 'core/computerName' ? 'PC' : undefined);
  e.writeSettings = () => false;
  e.writeServerConfig = (text) => { const changed = e.serverConfigs.at(-1) !== text; e.serverConfigs.push(text); return changed; };
  e.send = async (cmd, value) => { e.sent.push(`${cmd}=${value}`); return true; };
  e.query = async (cmd) => (cmd === 'monitors?' ? '[0,0,2560x1440][2560,180,1920x1080]' : '');
  e.restart = async () => true;
  e.detectVersion = async () => '1';
  return e;
}

function fakePeer() {
  const handlers = new Map();
  const up = new Set();
  return {
    up,
    send: async () => {},
    on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); },
    isConnected: (id) => up.has(id),
    deliver: (type, from, payload) => handlers.get(type)(from, payload, () => {}),
    stop: async () => {},
  };
}

function setup() {
  const settings = createSettings({});
  settings.set('devices', {
    mac: { id: 'mac', name: 'MacBook', engineName: 'MacBook', os: 'macos', paired: true, screens: [{ x: 0, y: 0, w: 1440, h: 900 }] },
    old: { id: 'old', name: 'Old PC', engineName: 'OldPC', os: 'windows', paired: true, screens: [{ x: 0, y: 0, w: 1920, h: 1080 }] },
  });
  settings.set('layout', { placements: { this: { x: 0, y: 0 }, mac: { x: 4480, y: 270 } } });
  const engine = fakeEngine();
  const log = fakeLog();
  const order = [];
  const events = [];
  const screenCbs = [];
  const fileCbs = [];
  let pairedCb = null;
  const mods = {
    pairing: { start() {}, enter() {}, cancel() {}, onPaired: (cb) => { pairedCb = cb; } },
    discovery: { onFound: (cb) => cb([]), linkFor: () => null, setLink: async () => {} },
    screen: { get: () => ({ sessions: [] }), on: (cb) => screenCbs.push(cb), start() {}, stop() {} },
    camera: { get: async () => ({ shared: false, liveDeviceId: null, watchers: [] }), on: () => {}, setShared: async () => ({}), watch: async (id) => ({ watching: id }), unwatch: async () => ({}) },
    files: { onItem: (cb) => fileCbs.push(cb), start: () => order.push('files.start'), stop() {} },
  };
  const args = {};
  const loader = (name, a) => { if (!args[name]) { order.push(name); args[name] = a; } return mods[name]; };
  const peer = fakePeer();
  const peerSent = [];
  peer.send = async (id, type, payload) => { peerSent.push({ id, type, payload }); };
  const api = createApi({
    settings, log, engine, shell: {}, security: { allowMedia: () => () => {}, openExternal: () => true },
    broadcast: (topic, v) => events.push([topic, v]),
    getScreens: () => [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }],
    loader, peerFactory: (a) => { order.push('peer'); args.peer = a; return peer; },
  });
  return { api, settings, engine, log, order, events, screenCbs, fileCbs, args, peer, peerSent, paired: () => pairedCb };
}

test('status: total = paired devices incl. this one, connected = this + online', () => {
  const { api } = setup();
  assert.deepEqual([api.status().connected, api.status().total], [1, 3]);
  api.devices.setOnline('mac', true);
  assert.deepEqual([api.status().connected, api.status().total], [2, 3]);
  api.stop();
});

test('modules start in order with engine + devices passed through', () => {
  const s = setup();
  s.api.startModules();
  assert.deepEqual(s.order, ['pairing', 'peer', 'discovery', 'screen', 'camera', 'files', 'files.start']);
  assert.equal(s.args.discovery.engine, s.engine);
  assert.equal(s.args.discovery.devices, s.api.devices);
  assert.equal(s.args.files.peer, s.peer);
  assert.equal(typeof s.paired(), 'function');
  s.api.stop();
});

test('onPaired rewrites the engine config', () => {
  const s = setup();
  s.api.startModules();
  const n = s.engine.serverConfigs.length;
  s.paired()({ id: 'mac' });
  assert.ok(s.engine.serverConfigs.length > n);
  s.api.stop();
});

test('monitor layouts: sent on peer connect, forwarded as peerMonitors=<engineName>, cleared on disconnect', async () => {
  const s = setup();
  s.api.startModules();
  s.peer.up.add('mac');
  await s.api.__pollPeers();
  await tick();
  assert.deepEqual(s.peerSent, [{ id: 'mac', type: 'engine.monitors', payload: { monitors: '[0,0,2560x1440][2560,180,1920x1080]' } }]);
  s.peer.deliver('engine.monitors', 'mac', { monitors: '[0,0,1440x900]' });
  await tick();
  assert.ok(s.engine.sent.includes('peerMonitors=MacBook:[0,0,1440x900]'));
  s.peer.deliver('engine.monitors', 'mac', { monitors: 'rm -rf' }); // ignored
  // replayed after an engine restart
  s.engine.sent.length = 0;
  s.engine.emit('status', { ipcConnected: false });
  s.engine.emit('status', { ipcConnected: true });
  await tick();
  assert.deepEqual(s.engine.sent, ['peerMonitors=MacBook:[0,0,1440x900]']);
  s.peer.up.delete('mac');
  await s.api.__pollPeers();
  await tick();
  assert.equal(s.engine.sent.at(-1), 'peerMonitors=MacBook:');
  s.api.stop();
});

test('clients never send peerMonitors to their engine', async () => {
  const s = setup();
  s.engine.st.mode = 'client';
  s.api.startModules();
  s.peer.deliver('engine.monitors', 'mac', { monitors: '[0,0,1440x900]' });
  await tick();
  assert.ok(!s.engine.sent.some((x) => x.startsWith('peerMonitors')));
  s.api.stop();
});

test('second screen: no link into the laptop while starting/live, restored after', () => {
  const s = setup();
  s.api.startModules();
  s.api.applyEngineConfig();
  assert.match(s.engine.serverConfigs.at(-1), /= MacBook/);
  s.screenCbs[0]({ sessions: [{ id: 'a', sourceId: 'this', targetId: 'mac', state: 'starting' }] });
  assert.doesNotMatch(s.engine.serverConfigs.at(-1), /= MacBook/);
  s.screenCbs[0]({ sessions: [{ id: 'a', sourceId: 'this', targetId: 'mac', state: 'live' }] });
  assert.doesNotMatch(s.engine.serverConfigs.at(-1), /= MacBook/);
  s.screenCbs[0]({ sessions: [] });
  assert.match(s.engine.serverConfigs.at(-1), /= MacBook/);
  s.api.stop();
});

test('clipboard history merges engine clipboardItem= and file items', async () => {
  const s = setup();
  s.api.startModules();
  s.engine.emit('ipc', 'clipboardItem', JSON.stringify({ kind: 'text', text: 'hi', bytes: 2, from: 'PC', to: '*', at: 1767225600000 }));
  s.fileCbs[0]({ id: 'f1', kind: 'file', from: 'mac', to: 'this', at: 1767225601000, name: 'a.pdf', bytes: 9, progress: 1 });
  const hist = await s.api.methods['clipboard.history'].run();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].id, 'f1');
  assert.equal(hist[1].from, 'this');
  assert.equal(hist[1].to, '*');
  assert.equal(hist[1].at, 1767225600000);
  assert.equal(typeof hist[1].id, 'string');
  s.api.stop();
});

test('clipFromEngine / formatMonitors', () => {
  const ids = { MacBook: 'mac', PC: 'this' };
  const c = clipFromEngine({ kind: 'image', width: 10, height: 20, bytes: 800, from: 'MacBook', to: 'PC', at: 5 }, (n) => ids[n]);
  assert.deepEqual({ ...c, id: 'x' }, { id: 'x', kind: 'image', from: 'mac', to: 'this', at: 5, width: 10, height: 20, bytes: 800 });
  assert.equal(clipFromEngine({ kind: 'exe' }, () => null), null);
  assert.equal(formatMonitors([{ x: -1, y: 0, w: 10, h: 20 }]), '[-1,0,10x20]');
});

test('camera.watch / unwatch are routed to the camera module', async () => {
  const s = setup();
  s.api.startModules();
  assert.deepEqual(await s.api.methods['camera.watch'].run('mac'), { watching: 'mac' });
  assert.ok(s.api.methods['camera.unwatch']);
  s.api.stop();
});

// ---- whose keyboard and mouse: exactly one engine server ----
function roleSetup() {
  const s = setup();
  s.restarts = [];
  s.engine.restart = async (role) => { s.restarts.push(role); return true; };
  s.engine.readSetting = (k) => (k === 'core/computerName' ? 'PC' : undefined);
  s.settings.set('devices', {
    mac: { id: 'mac', name: 'MacBook', engineName: 'MacBook', os: 'macos', paired: true, host: '192.168.1.20', screens: [{ x: 0, y: 0, w: 1440, h: 900 }] },
  });
  return s;
}

test('controller not chosen: every computer picks the first engine name (MacBook < PC)', () => {
  const s = roleSetup();
  assert.equal(s.api.status().controller, 'mac');
  assert.equal(s.api.syncRole({ restart: false }), true);
  assert.deepEqual(s.settings.get('engine'), { role: 'client', serverHost: '192.168.1.20', serverDeviceId: 'mac' });
  assert.deepEqual(s.restarts, []);
  assert.equal(s.api.syncRole(), false); // nothing changed, no restart
  s.api.stop();
});

test('choosing this computer makes it the server and tells the peer, newest choice wins', async () => {
  const s = roleSetup();
  s.api.syncRole({ restart: false });
  s.api.startModules();
  const v = await s.api.methods['mouse.set'].run({ controller: 'this' });
  assert.equal(v.controller, 'this');
  assert.equal(s.settings.get('engine').role, 'server');
  assert.deepEqual(s.restarts, ['server']);
  const msg = s.peerSent.find((m) => m.type === 'engine.controller');
  assert.equal(msg.id, 'mac');
  assert.equal(msg.payload.controller, 'sender');
  // an older choice from the Mac is ignored (and answered with ours)
  s.peerSent.length = 0;
  s.peer.deliver('engine.controller', 'mac', { controller: 'sender', at: msg.payload.at - 1000 });
  assert.equal(s.settings.get('engine').role, 'server');
  assert.equal(s.peerSent.at(-1).payload.controller, 'sender');
  // a newer one from the Mac: the Mac's keyboard and mouse, so this one becomes its client
  s.peer.deliver('engine.controller', 'mac', { controller: 'sender', at: msg.payload.at + 1000 });
  assert.equal(s.api.status().controller, 'mac');
  assert.deepEqual(s.settings.get('engine'), { role: 'client', serverHost: '192.168.1.20', serverDeviceId: 'mac', controller: 'mac', controllerAt: msg.payload.at + 1000 });
  assert.deepEqual(s.restarts, ['server', 'client']);
  // 'receiver' means this computer
  s.peer.deliver('engine.controller', 'mac', { controller: 'receiver', at: msg.payload.at + 2000 });
  assert.equal(s.settings.get('engine').role, 'server');
  s.api.stop();
});

test('controller must be this or a paired device', async () => {
  const s = roleSetup();
  await assert.rejects(async () => s.api.methods['mouse.set'].run({ controller: 'nope' }), (e) => e.code === 'not-found');
  s.api.stop();
});
