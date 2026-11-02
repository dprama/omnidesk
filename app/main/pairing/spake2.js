// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// SPAKE2 (RFC 9382), ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC, no AAD.
// Party A sends pA = w*M + x*P, party B sends pB = w*N + y*P. Both derive
// TT (§3.3), Ke || Ka = SHA256(TT), KcA || KcB = HKDF(Ka, nil,
// "ConfirmationKeys", 32) and confirm with cA = HMAC(KcA, TT),
// cB = HMAC(KcB, TT) (§4). Never log any value this module returns.

const crypto = require('node:crypto');
const { p256 } = require('@noble/curves/p256');
const { sha256 } = require('@noble/hashes/sha256');
const { hkdf } = require('@noble/hashes/hkdf');
const { hmac } = require('@noble/hashes/hmac');

const Point = p256.ProjectivePoint;
const n = p256.CURVE.n;

// RFC 9382 §6, P-256 seeds (compressed SEC1).
const M = Point.fromHex('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f');
const N = Point.fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49');

// w derivation (the RFC leaves MHF to the application): scrypt over the
// code, salted with both identities, 40 bytes (64 bits more than n) mod n.
const W_SALT = 'OmniDesk SPAKE2-P256-SHA256-HKDF-HMAC v1';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function bytesToBig(b) { return BigInt('0x' + (Buffer.from(b).toString('hex') || '0')); }
function bigTo32(v) { return Buffer.from(v.toString(16).padStart(64, '0'), 'hex'); }
function len8(buf) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(buf.length)); return b; }

function deriveW(password, idA, idB) {
  const salt = Buffer.concat([Buffer.from(W_SALT), len8(Buffer.from(idA)), Buffer.from(idA), len8(Buffer.from(idB)), Buffer.from(idB)]);
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(String(password), 'utf8'), salt, 40, SCRYPT, (err, out) => {
      if (err) return reject(err);
      const w = bytesToBig(out) % n;
      out.fill(0);
      resolve(w);
    });
  });
}

// Uniform scalar in [1, n): rejection sampling inside noble.
function randomScalar() { return bytesToBig(p256.utils.randomPrivateKey()); }

// Parses and validates a peer element (on curve, not identity).
function decodePoint(bytes) {
  let pt;
  try { pt = Point.fromHex(Buffer.from(bytes)); } catch { throw new Error('invalid point'); }
  pt.assertValidity();
  if (pt.equals(Point.ZERO)) throw new Error('invalid point');
  return pt;
}

function transcript(idA, idB, pA, pB, K, w) {
  const parts = [Buffer.from(idA), Buffer.from(idB), Buffer.from(pA), Buffer.from(pB), Buffer.from(K), bigTo32(w)];
  return Buffer.concat(parts.flatMap((p) => [len8(p), p]));
}

function keySchedule(TT) {
  const h = Buffer.from(sha256(TT));
  const Ke = h.subarray(0, 16);
  const Ka = h.subarray(16, 32);
  const kc = Buffer.from(hkdf(sha256, Ka, undefined, Buffer.from('ConfirmationKeys'), 32));
  const KcA = kc.subarray(0, 16);
  const KcB = kc.subarray(16, 32);
  return {
    Ke, Ka, KcA, KcB,
    cA: Buffer.from(hmac(sha256, KcA, TT)),
    cB: Buffer.from(hmac(sha256, KcB, TT)),
  };
}

// role 'A' or 'B'. opts.scalar lets tests inject x / y.
function start(role, w, opts = {}) {
  if (role !== 'A' && role !== 'B') throw new Error('role must be A or B');
  const s = opts.scalar !== undefined ? BigInt(opts.scalar) : randomScalar();
  const mine = (role === 'A' ? M : N).multiply(w).add(Point.BASE.multiply(s));
  const msg = Buffer.from(mine.toRawBytes(false));
  return {
    message: msg,
    // Returns { Ke, KcA, KcB, cA, cB, TT }; throws on an invalid peer element.
    finish(peerMsg, idA, idB) {
      const peer = decodePoint(peerMsg);
      const other = role === 'A' ? N : M;
      const Kpt = peer.subtract(other.multiply(w)).multiply(s); // h = 1 for P-256
      if (Kpt.equals(Point.ZERO)) throw new Error('invalid shared element');
      const K = Buffer.from(Kpt.toRawBytes(false));
      const pA = role === 'A' ? msg : Buffer.from(peerMsg);
      const pB = role === 'A' ? Buffer.from(peerMsg) : msg;
      const TT = transcript(idA, idB, pA, pB, K, w);
      return { ...keySchedule(TT), TT, K };
    },
  };
}

// Constant-time equality for MACs.
function macEqual(a, b) {
  const x = Buffer.from(a || []);
  const y = Buffer.from(b || []);
  if (x.length !== y.length || x.length === 0) {
    crypto.timingSafeEqual(x.length ? x : Buffer.alloc(1), x.length ? x : Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

module.exports = { M, N, deriveW, start, transcript, keySchedule, macEqual, bigTo32 };
