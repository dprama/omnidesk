// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// Fake backend for the renderer: defines a frozen `window.omnidesk` that implements every
// method in docs/API.md with realistic, moving data (concepts/BRIEF.md mock data).
// Classic script (not a module) so it can run before the shell's module script.
//
// Query `?mock-scenario=default|empty|offline|error` selects an edge state:
//   empty   - only this device, nothing paired
//   offline - the MacBook is offline
//   error   - every setter rejects with a user-facing message
//
// Cursor coordinates (`mouse.onCursor`, decision `pos=`) are device-local: the same space as
// that device's `screens` rects. Layout placements put each device's local space on one desk.
//
// Test hooks (not part of the API, never used by pages):
//   window.__omnideskMockCalls  every API call as { method, args, at }
//   window.__omnideskMock       { scenario, computeEdges, stop, subscriptions }
//     subscriptions() -> { total, byChannel: { status: n, ... } } live subscriber counts, so a
//     test can check that pages unsubscribe on unmount (the number must not grow).
//
// Devices: this = Windows PC (2560x1440 + 1920x1080). MacBook = the owner's 2018 Intel
// MacBook Pro 13": 1440x900 points (2880x1800 px Retina), x64. Screens are in desktop
// coordinates (points on macOS), like the engine reports them.
//
// Status counts (same definition as app/main): total = paired devices including this one;
// connected = this device + paired devices that are online. Default scenario: 2 of 3.
//
// Camera: by default the MacBook is sharing its camera (liveDeviceId 'macbook') and nobody
// watches; camera.watch('macbook') adds 'this' to watchers. In the error scenario camera.get()
// carries `why` (camera permission denied).
(function (window) {
  'use strict';
  if (window.omnidesk) return;

  // ---------- helpers ----------
  const T = {
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
  };
  const timers = new Set();
  const later = (fn, ms) => { const h = T.setTimeout(() => { timers.delete(h); fn(); }, ms); timers.add(h); return h; };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const now = () => Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const irnd = (a, b) => Math.floor(rnd(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pad2 = (n) => String(n).padStart(2, '0');
  const hms = (d = new Date()) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const fail = (code, message) => Promise.reject({ code, message });
  const isHidden = () => !!(window.document && window.document.hidden);

  let scenario = 'default';
  try {
    const q = new URLSearchParams((window.location && window.location.search) || '').get('mock-scenario');
    if (q && ['default', 'empty', 'offline', 'error'].includes(q)) scenario = q;
  } catch (_) { /* keep default */ }

  const calls = [];
  try { Object.defineProperty(window, '__omnideskMockCalls', { value: calls, configurable: true }); } catch (_) { window.__omnideskMockCalls = calls; }
  const record = (method, args) => {
    calls.push({ method, args: clone(Array.from(args)), at: iso(now()) });
    if (calls.length > 1000) calls.splice(0, calls.length - 1000);
  };

  // A tiny pub/sub. on() emits the current value on the next microtask (after the caller
  // has its unsubscribe function), then every change.
  function channel(current) {
    const subs = new Set();
    const deliver = (cb, v) => { try { cb(v); } catch (e) { T.setTimeout(() => { throw e; }, 0); } };
    return {
      on(cb, initial) {
        if (typeof cb !== 'function') throw new TypeError('Subscriber must be a function.');
        subs.add(cb);
        Promise.resolve().then(() => {
          if (!subs.has(cb)) return;
          const v = initial ? initial() : current();
          if (Array.isArray(v) && initial) v.forEach((x) => subs.has(cb) && deliver(cb, x));
          else if (v !== undefined) deliver(cb, v);
        });
        return () => { subs.delete(cb); };
      },
      emit(v) { const val = v === undefined ? current() : v; subs.forEach((cb) => deliver(cb, clone(val))); },
      get size() { return subs.size; },
    };
  }

  // ---------- geometry: outer edges ----------
  // Same conventions as main's engine/config.js (placeDevice, outerParts, computeEdges) and the
  // Screen layout page (placeable): a placement is where the device's monitor bounding box
  // starts, so screens in desktop coords (possibly negative) are shifted by -bbox first.
  const SNAP = 4; // config.js DEFAULT_TOL
  const SIDES = ['left', 'right', 'top', 'bottom'];
  const OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  function bbox(rs) {
    if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
    const x0 = Math.min(...rs.map((r) => r.x)); const y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)); const y1 = Math.max(...rs.map((r) => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // Monitors of one device in layout coordinates (config.js placeDevice).
  function placeDevice(screens, p) {
    const b = bbox(screens);
    return screens.map((s, i) => ({ i, x: s.x - b.x + p.x, y: s.y - b.y + p.y, w: s.w, h: s.h }));
  }
  function sideOf(r, side) {
    switch (side) {
      case 'left': return { line: r.x, a: r.y, b: r.y + r.h };
      case 'right': return { line: r.x + r.w, a: r.y, b: r.y + r.h };
      case 'top': return { line: r.y, a: r.x, b: r.x + r.w };
      default: return { line: r.y + r.h, a: r.x, b: r.x + r.w };
    }
  }
  const depthOf = (r, side) => (side === 'left' || side === 'right' ? { lo: r.x, hi: r.x + r.w } : { lo: r.y, hi: r.y + r.h });
  function subtract(ivs, cut) {
    const out = [];
    for (const [a, b] of ivs) {
      if (cut[1] <= a || cut[0] >= b) { out.push([a, b]); continue; }
      if (cut[0] > a) out.push([a, cut[0]]);
      if (cut[1] < b) out.push([cut[1], b]);
    }
    return out;
  }
  // Parts of r's `side` edge where no other monitor of the same device continues beyond it
  // (config.js outerParts).
  function outerParts(r, side, siblings) {
    const s = sideOf(r, side);
    const dir = side === 'right' || side === 'bottom' ? 1 : -1;
    let parts = [[s.a, s.b]];
    for (const n of siblings) {
      if (n === r) continue;
      const d = depthOf(n, side);
      const beyond = dir > 0 ? d.lo <= s.line + SNAP && d.hi > s.line + SNAP : d.hi >= s.line - SNAP && d.lo < s.line - SNAP;
      if (!beyond) continue;
      const t = sideOf(n, side);
      parts = subtract(parts, [t.a, t.b]);
    }
    return parts;
  }
  // Segments of every device's outer edges, split by neighbour.
  // devs: [{ id, screens }], placements: { id: { x, y } }
  // Returns { segments: [{ from, to, side, rect, line, a, b }], free: [{ from, side, rect, line, a, b }] }
  // in layout coordinates.
  function edgeSegments(devs, placements) {
    const placed = devs.filter((d) => placements[d.id] && Array.isArray(d.screens) && d.screens.length)
      .map((d) => ({ id: d.id, rects: placeDevice(d.screens, placements[d.id]) }));
    const segments = []; const free = [];
    for (const A of placed) {
      for (const r of A.rects) {
        for (const side of SIDES) {
          const outer = outerParts(r, side, A.rects);
          if (!outer.length) continue;
          const s = sideOf(r, side);
          const dir = side === 'right' || side === 'bottom' ? 1 : -1;
          let rest = outer.slice();
          for (const B of placed) {
            if (B === A) continue;
            for (const o of B.rects) {
              const d = depthOf(o, side);
              if (Math.abs((dir > 0 ? d.lo : d.hi) - s.line) > SNAP) continue;
              for (const [ta, tb] of outerParts(o, OPP[side], B.rects)) {
                for (const [a, b] of outer) {
                  const lo = Math.max(a, ta); const hi = Math.min(b, tb);
                  if (hi > lo) segments.push({ from: A.id, to: B.id, side, rect: r.i, line: s.line, a: lo, b: hi });
                }
                rest = subtract(rest, [ta, tb]);
              }
            }
          }
          for (const [a, b] of rest) if (b > a) free.push({ from: A.id, side, rect: r.i, line: s.line, a, b });
        }
      }
    }
    return { segments, free };
  }
  // Edge list as main returns it: overlap = merged length of the segments per (from, side, to).
  function computeEdges(devs, placements) {
    const map = new Map();
    for (const s of edgeSegments(devs, placements).segments) {
      const k = `${s.from}|${s.side}|${s.to}`;
      const e = map.get(k) || { edge: { from: s.from, fromEdge: s.side, to: s.to, overlapPx: 0 }, ivs: [] };
      e.ivs.push([s.a, s.b]);
      map.set(k, e);
    }
    return Array.from(map.values(), ({ edge, ivs }) => {
      ivs.sort((p, q) => p[0] - q[0]);
      let total = 0; let cur = null;
      for (const [a, b] of ivs) {
        if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
        else { if (cur) total += cur[1] - cur[0]; cur = [a, b]; }
      }
      if (cur) total += cur[1] - cur[0];
      edge.overlapPx = Math.round(total);
      return edge;
    });
  }

  // ---------- state ----------
  const T0 = now();
  const DAY = 86400000;
  const PC_SCREENS = [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }];
  const ENGINE_VERSION = '1.20.0';
  const HELPER = 'C:\\Program Files\\OmniDesk\\resources\\engine\\deskflow-core.exe';
  const PING_BASE = { usb: 1, wifi: 4, bluetooth: 18, ethernet: 1 };

  const devices = [
    {
      id: 'this', name: 'Windows PC', os: 'windows', osVersion: '11', arch: 'x64',
      thisDevice: true, online: true, paired: true, lastSeen: null,
      link: { type: 'ethernet', pingMs: null, available: ['ethernet', 'wifi'] },
      battery: null, screens: PC_SCREENS,
    },
  ];
  if (scenario !== 'empty') {
    devices.push({
      id: 'macbook', name: 'MacBook', os: 'macos', osVersion: '15', arch: 'x64',
      thisDevice: false, online: scenario !== 'offline', paired: true,
      lastSeen: scenario === 'offline' ? iso(T0 - 47 * 60000) : null,
      link: scenario === 'offline' ? null : { type: 'wifi', pingMs: 4, available: ['wifi', 'usb', 'bluetooth'] },
      battery: { percent: 82, charging: false },
      screens: [{ x: 0, y: 0, w: 1440, h: 900 }],
    });
    devices.push({
      id: 'macmini', name: 'Studio Mac mini', os: 'macos', osVersion: '15', arch: 'x64',
      thisDevice: false, online: false, paired: true, lastSeen: iso(T0 - 2 * DAY),
      link: null, battery: null,
      // External display left of the primary: negative desktop coords, so the bbox convention matters.
      screens: [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: -1920, y: 360, w: 1920, h: 1080 }],
    });
  }
  const dev = (id) => devices.find((d) => d.id === id);

  const mouse = { enabled: true, cooldownMs: 300, arrivalGuardMs: 150, lockHotkey: 'Ctrl+Alt+L', locked: false, controller: 'this' };
  const clip = { enabled: true, maxFileMB: 100, files: true };
  const multi = { enabled: scenario !== 'empty' };
  // shared = this device shares its camera; liveDeviceId = whose camera is shared (one at a time).
  const camera = { shared: false, liveDeviceId: scenario === 'default' || scenario === 'error' ? 'macbook' : null, watchers: [] };
  const cameraView = () => Object.assign(clone(camera), scenario === 'error'
    ? { why: 'OmniDesk can\'t use the camera: access is turned off in Windows Settings › Privacy › Camera.' } : {});
  const screen = { sessions: [] };
  const placements = { this: { x: 0, y: 0 } };
  if (dev('macbook')) placements.macbook = { x: 4480, y: 270 };
  if (dev('macmini')) placements.macmini = { x: 0, y: -1440 };
  let cursorOn = 'this';

  let clipSeq = 0;
  const clipItems = scenario === 'empty' ? [] : [
    { id: 'c' + (++clipSeq), kind: 'file', from: 'macbook', to: 'this', at: iso(T0 - 2 * 60000), name: 'Quarterly plan v3.docx', bytes: 2516582, progress: 1 },
    { id: 'c' + (++clipSeq), kind: 'image', from: 'macbook', to: 'this', at: iso(T0 - 9 * 60000), name: 'Screenshot.png', width: 2880, height: 1800, bytes: 834560 },
    { id: 'c' + (++clipSeq), kind: 'text', from: 'macbook', to: 'this', at: iso(T0 - 14 * 60000), text: 'meet at 4:30, room B' },
  ];

  const found = [];
  let discoveryStarted = false;
  let pairing = null; // { code, expiresAt, timer }

  const logs = [];
  const decisions = [];

  // ---------- derived views ----------
  const online = (d) => d && d.online && d.paired;
  const peers = () => devices.filter((d) => !d.thisDevice && d.paired);
  function sharingOf(d) {
    const inSession = screen.sessions.some((s) => s.sourceId === d.id || s.targetId === d.id);
    const cam = d.id === 'this' ? camera.shared : camera.watchers.includes(d.id) || camera.liveDeviceId === d.id;
    const on = d.thisDevice || online(d);
    return { mouse: on && mouse.enabled, clipboard: on && clip.enabled, screen: inSession, camera: cam };
  }
  const deviceView = (d) => Object.assign(clone(d), { sharing: sharingOf(d) });
  const devicesView = () => devices.map(deviceView);
  function mainPeer() {
    return devices.find((d) => d.id === 'macbook' && online(d)) || peers().find(online) || null;
  }
  function statusView() {
    const p = mainPeer();
    return {
      role: mouse.controller === 'this' ? 'server' : 'client',
      controller: mouse.controller,
      connected: 1 + peers().filter(online).length,   // this device + online paired devices
      total: 1 + peers().length,                     // paired devices including this one
      cursorOn,
      clipboard: clip.enabled,
      mouse: mouse.enabled,
      link: p && p.link ? { deviceId: p.id, type: p.link.type, pingMs: p.link.pingMs } : null,
      encrypted: true,
      engine: { running: true, version: ENGINE_VERSION + '+omnidesk', helperPath: HELPER },
    };
  }
  function screenView() {
    const p = mainPeer();
    const why = p ? undefined : (dev('macbook') ? `${dev('macbook').name} is offline.` : 'Pair a laptop first to use it as a screen.');
    const can = { extendThis: !!p, showHere: !!p };
    if (why) can.why = why;
    return {
      sessions: clone(screen.sessions), can,
      options: { resolutions: ['1440x900', '1680x1050', '1920x1080', '2560x1600'], refresh: [60], quality: ['latency', 'balanced', 'sharp'] },
    };
  }
  const layoutDevs = () => devices.map((d) => ({ id: d.id, screens: d.screens }));
  const layoutView = () => ({ placements: clone(placements), edges: computeEdges(layoutDevs(), placements) });

  const ch = {
    status: channel(statusView),
    devices: channel(devicesView),
    screen: channel(screenView),
    camera: channel(cameraView),
    found: channel(() => clone(found)),
    cursor: channel(() => ({ deviceId: sim.dev, x: Math.round(sim.x), y: Math.round(sim.y) })),
    decision: channel(() => undefined),
    clipItem: channel(() => clipItems[0] && clone(clipItems[0])),
    logLine: channel(() => logs[logs.length - 1]),
  };
  const changed = (...names) => names.forEach((n) => ch[n].emit());

  function log(level, msg) {
    const line = `${iso(now())} ${level} ${msg}`;
    logs.push(line);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    ch.logLine.emit(line);
  }
  log('INFO', `start mode=server helper=${HELPER} version=${ENGINE_VERSION}.0+2877600f pid=4242`); // OmniDeskLog.h formatStart
  log('INFO', `scenario=${scenario} devices=${devices.length}`);

  // ---------- decisions ----------
  const monitorsStr = (id) => (dev(id) ? dev(id).screens : []).map((r) => `[${r.x},${r.y},${r.w}x${r.h}]`).join('');
  function decide(line) {
    const full = `${hms()} ${line}`;
    decisions.push(full);
    if (decisions.length > 50) decisions.shift();
    log('INFO', full.slice(9));
    ch.decision.emit(full);
  }
  const P = (x, y) => `pos=(${Math.round(x)},${Math.round(y)})`;
  // Formats match engine/src/lib/base/OmniDeskLog.h (formatNoCross / formatCross) exactly;
  // ` remaining=<ms>ms` is written only for reason=cooldown.
  let lastCrossAt = 0;
  const noCross = (reason, side, devId, x, y) => {
    const rem = reason === 'cooldown' ? ` remaining=${Math.max(1, Math.round(mouse.cooldownMs - (now() - lastCrossAt)))}ms` : '';
    decide(`no-cross reason=${reason} edge=${side} ${P(x, y)} monitors=${monitorsStr(devId)}${rem}`);
  };
  const crossLine = (side, x, y, toId) => {
    lastCrossAt = now();
    decide(`cross edge=${side} ${P(x, y)} to=${dev(toId).name} cooldown=${mouse.cooldownMs}ms`);
  };
  // Seed a short history so the log panel isn't empty on first open.
  decisions.push(`${hms(new Date(T0 - 64000))} no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=${monitorsStr('this')}`);
  if (dev('macbook') && dev('macbook').online) {
    decisions.push(`${hms(new Date(T0 - 41000))} cross edge=right pos=(4479,640) to=MacBook cooldown=300ms`);
    decisions.push(`${hms(new Date(T0 - 23000))} cross edge=left pos=(0,402) to=Windows PC cooldown=300ms`);
  }

  // ---------- cursor simulation ----------
  const sim = { dev: 'this', x: 1280, y: 720, queue: [], step: null, from: null, t0: 0, episode: 0, lastEmit: '' };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  // Layout coords <-> a device's own desktop coords (placement = start of its monitor bbox).
  const origin = (id) => bbox(dev(id).screens);
  const local = (id, gx, gy) => { const b = origin(id); return { x: gx - placements[id].x + b.x, y: gy - placements[id].y + b.y }; };
  const toLayout = (id, x, y) => { const b = origin(id); return { x: x - b.x + placements[id].x, y: y - b.y + placements[id].y }; };
  // Point on a segment at fraction t: inside the "from" device (fx,fy) and just across (tx,ty), global coords.
  function segPoint(seg, t) {
    const m = seg.a + (seg.b - seg.a) * t;
    switch (seg.side) {
      case 'right': return { fx: seg.line - 1, fy: m, tx: seg.line, ty: m };
      case 'left': return { fx: seg.line, fy: m, tx: seg.line - 1, ty: m };
      case 'bottom': return { fx: m, fy: seg.line - 1, tx: m, ty: seg.line };
      default: return { fx: m, fy: seg.line, tx: m, ty: seg.line - 1 };
    }
  }
  const inward = (side, x, y, d) => ({ left: [x + d, y], right: [x - d, y], top: [x, y + d], bottom: [x, y - d] }[side]);
  const center = (id, i = 0) => { const r = dev(id).screens[i]; return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
  const wobble = (p, r) => ({ x: p.x + rnd(-r, r), y: p.y + rnd(-r, r) });
  const step = (d, x, y, ms, then) => ({ dev: d, x, y, ms, then });

  function peerSeg() {
    const p = dev('macbook') && online(dev('macbook')) ? 'macbook' : (peers().find(online) || {}).id;
    if (!p || !placements[p]) return null;
    const segs = edgeSegments(layoutDevs(), placements).segments.filter((s) => s.from === 'this' && s.to === p);
    if (!segs.length) return null;
    return segs.sort((a, b) => (b.b - b.a) - (a.b - a.a))[0];
  }
  function attemptBlocked(side, x, y) {
    if (!mouse.enabled) { noCross('sharing-off', side, 'this', x, y); return true; }
    if (mouse.locked) { noCross('locked', side, 'this', x, y); return true; }
    return false;
  }

  const episodes = {
    inner() {
      const [r0, r1] = PC_SCREENS;
      if (!r1 || r0.x + r0.w !== r1.x) return [];
      const lo = Math.max(r0.y, r1.y); const hi = Math.min(r0.y + r0.h, r1.y + r1.h);
      const y = irnd(lo + 120, hi - 120); const bx = r0.x + r0.w - 1;
      const c0 = wobble(center('this', 0), 300); const c1 = wobble(center('this', 1), 200);
      return [
        step('this', c0.x, c0.y, 1100),
        step('this', bx, y, 900, () => noCross('not-outer-edge', 'right', 'this', bx, y)),
        step('this', c1.x, c1.y, 800),
      ];
    },
    buttonHeld() {
      const seg = peerSeg();
      if (!seg) return episodes.noNeighbour();
      const p = local('this', ...Object.values(segPoint(seg, rnd(0.25, 0.75))).slice(0, 2));
      const [ix, iy] = inward(seg.side, p.x, p.y, 380);
      return [
        step('this', ix, iy, 700),
        step('this', p.x, p.y, 700, () => noCross('button-held', seg.side, 'this', p.x, p.y)),
        step('this', p.x, p.y, 500),
        step('this', ...inward(seg.side, p.x, p.y, 520), 700),
      ];
    },
    outsideZone() {
      const seg = peerSeg();
      if (!seg) return episodes.noNeighbour();
      const f = edgeSegments(layoutDevs(), placements).free.find((s) => s.from === 'this' && s.side === seg.side && Math.abs(s.line - seg.line) <= SNAP);
      if (!f) return episodes.buttonHeld();
      const q = segPoint(f, 0.5); const p = local('this', q.fx, q.fy);
      return [
        step('this', ...inward(f.side, p.x, p.y, 300), 900),
        step('this', p.x, p.y, 500, () => noCross('outside-zone', f.side, 'this', p.x, p.y)),
        step('this', ...inward(f.side, p.x, p.y, 450), 700),
      ];
    },
    noNeighbour() {
      const free = edgeSegments(layoutDevs(), placements).free.filter((s) => s.from === 'this' && s.b - s.a > 200);
      const f = free.find((s) => s.side === 'left') || free[0];
      if (!f) return [];
      const q = segPoint(f, rnd(0.3, 0.7)); const p = local('this', q.fx, q.fy);
      return [
        step('this', ...inward(f.side, p.x, p.y, 500), 1200),
        step('this', p.x, p.y, 600, () => {
          if (!attemptBlocked(f.side, p.x, p.y)) noCross('no-neighbour', f.side, 'this', p.x, p.y);
        }),
        step('this', ...inward(f.side, p.x, p.y, 600), 800),
      ];
    },
    cross() {
      const seg = peerSeg();
      if (!seg) return episodes.noNeighbour();
      const q = segPoint(seg, rnd(0.2, 0.8));
      const p = local('this', q.fx, q.fy);
      return [
        step('this', ...inward(seg.side, p.x, p.y, 600), 1000),
        step('this', p.x, p.y, 450, () => {
          if (attemptBlocked(seg.side, p.x, p.y)) {
            sim.queue.push(step('this', ...inward(seg.side, p.x, p.y, 500), 700));
            return;
          }
          crossLine(seg.side, p.x, p.y, seg.to);
          setCursorOn(seg.to);
          const a = local(seg.to, q.tx, q.ty);
          sim.queue.push(...remoteVisit(seg, a));
        }),
      ];
    },
  };

  // Steps on the peer: arrival, arrival-guard bounce, wander, cross back, cooldown bounce.
  function remoteVisit(seg, a) {
    const to = seg.to; const back = OPP[seg.side];
    const [ix, iy] = inward(back, a.x, a.y, 40);
    const r = dev(to).screens[0];
    const wp = () => ({ x: rnd(r.x + 120, r.x + r.w - 120), y: rnd(r.y + 100, r.y + r.h - 100) });
    const w1 = wp(); const w2 = wp();
    const ret = { x: a.x, y: Math.max(r.y + 10, Math.min(r.y + r.h - 10, a.y + rnd(-150, 150))) };
    if (back === 'top' || back === 'bottom') { ret.x = Math.max(r.x + 10, Math.min(r.x + r.w - 10, a.x + rnd(-150, 150))); ret.y = a.y; }
    const steps = [
      step(to, a.x, a.y, 1),
      step(to, ix, iy, Math.min(60, mouse.arrivalGuardMs / 3)),
      step(to, a.x, a.y, Math.min(50, mouse.arrivalGuardMs / 3), () => noCross('arrival-guard', back, to, a.x, a.y)),
      step(to, w1.x, w1.y, 1400),
      step(to, w2.x, w2.y, 1500),
      step(to, ...inward(back, ret.x, ret.y, 300), 900),
    ];
    steps.push(step(to, ret.x, ret.y, 450, function returnHome() {
      if (mouse.locked) {
        noCross('locked', back, to, ret.x, ret.y);
        const w = wp();
        sim.queue.push(step(to, w.x, w.y, 1500), step(to, ret.x, ret.y, 1200, returnHome));
        return;
      }
      crossLine(back, ret.x, ret.y, 'this');
      setCursorOn('this');
      // Re-enter this device at the matching point of the segment.
      const g = toLayout(to, ret.x, ret.y);
      const along = seg.side === 'left' || seg.side === 'right' ? g.y : g.x;
      const hp = local('this', ...Object.values(segPoint(seg, (along - seg.a) / (seg.b - seg.a || 1))).slice(0, 2));
      const [hx, hy] = inward(seg.side, hp.x, hp.y, 30);
      sim.queue.push(
        step('this', hp.x, hp.y, 1),
        step('this', hx, hy, Math.min(90, mouse.cooldownMs / 3)),
        step('this', hp.x, hp.y, Math.min(90, mouse.cooldownMs / 3), () => noCross('cooldown', seg.side, 'this', hp.x, hp.y)),
        step('this', ...inward(seg.side, hp.x, hp.y, 700), 900),
      );
    }));
    return steps;
  }

  const ORDER = ['inner', 'buttonHeld', 'cross', 'outsideZone', 'cross', 'noNeighbour'];
  function setCursorOn(id) {
    if (cursorOn === id) return;
    cursorOn = id;
    changed('status');
  }
  function returnCursorHome() {
    sim.queue = []; sim.step = null;
    const c = center('this', PC_SCREENS.length > 1 ? 1 : 0);
    sim.dev = 'this'; sim.x = c.x; sim.y = c.y;
    setCursorOn('this');
  }

  function simTick(t) {
    for (let guard = 0; guard < 40; guard++) {
      if (sim.dev !== 'this' && (!mouse.enabled || !online(dev(sim.dev)))) returnCursorHome();
      if (!sim.step) {
        if (!sim.queue.length) {
          const name = ORDER[sim.episode++ % ORDER.length];
          sim.queue = episodes[name]();
          if (!sim.queue.length) sim.queue = [step('this', ...Object.values(wobble(center('this', 0), 400)), 1500)];
        }
        sim.step = sim.queue.shift();
        if (sim.step.dev !== sim.dev) { sim.dev = sim.step.dev; sim.x = sim.step.x; sim.y = sim.step.y; }
        sim.from = { x: sim.x, y: sim.y }; sim.t0 = t;
      }
      const s = sim.step;
      const k = Math.min(1, (t - sim.t0) / Math.max(1, s.ms));
      sim.x = sim.from.x + (s.x - sim.from.x) * ease(k);
      sim.y = sim.from.y + (s.y - sim.from.y) * ease(k);
      if (k < 1) break;
      sim.step = null;
      sim.t0 = sim.t0 + s.ms;
      if (s.then) s.then();
    }
  }
  function emitCursor() {
    const v = { deviceId: sim.dev, x: Math.round(sim.x), y: Math.round(sim.y) };
    const key = `${v.deviceId}:${v.x}:${v.y}`;
    if (key === sim.lastEmit || !ch.cursor.size) return;
    sim.lastEmit = key;
    ch.cursor.emit(v);
  }

  // ---------- slow, living data ----------
  let lastBattery = now();
  let clipCycle = 0; let lastClip = now();
  const SAMPLE_TEXT = ['https://github.com/dprama/omnidesk/issues', 'Budget call moved to Thursday', 'ssh build@10.0.0.24', 'Remember the HDMI adapter'];
  function slowTick() {
    let devChanged = false;
    for (const d of devices) {
      if (d.thisDevice || !online(d) || !d.link) continue;
      const base = PING_BASE[d.link.type];
      const v = d.link.type === 'wifi' ? pick([3, 4, 4, 4, 4, 5, 5, 6, 7]) : d.link.type === 'bluetooth' ? irnd(14, 22) : (Math.random() < 0.85 ? base : base + 1);
      if (v !== d.link.pingMs) { d.link.pingMs = v; devChanged = true; }
    }
    const mb = dev('macbook');
    if (mb && online(mb) && mb.battery && now() - lastBattery > 75000) {
      lastBattery = now();
      mb.battery.percent = Math.max(5, mb.battery.percent - 1);
      devChanged = true;
    }
    if (devChanged) changed('devices', 'status');
    let scrChanged = false;
    for (const s of screen.sessions) {
      if (s.state !== 'live') continue;
      const peer = dev(s.sourceId === 'this' ? s.targetId : s.sourceId);
      const base = peer && peer.link && peer.link.type === 'usb' ? 38 : peer && peer.link && peer.link.type === 'ethernet' ? 33 : 61;
      s.latencyMs = base + irnd(-3, 4);
      s.fps = pick([60, 60, 60, 59, 58]);
      scrChanged = true;
    }
    if (scrChanged) changed('screen');
    if (clip.enabled && mb && online(mb) && now() - lastClip > 28000) { lastClip = now(); newClipItem(); }
  }
  function pushClip(item) {
    clipItems.unshift(item);
    if (clipItems.length > 20) clipItems.length = 20;
    ch.clipItem.emit(item);
  }
  function newClipItem() {
    const kind = ['text', 'file', 'image'][clipCycle++ % 3];
    const dir = Math.random() < 0.5 ? ['macbook', 'this'] : ['this', 'macbook'];
    const base = { id: 'c' + (++clipSeq), kind, from: dir[0], to: dir[1], at: iso(now()) };
    if (kind === 'text') return pushClip(Object.assign(base, { text: pick(SAMPLE_TEXT) }));
    if (kind === 'image') return pushClip(Object.assign(base, { name: 'Screenshot.png', width: 2880, height: 1800, bytes: irnd(300000, 900000) }));
    const item = Object.assign(base, { name: pick(['site-photos.zip', 'Invoice 0142.pdf', 'notes.md']), bytes: irnd(200000, 9000000), progress: 0 });
    pushClip(item);
    let n = 0;
    const tickFile = () => {
      n++; item.progress = Math.min(1, n / 8);
      ch.clipItem.emit(item);
      if (item.progress < 1) later(tickFile, 350);
    };
    later(tickFile, 350);
  }

  // ---------- clocks (reduced work when hidden) ----------
  let fastTimer = null; let slowTimer = null; let stopped = false;
  function startClocks() {
    if (stopped) return;
    if (fastTimer) T.clearInterval(fastTimer);
    if (slowTimer) T.clearInterval(slowTimer);
    fastTimer = null;
    if (isHidden()) {
      slowTimer = T.setInterval(() => { simTick(now()); slowTick(); }, 3000);
    } else {
      fastTimer = T.setInterval(() => { simTick(now()); emitCursor(); }, 50);
      slowTimer = T.setInterval(slowTick, 1000);
    }
  }
  if (window.document && window.document.addEventListener) window.document.addEventListener('visibilitychange', startClocks);
  startClocks();
  function stop() {
    stopped = true;
    if (fastTimer) T.clearInterval(fastTimer);
    if (slowTimer) T.clearInterval(slowTimer);
    timers.forEach((h) => T.clearTimeout(h)); timers.clear();
    if (pairing && pairing.timer) T.clearTimeout(pairing.timer);
  }

  // ---------- validation ----------
  const ERR_WHAT = {
    'mouse.set': 'the mouse and keyboard setting', 'layout.set': 'the screen layout', 'clipboard.set': 'the clipboard setting',
    'screen.start': 'second screen', 'screen.stop': 'second screen', 'camera.setShared': 'camera sharing',
    'camera.watch': 'the camera viewer', 'camera.unwatch': 'the camera viewer', 'multi.set': 'multi-device mode',
    'devices.rename': 'the device name', 'devices.forget': 'that change', 'connection.pairStart': 'pairing', 'connection.pairEnter': 'pairing',
    'connection.pairCancel': 'pairing', 'connection.setLink': 'the link',
  };
  function setterGuard(method) {
    if (scenario !== 'error') return null;
    const what = ERR_WHAT[method] || 'that change';
    return fail('engine-unavailable', `Couldn't update ${what}: the OmniDesk engine isn't responding. Try again in a moment.`);
  }
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const invalid = (message) => fail('invalid', message);
  function checkPatch(patch, schema, label) {
    if (!isObj(patch)) return `Send ${label} settings as an object.`;
    for (const [k, v] of Object.entries(patch)) {
      const rule = schema[k];
      if (!rule) return `"${k}" isn't a ${label} setting.`;
      const msg = rule(v);
      if (msg) return msg;
    }
    return null;
  }
  const bool = (name) => (v) => (typeof v === 'boolean' ? null : `${name} must be on or off.`);
  const ms = (name) => (v) => (Number.isInteger(v) && v >= 0 && v <= 5000 ? null : `${name} must be a whole number between 0 and 5000 ms.`);
  const nameOf = (id) => (dev(id) ? dev(id).name : 'That device');
  function needPeer(id) {
    const d = dev(id);
    if (!d) return fail('unknown-device', 'That device is no longer in your list.');
    if (!d.paired) return fail('not-paired', `Pair the ${d.name} first.`);
    if (!d.online) return fail('offline', `The ${d.name} is offline. Wake it up and try again.`);
    return null;
  }

  // ---------- API ----------
  function api(method, fn) {
    return function () { record(method, arguments); return fn.apply(null, arguments); };
  }
  const ok = (v) => Promise.resolve(clone(v));

  const omnidesk = {
    app: {
      info: api('app.info', () => ok({ version: '2.5.0', engineVersion: ENGINE_VERSION, os: 'windows', osVersion: '11', arch: 'x64', licence: 'GPL-2.0-only' })),
      openExternal: api('app.openExternal', (url) => {
        let u;
        try { u = new URL(String(url)); } catch (_) { return fail('blocked-url', 'That link isn\'t valid.'); }
        const allowed = ['github.com', 'omnidesk.app'];
        if (u.protocol !== 'https:' || !allowed.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
          return fail('blocked-url', 'OmniDesk only opens links to GitHub and the OmniDesk website.');
        }
        log('INFO', `open external ${u.origin}${u.pathname}`);
        return ok({ opened: true });
      }),
      logs: {
        tail: api('app.logs.tail', (n = 100) => ok(logs.slice(-Math.max(0, Math.min(500, Number(n) || 0))))),
        onLine: (cb) => ch.logLine.on(cb),
      },
    },

    status: {
      get: api('status.get', () => ok(statusView())),
      on: (cb) => ch.status.on(cb),
    },

    devices: {
      list: api('devices.list', () => ok(devicesView())),
      on: (cb) => ch.devices.on(cb),
      rename: api('devices.rename', (id, name) => {
        const g = setterGuard('devices.rename'); if (g) return g;
        const d = dev(id);
        if (!d) return fail('unknown-device', 'That device is no longer in your list.');
        const n = typeof name === 'string' ? name.trim() : '';
        if (!n || n.length > 40) return invalid('Use a name between 1 and 40 characters.');
        d.name = n;
        log('INFO', `rename device id=${id}`);
        changed('devices', 'camera');
        return ok(deviceView(d));
      }),
      forget: api('devices.forget', (id) => {
        const g = setterGuard('devices.forget'); if (g) return g;
        const d = dev(id);
        if (!d) return fail('unknown-device', 'That device is no longer in your list.');
        if (d.thisDevice) return fail('invalid', 'This computer can\'t forget itself.');
        devices.splice(devices.indexOf(d), 1);
        delete placements[id];
        screen.sessions = screen.sessions.filter((s) => s.sourceId !== id && s.targetId !== id);
        camera.watchers = camera.watchers.filter((w) => w !== id);
        if (camera.liveDeviceId === id) { camera.liveDeviceId = null; camera.watchers = []; }
        if (sim.dev === id) returnCursorHome();
        log('INFO', `forget device id=${id}`);
        changed('devices', 'status', 'screen', 'camera');
        return ok(devicesView());
      }),
    },

    mouse: {
      get: api('mouse.get', () => ok(mouse)),
      set: api('mouse.set', (patch) => {
        const g = setterGuard('mouse.set'); if (g) return g;
        const bad = checkPatch(patch, {
          enabled: bool('Mouse sharing'), locked: bool('Cursor lock'),
          cooldownMs: ms('Cooldown'), arrivalGuardMs: ms('Arrival guard'),
          lockHotkey: (v) => (typeof v === 'string' && v.trim() ? null : 'Pick a hotkey for locking the cursor.'),
          controller: (v) => (v === 'this' || peers().some((d) => d.id === v) ? null : 'That computer is not paired.'),
        }, 'mouse');
        if (bad) return invalid(bad);
        Object.assign(mouse, patch);
        log('INFO', `mouse ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        if (!mouse.enabled && sim.dev !== 'this') returnCursorHome();
        changed('status', 'devices');
        return ok(mouse);
      }),
      onCursor: (cb) => ch.cursor.on(cb),
      onDecision: (cb) => ch.decision.on(cb, () => decisions.slice(-20)),
    },

    layout: {
      get: api('layout.get', () => ok(layoutView())),
      set: api('layout.set', (arg) => {
        const g = setterGuard('layout.set'); if (g) return g;
        const pl = arg && arg.placements;
        if (!isObj(pl)) return invalid('Send the layout as { placements }.');
        for (const [id, p] of Object.entries(pl)) {
          if (!dev(id)) return fail('unknown-device', 'One of those devices is no longer in your list.');
          if (!isObj(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return invalid(`Give ${nameOf(id)} a position with x and y.`);
        }
        for (const [id, p] of Object.entries(pl)) placements[id] = { x: Math.round(p.x), y: Math.round(p.y) };
        // Interrupt any visit so the simulation follows the new layout.
        returnCursorHome();
        log('INFO', `layout saved devices=${Object.keys(placements).length} edges=${computeEdges(layoutDevs(), placements).length}; engine restarted`);
        return ok(layoutView());
      }),
    },

    clipboard: {
      get: api('clipboard.get', () => ok(clip)),
      set: api('clipboard.set', (patch) => {
        const g = setterGuard('clipboard.set'); if (g) return g;
        const bad = checkPatch(patch, {
          enabled: bool('Clipboard sharing'), files: bool('File sharing'),
          maxFileMB: (v) => (Number.isInteger(v) && v >= 1 && v <= 2048 ? null : 'File size limit must be between 1 and 2048 MB.'),
        }, 'clipboard');
        if (bad) return invalid(bad);
        Object.assign(clip, patch);
        log('INFO', `clipboard ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        changed('status', 'devices');
        return ok(clip);
      }),
      history: api('clipboard.history', () => ok(clipItems.slice(0, 20))),
      onItem: (cb) => ch.clipItem.on(cb),
    },

    screen: {
      get: api('screen.get', () => ok(screenView())),
      on: (cb) => ch.screen.on(cb),
      start: api('screen.start', (opts) => {
        const g = setterGuard('screen.start'); if (g) return g;
        if (!isObj(opts)) return invalid('Choose which screen goes where.');
        const { sourceId, targetId } = opts;
        const resolution = opts.resolution || '1920x1080'; const refresh = opts.refresh || 60; const quality = opts.quality || 'balanced';
        if (sourceId === targetId || (sourceId !== 'this' && targetId !== 'this')) return invalid('One side of a second screen must be this computer.');
        const e = needPeer(sourceId === 'this' ? targetId : sourceId); if (e) return e;
        const o = screenView().options;
        if (!o.resolutions.includes(resolution)) return invalid(`Pick one of ${o.resolutions.join(', ').replace(/x/g, '×')}.`);
        if (!o.refresh.includes(refresh)) return invalid('Second screen runs at 60 Hz.');
        if (!o.quality.includes(quality)) return invalid('Pick latency, balanced or sharp.');
        if (screen.sessions.some((s) => s.targetId === targetId || s.sourceId === sourceId)) {
          return fail('busy', `${nameOf(targetId)} is already part of a second screen. Stop it first.`);
        }
        const s = { id: 's' + Math.random().toString(36).slice(2, 8), sourceId, targetId, resolution, refresh, quality, state: 'starting', latencyMs: 0, fps: 0 };
        screen.sessions.push(s);
        log('INFO', `screen start ${sourceId}->${targetId} ${resolution}@${refresh} ${quality}`);
        changed('screen', 'devices');
        later(() => {
          if (s.state !== 'starting') return;
          const peer = dev(sourceId === 'this' ? targetId : sourceId);
          s.state = 'live'; s.fps = 60;
          s.latencyMs = peer && peer.link && peer.link.type === 'usb' ? 38 : 61;
          changed('screen', 'devices');
        }, 1200);
        return ok(s);
      }),
      stop: api('screen.stop', (sessionId) => {
        const g = setterGuard('screen.stop'); if (g) return g;
        const s = screen.sessions.find((x) => x.id === sessionId);
        if (!s) return fail('unknown-session', 'That second screen has already stopped.');
        s.state = 'stopping';
        changed('screen');
        later(() => {
          screen.sessions = screen.sessions.filter((x) => x !== s);
          log('INFO', `screen stop ${s.sourceId}->${s.targetId}`);
          changed('screen', 'devices');
        }, 600);
        return ok(screenView());
      }),
    },

    camera: {
      get: api('camera.get', () => ok(cameraView())),
      on: (cb) => ch.camera.on(cb),
      setShared: api('camera.setShared', (on) => {
        const g = setterGuard('camera.setShared'); if (g) return g;
        if (typeof on !== 'boolean') return invalid('Camera sharing must be on or off.');
        camera.shared = on;
        camera.liveDeviceId = on ? 'this' : null;
        camera.watchers = [];
        log('INFO', `camera shared=${on}`);
        changed('camera', 'devices');
        if (on) {
          later(() => {
            if (!camera.shared) return;
            camera.watchers = peers().filter(online).map((d) => d.id);
            changed('camera', 'devices');
          }, 800);
        }
        return ok(cameraView());
      }),
      watch: api('camera.watch', (deviceId) => {
        const g = setterGuard('camera.watch'); if (g) return g;
        if (deviceId === 'this') return invalid('That is this computer\'s own camera. Open it from another computer.');
        const e = needPeer(deviceId); if (e) return e;
        if (camera.liveDeviceId !== deviceId) return fail('not-sharing', `${nameOf(deviceId)} isn't sharing its camera right now.`);
        if (!camera.watchers.includes('this')) camera.watchers.push('this');
        log('INFO', `camera watch device=${deviceId} (mock: no window opened)`);
        changed('camera', 'devices');
        return ok(cameraView());
      }),
      unwatch: api('camera.unwatch', (deviceId) => {
        const g = setterGuard('camera.unwatch'); if (g) return g;
        if (!dev(deviceId)) return fail('unknown-device', 'That device is no longer in your list.');
        if (camera.liveDeviceId === deviceId) camera.watchers = camera.watchers.filter((w) => w !== 'this');
        log('INFO', `camera unwatch device=${deviceId}`);
        changed('camera', 'devices');
        return ok(cameraView());
      }),
    },

    connection: {
      onFound: (cb) => {
        if (!discoveryStarted) {
          discoveryStarted = true;
          later(() => {
            if (dev('livingroom')) return;
            found.push({
              id: 'livingroom', name: 'Living-room PC', os: 'windows', osVersion: '11', arch: 'x64',
              thisDevice: false, online: true, paired: false, lastSeen: null,
              link: { type: 'wifi', pingMs: 6, available: ['wifi', 'ethernet'] },
              battery: null, screens: [{ x: 0, y: 0, w: 1920, h: 1080 }],
              sharing: { mouse: false, clipboard: false, screen: false, camera: false },
            });
            log('INFO', 'discovery found name=Living-room PC via=wifi');
            changed('found');
          }, 3000);
        }
        return ch.found.on(cb);
      },
      pairStart: api('connection.pairStart', () => {
        const g = setterGuard('connection.pairStart'); if (g) return g;
        if (pairing && pairing.timer) T.clearTimeout(pairing.timer);
        const code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
        const expiresAt = iso(now() + 120000);
        pairing = { code, expiresAt, timer: T.setTimeout(() => { pairing = null; }, 120000) };
        log('INFO', 'pairing code shown, expires in 120s');
        return ok({ code, expiresAt });
      }),
      pairEnter: api('connection.pairEnter', (deviceId, code) => {
        const g = setterGuard('connection.pairEnter'); if (g) return g;
        const f = found.find((d) => d.id === deviceId);
        if (!f) return fail('unknown-device', 'That computer isn\'t visible any more. Make sure OmniDesk is open on it.');
        if (!/^\d{6}$/.test(String(code))) return invalid('Type all 6 digits of the code.');
        if (String(code) === '000000') return fail('bad-code', 'That code didn\'t match. Check the code on the other computer and try again.');
        return new Promise((resolve) => later(() => {
          found.splice(found.indexOf(f), 1);
          const d = Object.assign(clone(f), { paired: true });
          delete d.sharing;
          devices.push(d);
          placements[d.id] = { x: -1920, y: 180 };
          log('INFO', `paired name=${d.name} fingerprint pinned`);
          changed('found', 'devices', 'status', 'screen');
          resolve(deviceView(d));
        }, 900));
      }),
      pairCancel: api('connection.pairCancel', () => {
        const g = setterGuard('connection.pairCancel'); if (g) return g;
        if (pairing && pairing.timer) T.clearTimeout(pairing.timer);
        pairing = null;
        return ok({ cancelled: true });
      }),
      setLink: api('connection.setLink', (deviceId, type) => {
        const g = setterGuard('connection.setLink'); if (g) return g;
        const e = needPeer(deviceId); if (e) return e;
        const d = dev(deviceId);
        if (!d.link || !d.link.available.includes(type)) {
          const names = { wifi: 'Wi-Fi', usb: 'a USB cable', bluetooth: 'Bluetooth', ethernet: 'Ethernet' };
          return fail('link-unavailable', `${d.name} can't use ${names[type] || 'that link'} right now.`);
        }
        d.link.type = type; d.link.pingMs = PING_BASE[type];
        for (const s of screen.sessions) if (s.state === 'live' && (s.sourceId === deviceId || s.targetId === deviceId)) s.latencyMs = type === 'usb' ? 38 : 61;
        log('INFO', `link device=${deviceId} type=${type}`);
        changed('devices', 'status', 'screen');
        return ok(deviceView(d));
      }),
    },

    multi: {
      get: api('multi.get', () => ok(multi)),
      set: api('multi.set', (patch) => {
        const g = setterGuard('multi.set'); if (g) return g;
        const bad = checkPatch(patch, { enabled: bool('Multi-device mode') }, 'multi-device');
        if (bad) return invalid(bad);
        Object.assign(multi, patch);
        log('INFO', `multi enabled=${multi.enabled}`);
        return ok(multi);
      }),
    },

    feedback: {
      systemInfo: api('feedback.systemInfo', () => ok({
        os: 'windows', osVersion: '11', arch: 'x64', appVersion: '2.5.0', engineVersion: ENGINE_VERSION,
        monitors: PC_SCREENS, devices: devices.length,
      })),
      send: api('feedback.send', (msg) => {
        if (!isObj(msg) || !['bug', 'idea', 'thanks'].includes(msg.kind)) return invalid('Choose Bug, Idea or Thank you.');
        if (typeof msg.message !== 'string' || !msg.message.trim()) return invalid('Write a short message first.');
        log('INFO', `feedback kind=${msg.kind} systemInfo=${!!msg.includeSystemInfo} (mock: no browser opened)`);
        return ok({ opened: true });
      }),
    },

    tip: {
      open: api('tip.open', (amount) => {
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0 || n > 1000) return invalid('Pick an amount between $1 and $1000.');
        log('INFO', `tip open amount=${n} (mock: no browser opened)`);
        return ok({ opened: true });
      }),
    },
  };

  function deepFreeze(o) {
    Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); });
    return Object.freeze(o);
  }
  deepFreeze(omnidesk);
  Object.defineProperty(window, 'omnidesk', { value: omnidesk, enumerable: true, configurable: false, writable: false });
  Object.defineProperty(window, '__omnideskMock', {
    value: Object.freeze({
      scenario, computeEdges, stop,
      subscriptions() {
        const byChannel = {};
        let total = 0;
        for (const [k, c] of Object.entries(ch)) { byChannel[k] = c.size; total += c.size; }
        return { total, byChannel };
      },
    }), configurable: true,
  });
})(typeof window !== 'undefined' ? window : globalThis);
