// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Camera sharing between paired computers (multi-device mode). No Electron here;
// windows and OS permission are injected:
//   windows: { cameraAccess() -> { ok, why? },
//              openCapture(onMsg) -> { send, close },        hidden, holds the one camera stream
//              openViewer({ sessionId, title }, onMsg) -> { send, close } }  small always-on-top window
//   getPeer: () -> peer channel { send, request, on, isConnected } | null
//
// One camera runs at a time on the whole desk. The device whose switch is on
// holds the "claim" { owner, ts, prev }; its camera only runs while someone watches.
//
// Peer messages (every payload carries `to`, the recipient's own device id;
// ids inside payloads are 'me' = sender, 'you' = recipient, or a device id):
//   camera.state   msg  { to, shared, ts, prev: { owner, ts } | null, watchers: id[] }
//   camera.stop    req  claimant -> current sharer { to, ts }        -> { ok: true }
//   camera.watch   req  watcher -> sharer { to, sessionId }          -> { ok: true }
//   camera.signal  msg  { sessionId, kind: 'offer'|'answer'|'ice', data }
//   camera.unwatch msg  { sessionId, reason }   either side ends one watch session

const crypto = require('node:crypto');
const { validSignal } = require('../screen/core');

const SESSION_RE = /^[0-9a-f]{16,32}$/;
const DEVICE_RE = /^[0-9a-f]{8,64}$/;

const MULTI_OFF = Object.freeze({ code: 'multi-off', message: 'Turn on multi-device mode to share your camera.' });

function apiError(code, message) { return { code, message }; }
function msgOf(e) { return e && e.message ? e.message : String(e); }

function createCamera({
  log = () => {}, getPeer, devices, settings, multi, windows,
  now = Date.now, newId = () => crypto.randomBytes(8).toString('hex'),
  startTimeoutMs = 20000, requestTimeoutMs = 12000, cameraTimeoutMs = 15000, watchdogMs = 2000,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
}) {
  const listeners = new Set();
  const sessions = new Map(); // sessionId -> { id, remote, state, timer }   (this device shares)
  let shared = false;
  let claim = null; // { owner: 'this'|deviceId, ts, prev: { owner, ts } | null }
  let remoteWatchers = []; // watcher list from the claim owner, in local ids
  let viewing = null; // { id, remote, state, win, timer }   (this device watches)
  let capture = null; // window handle while the camera runs
  let cameraOn = false;
  let cameraStart = null; // Promise while the camera is starting
  let camWait = null; // { resolve, reject, timer }
  let why = null;
  let selfId = null;
  let reach = new Set();
  let peerWired = null;
  let lastJson = '';
  let closed = false;

  // ---------- helpers ----------
  const multiOn = () => { try { const m = typeof multi === 'function' ? multi() : multi.get(); return !!(m && m.enabled); } catch { return false; } };
  const peer = () => {
    let p = null;
    try { p = getPeer(); } catch { p = null; }
    if (p && peerWired !== p) wire(p);
    return p;
  };
  const connected = (id) => { const p = peer(); try { return !!(p && p.isConnected(id)); } catch { return false; } };
  const nameOf = (id) => { try { const d = devices && devices.get && devices.get(id); return (d && d.name) || 'Another device'; } catch { return 'Another device'; } };
  const uniq = (a) => [...new Set(a)];
  const sendTo = (id, type, payload) => {
    const p = peer();
    if (!p) return;
    Promise.resolve().then(() => p.send(id, type, payload)).catch((e) => log(`camera: send ${type} to ${id}: ${msgOf(e)}`));
  };

  function enc(id, to) { return id === 'this' ? 'me' : id === to ? 'you' : id; }
  function dec(x, from) {
    if (x === 'me') return from;
    if (x === 'you') return 'this';
    if (typeof x !== 'string' || !DEVICE_RE.test(x)) return null;
    return x === selfId ? 'this' : x;
  }
  const realId = (id) => (id === 'this' ? selfId || '' : id);
  // The newest switch wins a race (also against a stale claim from a device that
  // was away while another took over); same millisecond: lowest device id.
  const beats = (a, b) => a.ts > b.ts || (a.ts === b.ts && realId(a.owner) < realId(b.owner));

  function pairedIds() {
    let list = [];
    try { list = devices.list(); } catch { list = []; }
    return list.filter((d) => d && !d.thisDevice && d.id !== 'this' && d.paired !== false).map((d) => ({ id: d.id, online: !!d.online }));
  }

  // ---------- state ----------
  function get() {
    let watchers = [];
    if (claim && claim.owner === 'this') watchers = uniq([...sessions.values()].map((s) => s.remote));
    else if (claim) watchers = uniq([...remoteWatchers, ...(viewing && viewing.remote === claim.owner ? ['this'] : [])]);
    const out = { shared, liveDeviceId: claim ? claim.owner : null, watchers };
    if (why) out.why = why;
    return out;
  }

  function emit() {
    const v = get();
    const j = JSON.stringify(v);
    if (j === lastJson) return;
    lastJson = j;
    for (const cb of [...listeners]) { try { cb(v); } catch (e) { log(`camera listener: ${msgOf(e)}`); } }
  }

  function on(cb) {
    if (typeof cb !== 'function') throw apiError('bad-args', 'callback must be a function');
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function stateFor(to) {
    if (claim && claim.owner === 'this') {
      return {
        to, shared: true, ts: claim.ts,
        prev: claim.prev ? { owner: enc(claim.prev.owner, to), ts: claim.prev.ts } : null,
        watchers: uniq([...sessions.values()].map((s) => enc(s.remote, to))),
      };
    }
    return { to, shared: false, ts: now() };
  }

  function announce(ids = [...reach]) { for (const id of ids) sendTo(id, 'camera.state', stateFor(id)); }

  function persist(v) { try { settings.patch('camera', { shared: v, ts: v && claim && claim.owner === 'this' ? claim.ts : 0 }); } catch (e) { log(`camera: save setting: ${msgOf(e)}`); } }

  // ---------- peer wiring ----------
  function wire(p) {
    peerWired = p;
    p.on('camera.state', (from, payload) => onState(from, payload));
    p.on('camera.stop', (from, payload) => onStop(from, payload));
    p.on('camera.watch', (from, payload) => onWatch(from, payload));
    p.on('camera.signal', (from, payload) => onSignal(from, payload));
    p.on('camera.unwatch', (from, payload) => onUnwatch(from, payload));
    log('camera: peer channel wired');
  }

  function learn(p) { if (p && typeof p.to === 'string' && DEVICE_RE.test(p.to)) selfId = p.to; }

  function onState(from, p) {
    if (!p || typeof p !== 'object' || !Number.isFinite(p.ts)) return;
    learn(p);
    const cur = claim;
    if (p.shared === true) {
      const prev = p.prev && Number.isFinite(p.prev.ts) ? { owner: dec(p.prev.owner, from), ts: p.prev.ts } : null;
      const next = { owner: from, ts: p.ts, prev };
      const takesOver = cur && prev && prev.owner === cur.owner && prev.ts >= cur.ts;
      if (cur && cur.owner !== from && !takesOver && !beats(next, cur)) {
        log(`camera: ignoring claim from ${from} (an earlier camera won)`);
        if (cur.owner === 'this') sendTo(from, 'camera.state', stateFor(from)); // let it yield
        return;
      }
      if (cur && cur.owner !== from) {
        log(`camera: ${from}'s camera is the live one now`);
        if (cur.owner === 'this') yieldLocal(`${nameOf(from)} is sharing its camera now.`);
        if (viewing && viewing.remote === cur.owner) endViewing('another camera took over', true);
      }
      claim = next;
      remoteWatchers = Array.isArray(p.watchers) ? uniq(p.watchers.slice(0, 64).map((x) => dec(x, from)).filter(Boolean)) : [];
    } else if (cur && cur.owner === from) {
      claim = null;
      remoteWatchers = [];
      if (viewing && viewing.remote === from) endViewing('the camera was turned off', false);
    }
    emit();
  }

  async function onStop(from, p) {
    learn(p);
    if (shared) {
      log(`camera: ${from} asked this camera to stop`);
      yieldLocal(`${nameOf(from)} is sharing its camera now.`);
      announce();
      emit();
    }
    return { ok: true };
  }

  // ---------- sharer side ----------
  async function onWatch(from, p) {
    learn(p);
    if (!p || !SESSION_RE.test(String(p.sessionId))) throw apiError('bad-args', 'bad session id');
    if (!multiOn()) throw MULTI_OFF;
    if (!shared || !claim || claim.owner !== 'this') throw apiError('not-shared', 'This computer isn\'t sharing its camera.');
    const existing = sessions.get(p.sessionId);
    if (existing) { if (existing.remote !== from) throw apiError('busy', 'That session id is in use.'); return { ok: true }; }
    for (const s of [...sessions.values()]) if (s.remote === from) endSession(s, 'replaced', false);
    const s = { id: p.sessionId, remote: from, state: 'starting', timer: null };
    sessions.set(s.id, s);
    s.timer = timers.setTimeout(() => { if (s.state === 'starting') endSession(s, 'timed out while starting', true); }, startTimeoutMs);
    log(`camera: ${from} wants to watch (session ${s.id})`);
    try {
      await ensureCamera();
    } catch (e) {
      endSession(s, 'camera failed', false);
      throw apiError(e.code || 'camera-failed', e.message || 'The camera could not start.');
    }
    if (!sessions.has(s.id)) throw apiError('stopped', 'The camera was turned off.');
    capture.send({ type: 'add', sessionId: s.id });
    announce();
    emit();
    return { ok: true };
  }

  function ensureCamera() {
    if (cameraOn && capture) return Promise.resolve();
    if (cameraStart) return cameraStart;
    cameraStart = (async () => {
      const access = await windows.cameraAccess();
      if (!access || !access.ok) throw apiError('camera-denied', (access && access.why) || 'OmniDesk isn\'t allowed to use the camera.');
      let h = null;
      h = await windows.openCapture((m) => onCaptureMsg(h, m));
      if (!sessions.size || !shared) { h.close(); throw apiError('stopped', 'Nobody is watching any more.'); }
      capture = h;
      await new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => { camWait = null; reject(apiError('camera-failed', 'The camera did not start.')); }, cameraTimeoutMs);
        camWait = { resolve, reject, timer };
        h.send({ type: 'start' });
      });
      cameraOn = true;
      why = null;
      log('camera: camera on');
    })();
    cameraStart.catch((e) => {
      log(`camera: could not start: ${msgOf(e)}`);
      if (!e || e.code !== 'stopped') why = (e && e.message) || 'The camera could not start.';
      stopCamera();
      emit();
    }).finally(() => { cameraStart = null; });
    return cameraStart;
  }

  function stopCamera() {
    if (camWait) { timers.clearTimeout(camWait.timer); camWait.reject(apiError('stopped', 'The camera was turned off.')); camWait = null; }
    if (capture) { const h = capture; capture = null; try { h.close(); } catch (e) { log(`camera: close capture: ${msgOf(e)}`); } log('camera: camera off'); }
    cameraOn = false;
  }

  function onCaptureMsg(h, msg) {
    if (h !== capture && msg.type !== 'camera' && msg.type !== 'error') return;
    const s = msg.sessionId ? sessions.get(msg.sessionId) : null;
    switch (msg.type) {
      case 'camera':
        if (camWait) { timers.clearTimeout(camWait.timer); camWait.resolve(); camWait = null; }
        break;
      case 'signal': {
        const payload = { sessionId: msg.sessionId, kind: msg.kind, data: msg.data };
        if (s && validSignal(payload)) sendTo(s.remote, 'camera.signal', payload);
        break;
      }
      case 'state':
        if (s && msg.state === 'connected' && s.state === 'starting') { s.state = 'live'; timers.clearTimeout(s.timer); log(`camera: session ${s.id} live`); emit(); }
        break;
      case 'session-error':
        if (s) endSession(s, `error: ${String(msg.message || '').slice(0, 200)}`, true);
        break;
      case 'error': {
        const message = String(msg.message || 'The camera stopped.').slice(0, 300);
        if (camWait) { timers.clearTimeout(camWait.timer); camWait.reject(apiError('camera-failed', message)); camWait = null; return; }
        why = message;
        endAll(message, true);
        break;
      }
      case 'end':
        if (h === capture) { capture = null; cameraOn = false; endAll(msg.reason || 'the camera window closed', true); }
        break;
      default:
    }
  }

  function endSession(s, reason, notify) {
    if (!sessions.has(s.id)) return;
    sessions.delete(s.id);
    timers.clearTimeout(s.timer);
    log(`camera: session ${s.id} with ${s.remote} ended: ${reason}`);
    if (capture) capture.send({ type: 'remove', sessionId: s.id });
    if (notify) sendTo(s.remote, 'camera.unwatch', { sessionId: s.id, reason: String(reason).slice(0, 120) });
    if (!sessions.size) stopCamera(); // the camera stays off when nobody watches
    if (claim && claim.owner === 'this') announce();
    emit();
  }

  function endAll(reason, notify) { for (const s of [...sessions.values()]) endSession(s, reason, notify); stopCamera(); }

  function yieldLocal(reason) {
    shared = false;
    persist(false);
    if (claim && claim.owner === 'this') claim = null;
    endAll(reason, true);
    log(`camera: sharing off: ${reason}`);
  }

  // ---------- watcher side ----------
  function onViewerMsg(v, msg) {
    if (viewing !== v) return;
    switch (msg.type) {
      case 'signal': {
        const payload = { sessionId: v.id, kind: msg.kind, data: msg.data };
        if (validSignal(payload)) sendTo(v.remote, 'camera.signal', payload);
        break;
      }
      case 'state':
        if (msg.state === 'playing' && v.state === 'starting') { v.state = 'live'; timers.clearTimeout(v.timer); emit(); }
        break;
      case 'error': endViewing(`error: ${String(msg.message || '').slice(0, 200)}`, true); break;
      case 'end': endViewing(msg.reason || 'window closed', true); break;
      default:
    }
  }

  function endViewing(reason, notify) {
    const v = viewing;
    if (!v) return;
    viewing = null;
    timers.clearTimeout(v.timer);
    log(`camera: stopped watching ${v.remote}: ${reason}`);
    if (v.win) { try { v.win.close(); } catch (e) { log(`camera: close viewer: ${msgOf(e)}`); } }
    if (notify) sendTo(v.remote, 'camera.unwatch', { sessionId: v.id, reason: String(reason).slice(0, 120) });
    remoteWatchers = remoteWatchers.filter((x) => x !== 'this');
    emit();
  }

  async function watch(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId || deviceId === 'this') throw apiError('bad-args', 'Pick another device to watch.');
    if (!multiOn()) throw MULTI_OFF;
    if (!claim || claim.owner !== deviceId) throw apiError('not-shared', `${nameOf(deviceId)} isn't sharing its camera.`);
    if (!connected(deviceId)) throw apiError('offline', `${nameOf(deviceId)} isn't connected right now.`);
    if (viewing && viewing.remote === deviceId) return get();
    if (viewing) endViewing('watching another camera', true);
    const v = { id: newId(), remote: deviceId, state: 'starting', win: null, timer: null };
    viewing = v;
    v.timer = timers.setTimeout(() => { if (viewing === v && v.state === 'starting') endViewing('timed out while starting', true); }, startTimeoutMs);
    emit();
    try {
      const win = await windows.openViewer({ sessionId: v.id, title: `${nameOf(deviceId)} camera` }, (m) => onViewerMsg(v, m));
      if (viewing !== v) { win.close(); throw apiError('stopped', 'Watching was stopped.'); }
      v.win = win;
      win.send({ type: 'start', title: nameOf(deviceId) });
      await peer().request(deviceId, 'camera.watch', { to: deviceId, sessionId: v.id }, { timeoutMs: requestTimeoutMs });
    } catch (e) {
      if (viewing === v) endViewing(`could not start: ${msgOf(e)}`, false);
      throw apiError(e && e.code ? e.code : 'watch-failed', (e && e.message) || 'Could not watch that camera.');
    }
    return get();
  }

  // unwatch(id): stop watching that device's camera, or (on the sharer) stop that device watching.
  async function unwatch(deviceId) {
    if (viewing && (deviceId === undefined || viewing.remote === deviceId)) endViewing('closed here', true);
    for (const s of [...sessions.values()]) if (s.remote === deviceId) endSession(s, 'stopped by the sharing computer', true);
    return get();
  }

  // ---------- signalling routing ----------
  function onSignal(from, p) {
    if (!validSignal(p)) return;
    const s = sessions.get(p.sessionId);
    if (s && s.remote === from && capture) { capture.send({ type: 'signal', sessionId: s.id, kind: p.kind, data: p.data }); return; }
    if (viewing && viewing.id === p.sessionId && viewing.remote === from && viewing.win) viewing.win.send({ type: 'signal', kind: p.kind, data: p.data });
  }

  function onUnwatch(from, p) {
    if (!p || !SESSION_RE.test(String(p.sessionId))) return;
    const reason = `by the other device${p.reason ? ` (${String(p.reason).slice(0, 80)})` : ''}`;
    const s = sessions.get(p.sessionId);
    if (s && s.remote === from) endSession(s, `stopped ${reason}`, false);
    if (viewing && viewing.id === p.sessionId && viewing.remote === from) endViewing(`stopped ${reason}`, false);
  }

  // ---------- API ----------
  async function setShared(on) {
    if (typeof on !== 'boolean') throw apiError('bad-args', 'setShared needs true or false');
    if (!on) {
      if (shared) { yieldLocal('turned off here'); announce(); }
      why = null;
      emit();
      return get();
    }
    if (!multiOn()) throw MULTI_OFF;
    if (shared) return get();
    // Ask whichever camera is live to stop first (up to 3 rounds if it changes meanwhile).
    const asked = new Set();
    for (let i = 0; i < 3 && claim && claim.owner !== 'this' && !asked.has(claim.owner); i++) {
      const owner = claim.owner;
      asked.add(owner);
      try {
        const p = peer();
        if (p && connected(owner)) await p.request(owner, 'camera.stop', { to: owner, ts: now() }, { timeoutMs: requestTimeoutMs });
      } catch (e) { log(`camera: ${owner} did not confirm stopping: ${msgOf(e)}`); }
    }
    if (!multiOn()) throw MULTI_OFF;
    claim = { owner: 'this', ts: now(), prev: claim && claim.owner !== 'this' ? { owner: claim.owner, ts: claim.ts } : null };
    remoteWatchers = [];
    if (viewing) endViewing('this computer shares its own camera now', true);
    shared = true;
    why = null;
    persist(true);
    log('camera: sharing on');
    announce();
    emit();
    return get();
  }

  // Devices coming and going: tell newcomers our state; drop anything tied to a lost device.
  function scan() {
    if (closed) return;
    if (!multiOn()) {
      if (shared) { yieldLocal('multi-device mode is off'); announce(); why = 'Multi-device mode is off.'; }
      if (viewing) endViewing('multi-device mode is off', true);
    }
    const next = new Set(pairedIds().filter((d) => d.online || connected(d.id)).map((d) => d.id));
    const added = [...next].filter((id) => !reach.has(id));
    const lost = [...reach].filter((id) => !next.has(id));
    reach = next;
    if (shared && added.length) announce(added);
    for (const id of lost) {
      for (const s of [...sessions.values()]) if (s.remote === id) endSession(s, 'the link to the other device was lost', false);
      if (viewing && viewing.remote === id) endViewing('the link to the other device was lost', false);
      if (claim && claim.owner === id) { claim = null; remoteWatchers = []; }
      remoteWatchers = remoteWatchers.filter((x) => x !== id);
    }
    // A session whose channel dropped while the device still pings.
    for (const s of [...sessions.values()]) if (!connected(s.remote)) endSession(s, 'the link to the other device was lost', false);
    if (viewing && !connected(viewing.remote)) endViewing('the link to the other device was lost', false);
    emit();
  }

  function shutdown(reason = 'OmniDesk is quitting') {
    if (closed) return;
    endViewing(reason, true);
    endAll(reason, true);
    if (shared) for (const id of reach) sendTo(id, 'camera.state', { to: id, shared: false, ts: now() });
    closed = true;
    timers.clearInterval(watchdog);
    if (offDevices) offDevices();
  }

  // ---------- start ----------
  let offDevices = null;
  if (devices && typeof devices.on === 'function') {
    const fn = () => scan();
    devices.on('change', fn);
    offDevices = () => { if (devices.off) devices.off('change', fn); else if (devices.removeListener) devices.removeListener('change', fn); };
  }
  const watchdog = timers.setInterval(() => { try { scan(); } catch (e) { log(`camera: watchdog: ${msgOf(e)}`); } }, watchdogMs);
  if (watchdog && watchdog.unref) watchdog.unref();

  // Restore the switch with its original timestamp, so a claim saved before
  // another device took over (while this one was off) does not win it back.
  let saved = null;
  try { saved = settings.get('camera') || null; } catch { saved = null; }
  if (saved && saved.shared && multiOn()) { shared = true; claim = { owner: 'this', ts: Number.isFinite(saved.ts) && saved.ts > 0 ? saved.ts : 0, prev: null }; }
  peer();
  scan();

  return { get, setShared, on, watch, unwatch, shutdown, scan, _sessions: sessions };
}

module.exports = { createCamera, MULTI_OFF };
