// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// This device's engine TLS identity and the engine's trust files.
//
// - Certificate: tls/deskflow.pem holds the private key (PKCS#8 PEM) followed by
//   the X.509 certificate, exactly like deskflow::generatePemSelfSignedCert
//   (engine/src/lib/net/SecureUtils.cpp). Only the engine's Qt GUI generates it
//   (gui/TlsUtility.cpp), never deskflow-core, so OmniDesk reproduces it here
//   with node:crypto: RSA (security/keySize, min 2048), CN=Deskflow, SHA-256
//   signature, 365 days. An existing certificate is never replaced.
// - Fingerprint: SHA-256 of the DER certificate (net/SecureUtils.cpp).
// - Trust files tls/trusted-servers and tls/trusted-clients: one fingerprint
//   per line, "v2:sha256:<64 lowercase hex>" (net/Fingerprint.cpp toDbLine,
//   FingerprintDatabase.cpp: blank lines skipped, v1 "AA:BB:…" SHA-1 lines kept).
// - Device id: the first 20 hex chars of the fingerprint. Stable while the
//   certificate is, and it lets a peer check that an id belongs to a cert.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_LEN = 20;
const FP_RE = /^[0-9a-f]{64}$/;

// ---- minimal DER ----
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, ...content) {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}
const seq = (...c) => der(0x30, ...c);
const set = (...c) => der(0x31, ...c);
const nul = () => Buffer.from([0x05, 0x00]);
function oid(str) {
  const parts = str.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const tmp = [p & 0x7f];
    let v = p >>> 7;
    while (v > 0) { tmp.unshift(0x80 | (v & 0x7f)); v >>>= 7; }
    out.push(...tmp);
  }
  return der(0x06, Buffer.from(out));
}
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}
function utcTime(d) {
  const p = (v) => String(v).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(s, 'ascii'));
}

// Self-signed X.509 like the engine's: { keyPem, certPem, pem }.
function generateCertificate({ keySize = 2048, cn = 'Deskflow', days = 365, now = new Date() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: Math.max(2048, keySize | 0) });
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), nul()); // sha256WithRSAEncryption
  const name = seq(set(seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    der(0xa0, int(Buffer.from([2]))), // v3
    int(serial),
    sigAlg,
    name,
    seq(utcTime(now), utcTime(new Date(now.getTime() + days * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, sigAlg, der(0x03, Buffer.from([0]), sig));
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { keyPem, certPem, pem: keyPem + certPem };
}

// ---- PEM parsing / fingerprints ----
function splitPem(text) {
  const key = text.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/);
  const cert = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  return { keyPem: key ? key[0] + '\n' : null, certPem: cert ? cert[0] + '\n' : null };
}

// SHA-256 over DER, lowercase hex.
function fingerprintOfDer(derBuf) { return crypto.createHash('sha256').update(derBuf).digest('hex'); }
function fingerprintOfPem(certPem) { return fingerprintOfDer(new crypto.X509Certificate(certPem).raw); }
function idForFingerprint(fp) { return String(fp).slice(0, ID_LEN); }

// Loads tls/deskflow.pem, generating it when missing. Cached per path+mtime.
const cache = new Map();
function certificatePath(engine) {
  let p = null;
  try { p = engine.readSetting && engine.readSetting('security/certificate'); } catch { p = null; }
  return p || engine.paths.certificate;
}
function loadIdentity(engine, log) {
  const file = certificatePath(engine);
  let st = null;
  try { st = fs.statSync(file); } catch { st = null; }
  const hit = cache.get(file);
  if (hit && st && hit.mtimeMs === st.mtimeMs) return hit.identity;
  let text = st ? fs.readFileSync(file, 'utf8') : '';
  let { keyPem, certPem } = splitPem(text);
  if (!keyPem || !certPem) {
    if (st) throw Object.assign(new Error(`engine certificate ${file} has no key or certificate`), { code: 'bad-certificate' });
    let keySize = 2048;
    try { keySize = Math.max(2048, parseInt(engine.readSetting && engine.readSetting('security/keySize'), 10) || 2048); } catch { /* default */ }
    if (log) log(`generating engine TLS certificate (RSA ${keySize})`);
    const gen = generateCertificate({ keySize });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Never overwrite a certificate another process created meanwhile.
    try {
      fs.writeFileSync(file, gen.pem, { flag: 'wx', mode: 0o600 });
      text = gen.pem;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      text = fs.readFileSync(file, 'utf8');
    }
    ({ keyPem, certPem } = splitPem(text));
    st = fs.statSync(file);
  }
  const fingerprint = fingerprintOfPem(certPem);
  const identity = { keyPem, certPem, fingerprint, id: idForFingerprint(fingerprint), file };
  cache.set(file, { mtimeMs: st.mtimeMs, identity });
  return identity;
}

// ---- trust files ----
function parseTrustLine(line) {
  const l = String(line).trim();
  if (!l) return null;
  if (l.startsWith('v2:')) {
    const p = l.split(':');
    if (p.length !== 3) return null;
    const type = p[1].toLowerCase();
    const hexStr = p[2].toLowerCase();
    if (type === 'sha256' && FP_RE.test(hexStr)) return { type, hex: hexStr };
    if (type === 'sha1' && /^[0-9a-f]{40}$/.test(hexStr)) return { type, hex: hexStr };
    return null;
  }
  if (l.length === 59 && (l.match(/:/g) || []).length === 19) return { type: 'sha1', hex: l.replace(/:/g, '').toLowerCase() };
  return null;
}
function dbLine(fp) {
  const hexStr = String(fp).toLowerCase();
  if (!FP_RE.test(hexStr)) throw new Error('fingerprint must be 64 hex chars');
  return `v2:sha256:${hexStr}`;
}
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return []; }
}
function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = lines.filter((l) => l.trim()).map((l) => l.trim() + '\n').join('');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, file);
}
function trustedFingerprints(file) {
  const out = new Set();
  for (const l of readLines(file)) {
    const p = parseTrustLine(l);
    if (p && p.type === 'sha256') out.add(p.hex);
  }
  return out;
}
// Appends fp unless present. Returns true when the file changed.
function addTrusted(file, fp) {
  const line = dbLine(fp);
  const lines = readLines(file);
  if (lines.some((l) => { const p = parseTrustLine(l); return p && p.type === 'sha256' && p.hex === fp.toLowerCase(); })) return false;
  writeLines(file, [...lines, line]);
  return true;
}
// Removes sha256 lines matching predicate(hex). Returns true when changed.
function removeTrusted(file, match) {
  const lines = readLines(file);
  const keep = lines.filter((l) => { const p = parseTrustLine(l); return !(p && p.type === 'sha256' && match(p.hex)); });
  if (keep.filter((l) => l.trim()).length === lines.filter((l) => l.trim()).length) return false;
  writeLines(file, keep);
  return true;
}
function isTrusted(paths, fp) {
  const f = String(fp).toLowerCase();
  return trustedFingerprints(paths.trustedServers).has(f) || trustedFingerprints(paths.trustedClients).has(f);
}

module.exports = {
  ID_LEN, generateCertificate, splitPem, fingerprintOfDer, fingerprintOfPem, idForFingerprint,
  loadIdentity, certificatePath, parseTrustLine, dbLine, trustedFingerprints, addTrusted, removeTrusted, isTrusted,
};
