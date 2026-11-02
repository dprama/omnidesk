// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Camera state machine tests: several createCamera instances talk through an
// in-memory peer hub, with fake devices, settings, windows and camera access.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCamera, MULTI_OFF } = require('./core');
const { checkAccess } = require('./windows');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await tick(2); }
}

const PC = 'aaaa000000000000a001';
const MAC = 'bbbb000000000000b002';
const MINI = 'cccc000000000000c003';
const OFFER = { type: 'offer', sdp: 'v=0\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\n' };

// In-memory peer network with the peer.js API. hold() queues messages until flush().
function hub() {
  const handlers = new Map(); // id -> Map(type -> Set)
  const down = new Set(); // ids that are offline
  const queue = [];
  let holding = false;
  const log = [];
  const up = (a, b) => !down.has(a) && !down.has(b) && handlers.has(b);
  function deliver(from, to, type, payload) {
    const fns = handlers.get(to).get(type);
    if (!fns || !fns.size) return Promise.reject(Object.assign(new Error('no handler'), { code: 'no-handler' }));
    const json = JSON.parse(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      for (const fn of fns) {
        try {
          const r = fn(from, json, () => {});
          if (r && typeof r.then === 'function') r.then(resolve, reject); else resolve(r);
        } catch (e) { reject(e); }
      }
    });
  }
  function peerFor(me) {
    handlers.set(me, new Map());
    return {
      send(to, type, payload) {
        log.push([me, to, type, payload]);
        if (!up(me, to)) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
        const run = () => { if (up(me, to)) deliver(me, to, type, payload).catch(() => {}); };
        if (holding) queue.push(run); else queueMicrotask(run);
        return Promise.resolve();
      },
      request(to, type, payload) {
        log.push([me, to, type, payload]);
        if (!up(me, to)) return Promise.reject(Object.assign(new Error('offline'), { code: 'offline' }));
        return deliver(me, to, type, payload);
      },
      on(type, fn) { const m = handlers.get(me); if (!m.has(type)) m.set(type, new Set()); m.get(type).add(fn); return () => m.get(type).delete(fn); },
      isConnected(to) { return up(me, to); },
    };
  }
  return {
    peerFor, down, log,
    hold() { holding = true; },
    flush({ reverse = false } = {}) { holding = false; const q = queue.splice(0); if (reverse) q.reverse(); for (const run of q) run(); },
  };
}

function fakeWindows({ access = { ok: true }, cameraError = null } = {}) {
  const w = { captures: [], viewers: [], access };
  w.cameraAccess = async () => w.access;
  w.openCapture = async (onMsg) => {
    const h = { sent: [], closed: false, onMsg, send(cmd) { h.sent.push(cmd); if (cmd.type === 'start') queueMicrotask(() => onMsg(cameraError ? { type: 'error', message: cameraError } : { type: 'camera', ok: true })); }, close() { h.closed = true; } };
    w.captures.push(h);
    return h;
  };
  w.openViewer = async (cfg, onMsg) => {
    const h = { cfg, sent: [], closed: false, onMsg, send(cmd) { h.sent.push(cmd); }, close() { h.closed = true; } };
    w.viewers.push(h);
    return h;
  };
  w.liveCapture = () => w.captures.find((c) => !c.closed) || null;
  w.liveViewer = () => w.viewers.find((v) => !v.closed) || null;
  return w;
}

function fakeDevices(self, ids, net) {
  const fns = new Set();
  return {
    list: () => [{ id: 'this', thisDevice: true, name: self, online: true, paired: true },
      ...ids.filter((id) => id !== self).map((id) => ({ id, name: `dev-${id.slice(0, 4)}`, thisDevice: false, paired: true, online: !net.down.has(id) && !net.down.has(self) }))],
    get(id) { return this.list().find((d) => d.id === id) || null; },
    on(ev, fn) { if (ev === 'change') fns.add(fn); },
    off(ev, fn) { fns.delete(fn); },
    changed() { for (const fn of fns) fn(); },
  };
}

function fakeSettings(init = {}) {
  const data = { camera: { shared: false }, multi: { enabled: true }, ...init };
  return { data, get: (k) => data[k], patch: (k, v) => { data[k] = { ...(data[k] || {}), ...v }; return data[k]; } };
}

// A desk of devices; every device has its own camera instance.
function desk(ids = [PC, MAC, MINI], opts = {}) {
  const net = hub();
  const d = { net };
  for (const id of ids) {
    const settings = fakeSettings(opts.settings && opts.settings[id]);
    const windows = fakeWindows(opts.windows && opts.windows[id]);
    const devices = fakeDevices(id, ids, net);
    const p = net.peerFor(id);
    let clock = 1000;
    const now = (opts.now && opts.now[id]) || (() => ++clock);
    const cam = createCamera({ getPeer: () => p, devices, settings, multi: () => settings.get('multi'), windows, now, watchdogMs: 60000, startTimeoutMs: 2000 });
    d[id] = { cam, settings, windows, devices, peer: p };
  }
  d.all = () => ids.map((id) => d[id]);
  d.close = () => { for (const id of ids) d[id].cam.shutdown(); };
  return d;
}

// ---------------------------------------------------------------------------

test('multi-device mode off: setShared(true) and watch reject with multi-off', async () => {
  const d = desk([PC, MAC], { settings: { [PC]: { multi: { enabled: false } }, [MAC]: { multi: { enabled: false } } } });
  await assert.rejects(d[PC].cam.setShared(true), (e) => { assert.deepEqual(e, { code: 'multi-off', message: 'Turn on multi-device mode to share your camera.' }); return true; });
  assert.deepEqual(MULTI_OFF, { code: 'multi-off', message: 'Turn on multi-device mode to share your camera.' });
  await assert.rejects(d[MAC].cam.watch(PC), { code: 'multi-off' });
  assert.equal(d[PC].settings.data.camera.shared, false);
  assert.deepEqual(d[PC].cam.get(), { shared: false, liveDeviceId: null, watchers: [] });
  // Turning it off is always allowed.
  assert.equal((await d[PC].cam.setShared(false)).shared, false);
  d.close();
});

test('turning multi-device mode off stops sharing', async () => {
  const d = desk([PC, MAC]);
  await d[PC].cam.setShared(true);
  d[PC].settings.data.multi = { enabled: false };
  d[PC].cam.scan();
  assert.equal(d[PC].cam.get().shared, false);
  assert.equal(d[PC].cam.get().liveDeviceId, null);
  await until(() => d[MAC].cam.get().liveDeviceId === null);
  d.close();
});

test('setShared(true) announces to every online device; the camera stays off with nobody watching', async () => {
  const d = desk();
  const seen = [];
  d[MAC].cam.on((v) => seen.push(v));
  const v = await d[PC].cam.setShared(true);
  assert.deepEqual(v, { shared: true, liveDeviceId: 'this', watchers: [] });
  assert.equal(d[PC].settings.data.camera.shared, true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC && d[MINI].cam.get().liveDeviceId === PC);
  assert.deepEqual(d[MAC].cam.get(), { shared: false, liveDeviceId: PC, watchers: [] });
  assert.ok(seen.some((x) => x.liveDeviceId === PC));
  const sent = d.net.log.filter(([from, , type]) => from === PC && type === 'camera.state').map(([, to]) => to);
  assert.deepEqual(sent.sort(), [MAC, MINI].sort());
  assert.equal(d[PC].windows.captures.length, 0, 'no camera without watchers');
  d.close();
});

test('a device that comes online later is told who shares', async () => {
  const d = desk();
  d.net.down.add(MINI);
  d[PC].devices.changed();
  await d[PC].cam.setShared(true);
  await tick();
  assert.equal(d[MINI].cam.get().liveDeviceId, null);
  d.net.down.delete(MINI);
  d[PC].devices.changed();
  await until(() => d[MINI].cam.get().liveDeviceId === PC);
  d.close();
});

test('watch: camera starts, watchers update on every device, signalling flows, unwatch turns the camera off', async () => {
  const d = desk();
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);

  await d[MAC].cam.watch(PC);
  const cap = d[PC].windows.liveCapture();
  assert.ok(cap, 'capture window opened');
  assert.deepEqual(cap.sent.map((c) => c.type), ['start', 'add']);
  const sessionId = cap.sent[1].sessionId;
  const viewer = d[MAC].windows.liveViewer();
  assert.equal(viewer.cfg.sessionId, sessionId);
  assert.deepEqual(d[PC].cam.get().watchers, [MAC]);
  await until(() => d[MINI].cam.get().watchers.length === 1);
  assert.deepEqual(d[MINI].cam.get().watchers, [MAC]);
  assert.deepEqual(d[MAC].cam.get().watchers, ['this']);

  // Offer from the capture window reaches the viewer; the answer goes back.
  cap.onMsg({ type: 'signal', sessionId, kind: 'offer', data: OFFER });
  await until(() => viewer.sent.some((c) => c.type === 'signal' && c.kind === 'offer'));
  viewer.onMsg({ type: 'signal', kind: 'answer', data: ANSWER });
  await until(() => cap.sent.some((c) => c.type === 'signal' && c.kind === 'answer' && c.sessionId === sessionId));
  // Non-host ICE is dropped.
  viewer.onMsg({ type: 'signal', kind: 'ice', data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ srflx', sdpMid: '0', sdpMLineIndex: 0 } });
  await tick(5);
  assert.ok(!cap.sent.some((c) => c.kind === 'ice'));

  // Second watcher shares the same camera.
  await d[MINI].cam.watch(PC);
  assert.equal(d[PC].windows.captures.length, 1);
  assert.deepEqual(d[PC].cam.get().watchers.sort(), [MAC, MINI].sort());
  await until(() => d[MAC].cam.get().watchers.length === 2);
  assert.deepEqual(d[MAC].cam.get().watchers.sort(), ['this', MINI].sort());

  await d[MAC].cam.unwatch(PC);
  assert.ok(viewer.closed);
  await until(() => d[PC].cam.get().watchers.length === 1);
  assert.equal(cap.closed, false, 'still one watcher');
  await d[MINI].cam.unwatch(PC);
  await until(() => d[PC].cam.get().watchers.length === 0);
  assert.equal(cap.closed, true, 'camera off when nobody watches');
  await until(() => d[MAC].cam.get().watchers.length === 0);
  d.close();
});

test('closing the viewer window stops watching on both sides', async () => {
  const d = desk([PC, MAC]);
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await d[MAC].cam.watch(PC);
  d[MAC].windows.liveViewer().onMsg({ type: 'end', reason: 'window closed' });
  assert.deepEqual(d[MAC].cam.get().watchers, []);
  await until(() => d[PC].cam.get().watchers.length === 0);
  assert.equal(d[PC].windows.captures[0].closed, true);
  d.close();
});

test('the sharer can stop a watcher with unwatch(deviceId)', async () => {
  const d = desk([PC, MAC]);
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await d[MAC].cam.watch(PC);
  await d[PC].cam.unwatch(MAC);
  await until(() => d[MAC].windows.viewers[0].closed);
  assert.deepEqual(d[MAC].cam.get().watchers, []);
  d.close();
});

test('watch rejects when the device is not sharing, is this device, or is offline', async () => {
  const d = desk([PC, MAC]);
  await assert.rejects(d[MAC].cam.watch(PC), { code: 'not-shared' });
  await assert.rejects(d[MAC].cam.watch('this'), { code: 'bad-args' });
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  d.net.down.add(PC);
  await assert.rejects(d[MAC].cam.watch(PC), { code: 'offline' });
  d.close();
});

test('camera permission denied: watch rejects with a clear why, no camera window', async () => {
  const why = 'OmniDesk isn\'t allowed to use the camera. Allow it in System Settings → Privacy & Security → Camera, then try again.';
  const d = desk([PC, MAC], { windows: { [PC]: { access: { ok: false, why } } } });
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await assert.rejects(d[MAC].cam.watch(PC), (e) => { assert.equal(e.code, 'camera-denied'); assert.equal(e.message, why); return true; });
  assert.equal(d[PC].windows.captures.length, 0);
  assert.equal(d[PC].cam.get().why, why);
  assert.deepEqual(d[PC].cam.get().watchers, []);
  assert.ok(d[MAC].windows.viewers[0].closed);
  assert.deepEqual(d[MAC].cam.get().watchers, []);
  d.close();
});

test('camera fails in the capture window (no camera / in use): watch rejects, window closed', async () => {
  const d = desk([PC, MAC], { windows: { [PC]: { cameraError: 'The camera is in use by another app.' } } });
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await assert.rejects(d[MAC].cam.watch(PC), { code: 'camera-failed', message: 'The camera is in use by another app.' });
  assert.equal(d[PC].windows.captures[0].closed, true);
  assert.equal(d[PC].cam.get().why, 'The camera is in use by another app.');
  d.close();
});

test('one camera at a time: sharing on another device asks the live one to stop first', async () => {
  const d = desk();
  await d[PC].cam.setShared(true);
  await until(() => d[MINI].cam.get().liveDeviceId === PC);
  await d[MINI].cam.watch(PC);
  const cap = d[PC].windows.liveCapture();

  await d[MAC].cam.setShared(true);
  const stops = d.net.log.filter(([from, to, type]) => from === MAC && to === PC && type === 'camera.stop');
  assert.equal(stops.length, 1, 'asked the live camera to stop');
  assert.equal(d[PC].cam.get().shared, false);
  assert.equal(d[PC].settings.data.camera.shared, false);
  assert.equal(cap.closed, true, 'old camera turned off');
  await until(() => d.all().every((x) => {
    const v = x.cam.get();
    return v.liveDeviceId === (x === d[MAC] ? 'this' : MAC);
  }));
  assert.ok(d[MINI].windows.viewers[0].closed, 'old viewer closed');
  assert.equal(d.all().filter((x) => x.cam.get().shared).length, 1);
  d.close();
});

test('race: two devices share at the same moment, the newest switch wins everywhere', async () => {
  const d = desk([PC, MAC, MINI], { now: { [PC]: () => 5000, [MAC]: () => 4000 } });
  d.net.hold();
  await Promise.all([d[PC].cam.setShared(true), d[MAC].cam.setShared(true)]);
  d.net.flush();
  await until(() => d.all().every((x) => x.cam.get().liveDeviceId === (x === d[PC] ? 'this' : PC)));
  assert.equal(d[MAC].cam.get().shared, false);
  assert.equal(d[MAC].settings.data.camera.shared, false);
  assert.equal(d[PC].cam.get().shared, true);
  d.close();
});

test('regression: a device that was away while another took over does not win the camera back when it returns', async () => {
  let t = 1000;
  const d = desk([PC, MAC, MINI], { now: { [PC]: () => t, [MAC]: () => t, [MINI]: () => t } });
  t = 1000; await d[PC].cam.setShared(true);
  await until(() => d[MINI].cam.get().liveDeviceId === PC && d[MAC].cam.get().liveDeviceId === PC);
  // PC drops off the network (sleep); everyone forgets its claim, PC keeps its switch on.
  d.net.down.add(PC);
  for (const x of d.all()) x.cam.scan();
  assert.equal(d[MAC].cam.get().liveDeviceId, null);
  assert.equal(d[PC].cam.get().shared, true);
  // MAC turns its camera on meanwhile (later than PC's old claim).
  t = 9000; await d[MAC].cam.setShared(true);
  await until(() => d[MINI].cam.get().liveDeviceId === MAC);
  // PC comes back and re-announces its old claim: MAC keeps the camera, PC yields.
  d.net.down.delete(PC);
  t = 9500;
  for (const x of d.all()) x.cam.scan();
  await until(() => d.all().every((x) => x.cam.get().liveDeviceId === (x === d[MAC] ? 'this' : MAC)));
  assert.equal(d[MAC].cam.get().shared, true);
  assert.equal(d[PC].cam.get().shared, false);
  assert.equal(d[PC].settings.data.camera.shared, false);
  d.close();
});

test('regression: a switch restored at start keeps its saved timestamp and loses to a newer camera', async () => {
  const d = desk([PC, MAC], { now: { [PC]: () => 50000, [MAC]: () => 9000 }, settings: { [PC]: { camera: { shared: true, ts: 1000 } }, [MAC]: { camera: { shared: true, ts: 8000 } } } });
  // Both restore; MAC's saved claim (8000) is newer than PC's (1000).
  await until(() => d.all().every((x) => x.cam.get().liveDeviceId === (x === d[MAC] ? 'this' : MAC)));
  assert.equal(d[PC].cam.get().shared, false);
  assert.equal(d[MAC].cam.get().shared, true);
  d.close();
});

test('setShared(true) saves the claim timestamp with the switch', async () => {
  const d = desk([PC, MAC], { now: { [PC]: () => 4242 } });
  await d[PC].cam.setShared(true);
  assert.deepEqual(d[PC].settings.data.camera, { shared: true, ts: 4242 });
  await d[PC].cam.setShared(false);
  assert.equal(d[PC].settings.data.camera.shared, false);
  d.close();
});

test('regression: the capture window crashing before it is ready does not throw in the main process', async () => {
  const d = desk([PC, MAC]);
  d[PC].windows.openCapture = async (onMsg) => {
    onMsg({ type: 'end', reason: 'window crashed (killed)' }); // before openCapture resolves
    throw Object.assign(new Error('The camera window did not load.'), { code: 'window-timeout' });
  };
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await assert.rejects(d[MAC].cam.watch(PC), { code: 'window-timeout' }); // not a ReferenceError
  assert.deepEqual(d[PC].cam.get().watchers, []);
  d.close();
});

test('race with equal timestamps: the lowest device id wins everywhere', async () => {
  const d = desk([PC, MAC, MINI], { now: { [PC]: () => 7000, [MAC]: () => 7000, [MINI]: () => 7000 } });
  d.net.hold();
  await Promise.all([d[MINI].cam.setShared(true), d[MAC].cam.setShared(true)]);
  d.net.flush();
  // MAC (bbbb…) < MINI (cccc…)
  await until(() => d.all().every((x) => x.cam.get().liveDeviceId === (x === d[MAC] ? 'this' : MAC)));
  assert.equal(d[MINI].cam.get().shared, false);
  d.close();
});

test('a takeover is not mistaken for a race: the newer, deliberate claim wins', async () => {
  const d = desk([PC, MAC, MINI], { now: { [PC]: () => 1000, [MAC]: () => 2000 } });
  await d[PC].cam.setShared(true);
  await until(() => d[MINI].cam.get().liveDeviceId === PC);
  // MINI hears MAC's newer claim before PC's "off": it still follows MAC, then ignores PC's late "off".
  d.net.hold();
  await d[MAC].cam.setShared(true);
  d.net.flush({ reverse: true });
  await tick(5);
  assert.equal(d[MINI].cam.get().liveDeviceId, MAC);
  assert.equal(d[PC].cam.get().liveDeviceId, MAC);
  d.close();
});

test('peer disconnect ends sessions on both sides and clears the live camera', async () => {
  const d = desk([PC, MAC]);
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await d[MAC].cam.watch(PC);
  d.net.down.add(MAC);
  d[PC].cam.scan();
  d[MAC].cam.scan();
  assert.deepEqual(d[PC].cam.get().watchers, []);
  assert.equal(d[PC].windows.captures[0].closed, true);
  assert.equal(d[PC].cam.get().shared, true, 'the switch stays on');
  assert.ok(d[MAC].windows.viewers[0].closed);
  assert.equal(d[MAC].cam.get().liveDeviceId, null);
  d.close();
});

test('stop sharing and app quit end every watch and tell the others', async () => {
  const d = desk();
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await d[MAC].cam.watch(PC);
  await d[PC].cam.setShared(false);
  assert.equal(d[PC].windows.captures[0].closed, true);
  await until(() => d[MAC].cam.get().liveDeviceId === null && d[MAC].windows.viewers[0].closed);

  await d[PC].cam.setShared(true);
  await until(() => d[MINI].cam.get().liveDeviceId === PC);
  await d[MINI].cam.watch(PC);
  d[PC].cam.shutdown();
  assert.ok(d[PC].windows.captures.every((c) => c.closed));
  assert.equal(d[PC].settings.data.camera.shared, true, 'quitting keeps the switch for next start');
  await until(() => d[MINI].cam.get().liveDeviceId === null && d[MINI].windows.viewers[0].closed);
  d.close();
});

test('the capture window crashing or closing ends every watch', async () => {
  const d = desk([PC, MAC]);
  await d[PC].cam.setShared(true);
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  await d[MAC].cam.watch(PC);
  d[PC].windows.captures[0].onMsg({ type: 'end', reason: 'window crashed (killed)' });
  assert.deepEqual(d[PC].cam.get().watchers, []);
  await until(() => d[MAC].windows.viewers[0].closed);
  d.close();
});

test('the shared setting is restored at start when multi-device mode is on', async () => {
  const d = desk([PC, MAC], { settings: { [PC]: { camera: { shared: true } } } });
  assert.deepEqual(d[PC].cam.get(), { shared: true, liveDeviceId: 'this', watchers: [] });
  await until(() => d[MAC].cam.get().liveDeviceId === PC);
  d.close();
});

test('checkAccess: macOS asks once, explains denial; other platforms pass', async () => {
  assert.deepEqual(await checkAccess({ platform: 'darwin', getStatus: () => 'granted', ask: async () => false }), { ok: true });
  let asked = 0;
  assert.deepEqual(await checkAccess({ platform: 'darwin', getStatus: () => 'not-determined', ask: async () => { asked++; return true; } }), { ok: true });
  assert.equal(asked, 1);
  const no = await checkAccess({ platform: 'darwin', getStatus: () => 'not-determined', ask: async () => false });
  assert.equal(no.ok, false);
  assert.match(no.why, /System Settings → Privacy & Security → Camera/);
  assert.equal((await checkAccess({ platform: 'darwin', getStatus: () => 'denied', ask: async () => true })).ok, false);
  assert.match((await checkAccess({ platform: 'darwin', getStatus: () => 'restricted', ask: async () => true })).why, /policy/);
  assert.match((await checkAccess({ platform: 'win32', getStatus: () => 'denied' })).why, /Privacy & security → Camera/);
  assert.deepEqual(await checkAccess({ platform: 'linux' }), { ok: true });
});
