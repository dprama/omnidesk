// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// mDNS / DNS-SD discovery of other OmniDesk devices on every non-loopback
// IPv4 interface (Wi-Fi, Ethernet, USB/Thunderbolt networking, Bluetooth PAN).
//
// Service: _omnidesk._tcp.local, instance "<id>._omnidesk._tcp.local",
// SRV → pairing port 24802, TXT: v, id, fp, name, os, osVersion, arch,
// pairingPort, peerPort, enginePort. One multicast-dns socket per interface
// (UDP 5353, group 224.0.0.251). Peers are matched to the interface they were
// seen on by subnet, which gives the link type. See app/main/INTERFACES.md.

const os = require('node:os');
const identityLib = require('../pairing/identity');
const linktype = require('./linktype');

const SERVICE = '_omnidesk._tcp.local';
const PAIRING_PORT = 24802;
const PEER_PORT = 24803;
const ENGINE_PORT = 24800;
const TTL = 120;
const EXPIRE_MS = 75 * 1000;
const PREFER = ['usb', 'ethernet', 'wifi', 'bluetooth'];

function osName(p = process.platform) { return p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux'; }

// ---- helpers (exported for tests) ----
function ipToInt(ip) { return ip.split('.').reduce((a, b) => ((a << 8) >>> 0) + (Number(b) & 255), 0) >>> 0; }
function inSubnet(ip, addr, netmask) {
  const m = ipToInt(netmask);
  return ((ipToInt(ip) & m) >>> 0) === ((ipToInt(addr) & m) >>> 0);
}
// os.networkInterfaces() → [{ name, address, netmask }] for non-internal IPv4.
function listInterfaces(raw) {
  const out = [];
  for (const [name, addrs] of Object.entries(raw || {})) {
    for (const a of addrs || []) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal || !a.address || a.address.startsWith('127.')) continue;
      if (/^(utun|awdl|llw|lo|docker|veth|vmnet|vboxnet|ap\d)/i.test(name)) continue;
      out.push({ name, address: a.address, netmask: a.netmask || '255.255.255.0' });
      break; // one IPv4 per interface
    }
  }
  return out;
}
function ifaceFor(ifaces, ip) {
  return ifaces.find((i) => inSubnet(ip, i.address, i.netmask)) || null;
}

function encodeTxt(obj) {
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => Buffer.from(`${k}=${String(v).slice(0, 200)}`, 'utf8'));
}
function decodeTxt(data) {
  const out = {};
  for (const b of [].concat(data || [])) {
    const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
  }
  return out;
}
const cleanPort = (v, d) => { const n = parseInt(v, 10); return n > 0 && n < 65536 ? n : d; };

function createDiscovery({
  log = () => {},
  engine = null,
  devices = null,
  mdnsFactory = (opts) => require('multicast-dns')(opts),
  networkInterfaces = () => os.networkInterfaces(),
  detectLinks = (names) => linktype.detect(process.platform, names),
  platform = process.platform,
  pairingPort = PAIRING_PORT,
  peerPort = PEER_PORT,
  now = () => Date.now(),
  autoStart = true,
  queryEveryMs = 10000,
  rescanEveryMs = 15000,
} = {}) {
  const warn = log.warn || log;
  const eng = engine || { paths: require('../engine/paths').enginePaths(), readSetting: () => null };
  let self = null;
  const selfExtra = {};
  const peers = new Map(); // id -> { txt, seen: Map(ifaceName -> { address, at }) }
  const prefs = new Map(); // id -> LinkType
  const foundCbs = new Set();
  let ifaces = [];
  let linkTypes = {};
  const sockets = new Map(); // ifaceName -> mdns
  let lastFound = '';
  const timers = [];
  let stopped = false;

  function selfInfo() {
    if (!self) {
      try {
        const idn = identityLib.loadIdentity(eng, log);
        self = { id: idn.id, fp: idn.fingerprint };
      } catch (e) {
        warn(`no engine identity, not advertising: ${e.message}`);
        return null;
      }
    }
    let name = os.hostname().replace(/\.local$/, '');
    let osVersion = os.release();
    let arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (devices && devices.thisDevice) {
      try { const t = devices.thisDevice(); name = t.name; osVersion = t.osVersion; arch = t.arch; } catch { /* keep */ }
    }
    return { v: 1, id: self.id, fp: self.fp, name, os: osName(platform), osVersion, arch, pairingPort, peerPort, enginePort: ENGINE_PORT, ...selfExtra };
  }

  function instanceName(id) { return `${id}.${SERVICE}`; }
  function hostName(id) { return `${id}.local`; }

  function records(iface, ttl = TTL) {
    const me = selfInfo();
    if (!me) return null;
    const inst = instanceName(me.id);
    return [
      { name: SERVICE, type: 'PTR', ttl, data: inst },
      { name: inst, type: 'SRV', ttl, data: { port: pairingPort, target: hostName(me.id), priority: 0, weight: 0 } },
      { name: inst, type: 'TXT', ttl, data: encodeTxt(me) },
      { name: hostName(me.id), type: 'A', ttl, data: iface.address },
    ];
  }

  function announce(ifaceName, ttl = TTL) {
    const sock = sockets.get(ifaceName);
    const iface = ifaces.find((i) => i.name === ifaceName);
    if (!sock || !iface) return;
    const answers = records(iface, ttl);
    if (answers) sock.respond({ answers }, () => {});
  }

  const lastAnswer = new Map();
  function onQuery(q, rinfo) {
    if (!q || !Array.isArray(q.questions)) return;
    const me = selfInfo();
    if (!me) return;
    const wanted = q.questions.some((x) => x && (x.name === SERVICE || x.name === instanceName(me.id) || x.name === hostName(me.id)));
    if (!wanted) return;
    const iface = rinfo && rinfo.address ? ifaceFor(ifaces, rinfo.address) : null;
    if (!iface) return;
    const t = now();
    if (t - (lastAnswer.get(iface.name) || 0) < 1000) return;
    lastAnswer.set(iface.name, t);
    announce(iface.name);
  }

  function onResponse(res, rinfo) {
    if (!res || !rinfo || !rinfo.address) return;
    const all = [...(res.answers || []), ...(res.additionals || [])];
    const txts = all.filter((r) => r && r.type === 'TXT' && typeof r.name === 'string' && r.name.endsWith(`.${SERVICE}`));
    if (!txts.length) return;
    const iface = ifaceFor(ifaces, rinfo.address);
    if (!iface) return;
    const me = selfInfo();
    let changed = false;
    for (const r of txts) {
      const txt = decodeTxt(r.data);
      if (!txt.id || !/^[0-9a-f]{20}$/.test(txt.id) || !/^[0-9a-f]{64}$/.test(txt.fp || '') || !txt.fp.startsWith(txt.id)) continue;
      if (me && txt.id === me.id) continue;
      const aRec = all.find((x) => x && x.type === 'A' && x.name === hostName(txt.id));
      const address = aRec && typeof aRec.data === 'string' && ifaceFor([iface], aRec.data) ? aRec.data : rinfo.address;
      let p = peers.get(txt.id);
      if (!p) { p = { txt, seen: new Map() }; peers.set(txt.id, p); changed = true; }
      if (r.ttl === 0) { p.seen.delete(iface.name); if (!p.seen.size) peers.delete(txt.id); changed = true; continue; }
      if (JSON.stringify(p.txt) !== JSON.stringify(txt)) { p.txt = txt; changed = true; }
      const prev = p.seen.get(iface.name);
      if (!prev || prev.address !== address) changed = true;
      p.seen.set(iface.name, { address, at: now() });
    }
    if (changed) emitFound();
  }

  function expire() {
    const t = now();
    let changed = false;
    for (const [id, p] of peers) {
      for (const [n, s] of p.seen) if (t - s.at > EXPIRE_MS || !ifaces.some((i) => i.name === n)) { p.seen.delete(n); changed = true; }
      if (!p.seen.size) { peers.delete(id); changed = true; }
    }
    if (changed) emitFound();
  }

  function typeOf(ifaceName) { return linkTypes[ifaceName] || linktype.classifyByName(ifaceName, platform); }

  function linkFor(deviceId) {
    const p = peers.get(deviceId);
    if (!p || !p.seen.size) return null;
    const byType = new Map();
    for (const [n, s] of [...p.seen].sort((a, b) => b[1].at - a[1].at)) {
      const ty = typeOf(n);
      if (!byType.has(ty)) byType.set(ty, s.address);
    }
    const available = PREFER.filter((x) => byType.has(x));
    const pref = prefs.get(deviceId);
    const type = pref && byType.has(pref) ? pref : available[0];
    return { type, available, address: byType.get(type) };
  }

  // For pairing / peer channel: where to reach a device.
  function lookup(deviceId) {
    const l = linkFor(deviceId);
    if (!l) return null;
    const p = peers.get(deviceId);
    return {
      ...l,
      fingerprint: p.txt.fp,
      pairingPort: cleanPort(p.txt.pairingport, PAIRING_PORT),
      peerPort: cleanPort(p.txt.peerport, PEER_PORT),
      enginePort: cleanPort(p.txt.engineport, ENGINE_PORT),
      txt: { ...p.txt },
    };
  }

  function isPaired(fp) {
    try { return identityLib.isTrusted(eng.paths, fp); } catch { return false; }
  }

  function foundList() {
    const out = [];
    for (const [id, p] of peers) {
      if (isPaired(p.txt.fp)) continue;
      const l = linkFor(id);
      out.push({
        id,
        name: String(p.txt.name || id).slice(0, 64),
        os: ['windows', 'macos', 'linux'].includes(p.txt.os) ? p.txt.os : 'linux',
        osVersion: String(p.txt.osversion || ''),
        arch: p.txt.arch === 'arm64' ? 'arm64' : 'x64',
        thisDevice: false, online: true, paired: false, lastSeen: null,
        link: l ? { type: l.type, pingMs: null, available: l.available } : null,
        battery: null, screens: [],
        sharing: { mouse: false, clipboard: false, screen: false, camera: false },
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function emitFound(force = false) {
    const list = foundList();
    const j = JSON.stringify(list);
    if (!force && j === lastFound) return;
    lastFound = j;
    for (const cb of foundCbs) { try { cb(list); } catch (e) { warn(`onFound subscriber: ${e.message}`); } }
  }

  function query() {
    for (const sock of sockets.values()) sock.query({ questions: [{ name: SERVICE, type: 'PTR' }] }, () => {});
  }

  async function rescan() {
    if (stopped) return;
    const next = listInterfaces(networkInterfaces());
    const key = (l) => l.map((i) => `${i.name}=${i.address}/${i.netmask}`).sort().join(',');
    if (key(next) === key(ifaces) && sockets.size) return;
    const names = next.map((i) => i.name);
    try { linkTypes = await detectLinks(names); } catch { linkTypes = {}; }
    if (stopped) return;
    for (const [n, sock] of sockets) {
      const still = next.find((i) => i.name === n);
      const old = ifaces.find((i) => i.name === n);
      if (!still || !old || still.address !== old.address) { try { sock.destroy(); } catch { /* closed */ } sockets.delete(n); }
    }
    ifaces = next;
    for (const iface of ifaces) {
      if (sockets.has(iface.name)) continue;
      let sock;
      try {
        sock = mdnsFactory({ interface: iface.address, bind: '0.0.0.0', reuseAddr: true, loopback: false });
      } catch (e) { warn(`mdns on ${iface.name}: ${e.message}`); continue; }
      sock.on('query', onQuery);
      sock.on('response', onResponse);
      sock.on('error', (e) => warn(`mdns ${iface.name}: ${e.message}`));
      sock.on('warning', () => {});
      sockets.set(iface.name, sock);
      announce(iface.name);
      sock.query({ questions: [{ name: SERVICE, type: 'PTR' }] }, () => {});
    }
    log(`mdns on ${ifaces.map((i) => `${i.name}(${typeOf(i.name)})`).join(', ') || 'no interfaces'}`);
    expire();
  }

  function start() {
    rescan().catch((e) => warn(`rescan: ${e.message}`));
    timers.push(setInterval(() => { query(); expire(); emitFound(); }, queryEveryMs));
    timers.push(setInterval(() => rescan().catch(() => {}), rescanEveryMs));
    timers.push(setInterval(() => { for (const n of sockets.keys()) announce(n); }, (TTL * 1000) / 2));
    for (const t of timers) if (t.unref) t.unref();
  }

  const api = {
    // main API (INTERFACES.md)
    onFound(cb) {
      foundCbs.add(cb);
      try { cb(foundList()); } catch (e) { warn(`onFound subscriber: ${e.message}`); }
      return () => foundCbs.delete(cb);
    },
    linkFor,
    async setLink(deviceId, type) {
      if (!linktype.LINK_TYPES.includes(type)) throw { code: 'bad-args', message: 'Unknown link type.' };
      const l = linkFor(deviceId);
      if (l && !l.available.includes(type)) throw { code: 'link-unavailable', message: 'That link is not connected right now.' };
      prefs.set(deviceId, type);
    },
    // for pairing / peer
    lookup,
    refresh() { emitFound(true); },
    setSelf(patch) { Object.assign(selfExtra, patch || {}); for (const n of sockets.keys()) announce(n); },
    self: () => selfInfo(),
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      for (const n of sockets.keys()) announce(n, 0); // goodbye
      for (const s of sockets.values()) { try { s.destroy(); } catch { /* closed */ } }
      sockets.clear();
    },
    // tests
    _onResponse: onResponse,
    _onQuery: onQuery,
    _rescan: rescan,
  };
  if (autoStart) start();
  return api;
}

let shared = null;
function create(args) {
  if (!shared) shared = createDiscovery(args);
  return shared;
}

module.exports = {
  create, createDiscovery, current: () => shared,
  SERVICE, PAIRING_PORT, PEER_PORT, ENGINE_PORT,
  listInterfaces, ifaceFor, inSubnet, encodeTxt, decodeTxt,
};
