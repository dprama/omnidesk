// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createPairing } = require('./index');
const identity = require('./identity');
const { fakeDevice, waitFor } = require('./testutil');

function pairOf(opts = {}) {
  const a = fakeDevice('a');
  const b = fakeDevice('b');
  const A = createPairing({ ...a, listenHost: '127.0.0.1', port: 0, ...opts });
  const B = createPairing({ ...b, resolve: () => ({ address: '127.0.0.1', pairingPort: A._port() }) });
  const idA = identity.loadIdentity(a.engine);
  const idB = identity.loadIdentity(b.engine);
  return { a, b, A, B, idA, idB, done() { A.cancel(); B.cancel(); a.cleanup(); b.cleanup(); } };
}

function wrongCode(code) { return String((Number(code) + 1) % 1000000).padStart(6, '0'); }
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

test('right code pairs both ways and writes both trust files in the engine format', async () => {
  const t = pairOf();
  try {
    // An existing v1 (SHA-1) trust line must survive.
    const legacy = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD';
    fs.mkdirSync(t.a.engine.paths.tlsDir, { recursive: true });
    fs.writeFileSync(t.a.engine.paths.trustedClients, legacy + '\n');

    const { code, expiresAt } = await t.A.start();
    assert.match(code, /^\d{6}$/);
    assert.ok(Date.parse(expiresAt) > Date.now());
    const dev = await t.B.enter(t.idA.id, code);
    assert.equal(dev.id, t.idA.id);
    assert.equal(dev.name, 'Device a');
    assert.equal(dev.engineName, 'a-engine');
    assert.equal(dev.fingerprint, t.idA.fingerprint);
    assert.equal(dev.paired, true);
    assert.deepEqual(dev.screens, [{ x: 0, y: 0, w: 1920, h: 1080 }]);

    await waitFor(() => t.a.devices.store[t.idB.id]);
    const onA = t.a.devices.store[t.idB.id];
    assert.equal(onA.fingerprint, t.idB.fingerprint);
    assert.equal(onA.engineName, 'b-engine');
    assert.equal(onA.host, '127.0.0.1');

    // B trusts A, A trusts B, in both files, one "v2:sha256:<hex>" per line.
    assert.equal(read(t.b.engine.paths.trustedServers), `v2:sha256:${t.idA.fingerprint}\n`);
    assert.equal(read(t.b.engine.paths.trustedClients), `v2:sha256:${t.idA.fingerprint}\n`);
    assert.equal(read(t.a.engine.paths.trustedServers), `v2:sha256:${t.idB.fingerprint}\n`);
    assert.equal(read(t.a.engine.paths.trustedClients), `${legacy}\nv2:sha256:${t.idB.fingerprint}\n`);

    // The fingerprint is SHA-256 of the DER certificate (engine SecureUtils.cpp).
    const der = new crypto.X509Certificate(fs.readFileSync(t.a.engine.paths.certificate)).raw;
    assert.equal(crypto.createHash('sha256').update(der).digest('hex'), t.idA.fingerprint);
    // deskflow.pem = private key, then certificate.
    assert.match(read(t.a.engine.paths.certificate), /^-----BEGIN PRIVATE KEY-----[\s\S]+-----BEGIN CERTIFICATE-----/);

    // Single use: the same code doesn't work again.
    await assert.rejects(t.B.enter(t.idA.id, code), (e) => ['no-session', 'unreachable'].includes(e.code));

    // Codes and keys never reach the log.
    for (const l of [...t.a.log.lines, ...t.b.log.lines]) assert.ok(!l.includes(code), `log leaked the code: ${l}`);

    // forget removes the fingerprint from both files and keeps the rest.
    assert.equal(t.A.forget(t.idB.id), true);
    assert.equal(read(t.a.engine.paths.trustedServers), '');
    assert.equal(read(t.a.engine.paths.trustedClients), `${legacy}\n`);
  } finally { t.done(); }
});

test('wrong code fails, then the right code still works', async () => {
  const t = pairOf();
  try {
    const { code } = await t.A.start();
    await assert.rejects(t.B.enter(t.idA.id, wrongCode(code)), (e) => e.code === 'wrong-code' && /didn’t match/.test(e.message));
    assert.equal(read(t.b.engine.paths.trustedServers), '');
    await waitFor(() => t.a.log.lines.some((l) => l.includes('(1/3)')));
    const dev = await t.B.enter(t.idA.id, code);
    assert.equal(dev.id, t.idA.id);
  } finally { t.done(); }
});

test('three wrong attempts end the code', async () => {
  const t = pairOf();
  try {
    const { code } = await t.A.start();
    for (let i = 1; i <= 3; i++) {
      await assert.rejects(t.B.enter(t.idA.id, wrongCode(code)), (e) => e.code === 'wrong-code');
      await waitFor(() => t.a.log.lines.some((l) => l.includes(`(${i}/3)`)));
    }
    await waitFor(() => !t.A._active());
    await assert.rejects(t.B.enter(t.idA.id, code), (e) => ['no-session', 'unreachable'].includes(e.code));
    assert.equal(read(t.a.engine.paths.trustedClients), '');
    assert.equal(Object.keys(t.a.devices.store).length, 0);
  } finally { t.done(); }
});

test('code expires', async () => {
  const t = pairOf({ codeTtlMs: 300 });
  try {
    const { code } = await t.A.start();
    const port = t.A._port();
    await waitFor(() => !t.A._active());
    const B = createPairing({ ...t.b, resolve: () => ({ address: '127.0.0.1', pairingPort: port }) });
    await assert.rejects(B.enter(t.idA.id, code), (e) => ['no-session', 'unreachable'].includes(e.code));
  } finally { t.done(); }
});

test('cancel stops the code and bad input is rejected', async () => {
  const t = pairOf();
  try {
    const { code } = await t.A.start();
    const port = t.A._port();
    t.A.cancel();
    assert.equal(t.A._active(), false);
    const B = createPairing({ ...t.b, resolve: () => ({ address: '127.0.0.1', pairingPort: port }) });
    await assert.rejects(B.enter(t.idA.id, code), (e) => ['no-session', 'unreachable'].includes(e.code));
    await assert.rejects(B.enter(t.idA.id, '12345'), (e) => e.code === 'bad-code');
    const C = createPairing({ ...t.b, resolve: () => null });
    await assert.rejects(C.enter(t.idA.id, '123456'), (e) => e.code === 'not-found');
  } finally { t.done(); }
});

test('trust-line parser matches engine Fingerprint::fromDbLine', () => {
  const fp = 'ab'.repeat(32);
  assert.deepEqual(identity.parseTrustLine(`v2:sha256:${fp}`), { type: 'sha256', hex: fp });
  assert.deepEqual(identity.parseTrustLine(`v2:SHA256:${fp.toUpperCase()}`), { type: 'sha256', hex: fp });
  assert.equal(identity.parseTrustLine('v2:sha256:abc'), null);
  assert.equal(identity.parseTrustLine(''), null);
  assert.equal(identity.parseTrustLine('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD').type, 'sha1');
  assert.equal(identity.dbLine(fp.toUpperCase()), `v2:sha256:${fp}`);
});
