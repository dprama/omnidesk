// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Real implementation of window.omnidesk (docs/API.md). Returns the method
// table for router.register() plus event topics for the preload's on*().

const path = require('node:path');
const { ApiError, notReady } = require('../errors');
const { t } = require('../router');
const { DeviceStore, LINK_TYPES } = require('./devices');
const system = require('./system');
const { buildIssueUrl } = require('./feedback');
const engineConfig = require('../engine/config');
const { parseDecision } = require('../engine/decisions');
const { cleanComputerName } = require('../engine/paths');

const APP_VERSION = '2.5.0';
const CLIP_MAX = 20;
const MONITORS_RE = /^(\[-?\d{1,6},-?\d{1,6},\d{1,5}x\d{1,5}\]){0,16}$/;
const PEER_POLL_MS = 2000;

// Rect[] -> the engine's monitor list format "[x,y,WxH][x,y,WxH]".
function formatMonitors(rects) {
  return (rects || []).map((r) => `[${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)}x${Math.round(r.h)}]`).join('');
}

// Engine `clipboardItem=` JSON -> ClipItem. Engine names become device ids
// ('this' for us), `to` may be '*', `at` is epoch ms. The engine sends no id.
function clipFromEngine(raw, idForName) {
  if (!raw || typeof raw !== 'object' || !['text', 'image', 'file'].includes(raw.kind)) return null;
  const at = Number.isFinite(+raw.at) && +raw.at > 0 ? Math.round(+raw.at) : Date.now();
  const who = (n) => (n === '*' ? '*' : (idForName(n) || String(n || '').slice(0, 64)));
  const item = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : `eng-${at}-${Math.random().toString(16).slice(2, 8)}`,
    kind: raw.kind, from: who(raw.from), to: who(raw.to), at,
  };
  if (typeof raw.text === 'string') item.text = raw.text.slice(0, 200);
  for (const k of ['width', 'height', 'bytes']) if (Number.isFinite(+raw[k])) item[k] = +raw[k];
  if (typeof raw.name === 'string') item.name = raw.name.slice(0, 200);
  return item;
}

// Loads app/main/<name>/index.js written by another agent; null while missing.
function makeLoader(log, baseDir = path.join(__dirname, '..')) {
  const cache = new Map();
  return function load(name, args) {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(baseDir, name, 'index.js');
    let mod;
    try {
      mod = require(file);
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.join(baseDir, name))) return null;
      log.error(`could not load ${name}: ${e && e.stack ? e.stack : e}`);
      return null;
    }
    try {
      const inst = mod.create(args);
      cache.set(name, inst);
      log(`${name} module loaded`);
      return inst;
    } catch (e) {
      log.error(`${name}.create failed: ${e && e.stack ? e.stack : e}`);
      return null;
    }
  };
}

function createApi({ settings, log, engine, shell, security, broadcast, getScreens, loader, peerFactory }) {
  const load = loader || makeLoader(log);
  const timers = [];
  const state = {
    cursorOn: 'this', lastCursor: null, found: [], clips: [], screenState: null, cameraState: null,
    pausedTo: [],            // device ids edge crossing must not enter (second-screen sessions)
    peerMonitors: new Map(), // deviceId -> "[x,y,WxH]…" from that device's engine
    peerUp: new Set(),       // device ids whose peer channel is connected
  };

  const devices = new DeviceStore({
    settings,
    getScreens,
    getSharing: () => ({
      mouse: !!settings.get('mouse').enabled,
      clipboard: !!settings.get('clipboard').enabled,
      screen: !!(state.screenState && state.screenState.sessions && state.screenState.sessions.length),
      camera: !!settings.get('camera').shared,
    }),
    engineName: () => engine.readSetting('core/computerName') || cleanComputerName(require('node:os').hostname()),
  });

  // ---- other agents' modules (lazy) ----
  // Startup order (startModules): pairing -> peer channel -> discovery -> screen -> camera -> files.
  const discovery = () => {
    const d = load('discovery', { log: log.child('discovery'), engine, devices });
    if (d && !d.__wired) {
      d.__wired = true;
      try {
        d.onFound((list) => { state.found = Array.isArray(list) ? list : []; broadcast('connection.found', state.found); });
      } catch (e) { log.error(`discovery.onFound: ${e.message}`); }
    }
    return d;
  };
  const pairing = () => {
    const p = load('pairing', { settings, engine, log: log.child('pairing'), devices });
    if (p && !p.__wired && typeof p.onPaired === 'function') {
      p.__wired = true;
      // Both sides (the one showing the code too) must rewrite the engine config.
      p.onPaired(() => { if (applyEngineConfig()) scheduleRestart(); });
    }
    return p;
  };
  let peerInst;
  const peer = () => {
    if (peerInst !== undefined) return peerInst;
    try {
      const make = peerFactory || ((a) => require('../pairing/peer').create(a));
      peerInst = make({ engine, devices, log: log.child('peer') });
      log('peer module loaded');
      peerInst.on('engine.monitors', (from, payload) => onPeerMonitors(from, payload));
    } catch (e) {
      log.error(`peer channel: ${e && e.stack ? e.stack : e}`);
      peerInst = null;
    }
    return peerInst;
  };
  const screenMod = () => {
    const s = load('screen', { engine, log: log.child('screen'), allowMedia: security.allowMedia });
    if (s && !s.__wired) {
      s.__wired = true;
      try { s.on((v) => { state.screenState = v; broadcast('screen', v); emitDevices(); updatePausedTargets(v); }); } catch (e) { log.error(`screen.on: ${e.message}`); }
    }
    return s;
  };
  const cameraMod = () => {
    const c = load('camera', {
      peer: () => peer(), devices, log: log.child('camera'), allowMedia: security.allowMedia, settings,
      multi: { get: () => settings.get('multi') },
    });
    if (c && !c.__wired) {
      c.__wired = true;
      try { c.on((v) => { state.cameraState = v; broadcast('camera', v); emitDevices(); }); } catch (e) { log.error(`camera.on: ${e.message}`); }
    }
    return c;
  };
  const filesMod = () => {
    const p = peer();
    if (!p) return null;
    const f = load('files', { peer: p, devices, engine, log: log.child('files'), settings });
    if (f && !f.__wired) {
      f.__wired = true;
      try { f.onItem(addClip); f.start(); } catch (e) { log.error(`files.start: ${e.message}`); }
    }
    return f;
  };
  let modulesStarted = false;
  function startModules() {
    if (modulesStarted) return;
    modulesStarted = true;
    pairing();
    peer();
    discovery();
    screenMod(); // the receiving side must listen for screen.open
    cameraMod(); // answers watch requests, announces the saved switch
    filesMod();
    const t = setInterval(pollPeers, PEER_POLL_MS);
    if (t.unref) t.unref();
    timers.push(t);
    pollPeers();
  }

  // ---- clipboard history: engine (text/image) + files module, one list ----
  function addClip(item) {
    if (!item || typeof item.id !== 'string') return;
    state.clips = [item, ...state.clips.filter((c) => c.id !== item.id)].slice(0, CLIP_MAX);
    broadcast('clipboard.item', item);
  }

  // ---- second screen: no crossing into a laptop while it shows a screen ----
  function updatePausedTargets(v) {
    const ids = new Set();
    for (const s of (v && v.sessions) || []) {
      if (s.state !== 'starting' && s.state !== 'live') continue;
      if (s.targetId && s.targetId !== 'this') ids.add(s.targetId);
    }
    const next = [...ids].sort();
    if (next.join(',') === state.pausedTo.join(',')) return;
    log(next.length ? `edge crossing paused toward ${next.join(', ')} (second screen)` : 'edge crossing toward second-screen devices restored');
    state.pausedTo = next;
    if (applyEngineConfig() && settings.get('engine').role === 'server') scheduleRestart();
  }

  // ---- monitor layouts for the outer-edge rule on clients ----
  // Each device sends its engine's `monitors?` answer to every peer when the
  // channel comes up; the server hands it to its engine as peerMonitors=.
  async function localMonitors() {
    if (engine.status().ipcConnected && engine.query) {
      try {
        const v = String(await engine.query('monitors?', 'monitors')).trim();
        if (v && MONITORS_RE.test(v)) return v;
      } catch (e) { log.warn(`monitors? failed: ${e.message}`); }
    }
    return formatMonitors(getScreens()); // engine not up yet: Electron's view, same desktop coords
  }
  async function shareMonitors(ids) {
    const p = peer();
    if (!p) return;
    const monitors = await localMonitors();
    for (const id of ids) {
      p.send(id, 'engine.monitors', { monitors }).catch((e) => log.warn(`could not send monitors to ${id}: ${e.code || e.message}`));
    }
  }
  function engineNameOf(id) { const r = devices.record(id); return r && r.engineName; }
  function pushPeerMonitors(id, monitors) {
    const name = engineNameOf(id); // = the screen name in the written server config
    const es = engine.status();
    if (!name || es.mode !== 'server' || !es.ipcConnected) return;
    engine.send('peerMonitors', `${name}:${monitors}`).catch((e) => log.warn(`peerMonitors for ${name}: ${e.message}`));
  }
  function onPeerMonitors(from, payload) {
    const monitors = payload && typeof payload.monitors === 'string' ? payload.monitors.trim() : '';
    if (!MONITORS_RE.test(monitors) || !devices.record(from)) return;
    state.peerMonitors.set(from, monitors);
    pushPeerMonitors(from, monitors);
  }
  function pollPeers() {
    const p = peer();
    if (!p) return;
    const up = [];
    for (const d of devices.list()) {
      if (d.thisDevice) continue;
      const now = p.isConnected(d.id);
      if (now && !state.peerUp.has(d.id)) { state.peerUp.add(d.id); up.push(d.id); }
      else if (!now && state.peerUp.has(d.id)) {
        state.peerUp.delete(d.id);
        if (state.peerMonitors.delete(d.id)) pushPeerMonitors(d.id, ''); // clears it in the engine
      }
    }
    for (const id of state.peerUp) if (!devices.record(id)) state.peerUp.delete(id);
    return up.length ? shareMonitors(up) : Promise.resolve();
  }
  // The engine forgets peerMonitors when it restarts: replay on every IPC connect.
  let ipcWasUp = false;
  engine.on('status', (st) => {
    const upNow = !!(st && st.ipcConnected);
    if (upNow && !ipcWasUp) for (const [id, m] of state.peerMonitors) pushPeerMonitors(id, m);
    ipcWasUp = upNow;
  });
  function monitorsChanged() { if (state.peerUp.size) shareMonitors([...state.peerUp]); }
  const need = (mod) => { if (!mod) throw notReady(); return mod; };

  // ---- status / devices broadcasting ----
  let lastStatus = '';
  let lastDevices = '';
  function emitStatus() {
    const s = status();
    const j = JSON.stringify(s);
    if (j !== lastStatus) { lastStatus = j; broadcast('status', s); }
  }
  function emitDevices() {
    const l = devices.list();
    const j = JSON.stringify(l);
    if (j !== lastDevices) { lastDevices = j; broadcast('devices', l); }
    emitStatus();
  }
  devices.on('change', emitDevices);
  engine.on('status', emitStatus);

  function status() {
    const list = devices.list();
    const peers = list.filter((d) => !d.thisDevice && d.paired);
    const online = peers.filter((d) => d.online);
    const main = online.find((d) => d.link) || null;
    const es = engine.status();
    const tls = engine.readSetting('security/tlsEnabled');
    return {
      role: settings.get('engine').role === 'off' ? 'off' : es.running ? es.mode : 'off',
      // docs/API.md: total = paired devices including this one;
      // connected = this device + online paired devices.
      connected: 1 + online.length,
      total: 1 + peers.length,
      cursorOn: state.cursorOn,
      clipboard: !!settings.get('clipboard').enabled,
      mouse: !!settings.get('mouse').enabled,
      link: main ? { deviceId: main.id, type: main.link.type, pingMs: main.link.pingMs ?? 0 } : null,
      encrypted: tls === undefined ? true : tls === 'true',
      engine: { running: es.running, version: es.version, helperPath: es.helperPath, reason: es.reason || '' },
    };
  }

  // ---- engine config ----
  function placementsWithDefaults() {
    const p = { ...(settings.get('layout').placements || {}) };
    if (!p.this) p.this = { x: 0, y: 0 };
    return p;
  }

  function layoutValue() {
    const placements = placementsWithDefaults();
    const { edges } = engineConfig.computeEdges(devices.records(), placements);
    return { placements, edges };
  }

  let restartTimer = null;
  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      const role = settings.get('engine').role;
      if (engine.status().running || role !== 'off') engine.restart(role).catch((e) => log.error(`engine restart: ${e.message}`));
    }, 400);
  }

  // Writes deskflow-server.conf + Deskflow.conf. Returns true if anything changed.
  function applyEngineConfig() {
    if (!engine.binary) return false; // never touch engine files without an engine
    const recs = devices.records();
    const placements = placementsWithDefaults();
    const names = Object.fromEntries(recs.map((r) => [r.id, r.engineName]));
    const mouse = settings.get('mouse');
    const clip = settings.get('clipboard');
    const eng = settings.get('engine');
    const text = engineConfig.buildServerConfig({
      devices: recs, placements, names, pausedTo: state.pausedTo,
      options: { cooldownMs: mouse.cooldownMs, arrivalGuardMs: mouse.arrivalGuardMs, clipboard: !!clip.enabled, lockHotkey: mouse.lockHotkey },
    });
    let changed = false;
    try {
      changed = engine.writeServerConfig(text) || changed;
      const values = {
        ...engineConfig.computerSettings(Object.fromEntries(recs.filter((r) => placements[r.id]).map((r) => [r.id, r.engineName]))),
        'server/enableClipboard': !!clip.enabled,
        'server/omnideskCrossCooldown': Math.round(mouse.cooldownMs),
        'server/omnideskArrivalGuard': Math.round(mouse.arrivalGuardMs),
      };
      if (!engine.readSetting('core/computerName')) values['core/computerName'] = names.this;
      if (eng.serverHost) values['client/remoteHost'] = eng.serverHost;
      changed = engine.writeSettings(values, { removeGroups: (g) => g.startsWith('computer_') && !(`${g}/name` in values) }) || changed;
    } catch (e) {
      log.error(`could not write engine config: ${e.message}`);
    }
    return changed;
  }

  // ---- engine events: decisions, cursor, online state, clipboard ----
  let cursorTimer = null;
  let cursorPending = null;
  let cursorLast = 0;
  function emitCursor(c) {
    state.lastCursor = c;
    cursorPending = c;
    const now = Date.now();
    const fire = () => { cursorTimer = null; cursorLast = Date.now(); broadcast('mouse.cursor', cursorPending); };
    if (now - cursorLast >= 50) fire();
    else if (!cursorTimer) cursorTimer = setTimeout(fire, 50 - (now - cursorLast));
  }

  engine.on('line', (line) => {
    const d = parseDecision(line);
    if (!d) return;
    broadcast('mouse.decision', d.line);
    if (d.kind === 'cross') {
      const id = devices.idForEngineName(d.fields.to) || state.cursorOn;
      state.cursorOn = id;
      // d.pos is the exit point on the computer the cursor left; the position on the
      // new computer arrives with the engine's next `cursor=` IPC event.
      emitStatus();
    }
  });

  engine.on('ipc', (cmd, value) => {
    if (cmd === 'connectedClients') {
      const names = value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const ids = new Set(names.map((n) => devices.idForEngineName(n)).filter(Boolean));
      for (const d of devices.list()) if (!d.thisDevice) devices.setOnline(d.id, ids.has(d.id));
    } else if (cmd === 'connectionState' && settings.get('engine').role === 'client') {
      const sid = settings.get('engine').serverDeviceId;
      if (sid) devices.setOnline(sid, value === 'Connected');
    } else if (cmd === 'cursor') {
      // proposed: cursor=<computerName>,<x>,<y>
      const [n, x, y] = value.split(',');
      const id = devices.idForEngineName(n);
      if (id && Number.isFinite(+x) && Number.isFinite(+y)) {
        if (state.cursorOn !== id) { state.cursorOn = id; emitStatus(); }
        emitCursor({ deviceId: id, x: +x, y: +y });
      }
    } else if (cmd === 'clipboardItem') {
      // proposed: clipboardItem=<JSON ClipItem>
      let raw = null;
      try { raw = JSON.parse(value); } catch { /* ignore malformed */ }
      const item = clipFromEngine(raw, (n) => devices.idForEngineName(n));
      if (item) addClip(item);
    }
  });

  // ---- polling: battery, ping ----
  async function pollBattery() {
    try { devices.setRuntime('this', { battery: await system.battery() }); } catch { /* none */ }
  }
  async function pollPing() {
    for (const d of devices.list()) {
      if (d.thisDevice || !d.online) continue;
      const rec = devices.record(d.id);
      let host = rec && rec.host;
      const disc = discovery();
      if (disc && disc.linkFor) {
        try { const l = disc.linkFor(d.id); if (l) { host = l.address || host; devices.setRuntime(d.id, { link: { type: l.type, available: l.available || [l.type] } }); } } catch { /* ignore */ }
      }
      if (host) devices.setRuntime(d.id, { pingMs: await system.ping(host) });
    }
  }
  function startPolling() {
    pollBattery();
    timers.push(setInterval(pollBattery, 60000), setInterval(pollPing, 5000));
    discovery();
  }

  // ---- methods ----
  const patchable = (key, shape) => (patch) => {
    const before = settings.get(key);
    const next = settings.patch(key, patch);
    return { before, next };
  };

  const methods = {
    'app.info': { args: [], run: async () => {
      await engine.detectVersion().catch(() => {});
      return { version: APP_VERSION, engineVersion: engine.status().version || '', os: system.osName(), osVersion: devices.osVersion, arch: system.arch(), licence: 'GPL-2.0-only' };
    } },
    'app.openExternal': { args: [t.str(2048)], run: (url) => {
      if (!security.openExternal(url)) throw new ApiError('blocked-url', 'OmniDesk only opens secure links to GitHub and the OmniDesk site.');
      return true;
    } },
    'app.logs.tail': { args: [t.optional(t.int(1, 1000))], run: (n) => log.tail(n || 200) },

    'status.get': { args: [], run: () => status() },

    'devices.list': { args: [], run: () => devices.list() },
    'devices.rename': { args: [t.id, t.str(64)], run: (id, name) => { const d = devices.rename(id, name); applyEngineConfig(); return d; } },
    'devices.forget': { args: [t.id], run: (id) => {
      devices.forget(id);
      const p = pairing();
      if (p && p.forget) Promise.resolve(p.forget(id)).catch((e) => log.error(`pairing.forget: ${e.message}`));
      if (applyEngineConfig()) scheduleRestart();
      return true;
    } },

    'mouse.get': { args: [], run: () => settings.get('mouse') },
    'mouse.set': {
      args: [t.obj({ enabled: t.bool, cooldownMs: t.int(0, 5000), arrivalGuardMs: t.int(0, 5000), locked: t.bool, lockHotkey: t.oneOf('Ctrl+Alt+L') }, { partial: true })],
      run: (patch) => {
        const { before, next } = patchable('mouse')(patch);
        if (before.enabled !== next.enabled) engine.send('mouseSharing', next.enabled ? 'on' : 'off').catch(() => {});
        if (before.locked !== next.locked) engine.send('lockCursor', next.locked ? 'on' : 'off').catch(() => {});
        if (before.cooldownMs !== next.cooldownMs || before.arrivalGuardMs !== next.arrivalGuardMs) {
          if (applyEngineConfig()) scheduleRestart();
        }
        emitDevices();
        return next;
      },
    },

    'layout.get': { args: [], run: () => layoutValue() },
    'layout.set': {
      args: [t.obj({ placements: t.record(t.id, t.obj({ x: t.num(-1e6, 1e6), y: t.num(-1e6, 1e6) })) })],
      run: ({ placements }) => {
        const known = new Set(devices.list().map((d) => d.id));
        const clean = {};
        for (const [id, p] of Object.entries(placements)) {
          if (!known.has(id)) throw new ApiError('not-found', 'The layout names a device that is not paired.');
          clean[id] = { x: Math.round(p.x), y: Math.round(p.y) };
        }
        settings.set('layout', { ...settings.get('layout'), placements: clean });
        if (applyEngineConfig() && settings.get('engine').role === 'server') scheduleRestart();
        return layoutValue();
      },
    },

    'clipboard.get': { args: [], run: () => settings.get('clipboard') },
    'clipboard.set': {
      args: [t.obj({ enabled: t.bool, maxFileMB: t.int(1, 4096), files: t.bool }, { partial: true })],
      run: (patch) => {
        const { before, next } = patchable('clipboard')(patch);
        if (before.enabled !== next.enabled) {
          applyEngineConfig();
          engine.send('clipboard', next.enabled ? 'on' : 'off').catch(() => {});
        }
        emitDevices();
        return next;
      },
    },
    'clipboard.history': { args: [], run: () => state.clips.slice(0, CLIP_MAX) },

    'screen.get': { args: [], run: async () => need(screenMod()).get() },
    'screen.start': {
      args: [t.obj({ sourceId: t.id, targetId: t.id, resolution: t.str(20), refresh: t.int(1, 480), quality: t.oneOf('latency', 'balanced', 'sharp') })],
      run: async (opts) => need(screenMod()).start(opts),
    },
    'screen.stop': { args: [t.id], run: async (id) => need(screenMod()).stop(id) },

    'camera.get': { args: [], run: async () => { const c = cameraMod(); return c ? c.get() : cameraValue(); } },
    'camera.setShared': { args: [t.bool], run: async (shared) => need(cameraMod()).setShared(shared) },
    'camera.watch': { args: [t.str(64)], run: async (id) => need(cameraMod()).watch(id) },
    'camera.unwatch': { args: [t.str(64)], run: async (id) => need(cameraMod()).unwatch(id) },

    'connection.pairStart': { args: [], run: async () => need(pairing()).start() },
    'connection.pairEnter': { args: [t.id, (v) => typeof v === 'string' && /^\d{6}$/.test(v)], run: async (id, code) => {
      const dev = await need(pairing()).enter(id, code);
      if (applyEngineConfig()) scheduleRestart();
      return dev && dev.id ? devices.get(dev.id) || dev : dev;
    } },
    'connection.pairCancel': { args: [], run: async () => { await need(pairing()).cancel(); return true; } },
    'connection.setLink': { args: [t.id, t.oneOf(...LINK_TYPES)], run: async (id, type) => {
      const d = need(discovery());
      await d.setLink(id, type);
      const l = d.linkFor ? d.linkFor(id) : null;
      devices.setRuntime(id, { link: l ? { type: l.type, available: l.available || [l.type] } : { type, available: [type] } });
      return devices.get(id);
    } },

    'multi.get': { args: [], run: () => settings.get('multi') },
    'multi.set': { args: [t.obj({ enabled: t.bool })], run: ({ enabled }) => settings.patch('multi', { enabled }) },

    'feedback.systemInfo': { args: [], run: () => systemInfo() },
    'feedback.send': {
      args: [t.obj({ kind: t.oneOf('bug', 'idea', 'thanks'), message: t.str(5000), includeSystemInfo: t.bool })],
      run: async ({ kind, message, includeSystemInfo }) => {
        if (!message.trim()) throw new ApiError('empty', 'Write a few words first.');
        const url = buildIssueUrl({ repoUrl: settings.get('repoUrl'), kind, message, includeSystemInfo, systemInfo: includeSystemInfo ? await systemInfo() : null });
        await shell.openExternal(url);
        return { opened: true };
      },
    },

    'tip.open': { args: [t.optional(t.num(0, 100000))], run: async (amount) => {
      const raw = String(settings.get('tipUrl') || '');
      const url = raw.includes('{amount}') ? raw.replace('{amount}', encodeURIComponent(String(amount ?? ''))) : raw;
      let u;
      try { u = new URL(url); } catch { throw new ApiError('bad-tip-url', 'The tip link in settings is not valid.'); }
      if (u.protocol !== 'https:') throw new ApiError('bad-tip-url', 'The tip link in settings must start with https.');
      await shell.openExternal(u.toString());
      return { opened: true };
    } },

    // Current values for the preload's on*() first call. Not part of window.omnidesk.
    'topic.current': { args: [t.str(40)], run: (topic) => current(topic) },
  };

  function cameraValue() {
    return { shared: !!settings.get('camera').shared, liveDeviceId: null, watchers: [] };
  }

  async function systemInfo() {
    await engine.detectVersion().catch(() => {});
    return {
      os: system.osName(), osVersion: devices.osVersion, arch: system.arch(), appVersion: APP_VERSION,
      engineVersion: engine.status().version || '', monitors: devices.thisDevice().screens,
      devices: devices.list().filter((d) => !d.thisDevice && d.paired).length,
    };
  }

  async function current(topic) {
    switch (topic) {
      case 'status': return status();
      case 'devices': return devices.list();
      case 'mouse.cursor': return state.lastCursor;
      case 'camera': { const c = cameraMod(); if (!c) return cameraValue(); try { return await c.get(); } catch { return cameraValue(); } }
      case 'connection.found': discovery(); return state.found;
      case 'screen': { const s = screenMod(); if (!s) return null; try { return await s.get(); } catch { return null; } }
      default: return null; // streams (logs.line, mouse.decision, clipboard.item) have no current value
    }
  }

  log.onLine((line) => broadcast('logs.line', line));

  return {
    methods,
    devices,
    status,
    applyEngineConfig,
    startPolling,
    startModules,
    monitorsChanged,
    __pollPeers: () => pollPeers(), // tests
    modules: () => ({ pairing: !!pairing(), peer: !!peer(), discovery: !!discovery(), screen: !!screenMod(), camera: !!cameraMod(), files: !!filesMod() }),
    stop() {
      timers.forEach(clearInterval);
      clearTimeout(restartTimer);
      if (!modulesStarted) return;
      for (const [name, fn] of [['files', () => filesMod() && filesMod().stop()], ['pairing', () => { const p = pairing(); if (p && p.stop) p.stop(); }],
        ['peer', () => peerInst && peerInst.stop()], ['discovery', () => { const d = discovery(); if (d && d.stop) d.stop(); }]]) {
        try { Promise.resolve(fn()).catch(() => {}); } catch (e) { log.warn(`${name}.stop: ${e.message}`); }
      }
    },
  };
}

module.exports = { createApi, makeLoader, APP_VERSION, clipFromEngine, formatMonitors };
