// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const spake2 = require('./spake2');
// RFC 9382 Appendix B, extracted verbatim (P256-SHA256-HKDF-HMAC).
const VECTORS = require('./fixtures/rfc9382-vectors.json');

const hex = (b) => Buffer.from(b).toString('hex');

for (const v of VECTORS) {
  test(`RFC 9382 vector A='${v.A}' B='${v.B}'`, () => {
    const w = BigInt('0x' + v.w);
    const a = spake2.start('A', w, { scalar: BigInt('0x' + v.x) });
    const b = spake2.start('B', w, { scalar: BigInt('0x' + v.y) });
    assert.equal(hex(a.message), v.pA);
    assert.equal(hex(b.message), v.pB);
    const ka = a.finish(b.message, v.A, v.B);
    const kb = b.finish(a.message, v.A, v.B);
    for (const k of [ka, kb]) {
      assert.equal(hex(k.K), v.K);
      assert.equal(hex(k.TT), v.TT);
      assert.equal(hex(k.Ke), v.Ke);
      assert.equal(hex(k.Ka), v.Ka);
      assert.equal(hex(k.KcA), v.KcA);
      assert.equal(hex(k.KcB), v.KcB);
      assert.equal(hex(k.cA), v.cA);
      assert.equal(hex(k.cB), v.cB);
    }
  });
}

test('different passwords give different keys and failing confirmation', async () => {
  const w1 = await spake2.deriveW('123456', 'a', 'b');
  const w2 = await spake2.deriveW('123457', 'a', 'b');
  assert.notEqual(w1, w2);
  assert.equal(await spake2.deriveW('123456', 'a', 'b'), w1);
  const a = spake2.start('A', w1);
  const b = spake2.start('B', w2);
  const ka = a.finish(b.message, 'a', 'b');
  const kb = b.finish(a.message, 'a', 'b');
  assert.equal(spake2.macEqual(ka.cB, kb.cB), false);
  assert.equal(spake2.macEqual(ka.cA, kb.cA), false);
});

test('same password confirms', async () => {
  const w = await spake2.deriveW('000042', 'a', 'b');
  const a = spake2.start('A', w);
  const b = spake2.start('B', w);
  const ka = a.finish(b.message, 'a', 'b');
  const kb = b.finish(a.message, 'a', 'b');
  assert.ok(spake2.macEqual(ka.cA, kb.cA));
  assert.ok(spake2.macEqual(ka.cB, kb.cB));
  assert.ok(spake2.macEqual(ka.Ke, kb.Ke));
});

test('rejects invalid peer elements', async () => {
  const a = spake2.start('A', 5n);
  assert.throws(() => a.finish(Buffer.alloc(65), 'a', 'b'));
  assert.throws(() => a.finish(Buffer.from('04' + '11'.repeat(64), 'hex'), 'a', 'b'));
  assert.throws(() => a.finish(Buffer.alloc(0), 'a', 'b'));
});
