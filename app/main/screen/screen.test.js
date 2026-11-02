// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// State machine tests with fakes for the peer channel, the virtual display
// (driver/helper) and the WebRTC windows. Two createScreen instances talk to
// each other through an in-memory peer pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreen, validSignal } = require('./core');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await tick(5); }
}

// In-memory peer channel with the peer.js API: send, request, on, isConnected.
function peerPair(idA = 'pc', idB = 'mac') {
  const handlers = { [idA]: new Map(), [idB]: new Map() };
  const state = { connected: true, log: [] };
  function make(me, other) {
    const deliver = (type, payload) => {
      const fns = handlers[other].get(type);
      if (!fns || !fns.size) return Promise.reject(Object.assign(new Error(`no handler ${type}`), { code: 'no-handler' }));
      const json = JSON.parse(JSON.stringify(payload)); // like the wire
      return new Promise((resolve, reject) => {
        const reply = (v) => resolve(v);
        reply.error = (e) => reject(e);
        for (const fn of fns) {
          try {
            const r = fn(me, json, reply);
            if (r && typeof r.then === 'function') r.then((v) => { if (v !== undefined) resolve(v); }, reject);
            else if (r !== undefined) resolve(r);
          } catch (e) { reject(e); }
        }
      });
    };
    return {
      send(to, type, payload) { state.log.push([me, type, payload]); if (!state.connected || to !== other) return Promise.reject(new Error('offline')); deliver(type, payload).catch(() => {}); return Promise.resolve(); },
      request(to, type, payload) { state.log.push([me, type, payload]); if (!state.connected || to !== other) return Promise.reject(new Error('offline')); return deliver(type, payload); },
      on(type, fn) { if (!handlers[me].has(type)) handlers[me].set(type, new Set()); handlers[me].get(type).add(fn); return () => handlers[me].get(type).delete(fn); },
      isConnected(to) { return state.connected && to === other; },
    };
  }
  return { a: make(idA, idB), b: make(idB, idA), state };
}

function fakePlatform({ extendThis = true, showHere = true, why, failCreate = false, createDelay = 0 } = {}) {
  const p = {
    displays: new Set(), created: 0, removed: 0, calls: 0,
    can: () => ({ extendThis, showHere, ...(why ? { why } : {}) }),
    async createDisplay({ width, height, refresh }) {
      p.calls++;
      await tick(createDelay);
      if (failCreate) throw Object.assign(new Error('driver missing'), { code: 'vdd-failed' });
      const id = String(1000 + ++p.created);
      p.displays.add(id);
      p.last = { width, height, refresh };
      const gone = [];
      p.vanish = () => { p.displays.delete(id); for (const cb of gone) cb(); };
      return { displayId: id, remove: async () => { p.displays.delete(id); p.removed++; }, onGone: (cb) => gone.push(cb) };
    },
  };
  return p;
}

// Fake windows: the source "renderer" makes an offer, the viewer answers,
// then both report connected/playing and stats.
function fakeMedia({ autoConnect = true, viewerFails = false } = {}) {
  const m = { opened: [], closed: 0, handles: [] };
  function handle(kind, cfg, onMsg) {
    const h = {
      kind, cfg, onMsg, sent: [], closed: false,
      send(cmd) {
        h.sent.push(cmd);
        if (!autoConnect || cmd.type !== 'signal') return;
        if (kind === 'viewer' && cmd.kind === 'offer') {
          setTimeout(() => {
            onMsg({ type: 'signal', kind: 'answer', data: { type: 'answer', sdp: 'v=0\r\n' } });
            onMsg({ type: 'signal', kind: 'ice', data: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
            onMsg({ type: 'state', state: 'playing' });
            onMsg({ type: 'stats', fps: 59, latencyMs: 42 });
          }, 1);
        }
        if (kind === 'source' && cmd.kind === 'answer') setTimeout(() => { onMsg({ type: 'state', state: 'connected' }); onMsg({ type: 'stats', fps: 60, latencyMs: 5 }); }, 1);
      },
      close() { if (!h.closed) { h.closed = true; m.closed++; } },
    };
    m.handles.push(h);
    return h;
  }
  m.findCaptureSource = async (displayId) => `screen:${displayId}:0`;
  m.openSource = async (cfg, onMsg) => {
    m.opened.push(['source', cfg]);
    const h = handle('source', cfg, onMsg);
    if (autoConnect) setTimeout(() => onMsg({ type: 'signal', kind: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' } }), 1);
    return h;
  };
  m.openViewer = async (cfg, onMsg) => {
    if (viewerFails) throw Object.assign(new Error('no display'), { code: 'viewer-failed' });
    m.opened.push(['viewer', cfg]);
    return handle('viewer', cfg, onMsg);
  };
  return m;
}

function pair(opts = {}) {
  const peers = peerPair();
  const pcPlat = fakePlatform(opts.pc), macPlat = fakePlatform(opts.mac);
  const pcMedia = fakeMedia(opts.pcMedia), macMedia = fakeMedia(opts.macMedia);
  let n = 0;
  const common = { startTimeoutMs: 300, stopTimeoutMs: 200, requestTimeoutMs: 200, watchdogMs: 20, statsStaleMs: 10000, ...(opts.common || {}) };
  const pc = createScreen({ platform: pcPlat, media: pcMedia, getPeer: () => peers.a, newId: () => `aaaaaaaaaaaaaaa${++n}`, ...common });
  const mac = createScreen({ platform: macPlat, media: macMedia, getPeer: () => peers.b, newId: () => `bbbbbbbbbbbbbbb${++n}`, ...common });
  return { peers, pc, mac, pcPlat, macPlat, pcMedia, macMedia, done: () => { pc.dispose(); mac.dispose(); return Promise.all([pc.stopAll(), mac.stopAll()]); } };
}

const START = { resolution: '2560x1600', refresh: 60, quality: 'balanced' };

test('get() has the API shape', () => {
  const t = pair();
  const v = t.pc.get();
  assert.deepEqual(Object.keys(v).sort(), ['can', 'options', 'sessions']);
  assert.deepEqual(v.options, { resolutions: ['1920x1080', '2560x1600'], refresh: [60], quality: ['latency', 'balanced', 'sharp'] });
  assert.deepEqual(v.can, { extendThis: true, showHere: true });
  return t.done();
});

test('PC extends onto the Mac: starting -> live -> stopping -> gone, display removed', async () => {
  const t = pair();
  const pcStates = []; const macStates = [];
  t.pc.on((v) => pcStates.push(v.sessions[0] ? v.sessions[0].state : 'none'));
  t.mac.on((v) => macStates.push(v.sessions[0] ? v.sessions[0].state : 'none'));
  const s = t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  assert.equal(s.state, 'starting');
  assert.deepEqual(Object.keys(s).sort(), ['fps', 'id', 'latencyMs', 'quality', 'refresh', 'resolution', 'sourceId', 'state', 'targetId']);
  await until(() => t.pc.get().sessions[0]?.state === 'live' && t.mac.get().sessions[0]?.state === 'live');
  assert.deepEqual(t.pcPlat.last, { width: 2560, height: 1600, refresh: 60 });
  assert.equal(t.pcMedia.opened[0][1].chromeMediaSourceId, 'screen:1001:0');
  const macSess = t.mac.get().sessions[0];
  assert.equal(macSess.sourceId, 'pc');
  assert.equal(macSess.targetId, 'this');
  assert.equal(macSess.id, s.id);
  await until(() => t.pc.get().sessions[0].latencyMs === 42); // viewer's measurement relayed
  assert.equal(t.pc.get().sessions[0].fps, 60);
  await t.pc.stop(s.id);
  assert.equal(t.pc.get().sessions.length, 0);
  assert.equal(t.pcPlat.displays.size, 0, 'virtual display removed');
  await until(() => t.mac.get().sessions.length === 0);
  assert.ok(t.macMedia.handles.every((h) => h.closed), 'viewer closed');
  assert.ok(pcStates.includes('starting') && pcStates.includes('live') && pcStates.includes('stopping'));
  assert.ok(macStates.includes('live') && macStates.includes('stopping'));
  await t.done();
});

test('Mac asks the PC to extend onto it (target-initiated)', async () => {
  const t = pair();
  const s = t.mac.start({ sourceId: 'pc', targetId: 'this', ...START, quality: 'latency' });
  assert.equal(s.sourceId, 'pc');
  await until(() => t.mac.get().sessions[0]?.state === 'live' && t.pc.get().sessions[0]?.state === 'live');
  assert.equal(t.pc.get().sessions[0].id, s.id);
  assert.equal(t.pc.get().sessions[0].quality, 'latency');
  await t.mac.stop(s.id); // the viewer side stops
  await until(() => t.pc.get().sessions.length === 0);
  assert.equal(t.pcPlat.displays.size, 0);
  await t.done();
});

test('viewer Esc-twice (end message) stops both sides and removes the display', async () => {
  const t = pair();
  t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t.mac.get().sessions[0]?.state === 'live' && t.pc.get().sessions[0]?.state === 'live');
  t.macMedia.handles[0].onMsg({ type: 'end', reason: 'user' });
  await until(() => t.pc.get().sessions.length === 0 && t.mac.get().sessions.length === 0);
  assert.equal(t.pcPlat.removed, 1);
  await t.done();
});

test('failure while creating the display cleans up both sides', async () => {
  const t = pair({ pc: { failCreate: true } });
  t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t.pc.get().sessions.length === 0 && t.mac.get().sessions.length === 0);
  assert.ok(t.macMedia.handles.every((h) => h.closed));
  await t.done();
});

test('start timeout: no WebRTC connection -> stopped, display removed', async () => {
  const t = pair({ pcMedia: { autoConnect: false }, macMedia: { autoConnect: false } });
  t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t.pcPlat.created === 1);
  await until(() => t.pc.get().sessions.length === 0, 2000);
  assert.equal(t.pcPlat.displays.size, 0);
  await until(() => t.mac.get().sessions.length === 0);
  await t.done();
});

test('stop while the display is still being created still removes it', async () => {
  const t = pair({ pc: { createDelay: 60 } });
  const s = t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t.pcPlat.calls === 1); // creation in flight
  await t.pc.stop(s.id);
  await tick(120);
  assert.equal(t.pcPlat.created, 1);
  assert.equal(t.pcPlat.displays.size, 0, 'late display removed');
  await t.done();
});

test('link lost while live: watchdog stops and removes display', async () => {
  const t = pair();
  t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t.pc.get().sessions[0]?.state === 'live');
  t.peers.state.connected = false;
  await until(() => t.pc.get().sessions.length === 0 && t.mac.get().sessions.length === 0);
  assert.equal(t.pcPlat.displays.size, 0);
  await t.done();
});

test('can() and argument checks', async () => {
  const t = pair({ pc: { extendThis: false, why: 'driver not installed' }, mac: { showHere: false, why: 'no display' } });
  assert.throws(() => t.pc.start({ sourceId: 'this', targetId: 'mac', ...START }), { code: 'unsupported', message: 'driver not installed' });
  assert.throws(() => t.pc.start({ sourceId: 'mac', targetId: 'mac', ...START }), { code: 'bad-args' });
  assert.throws(() => t.pc.start({ sourceId: 'this', targetId: 'mac', ...START, resolution: '800x600' }), { code: 'bad-args' });
  assert.throws(() => t.pc.start({ sourceId: 'this', targetId: 'mac', ...START, quality: 'ultra' }), { code: 'bad-args' });
  assert.throws(() => t.pc.start({ sourceId: 'this', targetId: 'nobody', ...START }), { code: 'offline' });
  // Mac asks the PC, PC can't extend: Mac's session ends with the refusal.
  const t2 = pair({ pc: { extendThis: false, why: 'no driver' } });
  t2.mac.start({ sourceId: 'pc', targetId: 'this', ...START });
  await until(() => t2.mac.get().sessions.length === 0);
  // Target can't show: the source session ends and never creates a display.
  t.peers.state.connected = true;
  const t3 = pair({ mac: { showHere: false, why: 'no display' } });
  t3.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t3.pc.get().sessions.length === 0);
  assert.equal(t3.pcPlat.created, 0);
  await Promise.all([t.done(), t2.done(), t3.done()]);
});

test('no peer channel yet -> not-ready', () => {
  const s = createScreen({ platform: fakePlatform(), media: fakeMedia(), getPeer: () => null });
  assert.throws(() => s.start({ sourceId: 'this', targetId: 'mac', ...START }), { code: 'not-ready' });
  s.dispose();
});

test('second session with the same device is refused', async () => {
  const t = pair();
  t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  assert.throws(() => t.pc.start({ sourceId: 'this', targetId: 'mac', ...START }), { code: 'busy' });
  await t.done();
});

test('validSignal accepts host ICE only and bounds sizes', () => {
  const id = 'aaaaaaaaaaaaaaaa';
  assert.ok(validSignal({ sessionId: id, kind: 'offer', data: { type: 'offer', sdp: 'v=0' } }));
  assert.ok(!validSignal({ sessionId: id, kind: 'offer', data: { type: 'answer', sdp: 'v=0' } }));
  assert.ok(!validSignal({ sessionId: id, kind: 'offer', data: { type: 'offer', sdp: 'x'.repeat(70000) } }));
  assert.ok(validSignal({ sessionId: id, kind: 'ice', data: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } }));
  assert.ok(!validSignal({ sessionId: id, kind: 'ice', data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ srflx raddr 0.0.0.0 rport 0', sdpMid: '0', sdpMLineIndex: 0 } }));
  assert.ok(!validSignal({ sessionId: '../x', kind: 'offer', data: { type: 'offer', sdp: 'v=0' } }));
});

test('regression: the virtual display vanishing mid-session (helper crash, driver off) ends the session on both sides', async () => {
  const t = pair();
  t.pc.start({ sourceId: 'this', targetId: 'mac', ...START });
  await until(() => t.pc.get().sessions[0]?.state === 'live' && t.mac.get().sessions[0]?.state === 'live');
  t.pcPlat.vanish();
  await until(() => t.pc.get().sessions.length === 0 && t.mac.get().sessions.length === 0);
  assert.ok(t.pcMedia.handles.every((h) => h.closed), 'capture window closed');
  assert.ok(t.macMedia.handles.every((h) => h.closed), 'viewer closed on the laptop');
  assert.ok(t.peers.state.log.some(([from, type, p]) => from === 'pc' && type === 'screen.stop' && /virtual display went away/.test(p.reason)));
  await t.done();
});
