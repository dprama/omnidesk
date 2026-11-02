// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPeer } = require('./peer');
const identity = require('./identity');
const { fakeDevice, waitFor } = require('./testutil');

// Two devices with throw-away certs that trust each other.
async function setup({ trust = true, autoConnect = false } = {}) {
  const a = fakeDevice('pa');
  const b = fakeDevice('pb');
  const idA = identity.loadIdentity(a.engine);
  const idB = identity.loadIdentity(b.engine);
  if (trust) {
    for (const [d, other] of [[a, idB], [b, idA]]) {
      identity.addTrusted(d.engine.paths.trustedServers, other.fingerprint);
      identity.addTrusted(d.engine.paths.trustedClients, other.fingerprint);
    }
  }
  a.devices.store[idB.id] = { id: idB.id, fingerprint: idB.fingerprint, paired: true };
  b.devices.store[idA.id] = { id: idA.id, fingerprint: idA.fingerprint, paired: true };
  const ports = {};
  const opts = { listenHost: '127.0.0.1', port: 0, autoConnect, backoffMinMs: 50, backoffMaxMs: 200 };
  const A = createPeer({ ...a, ...opts, resolve: () => ({ address: '127.0.0.1', peerPort: ports.b }) });
  const B = createPeer({ ...b, ...opts, resolve: () => ({ address: '127.0.0.1', peerPort: ports.a }) });
  await Promise.all([A.ready, B.ready]);
  ports.a = A.port();
  ports.b = B.port();
  return { a, b, A, B, idA, idB, async done() { await A.stop(); await B.stop(); a.cleanup(); b.cleanup(); } };
}

test('send / request round trip over mutual TLS', async () => {
  const t = await setup();
  try {
    const got = [];
    const off = t.B.on('hello', (from, payload) => { got.push([from, payload]); });
    t.B.on('add', (from, { x, y }, reply) => reply({ sum: x + y, from }));
    t.B.on('async', async (from, p) => ({ echoed: p }));
    t.B.on('fail', () => { throw Object.assign(new Error('nope'), { code: 'denied' }); });

    await t.A.send(t.idB.id, 'hello', { n: 1 });
    await waitFor(() => got.length === 1);
    assert.deepEqual(got[0], [t.idA.id, { n: 1 }]); // B sees A's id from A's certificate
    assert.ok(t.A.isConnected(t.idB.id));
    assert.ok(t.B.isConnected(t.idA.id));

    assert.deepEqual(await t.A.request(t.idB.id, 'add', { x: 2, y: 3 }), { sum: 5, from: t.idA.id });
    assert.deepEqual(await t.A.request(t.idB.id, 'async', 'hi'), { echoed: 'hi' });
    await assert.rejects(t.A.request(t.idB.id, 'fail', null), (e) => e.code === 'denied');
    await assert.rejects(t.A.request(t.idB.id, 'nobody', null), (e) => e.code === 'no-handler');

    // Both directions on the same connection.
    t.A.on('ping', (from, p, reply) => reply('pong'));
    assert.equal(await t.B.request(t.idA.id, 'ping', null), 'pong');

    // 1 MB limit.
    await assert.rejects(t.A.send(t.idB.id, 'hello', 'x'.repeat(1024 * 1024)), (e) => e.code === 'too-large');
    const big = 'y'.repeat(900 * 1024);
    await t.A.send(t.idB.id, 'hello', big);
    await waitFor(() => got.length === 2);
    assert.equal(got[1][1].length, big.length);

    off();
    await t.A.send(t.idB.id, 'hello', { n: 3 });
    await assert.rejects(t.A.request(t.idB.id, 'slow', null, { timeoutMs: 50 }), (e) => e.code === 'no-handler' || e.code === 'timeout');
  } finally { await t.done(); }
});

test('untrusted peers are refused', async () => {
  const t = await setup({ trust: false });
  try {
    await assert.rejects(t.A.send(t.idB.id, 'hello', 1), (e) => e.code === 'not-paired');
    // A trusts B but B does not trust A: B drops the connection.
    identity.addTrusted(t.a.engine.paths.trustedServers, t.idB.fingerprint);
    const got = [];
    t.B.on('hello', () => got.push(1));
    await t.A.send(t.idB.id, 'hello', 1).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got.length, 0);
    assert.equal(t.B.isConnected(t.idA.id), false);
  } finally { await t.done(); }
});

test('reconnects with backoff and drops forgotten peers', async () => {
  const t = await setup({ autoConnect: true });
  try {
    await waitFor(() => t.A.isConnected(t.idB.id) && t.B.isConnected(t.idA.id));
    // B forgets A: B closes the channel; A keeps retrying but B refuses.
    identity.removeTrusted(t.b.engine.paths.trustedServers, (h) => h === t.idA.fingerprint);
    identity.removeTrusted(t.b.engine.paths.trustedClients, (h) => h === t.idA.fingerprint);
    t.b.devices.emit('change');
    await waitFor(() => !t.A.isConnected(t.idB.id));
    // Trust again: A's backoff loop reconnects on its own.
    identity.addTrusted(t.b.engine.paths.trustedClients, t.idA.fingerprint);
    await waitFor(() => t.A.isConnected(t.idB.id), 5000);
  } finally { await t.done(); }
});
