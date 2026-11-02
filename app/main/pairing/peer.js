// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Peer channel between paired devices: mutual TLS on TCP 24803 with each
// device's engine certificate (tls/deskflow.pem). Only peers whose SHA-256
// certificate fingerprint is in tls/trusted-servers or tls/trusted-clients are
// accepted. JSON messages, 4-byte big-endian length prefix, max 1 MiB each.
// Interface: ./PEER.md.

const tls = require('node:tls');
const crypto = require('node:crypto');
const identity = require('./identity');
const framing = require('./framing');

const PEER_PORT = 24803;
const MAX_MESSAGE = 1024 * 1024;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60000;

function peerError(code, message) { const e = new Error(message); e.code = code; return e; }

function createPeer({
  engine, devices, log = () => {},
  discovery = null, // defaults to the shared discovery instance
  resolve = null, // (deviceId) => { address, peerPort } (tests)
  port = PEER_PORT, listenHost,
  connectTimeoutMs = 8000, backoffMinMs = BACKOFF_MIN_MS, backoffMaxMs = BACKOFF_MAX_MS,
  autoConnect = true,
} = {}) {
  const warn = log.warn || log;
  const disc = () => discovery || (require('../discovery').current && require('../discovery').current()) || null;
  const handlers = new Map(); // type -> Set(fn)
  const conns = new Map(); // deviceId -> conn
  const dialing = new Map(); // deviceId -> Promise<conn>
  const retry = new Map(); // deviceId -> { delay, timer }
  const pending = new Map(); // request id -> { resolve, reject, timer, conn }
  let server = null;
  let boundPort = null;
  let stopped = false;
  const me = () => identity.loadIdentity(engine, log); // cached unless the file changes
  const trusted = (fp) => identity.isTrusted(engine.paths, fp);
  const fpOfSocket = (socket) => {
    const c = socket.getPeerCertificate();
    return c && c.raw ? identity.fingerprintOfDer(c.raw) : null;
  };

  function expectedFingerprint(deviceId) {
    let rec = null;
    try { rec = devices && devices.record ? devices.record(deviceId) : null; } catch { rec = null; }
    if (rec && rec.fingerprint) return String(rec.fingerprint).toLowerCase();
    const d = disc();
    const l = d && d.lookup ? d.lookup(deviceId) : null;
    return l && l.fingerprint ? l.fingerprint : null;
  }

  async function target(deviceId) {
    if (resolve) return resolve(deviceId);
    const d = disc();
    const l = d && d.lookup ? d.lookup(deviceId) : null;
    if (l && l.address) return { address: l.address, peerPort: l.peerPort };
    let rec = null;
    try { rec = devices && devices.record ? devices.record(deviceId) : null; } catch { rec = null; }
    if (rec && rec.host) return { address: rec.host, peerPort: rec.peerPort || PEER_PORT };
    return null;
  }

  // ---- connections ----
  function attach(socket, deviceId, dialer) {
    const myId = me().id;
    const existing = conns.get(deviceId);
    if (existing && !existing.closed) {
      // Simultaneous dials: keep the connection dialled by the smaller id.
      const keepNew = dialer === (myId < deviceId);
      const keepOld = existing.dialer === (myId < deviceId);
      if (!keepNew || keepOld) { socket.destroy(); return existing; }
      existing.close();
    }
    const conn = { socket, deviceId, dialer, closed: false, fingerprint: fpOfSocket(socket) };
    conn.write = (obj) => new Promise((res, rej) => {
      let frame;
      try { frame = framing.encode(obj, MAX_MESSAGE); } catch (e) { rej(peerError('too-large', 'The message is larger than 1 MB.')); return; }
      if (conn.closed) { rej(peerError('disconnected', 'The device disconnected.')); return; }
      socket.write(frame, (err) => (err ? rej(peerError('disconnected', 'The device disconnected.')) : res()));
    });
    conn.close = () => { if (!conn.closed) { conn.closed = true; socket.destroy(); } };
    socket.setKeepAlive(true, 15000);
    socket.setNoDelay(true);
    socket.on('data', framing.decoder(MAX_MESSAGE, (m) => onMessage(conn, m), (e) => { warn(`peer ${deviceId}: ${e.message}`); conn.close(); }));
    socket.on('error', () => {});
    socket.on('close', () => {
      conn.closed = true;
      if (conns.get(deviceId) === conn) {
        conns.delete(deviceId);
        log(`peer ${deviceId} disconnected`);
        schedule(deviceId);
      }
      for (const [id, p] of pending) if (p.conn === conn) { pending.delete(id); clearTimeout(p.timer); p.reject(peerError('disconnected', 'The device disconnected.')); }
    });
    conns.set(deviceId, conn);
    const r = retry.get(deviceId);
    if (r) { clearTimeout(r.timer); retry.delete(deviceId); }
    log(`peer ${deviceId} connected (${dialer ? 'out' : 'in'})`);
    return conn;
  }

  function dial(deviceId) {
    if (dialing.has(deviceId)) return dialing.get(deviceId);
    const p = (async () => {
      const fp = expectedFingerprint(deviceId);
      if (!fp || !trusted(fp)) throw peerError('not-paired', 'Pair this device first.');
      const t = await target(deviceId);
      if (!t || !t.address) throw peerError('offline', 'That device isn’t reachable right now.');
      const mine = me();
      const socket = tls.connect({
        host: t.address, port: t.peerPort || PEER_PORT,
        key: mine.keyPem, cert: mine.certPem,
        rejectUnauthorized: false, checkServerIdentity: () => undefined,
        minVersion: 'TLSv1.3',
      });
      await new Promise((res, rej) => {
        const timer = setTimeout(() => { socket.destroy(); rej(peerError('offline', 'That device isn’t reachable right now.')); }, connectTimeoutMs);
        socket.once('secureConnect', () => { clearTimeout(timer); res(); });
        socket.once('error', () => { clearTimeout(timer); rej(peerError('offline', 'That device isn’t reachable right now.')); });
      });
      const got = fpOfSocket(socket);
      if (!got || got !== fp || !trusted(got)) {
        socket.destroy();
        warn(`peer ${deviceId}: certificate does not match the paired fingerprint`);
        throw peerError('untrusted', 'That device’s certificate changed. Pair it again.');
      }
      return attach(socket, deviceId, true);
    })();
    dialing.set(deviceId, p);
    p.then(() => dialing.delete(deviceId), () => dialing.delete(deviceId));
    return p;
  }

  async function ensure(deviceId) {
    if (stopped) throw peerError('stopped', 'The peer channel is stopped.');
    const c = conns.get(deviceId);
    if (c && !c.closed) return c;
    try {
      return await dial(deviceId);
    } catch (e) {
      schedule(deviceId);
      throw e;
    }
  }

  // Reconnect with exponential backoff while the device is paired.
  function schedule(deviceId) {
    if (stopped || !autoConnect || retry.has(deviceId)) return;
    const c = conns.get(deviceId);
    if (c && !c.closed) return;
    const fp = expectedFingerprint(deviceId);
    if (!fp || !trusted(fp)) return;
    const prev = retry.get(deviceId);
    const delay = Math.min(backoffMaxMs, prev ? prev.delay * 2 : backoffMinMs);
    const r = { delay, timer: null };
    r.timer = setTimeout(() => {
      retry.delete(deviceId);
      dial(deviceId).catch(() => {
        const next = { delay: Math.min(backoffMaxMs, delay * 2), timer: null };
        retry.set(deviceId, next);
        next.timer = setTimeout(() => { retry.delete(deviceId); schedule(deviceId); }, next.delay);
        if (next.timer.unref) next.timer.unref();
      });
    }, delay * (0.75 + Math.random() * 0.5));
    if (r.timer.unref) r.timer.unref();
    retry.set(deviceId, r);
  }

  function pairedIds() {
    try {
      return (devices && devices.list ? devices.list() : []).filter((d) => !d.thisDevice && d.paired).map((d) => d.id);
    } catch { return []; }
  }

  function sync() {
    // Drop connections whose fingerprint is no longer trusted (forgotten).
    for (const c of conns.values()) if (!c.fingerprint || !trusted(c.fingerprint)) c.close();
    for (const id of pairedIds()) if (!conns.has(id)) schedule(id);
  }

  // ---- messages ----
  function onMessage(conn, m) {
    const from = conn.deviceId;
    if (m.t === 'res') {
      const p = pending.get(m.id);
      if (!p || p.conn.deviceId !== from) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.payload);
      else p.reject(peerError(String((m.error && m.error.code) || 'remote-error'), String((m.error && m.error.message) || 'The other device could not do that.')));
      return;
    }
    if ((m.t !== 'msg' && m.t !== 'req') || typeof m.type !== 'string') return;
    const fns = handlers.get(m.type);
    let replied = m.t !== 'req';
    const reply = (payload) => {
      if (replied) return;
      replied = true;
      conn.write({ t: 'res', id: m.id, ok: true, payload: payload === undefined ? null : payload }).catch((e) => {
        if (e.code === 'too-large') conn.write({ t: 'res', id: m.id, ok: false, error: { code: 'too-large', message: 'The reply is larger than 1 MB.' } }).catch(() => {});
      });
    };
    reply.error = (err) => {
      if (replied) return;
      replied = true;
      conn.write({ t: 'res', id: m.id, ok: false, error: { code: String((err && err.code) || 'error'), message: String((err && err.message) || 'Error') } }).catch(() => {});
    };
    if (!fns || !fns.size) { reply.error({ code: 'no-handler', message: `The other device does not handle ${m.type}.` }); return; }
    for (const fn of [...fns]) {
      try {
        const r = fn(from, m.payload, reply);
        if (r && typeof r.then === 'function') r.then((v) => { if (v !== undefined) reply(v); }, (e) => reply.error(e));
        else if (r !== undefined) reply(r);
      } catch (e) {
        warn(`peer handler ${m.type}: ${e.message}`);
        reply.error(e);
      }
    }
  }

  // ---- server ----
  function listen() {
    let mine;
    try { mine = me(); } catch (e) { warn(`peer channel off: ${e.message}`); return Promise.resolve(false); }
    server = tls.createServer({
      key: mine.keyPem, cert: mine.certPem,
      requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3',
    }, (socket) => {
      const fp = fpOfSocket(socket);
      if (!fp || !trusted(fp)) { socket.destroy(); return; }
      attach(socket, identity.idForFingerprint(fp), false);
    });
    server.on('tlsClientError', () => {});
    server.on('error', (e) => warn(`peer server: ${e.message}`));
    return new Promise((res) => {
      server.once('error', (e) => { warn(`peer channel could not listen on ${port}: ${e.code || e.message}`); res(false); });
      server.listen({ port, host: listenHost }, () => { boundPort = server.address().port; log(`peer channel on TCP ${boundPort}`); res(true); });
    });
  }

  const ready = listen();
  if (autoConnect) {
    ready.then(() => sync());
    if (devices && devices.on) devices.on('change', () => { if (!stopped) sync(); });
  }

  return {
    send(deviceId, type, payload) {
      return ensure(deviceId).then((c) => c.write({ t: 'msg', type: String(type), payload: payload === undefined ? null : payload }));
    },
    request(deviceId, type, payload, { timeoutMs = 15000 } = {}) {
      return ensure(deviceId).then((c) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(peerError('timeout', 'The other device didn’t answer in time.')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer, conn: c });
        c.write({ t: 'req', id, type: String(type), payload: payload === undefined ? null : payload })
          .catch((e) => { pending.delete(id); clearTimeout(timer); reject(e); });
      }));
    },
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => { const s = handlers.get(type); if (s) s.delete(fn); };
    },
    isConnected(deviceId) { const c = conns.get(deviceId); return !!(c && !c.closed); },
    // extras
    ready,
    port: () => boundPort,
    stop() {
      stopped = true;
      for (const r of retry.values()) clearTimeout(r.timer);
      retry.clear();
      for (const c of conns.values()) c.close();
      conns.clear();
      return new Promise((res) => (server ? server.close(() => res()) : res()));
    },
  };
}

let shared = null;
// One channel per process: every caller gets the same instance.
function create(args) {
  if (!shared) shared = createPeer(args);
  return shared;
}

module.exports = { create, createPeer, current: () => shared, PEER_PORT, MAX_MESSAGE };
