// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Second-screen sessions: state machine starting -> live -> stopping -> gone.
// No Electron here; everything OS- or window-specific is injected:
//   platform: { can(), createDisplay({width,height,refresh}) -> { displayId, remove(), onGone?(cb) } }
//   media:    { findCaptureSource(displayId), openSource(cfg, onMsg), openViewer(cfg, onMsg) } -> { send, close }
//   getPeer:  () -> peer channel { send, request, on, isConnected } | null
//
// Peer messages (both directions, payloads always carry sessionId):
//   screen.open   req  source -> target  { sessionId, resolution, refresh, quality }  -> { ok: true }
//   screen.ask    req  target -> source  same; the source then starts and sends screen.open
//   screen.signal msg  { sessionId, kind: 'offer'|'answer'|'ice', data }
//   screen.stats  msg  target -> source  { sessionId, latencyMs, fps }
//   screen.stop   msg  { sessionId, reason }
// Session ids are always relative to this device: the peer side's
// 'this' becomes the sender's deviceId.

const crypto = require('node:crypto');

const OPTIONS = Object.freeze({ resolutions: ['1920x1080', '2560x1600'], refresh: [60], quality: ['latency', 'balanced', 'sharp'] });
const ID_RE = /^[0-9a-f]{16,32}$/;
const MAX_SDP = 64 * 1024;

function apiError(code, message) { return { code, message }; }

function parseRes(r) { const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(r)); return m ? { width: +m[1], height: +m[2] } : null; }

function validSignal(p) {
  if (!p || typeof p !== 'object' || !ID_RE.test(String(p.sessionId))) return false;
  const d = p.data;
  if (!d || typeof d !== 'object') return false;
  if (p.kind === 'offer' || p.kind === 'answer') return d.type === p.kind && typeof d.sdp === 'string' && d.sdp.length <= MAX_SDP;
  if (p.kind === 'ice') {
    return typeof d.candidate === 'string' && d.candidate.length <= 1024 && /(^|\s)typ\s+host(\s|$)/.test(d.candidate)
      && (d.sdpMid === null || d.sdpMid === undefined || (typeof d.sdpMid === 'string' && d.sdpMid.length <= 32))
      && (d.sdpMLineIndex === null || d.sdpMLineIndex === undefined || (Number.isInteger(d.sdpMLineIndex) && d.sdpMLineIndex >= 0 && d.sdpMLineIndex < 16));
  }
  return false;
}

function createScreen({
  log = () => {}, platform, media, getPeer,
  newId = () => crypto.randomBytes(8).toString('hex'),
  // start: driver on (~7 s) + waiting for the display (20 s) + capture and connect
  startTimeoutMs = 45000, stopTimeoutMs = 6000, requestTimeoutMs = 12000,
  watchdogMs = 2000, statsStaleMs = 10000,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  const sessions = new Map(); // id -> internal record
  const listeners = new Set();
  let peerWired = null;
  let peerRetry = null;

  // ---------- state ----------
  const pub = (s) => ({
    id: s.id, sourceId: s.sourceId, targetId: s.targetId, resolution: s.resolution, refresh: s.refresh,
    quality: s.quality, state: s.state, latencyMs: s.latencyMs, fps: s.fps,
  });

  function get() {
    let can;
    try { can = platform.can(); } catch (e) { can = { extendThis: false, showHere: false, why: `Second screen is unavailable: ${e.message}` }; }
    const out = { extendThis: !!can.extendThis, showHere: !!can.showHere };
    if (can.why) out.why = String(can.why);
    return { sessions: [...sessions.values()].map(pub), can: out, options: { resolutions: [...OPTIONS.resolutions], refresh: [...OPTIONS.refresh], quality: [...OPTIONS.quality] } };
  }

  function emit() {
    const v = get();
    for (const cb of [...listeners]) { try { cb(v); } catch (e) { log(`screen listener: ${e.message}`); } }
  }

  function on(cb) {
    if (typeof cb !== 'function') throw apiError('bad-args', 'callback must be a function');
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  // ---------- peer wiring ----------
  function peer() {
    const p = getPeer();
    if (p && peerWired !== p) wire(p);
    return p;
  }

  function wire(p) {
    peerWired = p;
    p.on('screen.open', (from, payload) => onOpen(from, payload));
    p.on('screen.ask', (from, payload) => onAsk(from, payload));
    p.on('screen.signal', (from, payload) => {
      if (!validSignal(payload)) return;
      const s = sessions.get(payload.sessionId);
      if (!s || s.remote !== from || !s.win || s.state === 'stopping') return;
      s.win.send({ type: 'signal', kind: payload.kind, data: payload.data });
    });
    p.on('screen.stats', (from, payload) => {
      const s = payload && sessions.get(payload.sessionId);
      if (!s || s.remote !== from || s.role !== 'source') return;
      if (Number.isFinite(payload.latencyMs) && payload.latencyMs >= 0 && payload.latencyMs < 60000) {
        s.remoteLatency = { ms: Math.round(payload.latencyMs), at: Date.now() };
      }
    });
    p.on('screen.stop', (from, payload) => {
      const s = payload && sessions.get(payload.sessionId);
      if (s && s.remote === from) stopSession(s, `stopped by the other device${payload.reason ? ` (${String(payload.reason).slice(0, 80)})` : ''}`, false);
    });
    log('screen: peer channel wired');
  }

  // Keep trying to wire the peer channel so this device can receive sessions
  // even before anyone opens the Second screen page.
  function wireSoon() {
    try { if (peer()) return; } catch (e) { log(`screen: peer channel: ${e.message}`); }
    peerRetry = timers.setTimeout(wireSoon, 5000);
    if (peerRetry && peerRetry.unref) peerRetry.unref();
  }

  function checkOptions(o) {
    if (!OPTIONS.resolutions.includes(o.resolution)) throw apiError('bad-args', `Resolution must be one of ${OPTIONS.resolutions.join(', ')}.`);
    if (!OPTIONS.refresh.includes(o.refresh)) throw apiError('bad-args', `Refresh must be one of ${OPTIONS.refresh.join(', ')}.`);
    if (!OPTIONS.quality.includes(o.quality)) throw apiError('bad-args', `Quality must be one of ${OPTIONS.quality.join(', ')}.`);
  }

  // ---------- session records ----------
  function addSession({ id, role, remote, resolution, refresh, quality }) {
    const s = {
      id, role, remote, resolution, refresh, quality,
      sourceId: role === 'source' ? 'this' : remote,
      targetId: role === 'source' ? remote : 'this',
      state: 'starting', latencyMs: 0, fps: 0,
      win: null, display: null, timers: [], lastStats: Date.now(), remoteLatency: null, stopping: null,
    };
    sessions.set(id, s);
    const t = timers.setTimeout(() => { if (s.state === 'starting') stopSession(s, 'timed out while starting', true); }, startTimeoutMs);
    s.timers.push(['t', t]);
    const w = timers.setInterval(() => watchdog(s), watchdogMs);
    s.timers.push(['i', w]);
    log(`screen: session ${id} ${role} ${role === 'source' ? '->' : '<-'} ${remote} ${resolution}@${refresh} ${quality}`);
    emit();
    return s;
  }

  function watchdog(s) {
    if (s.state === 'stopping') return;
    let p = null;
    try { p = getPeer(); } catch { /* none */ }
    if (!p || !p.isConnected(s.remote)) { stopSession(s, 'the link to the other device was lost', false); return; }
    if (s.state === 'live' && Date.now() - s.lastStats > statsStaleMs) stopSession(s, 'the stream stopped', true);
  }

  function setLive(s) {
    if (s.state !== 'starting') return;
    s.state = 'live';
    s.lastStats = Date.now();
    log(`screen: session ${s.id} live`);
    emit();
  }

  // Messages from this session's capture or viewer window.
  function onWindowMsg(s, msg) {
    if (s.state === 'stopping') return;
    switch (msg.type) {
      case 'signal': {
        const payload = { sessionId: s.id, kind: msg.kind, data: msg.data };
        if (!validSignal(payload)) return;
        const p = getPeer();
        if (p) Promise.resolve(p.send(s.remote, 'screen.signal', payload)).catch((e) => log(`screen: signal send: ${e.message}`));
        break;
      }
      case 'state':
        if ((s.role === 'source' && msg.state === 'connected') || (s.role === 'target' && msg.state === 'playing')) setLive(s);
        break;
      case 'stats': {
        s.lastStats = Date.now();
        const fps = Number.isFinite(msg.fps) ? Math.max(0, Math.round(msg.fps)) : 0;
        let lat = Number.isFinite(msg.latencyMs) ? Math.max(0, Math.round(msg.latencyMs)) : 0;
        // The viewer measures the fuller path (network + jitter buffer + decode).
        if (s.role === 'source' && s.remoteLatency && Date.now() - s.remoteLatency.at < 3000) lat = s.remoteLatency.ms;
        if (s.role === 'target') {
          const p = getPeer();
          if (p) Promise.resolve(p.send(s.remote, 'screen.stats', { sessionId: s.id, latencyMs: lat, fps })).catch(() => {});
        }
        if (fps !== s.fps || lat !== s.latencyMs) { s.fps = fps; s.latencyMs = lat; emit(); }
        break;
      }
      case 'end':
        stopSession(s, msg.reason || 'ended', true);
        break;
      case 'error':
        stopSession(s, `error: ${String(msg.message || '').slice(0, 200)}`, true);
        break;
      default:
    }
  }

  // ---------- source side ----------
  function startSource(remote, opts, id) {
    const s = addSession({ id, role: 'source', remote, ...opts });
    (async () => {
      const p = peer();
      if (!p) throw apiError('not-ready', 'The secure link is not ready.');
      // The viewer opens first so the laptop is ready before a monitor appears here.
      await p.request(remote, 'screen.open', { sessionId: id, resolution: opts.resolution, refresh: opts.refresh, quality: opts.quality }, { timeoutMs: requestTimeoutMs });
      if (s.state === 'stopping') return;
      const { width, height } = parseRes(opts.resolution);
      const display = await platform.createDisplay({ width, height, refresh: opts.refresh });
      // Stopped while the display was being created: the cleanup already ran, so remove it here.
      if (s.state === 'stopping') { await display.remove(); return; }
      s.display = display;
      // The monitor vanished under us (helper crashed or was killed, driver
      // turned off): the capture window keeps reporting 0 fps, so end it here.
      if (typeof display.onGone === 'function') display.onGone(() => stopSession(s, 'the virtual display went away', true));
      const sourceId = await media.findCaptureSource(s.display.displayId);
      if (s.state === 'stopping') return;
      const win = await media.openSource({ sessionId: id, chromeMediaSourceId: sourceId, width, height, refresh: opts.refresh, quality: opts.quality }, (m) => onWindowMsg(s, m));
      if (s.state === 'stopping') { win.close(); return; }
      s.win = win;
    })().catch((e) => {
      log(`screen: session ${id} failed: ${e && e.message ? e.message : e}`);
      s.error = e;
      stopSession(s, `could not start: ${e && e.message ? e.message : e}`, true);
    });
    return s;
  }

  // ---------- target side ----------
  async function onOpen(from, payload) {
    if (!payload || !ID_RE.test(String(payload.sessionId))) throw apiError('bad-args', 'bad session id');
    checkOptions(payload);
    let s = sessions.get(payload.sessionId);
    if (s && (s.role !== 'target' || s.remote !== from)) throw apiError('busy', 'That session id is in use.');
    if (!s) {
      const can = get().can;
      if (!can.showHere) throw apiError('unsupported', can.why || 'This computer can\'t show another screen.');
      if ([...sessions.values()].some((x) => x.role === 'target' && x.state !== 'stopping')) throw apiError('busy', 'This computer is already showing another screen.');
      s = addSession({ id: payload.sessionId, role: 'target', remote: from, resolution: payload.resolution, refresh: payload.refresh, quality: payload.quality });
    }
    if (s.win) return { ok: true };
    try {
      const win = await media.openViewer({ sessionId: s.id, quality: s.quality }, (m) => onWindowMsg(s, m));
      if (s.state === 'stopping') { win.close(); throw apiError('stopped', 'The session was stopped.'); }
      s.win = win;
      return { ok: true };
    } catch (e) {
      stopSession(s, `viewer failed: ${e.message}`, false);
      throw apiError(e.code || 'viewer-failed', e.message || 'The viewer could not open.');
    }
  }

  async function onAsk(from, payload) {
    if (!payload || !ID_RE.test(String(payload.sessionId))) throw apiError('bad-args', 'bad session id');
    checkOptions(payload);
    if (sessions.has(payload.sessionId)) throw apiError('busy', 'That session id is in use.');
    const can = get().can;
    if (!can.extendThis) throw apiError('unsupported', can.why || 'This computer can\'t add a display.');
    if ([...sessions.values()].some((x) => x.role === 'source' && x.state !== 'stopping')) throw apiError('busy', 'This computer is already extending onto another screen.');
    startSource(from, { resolution: payload.resolution, refresh: payload.refresh, quality: payload.quality }, payload.sessionId);
    return { ok: true };
  }

  // ---------- API ----------
  function start(opts) {
    if (!opts || typeof opts !== 'object') throw apiError('bad-args', 'start needs { sourceId, targetId, resolution, refresh, quality }');
    const { sourceId, targetId } = opts;
    if (typeof sourceId !== 'string' || typeof targetId !== 'string' || sourceId === targetId || (sourceId !== 'this' && targetId !== 'this')) {
      throw apiError('bad-args', 'One side of a second-screen session must be this computer.');
    }
    const o = { resolution: opts.resolution, refresh: opts.refresh, quality: opts.quality || 'balanced' };
    checkOptions(o);
    const p = peer();
    if (!p) throw apiError('not-ready', 'The secure link to your other computers is still starting.');
    const remote = sourceId === 'this' ? targetId : sourceId;
    if (!p.isConnected(remote)) throw apiError('offline', 'That computer isn\'t connected right now.');
    if ([...sessions.values()].some((x) => x.remote === remote && x.state !== 'stopping')) throw apiError('busy', 'A second-screen session with that computer is already running.');
    const can = get().can;

    if (sourceId === 'this') {
      if (!can.extendThis) throw apiError('unsupported', can.why || 'This computer can\'t add a display.');
      if ([...sessions.values()].some((x) => x.role === 'source' && x.state !== 'stopping')) throw apiError('busy', 'This computer is already extending onto another screen.');
      return pub(startSource(remote, o, newId()));
    }
    if (!can.showHere) throw apiError('unsupported', can.why || 'This computer can\'t show another screen.');
    if ([...sessions.values()].some((x) => x.role === 'target' && x.state !== 'stopping')) throw apiError('busy', 'This computer is already showing another screen.');
    const s = addSession({ id: newId(), role: 'target', remote, ...o });
    Promise.resolve(p.request(remote, 'screen.ask', { sessionId: s.id, ...o }, { timeoutMs: requestTimeoutMs }))
      .catch((e) => stopSession(s, `the other computer said no: ${e && e.message ? e.message : e}`, false));
    return pub(s);
  }

  function stopSession(s, reason, notify) {
    if (s.stopping) return s.stopping;
    s.state = 'stopping';
    log(`screen: session ${s.id} stopping: ${reason}`);
    emit();
    for (const [k, t] of s.timers) (k === 't' ? timers.clearTimeout : timers.clearInterval)(t);
    s.timers = [];
    if (notify) {
      try { const p = getPeer(); if (p) Promise.resolve(p.send(s.remote, 'screen.stop', { sessionId: s.id, reason: String(reason).slice(0, 120) })).catch(() => {}); } catch { /* link gone */ }
    }
    const cleanup = (async () => {
      if (s.win) { try { s.win.close(); } catch (e) { log(`screen: close window: ${e.message}`); } }
      // Always remove the virtual display, even if creation is still in flight.
      if (s.display) {
        await Promise.race([
          Promise.resolve().then(() => s.display.remove()),
          new Promise((r) => { const t = timers.setTimeout(r, stopTimeoutMs); if (t && t.unref) t.unref(); }),
        ]).catch((e) => log(`screen: remove display: ${e.message}`));
      }
    })();
    s.stopping = cleanup.finally(() => {
      sessions.delete(s.id);
      log(`screen: session ${s.id} ended`);
      emit();
    });
    return s.stopping;
  }

  async function stop(id) {
    const s = sessions.get(id);
    if (!s) return;
    await stopSession(s, 'stopped here', true);
  }

  function stopAll(reason = 'OmniDesk is quitting') {
    return Promise.all([...sessions.values()].map((s) => stopSession(s, reason, true)));
  }

  function dispose() { timers.clearTimeout(peerRetry); }

  wireSoon();
  return { get, start, stop, on, stopAll, dispose, _sessions: sessions };
}

module.exports = { createScreen, OPTIONS, validSignal, parseRes };
