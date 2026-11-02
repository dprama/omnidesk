// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Pairing with a 6-digit code (see app/main/INTERFACES.md, docs/API.md).
//
// Device A (start) shows a random code and listens on TCP 24802 for two
// minutes. Device B (enter) connects to A's address from discovery. Both run
// SPAKE2 (RFC 9382, P-256, ./spake2.js) with the code as password, B as SPAKE2
// party "A" (initiator) and A as party "B" (responder), confirm keys both ways,
// then exchange over AES-256-GCM (key = HKDF-SHA256(Ke)) each side's engine
// TLS certificate fingerprint plus { name, os, osVersion, arch, engineName,
// screens }. Each side appends the other's fingerprint to tls/trusted-servers
// and tls/trusted-clients and calls devices.upsert(). Codes are single-use,
// 3 wrong attempts end a code, comparisons are constant-time, and codes and
// keys are never logged.
//
// Wire (4-byte length-prefixed JSON, max 64 KiB):
//   B→A {t:'hello', v:1, id, pA}        A→B {t:'pb', pB, cB} | {t:'error', code}
//   B→A {t:'confirm', cA}               A→B {t:'info', box} | {t:'error', code}
//   B→A {t:'info', box}                 A→B {t:'ok'}

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const spake2 = require('./spake2');
const identity = require('./identity');
const framing = require('./framing');
const { cleanComputerName } = require('../engine/paths');

const PAIRING_PORT = 24802;
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_FRAME = 64 * 1024;
const STEP_TIMEOUT_MS = 20000;
const ID_RE = /^[0-9a-f]{20}$/;
const FP_RE = /^[0-9a-f]{64}$/;
const HEX_POINT_RE = /^04[0-9a-f]{128}$/;
const HEX_MAC_RE = /^[0-9a-f]{64}$/;
const AES_INFO = Buffer.from('OmniDesk pairing v1 AES-256-GCM');

const MESSAGES = {
  'bad-code': 'Type the 6-digit code shown on the other device.',
  'wrong-code': 'That code didn’t match. Check the code on the other device and try again.',
  'too-many-attempts': 'Too many wrong codes. Start pairing again on the other device to get a new code.',
  'no-session': 'The other device isn’t showing a pairing code any more. Start pairing there first.',
  busy: 'The other device is busy pairing. Try again in a moment.',
  'not-found': 'OmniDesk can’t see that device on the network. Make sure both devices are on the same Wi-Fi, cable or Bluetooth link.',
  unreachable: 'Couldn’t reach the other device. Check that OmniDesk is open there and allowed through the firewall.',
  timeout: 'The other device stopped answering. Try again.',
  protocol: 'Pairing failed because the other device sent something unexpected. Update OmniDesk on both devices.',
  'port-busy': 'OmniDesk couldn’t open its pairing port (24802). Is another copy of OmniDesk running?',
  'no-identity': 'OmniDesk couldn’t read or create this device’s security certificate.',
  cancelled: 'Pairing was cancelled.',
};
function fail(code, detail) {
  const e = new Error(MESSAGES[code] || detail || code);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

// ---- framed connection with a promise-based reader ----
function wrap(socket) {
  const queue = [];
  const waiters = [];
  let closed = false;
  let closeErr = null;
  const finish = (err) => {
    if (closed) return;
    closed = true;
    closeErr = err || fail('timeout', 'connection closed');
    while (waiters.length) waiters.shift().reject(closeErr);
  };
  socket.on('data', framing.decoder(MAX_FRAME, (m) => {
    if (waiters.length) waiters.shift().resolve(m); else queue.push(m);
  }, (e) => { finish(fail('protocol', e.message)); socket.destroy(); }));
  socket.on('close', () => finish());
  socket.on('error', (e) => finish(fail('unreachable', e.message)));
  return {
    socket,
    get closed() { return closed; },
    send(obj) { if (!closed) socket.write(framing.encode(obj, MAX_FRAME)); },
    next(timeoutMs = STEP_TIMEOUT_MS) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(closeErr);
      return new Promise((resolve, reject) => {
        const w = {
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(fail('timeout')); }, timeoutMs);
        waiters.push(w);
      });
    },
    end() { closed = true; socket.end(); setTimeout(() => socket.destroy(), 1000).unref(); },
  };
}

// ---- AES-256-GCM box ----
function boxKey(Ke) { return Buffer.from(crypto.hkdfSync('sha256', Ke, Buffer.alloc(0), AES_INFO, 32)); }
function seal(key, aad, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function open(key, aad, box) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(box.iv), 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(String(box.tag), 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(String(box.ct), 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw fail('protocol', 'could not open sealed info');
  }
}

// Validates the peer's info and returns the device record to upsert.
function cleanInfo(info, expectedId) {
  if (!info || typeof info !== 'object') throw fail('protocol', 'no info');
  const fp = String(info.fingerprint || '').toLowerCase();
  if (!FP_RE.test(fp)) throw fail('protocol', 'bad fingerprint');
  if (identity.idForFingerprint(fp) !== expectedId || info.id !== expectedId) throw fail('protocol', 'id does not match certificate');
  const num = (v) => (Number.isFinite(+v) ? Math.round(+v) : 0);
  const screens = (Array.isArray(info.screens) ? info.screens : []).slice(0, 16)
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ x: num(r.x), y: num(r.y), w: Math.max(0, num(r.w)), h: Math.max(0, num(r.h)) }));
  const name = String(info.name || '').replace(/\s+/g, ' ').trim().slice(0, 64) || expectedId;
  return {
    id: expectedId,
    fingerprint: fp,
    name,
    os: ['windows', 'macos', 'linux'].includes(info.os) ? info.os : 'linux',
    osVersion: String(info.osVersion || '').slice(0, 64),
    arch: info.arch === 'arm64' ? 'arm64' : 'x64',
    engineName: cleanComputerName(info.engineName) || cleanComputerName(name) || expectedId,
    screens,
    peerPort: Number.isInteger(info.peerPort) && info.peerPort > 0 && info.peerPort < 65536 ? info.peerPort : 24803,
  };
}

function hostOf(addr) { return String(addr || '').replace(/^::ffff:/, ''); }

function createPairing({
  settings, engine, log = () => {}, devices,
  discovery = null, // defaults to the shared discovery instance
  resolve = null, // (deviceId) => { address, pairingPort } (tests)
  port = PAIRING_PORT, listenHost, codeTtlMs = CODE_TTL_MS, maxAttempts = MAX_ATTEMPTS,
  peerPort = 24803, connectTimeoutMs = 8000, stepTimeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  const warn = log.warn || log;
  const disc = () => discovery || (require('../discovery').current && require('../discovery').current()) || null;
  const pairedCbs = new Set();
  let session = null; // responder: { code, expiresAt, server, attempts, busy, timer }

  function me() {
    let idn;
    try { idn = identity.loadIdentity(engine, log); } catch (e) { warn(`identity: ${e.message}`); throw fail('no-identity'); }
    let t = {};
    try { t = devices && devices.thisDevice ? devices.thisDevice() : {}; } catch { t = {}; }
    let engineName = null;
    try { engineName = engine.readSetting && engine.readSetting('core/computerName'); } catch { engineName = null; }
    return {
      idn,
      info: {
        v: 1,
        id: idn.id,
        fingerprint: idn.fingerprint,
        name: t.name || os.hostname().replace(/\.local$/, ''),
        os: t.os || (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'),
        osVersion: t.osVersion || os.release(),
        arch: t.arch || (process.arch === 'arm64' ? 'arm64' : 'x64'),
        engineName: engineName || cleanComputerName(t.name || os.hostname()),
        screens: t.screens || [],
        peerPort,
      },
    };
  }

  function trustAndSave(rec, host) {
    identity.addTrusted(engine.paths.trustedServers, rec.fingerprint);
    identity.addTrusted(engine.paths.trustedClients, rec.fingerprint);
    const d = disc();
    let link = null;
    if (d && d.linkFor) { try { const l = d.linkFor(rec.id); if (l) link = { type: l.type, available: l.available }; } catch { /* none */ } }
    const saved = devices.upsert({ ...rec, host, ...(link ? { link } : {}), paired: true, pairedAt: new Date().toISOString() });
    try { if (settings && settings.patch) settings.patch('pairing', { fingerprints: { [rec.id]: rec.fingerprint } }); } catch { /* optional */ }
    if (d && d.refresh) { try { d.refresh(); } catch { /* ignore */ } }
    log(`paired with ${rec.name} (${rec.id})`);
    for (const cb of pairedCbs) { try { cb(saved || rec); } catch (e) { warn(`onPaired: ${e.message}`); } }
    return saved || rec;
  }

  // ---- responder (shows the code) ----
  function endSession(reason) {
    const s = session;
    if (!s) return;
    session = null;
    clearTimeout(s.timer);
    try { s.server.close(); } catch { /* closed */ }
    for (const c of s.conns) { try { c.destroy(); } catch { /* closed */ } }
    log(`pairing code closed (${reason})`);
  }

  async function handle(s, socket) {
    s.conns.add(socket);
    socket.on('close', () => s.conns.delete(socket));
    const conn = wrap(socket);
    const remote = hostOf(socket.remoteAddress);
    if (session !== s || Date.now() > s.expiresAt) { conn.send({ t: 'error', code: 'no-session' }); conn.end(); return; }
    if (s.busy) { conn.send({ t: 'error', code: 'busy' }); conn.end(); return; }
    s.busy = true;
    let pending = false; // true once a code guess has been made
    let done = false;
    const strike = () => {
      s.attempts += 1;
      warn(`pairing attempt from ${remote} failed (${s.attempts}/${maxAttempts})`);
      if (s.attempts >= maxAttempts && session === s) endSession('too many attempts');
    };
    try {
      const hello = await conn.next(stepTimeoutMs);
      if (hello.t !== 'hello' || hello.v !== 1 || !ID_RE.test(hello.id) || !HEX_POINT_RE.test(String(hello.pA))) throw fail('protocol', 'bad hello');
      const mine = me();
      if (hello.id === mine.idn.id) throw fail('protocol', 'pairing with itself');
      const w = await spake2.deriveW(s.code, hello.id, mine.idn.id);
      if (session !== s) throw fail('no-session');
      const party = spake2.start('B', w);
      pending = true;
      const keys = party.finish(Buffer.from(hello.pA, 'hex'), hello.id, mine.idn.id);
      conn.send({ t: 'pb', pB: party.message.toString('hex'), cB: keys.cB.toString('hex') });
      const conf = await conn.next(stepTimeoutMs);
      if (conf.t !== 'confirm' || !HEX_MAC_RE.test(String(conf.cA)) || !spake2.macEqual(Buffer.from(conf.cA, 'hex'), keys.cA)) {
        throw fail('wrong-code');
      }
      // Correct code: it is used up now.
      pending = false;
      if (session === s) { session = null; clearTimeout(s.timer); try { s.server.close(); } catch { /* closed */ } }
      const key = boxKey(keys.Ke);
      conn.send({ t: 'info', box: seal(key, 'responder->initiator', mine.info) });
      const theirs = await conn.next(stepTimeoutMs);
      if (theirs.t !== 'info' || !theirs.box) throw fail('protocol', 'no info');
      const rec = cleanInfo(open(key, 'initiator->responder', theirs.box), hello.id);
      trustAndSave(rec, remote);
      done = true;
      conn.send({ t: 'ok' });
      conn.end();
    } catch (e) {
      if (pending && !done) strike();
      if (!conn.closed) {
        conn.send({ t: 'error', code: e.code === 'wrong-code' && session !== s ? 'too-many-attempts' : MESSAGES[e.code] ? e.code : 'protocol' });
        conn.end();
      }
      if (e.code !== 'wrong-code') warn(`pairing from ${remote}: ${e.detail || e.code || e.message}`);
    } finally {
      s.busy = false;
    }
  }

  async function start() {
    endSession('restarted');
    me(); // make sure the certificate exists before showing a code
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = Date.now() + codeTtlMs;
    const s = { code, expiresAt, attempts: 0, busy: false, conns: new Set(), server: null, timer: null };
    s.server = net.createServer((sock) => { handle(s, sock).catch(() => {}); });
    s.server.maxConnections = 4;
    await new Promise((resolve, reject) => {
      s.server.once('error', (e) => reject(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? fail('port-busy') : e));
      s.server.listen({ port, host: listenHost, exclusive: true }, resolve);
    });
    s.server.on('error', (e) => warn(`pairing server: ${e.message}`));
    s.timer = setTimeout(() => { if (session === s) endSession('expired'); }, codeTtlMs);
    if (s.timer.unref) s.timer.unref();
    session = s;
    log(`pairing code shown; listening on TCP ${port} for ${Math.round(codeTtlMs / 1000)} s`);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  // ---- initiator (types the code) ----
  let entering = null;
  async function enter(deviceId, code) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw fail('bad-code');
    if (typeof deviceId !== 'string' || !ID_RE.test(deviceId)) throw fail('not-found');
    let target = null;
    if (resolve) target = await resolve(deviceId);
    else {
      const d = disc();
      const l = d && d.lookup ? d.lookup(deviceId) : null;
      if (l) target = { address: l.address, pairingPort: l.pairingPort, fingerprint: l.fingerprint };
    }
    if (!target || !target.address) throw fail('not-found');
    const mine = me();
    if (deviceId === mine.idn.id) throw fail('not-found');

    const socket = net.connect({ host: target.address, port: target.pairingPort || PAIRING_PORT });
    entering = socket;
    const conn = wrap(socket);
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(() => { socket.destroy(); rej(fail('unreachable')); }, connectTimeoutMs);
        socket.once('connect', () => { clearTimeout(t); res(); });
        socket.once('error', (e) => { clearTimeout(t); rej(fail('unreachable', e.message)); });
      });
      const w = await spake2.deriveW(code, mine.idn.id, deviceId);
      const party = spake2.start('A', w);
      conn.send({ t: 'hello', v: 1, id: mine.idn.id, pA: party.message.toString('hex') });
      const pb = await conn.next(stepTimeoutMs);
      if (pb.t === 'error') throw fail(MESSAGES[pb.code] ? pb.code : 'protocol');
      if (pb.t !== 'pb' || !HEX_POINT_RE.test(String(pb.pB)) || !HEX_MAC_RE.test(String(pb.cB))) throw fail('protocol', 'bad pb');
      let keys;
      try { keys = party.finish(Buffer.from(pb.pB, 'hex'), mine.idn.id, deviceId); } catch { throw fail('protocol', 'bad point'); }
      if (!spake2.macEqual(Buffer.from(pb.cB, 'hex'), keys.cB)) throw fail('wrong-code');
      conn.send({ t: 'confirm', cA: keys.cA.toString('hex') });
      const box = await conn.next(stepTimeoutMs);
      if (box.t === 'error') throw fail(MESSAGES[box.code] ? box.code : 'protocol');
      if (box.t !== 'info' || !box.box) throw fail('protocol', 'no info');
      const key = boxKey(keys.Ke);
      const rec = cleanInfo(open(key, 'responder->initiator', box.box), deviceId);
      if (target.fingerprint && target.fingerprint !== rec.fingerprint) throw fail('protocol', 'fingerprint differs from the advertised one');
      conn.send({ t: 'info', box: seal(key, 'initiator->responder', mine.info) });
      const ok = await conn.next(stepTimeoutMs);
      if (ok.t !== 'ok') throw fail(ok.t === 'error' && MESSAGES[ok.code] ? ok.code : 'protocol');
      conn.end();
      return trustAndSave(rec, hostOf(target.address));
    } catch (e) {
      socket.destroy();
      if (entering !== socket && e.code !== 'wrong-code') throw fail('cancelled');
      if (e.code && MESSAGES[e.code]) {
        if (e.detail) warn(`pairing with ${deviceId}: ${e.code} (${e.detail})`);
        throw e;
      }
      warn(`pairing with ${deviceId}: ${e.message}`);
      throw fail('protocol', e.message);
    } finally {
      if (entering === socket) entering = null;
    }
  }

  function cancel() {
    endSession('cancelled');
    if (entering) { const s = entering; entering = null; s.destroy(); }
  }

  function forget(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) return false;
    let fp = null;
    try { fp = ((settings && settings.get && settings.get('pairing')) || {}).fingerprints?.[deviceId] || null; } catch { fp = null; }
    const match = (hex) => hex === fp || (ID_RE.test(deviceId) && hex.startsWith(deviceId));
    let changed = identity.removeTrusted(engine.paths.trustedServers, match);
    changed = identity.removeTrusted(engine.paths.trustedClients, match) || changed;
    try {
      if (settings && settings.get && settings.set) {
        const p = settings.get('pairing') || {};
        if (p.fingerprints && p.fingerprints[deviceId]) {
          const fps = { ...p.fingerprints };
          delete fps[deviceId];
          settings.set('pairing', { ...p, fingerprints: fps });
        }
      }
    } catch { /* optional */ }
    const d = disc();
    if (d && d.refresh) { try { d.refresh(); } catch { /* ignore */ } }
    if (changed) log(`forgot ${deviceId}: removed its fingerprint from the trust files`);
    return changed;
  }

  return {
    start, enter, cancel, forget,
    onPaired(cb) { pairedCbs.add(cb); return () => pairedCbs.delete(cb); },
    stop() { cancel(); },
    // tests
    _port: () => (session && session.server.address() ? session.server.address().port : null),
    _active: () => !!session,
  };
}

function create(args) {
  return createPairing(args);
}

module.exports = { create, createPairing, PAIRING_PORT, cleanInfo, get peer() { return require('./peer'); } };
