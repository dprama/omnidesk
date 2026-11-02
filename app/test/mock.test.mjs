// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Unit tests for app/mock/omnidesk-mock.js in a minimal fake window (node:vm).
// Run: node --test app/test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const SRC = readFileSync(new URL('../mock/omnidesk-mock.js', import.meta.url), 'utf8');
const loaded = [];

function load(scenario = 'default', { hidden = false } = {}) {
  const listeners = {};
  const win = {
    location: { search: scenario === 'default' ? '' : `?mock-scenario=${scenario}` },
    document: { hidden, addEventListener: (t, f) => { listeners[t] = f; } },
    // Short one-shots stay ref'd: tests await mock calls that resolve on them (pairEnter, 900 ms),
    // and Node 22 ends a test whose only pending work is unref'd. Long ones (code expiry) don't hold exit.
    setTimeout: (f, ms) => { const h = setTimeout(f, ms); if (ms >= 10000) h.unref(); return h; },
    clearTimeout, clearInterval,
    setInterval: (f, ms) => { const h = setInterval(f, ms); h.unref(); return h; },
    URL, URLSearchParams,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'omnidesk-mock.js' });
  loaded.push(win);
  return win;
}
after(() => loaded.forEach((w) => w.__omnideskMock.stop()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => JSON.parse(JSON.stringify(v));

const API = {
  app: ['info', 'openExternal'], 'app.logs': ['tail', 'onLine'],
  status: ['get', 'on'], devices: ['list', 'on', 'rename', 'forget'],
  mouse: ['get', 'set', 'onCursor', 'onDecision'], layout: ['get', 'set'],
  clipboard: ['get', 'set', 'history', 'onItem'], screen: ['get', 'start', 'stop', 'on'],
  camera: ['get', 'setShared', 'on', 'watch', 'unwatch'], connection: ['onFound', 'pairStart', 'pairEnter', 'pairCancel', 'setLink'],
  multi: ['get', 'set'], feedback: ['systemInfo', 'send'], tip: ['open'],
};

test('every API method exists and the object is frozen', () => {
  const { omnidesk } = load();
  for (const [ns, methods] of Object.entries(API)) {
    const obj = ns.split('.').reduce((o, k) => o[k], omnidesk);
    for (const m of methods) assert.equal(typeof obj[m], 'function', `${ns}.${m}`);
    assert.ok(Object.isFrozen(obj), `${ns} frozen`);
  }
  assert.ok(Object.isFrozen(omnidesk));
});

test('non-subscription methods return promises', async () => {
  const { omnidesk } = load();
  for (const [ns, methods] of Object.entries(API)) {
    const obj = ns.split('.').reduce((o, k) => o[k], omnidesk);
    for (const m of methods.filter((x) => !/^on/.test(x) && !/^(set|rename|forget|start|stop|pair|open|send|watch|unwatch)/.test(x))) {
      const p = obj[m]();
      assert.equal(typeof p.then, 'function', `${ns}.${m}`);
      await p;
    }
  }
});

test('mock data matches the brief', async () => {
  const { omnidesk } = load();
  const list = await omnidesk.devices.list();
  const pc = list.find((d) => d.id === 'this'); const mb = list.find((d) => d.id === 'macbook'); const mm = list.find((d) => d.id === 'macmini');
  assert.deepEqual(plain(pc.screens), [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }]);
  assert.equal(mb.arch, 'x64'); assert.equal(mb.os, 'macos'); assert.equal(mb.battery.percent, 82);
  // the owner's 2018 Intel MacBook Pro: 1440x900 points
  assert.deepEqual(plain(mb.screens), [{ x: 0, y: 0, w: 1440, h: 900 }]);
  assert.ok(mb.link.pingMs >= 3 && mb.link.pingMs <= 7);
  assert.equal(mm.online, false);
  assert.ok(Date.now() - Date.parse(mm.lastSeen) >= 2 * 86400000 - 1000);
  const st = await omnidesk.status.get();
  // total = paired devices including this one; connected = this device + online paired devices
  assert.equal(st.connected, 2); assert.equal(st.total, 3);
  const hist = await omnidesk.clipboard.history();
  assert.equal(hist[0].name, 'Quarterly plan v3.docx');
  const info = await omnidesk.feedback.systemInfo();
  assert.deepEqual(Object.keys(info).sort(), ['appVersion', 'arch', 'devices', 'engineVersion', 'monitors', 'os', 'osVersion']);
  assert.ok(!/MacBook|Windows PC|@/.test(JSON.stringify(info)));
});

test('subscriptions emit immediately and unsubscribe works', async () => {
  const { omnidesk } = load();
  const subs = [
    ['status.on', omnidesk.status.on], ['devices.on', omnidesk.devices.on], ['screen.on', omnidesk.screen.on],
    ['camera.on', omnidesk.camera.on], ['mouse.onCursor', omnidesk.mouse.onCursor], ['mouse.onDecision', omnidesk.mouse.onDecision],
    ['clipboard.onItem', omnidesk.clipboard.onItem], ['connection.onFound', omnidesk.connection.onFound], ['app.logs.onLine', omnidesk.app.logs.onLine],
  ];
  for (const [name, on] of subs) {
    let n = 0;
    const off = on((v) => { n++; assert.notEqual(v, undefined); });
    assert.equal(typeof off, 'function', name);
    await sleep(0);
    assert.ok(n >= 1, `${name} emitted immediately`);
    off();
  }
  // After unsubscribe, a change is not delivered.
  let n = 0;
  const off = omnidesk.status.on(() => n++);
  await sleep(0);
  assert.equal(n, 1);
  off();
  await omnidesk.clipboard.set({ enabled: false });
  assert.equal(n, 1);
});

test('toggles change state and fire subscribers', async () => {
  const { omnidesk } = load();
  const seen = [];
  const off = omnidesk.status.on((s) => seen.push(s.clipboard));
  await sleep(0);
  const r = await omnidesk.clipboard.set({ enabled: false });
  assert.equal(r.enabled, false); assert.equal(r.maxFileMB, 100);
  assert.deepEqual(seen, [true, false]);
  off();
  await omnidesk.mouse.set({ enabled: false });
  assert.equal((await omnidesk.status.get()).mouse, false);
  const cams = [];
  omnidesk.camera.on((c) => cams.push(c));
  await omnidesk.camera.setShared(true);
  await sleep(900);
  const last = cams.at(-1);
  assert.equal(last.liveDeviceId, 'this'); assert.deepEqual(plain(last.watchers), ['macbook']);
  assert.equal((await omnidesk.multi.set({ enabled: false })).enabled, false);
  await assert.rejects(omnidesk.mouse.set({ cooldownMs: -5 }), (e) => e.code === 'invalid' && /Cooldown/.test(e.message));
});

test('screen session goes starting -> live -> gone', async () => {
  const { omnidesk } = load();
  const s = await omnidesk.screen.start({ sourceId: 'this', targetId: 'macbook', resolution: '2560x1600', refresh: 60, quality: 'latency' });
  assert.equal(s.state, 'starting');
  await sleep(1300);
  const live = (await omnidesk.screen.get()).sessions[0];
  assert.equal(live.state, 'live'); assert.ok(live.latencyMs >= 55 && live.latencyMs <= 67);
  await omnidesk.screen.stop(s.id);
  assert.equal((await omnidesk.screen.get()).sessions[0].state, 'stopping');
  await sleep(700);
  assert.equal((await omnidesk.screen.get()).sessions.length, 0);
});

test('layout edges are computed on outer edges only', async () => {
  const { omnidesk, __omnideskMock: m } = load();
  const { edges, placements } = await omnidesk.layout.get();
  assert.deepEqual(plain(placements.macbook), { x: 4480, y: 270 });
  const pcToMac = edges.find((e) => e.from === 'this' && e.to === 'macbook');
  assert.deepEqual(plain(pcToMac), { from: 'this', fromEdge: 'right', to: 'macbook', overlapPx: 900 });
  assert.ok(edges.find((e) => e.from === 'macbook' && e.fromEdge === 'left' && e.to === 'this'));

  const pc = { id: 'pc', screens: [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }] };
  const mac = { id: 'mac', screens: [{ x: 0, y: 0, w: 1440, h: 900 }] };
  // Mac touching monitor 1's right edge only above monitor 2 (y 0..180): that part is outer.
  let e = m.computeEdges([pc, mac], { pc: { x: 0, y: 0 }, mac: { x: 2560, y: -720 } });
  assert.deepEqual(plain(e.find((x) => x.from === 'pc')), { from: 'pc', fromEdge: 'right', to: 'mac', overlapPx: 180 });
  // A Mac sitting where monitor 2 continues gets no edge from monitor 1.
  e = m.computeEdges([pc, mac], { pc: { x: 0, y: 0 }, mac: { x: 2560, y: 200 } });
  assert.equal(e.filter((x) => x.from === 'pc' && x.fromEdge === 'right').length, 0);
  // Gap: no edge.
  e = m.computeEdges([pc, mac], { pc: { x: 0, y: 0 }, mac: { x: 4600, y: 270 } });
  assert.equal(e.length, 0);
  // Left of monitor 1.
  e = m.computeEdges([pc, mac], { pc: { x: 0, y: 0 }, mac: { x: -1440, y: 100 } });
  assert.deepEqual(plain(e.find((x) => x.from === 'pc')), { from: 'pc', fromEdge: 'left', to: 'mac', overlapPx: 900 });

  const r = await omnidesk.layout.set({ placements: { macbook: { x: -1440, y: 100 } } });
  assert.ok(r.edges.find((x) => x.from === 'this' && x.fromEdge === 'left' && x.to === 'macbook'));
});

test('mock edges use main\'s placement convention (bbox start), also for negative monitor coords', () => {
  const { __omnideskMock: m } = load();
  const main = createRequire(import.meta.url)('../main/engine/config.js');
  const PC = { id: 'pc', screens: [{ x: -1920, y: -300, w: 1920, h: 1080 }, { x: 0, y: 0, w: 2560, h: 1440 }] };
  const MAC = { id: 'mac', screens: [{ x: 0, y: 0, w: 1512, h: 982 }, { x: -200, y: -1080, w: 1920, h: 1080 }] };
  const key = (es) => new Map(es.map((e) => [`${e.from}|${e.fromEdge}|${e.to}`, Math.round(e.overlapPx)]));
  for (const placements of [
    { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 1080 } },
    { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 400 } },
    { pc: { x: 0, y: 0 }, mac: { x: -1920, y: 0 } },
    { pc: { x: 0, y: 0 }, mac: { x: 500, y: -2062 } },
  ]) {
    assert.deepEqual(key(plain(m.computeEdges([PC, MAC], placements))), key(main.computeEdges([PC, MAC], placements).edges), JSON.stringify(placements));
  }
});

// The engine's own patterns (engine/src/lib/base/OmniDeskLog.h, used verbatim by main).
const ENGINE = createRequire(import.meta.url)('../main/engine/decisions.js');
const body = (re) => re.source.replace(/^\^/, '').replace(/\$$/, '');
const DECISION = new RegExp(`^\\d{2}:\\d{2}:\\d{2} (?:${body(ENGINE.NO_CROSS)}|${body(ENGINE.CROSS)})$`);

test('decision lines match the engine format and cover every reason over time', { timeout: 60000 }, async () => {
  assert.match('12:04:31 no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[0,0,2560x1440][2560,180,1920x1080]', DECISION);
  assert.match('12:04:31 cross edge=right pos=(4479,640) to=MacBook cooldown=300ms', DECISION);
  const { omnidesk } = load();
  const lines = []; const cursors = [];
  omnidesk.mouse.onDecision((l) => lines.push(l));
  omnidesk.mouse.onCursor((c) => cursors.push(c));
  await sleep(26000);
  await omnidesk.mouse.set({ enabled: false });
  await sleep(9000);
  await omnidesk.mouse.set({ enabled: true, locked: true });
  await sleep(9000);
  for (const l of lines) {
    assert.match(l, DECISION);
    // remaining=<ms>ms appears exactly on cooldown lines, as formatNoCross writes it.
    assert.equal(/ remaining=\d+ms$/.test(l), / reason=cooldown /.test(l), l);
  }
  const reasons = new Set(lines.map((l) => (l.match(/reason=([\w-]+)/) || [, 'cross'])[1]));
  for (const r of ['cross', 'not-outer-edge', 'button-held', 'cooldown', 'arrival-guard', 'outside-zone', 'no-neighbour', 'sharing-off', 'locked']) {
    assert.ok(reasons.has(r), `saw ${r}: ${[...reasons]}`);
  }
  assert.ok(lines.some((l) => / cross edge=right pos=\(4479,\d+\) to=MacBook cooldown=300ms$/.test(l)));
  assert.ok(lines.some((l) => /not-outer-edge edge=right pos=\(2559,\d+\) monitors=\[0,0,2560x1440\]\[2560,180,1920x1080\]$/.test(l)));
  assert.ok(cursors.some((c) => c.deviceId === 'macbook'));
  // Cursor rate stays at or under 20 per second.
  assert.ok(cursors.length <= 20 * 45, `cursor events ${cursors.length}`);
});

test('pairing: code, discovery and pairEnter', async () => {
  const { omnidesk } = load('empty');
  assert.equal((await omnidesk.devices.list()).length, 1);
  const { code, expiresAt } = await omnidesk.connection.pairStart();
  assert.match(code, /^\d{6}$/);
  const left = Date.parse(expiresAt) - Date.now();
  assert.ok(left > 115000 && left <= 120000);
  const found = [];
  omnidesk.connection.onFound((l) => found.push(l));
  await sleep(3200);
  const lr = found.at(-1).find((d) => d.name === 'Living-room PC');
  assert.ok(lr);
  await assert.rejects(omnidesk.connection.pairEnter(lr.id, '000000'), (e) => e.code === 'bad-code');
  const d = await omnidesk.connection.pairEnter(lr.id, '123456');
  assert.equal(d.paired, true);
  const st = await omnidesk.status.get();
  assert.equal(st.total, 2); assert.equal(st.connected, 2);
});

test('scenarios: offline and error', async () => {
  const off = load('offline').omnidesk;
  const mb = (await off.devices.list()).find((d) => d.id === 'macbook');
  assert.equal(mb.online, false);
  const offSt = await off.status.get();
  assert.equal(offSt.link, null); assert.equal(offSt.connected, 1); assert.equal(offSt.total, 3);
  assert.equal((await off.camera.get()).liveDeviceId, null);
  const empty = await load('empty').omnidesk.status.get();
  assert.equal(empty.connected, 1); assert.equal(empty.total, 1);
  await assert.rejects(off.screen.start({ sourceId: 'this', targetId: 'macbook' }), (e) => e.code === 'offline');
  const err = load('error').omnidesk;
  await assert.rejects(err.clipboard.set({ enabled: false }), (e) => typeof e.code === 'string' && /engine/.test(e.message));
  await assert.rejects(err.layout.set({ placements: {} }));
  assert.equal((await err.clipboard.get()).enabled, true);
  assert.match((await err.camera.get()).why, /camera/i);
  await assert.rejects(err.camera.watch('macbook'), (e) => /engine/.test(e.message));
});

test('external calls resolve without network and are recorded', async () => {
  const win = load();
  const { omnidesk } = win;
  assert.deepEqual(plain(await omnidesk.feedback.send({ kind: 'idea', message: 'hi', includeSystemInfo: false })), { opened: true });
  assert.deepEqual(plain(await omnidesk.tip.open(5)), { opened: true });
  assert.deepEqual(plain(await omnidesk.app.openExternal('https://github.com/deskflow/deskflow')), { opened: true });
  await assert.rejects(omnidesk.app.openExternal('http://example.com'), (e) => e.code === 'blocked-url');
  const names = win.__omnideskMockCalls.map((c) => c.method);
  for (const m of ['feedback.send', 'tip.open', 'app.openExternal']) assert.ok(names.includes(m), m);
});

test('camera: watch and unwatch the device that is sharing', async () => {
  const { omnidesk } = load();
  const c0 = await omnidesk.camera.get();
  assert.equal(c0.liveDeviceId, 'macbook'); assert.equal(c0.shared, false); assert.deepEqual(plain(c0.watchers), []);
  assert.equal(c0.why, undefined);
  const seen = [];
  const off = omnidesk.camera.on((c) => seen.push(plain(c.watchers)));
  await sleep(0);
  const c1 = await omnidesk.camera.watch('macbook');
  assert.deepEqual(plain(c1.watchers), ['this']);
  assert.deepEqual(seen.at(-1), ['this']);
  await assert.rejects(omnidesk.camera.watch('macmini'), (e) => e.code === 'offline');
  await assert.rejects(omnidesk.camera.watch('this'), (e) => e.code === 'invalid');
  const c2 = await omnidesk.camera.unwatch('macbook');
  assert.deepEqual(plain(c2.watchers), []);
  off();
  // sharing this camera takes over: only one camera at a time
  const c3 = await omnidesk.camera.setShared(true);
  assert.equal(c3.liveDeviceId, 'this');
  await assert.rejects(omnidesk.camera.watch('macbook'), (e) => e.code === 'not-sharing');
});

test('debug counter tracks live subscriptions', async () => {
  const { omnidesk, __omnideskMock: m } = load();
  const base = m.subscriptions().total;
  const offs = [omnidesk.status.on(() => {}), omnidesk.devices.on(() => {}), omnidesk.mouse.onCursor(() => {})];
  assert.equal(m.subscriptions().total, base + 3);
  assert.equal(m.subscriptions().byChannel.cursor, 1);
  offs.forEach((f) => f());
  assert.equal(m.subscriptions().total, base);
});
