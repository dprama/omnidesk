// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// File clipboard over the encrypted peer channel (app/main/pairing/PEER.md).
// No Electron here: the clipboard is behind `platform` so tests can fake it.
//
//   sender                                   receiver
//   local copy of files seen by the poll
//   files.offer {id, files:[{name,size,sha256}], skipped}  ──▶  checks caps, starts pulling
//                       ◀── request files.chunk {id, file, index}
//   reply {data: base64 of ≤ 512 KiB}  ──▶  write + SHA-256, verify per file
//                                            put the files on the local clipboard
//
// Paths never leave this computer: the receiver only learns names, sizes, hashes.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { uniqueNames, sanitizeName } = require('./names');

const CHUNK = 512 * 1024; // base64 + JSON stays well under the 1 MiB peer frame
const MAX_FILES = 20;
const HISTORY_MAX = 20;
const KEEP_OFFERS = 4; // the sender serves the last few offers…
const OFFER_TTL_MS = 60 * 60 * 1000; // …for an hour
const TEMP_TTL_MS = 24 * 60 * 60 * 1000;
const TEMP_PREFIX = 'clip-';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const RETRY_CODES = new Set(['timeout', 'disconnected', 'offline']);
const CODE_RE = /^[a-z][a-z-]{0,31}$/;
// The engine clears the other computer's clipboard when the cursor enters it
// and the sending side had nothing it can convert (a clipboard with only files
// is empty to the engine): Server::switchScreen sends the empty clipboard to a
// dirty client, and Computer::grabClipboard empties Windows on a remote grab.
// While the files we put on (or copied from) the clipboard are the newest
// copy, an emptied clipboard is put back. Bounded so we never fight anyone.
const GUARD_MS = 60 * 60 * 1000;
const GUARD_MAX_RESTORES = 200;
const GUARD_MIN_GAP_MS = 1000;
const ECHO_MS = 5000;

const err = (code, message) => Object.assign(new Error(message || code), { code });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const pathsKey = (paths) => paths.map((p) => String(p).normalize('NFC')).join('\n');
const reasonCounts = (list) => {
  const n = {};
  for (const s of list) { const why = CODE_RE.test(String(s && s.why)) ? s.why : 'other'; n[why] = (n[why] || 0) + 1; }
  return Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ');
};

async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

function label(names) {
  if (names.length === 1) return names[0];
  return `${names[0]} and ${names.length - 1} more`;
}

function within(dir, p) {
  const rel = path.relative(dir.normalize('NFC'), String(p).normalize('NFC'));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function createFiles({
  peer, devices, engine, log = () => {}, settings, platform, tempRoot,
  pollMs = 500, chunkSize = CHUNK, now = Date.now, retryDelayMs = 300, parseDecision = null,
}) {
  if (typeof log.warn !== 'function' || typeof log.error !== 'function') {
    const base = log;
    log = (m) => base(m);
    log.warn = (m) => base(`warn ${m}`);
    log.error = (m) => base(`error ${m}`);
  }
  const conf = () => ({ enabled: true, maxFileMB: 100, files: true, ...(settings.get('clipboard') || {}) });
  const limitBytes = () => Math.max(1, Number(conf().maxFileMB) || 100) * 1024 * 1024;
  const active = () => { const c = conf(); return !!c.enabled && !!c.files; };

  const tempRoots = [tempRoot];
  function addRealRoot() {
    try { const real = fs.realpathSync(tempRoot); if (!tempRoots.includes(real)) tempRoots.push(real); } catch { /* not created yet */ }
  }
  addRealRoot();
  const inTemp = (p) => tempRoots.some((r) => within(r, p));
  const items = [];
  const listeners = new Set();
  const outgoing = new Map(); // id -> { id, to:Set, files:[{path,name,size,sha256}], total, served:Map, item }
  const incoming = new Map(); // id -> { id, from, cancelled, dir }
  let latestIncoming = null;
  let lastSig = null;
  let localSeq = 0; // bumps whenever files (not ours) are copied here
  let guard = null; // { paths, at, restores, lastRestore }: files that are the newest copy on this clipboard
  let restoreEcho = null; // { key, until }: our own restore, not a new copy
  let cursorOn = 'this';
  let timer = null;
  let cleanTimer = null;
  let ticking = false;
  const offs = [];

  // ---- history / events ----
  function emit(item) {
    const { _last, ...copy } = item;
    void _last;
    const i = items.findIndex((x) => x.id === item.id);
    if (i !== -1) items.splice(i, 1);
    items.unshift(copy);
    items.length = Math.min(items.length, HISTORY_MAX);
    for (const cb of listeners) { try { cb({ ...copy }); } catch (e) { log.error(`files listener: ${e.message}`); } }
  }
  function throttled(item) {
    const t = now();
    if (item.progress >= 1 || !item._last || t - item._last >= 250) { item._last = t; emit(item); }
  }

  // ---- where the cursor is (engine events, same sources as api/index.js) ----
  function onLine(line) {
    if (!parseDecision) return;
    const d = parseDecision(line);
    if (d && d.kind === 'cross') cursorOn = devices.idForEngineName(d.fields.to) || cursorOn;
  }
  function onIpc(cmd, value) {
    if (cmd !== 'cursor' || typeof value !== 'string') return;
    const id = devices.idForEngineName(value.split(',')[0]);
    if (id) cursorOn = id;
  }

  function reachable(d) {
    if (!d || d.thisDevice || d.paired === false) return false;
    if (d.online) return true;
    try { return !!peer.isConnected(d.id); } catch { return false; }
  }
  // The device the cursor is on if it's a peer, else every reachable paired device.
  function targets() {
    const list = devices.list();
    if (cursorOn && cursorOn !== 'this') {
      const d = list.find((x) => x.id === cursorOn);
      if (reachable(d)) return [d.id];
    }
    return list.filter(reachable).map((d) => d.id);
  }

  // ---- sender ----
  function prune() {
    const t = now();
    const ids = [...outgoing.keys()];
    for (const id of ids) if (t - outgoing.get(id).at > OFFER_TTL_MS) outgoing.delete(id);
    while (outgoing.size > KEEP_OFFERS) outgoing.delete(outgoing.keys().next().value);
  }

  async function offer(paths, to = targets()) {
    if (!active()) return null;
    if (!to.length) { log('files: copied files but no peer is reachable'); return null; }
    const max = limitBytes();
    const files = [];
    const skipped = [];
    let total = 0;
    for (const p of paths) {
      const name = path.basename(p);
      if (files.length >= MAX_FILES) { skipped.push({ name, why: 'too-many' }); continue; }
      let st;
      try { st = await fsp.stat(p); } catch { skipped.push({ name, why: 'unreadable' }); continue; }
      if (st.isDirectory()) { skipped.push({ name, why: 'folder' }); continue; }
      if (!st.isFile()) { skipped.push({ name, why: 'not-a-file' }); continue; }
      if (st.size > max || total + st.size > max) { skipped.push({ name, why: 'too-big' }); continue; }
      total += st.size;
      files.push({ path: p, size: st.size });
    }
    if (skipped.length) log(`files: skipped ${reasonCounts(skipped)}`); // no names: logs never hold clipboard content
    if (!files.length) return null;
    const names = uniqueNames(files.map((f) => path.basename(f.path)));
    for (const [i, f] of files.entries()) {
      f.name = names[i];
      try { f.sha256 = await sha256File(f.path); } catch (e) { log.warn(`files: cannot read a copied file: ${e.code || 'error'}`); return null; }
    }
    const id = crypto.randomUUID();
    const item = { id, kind: 'file', from: 'this', to: to.length === 1 ? to[0] : '*', at: now(), name: label(names), bytes: total, progress: 0 };
    outgoing.set(id, { id, to: new Set(to), files, total, served: new Map(), at: item.at, item });
    prune();
    const payload = {
      id,
      files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
      skipped: skipped.map((s) => ({ name: sanitizeName(s.name), why: s.why })),
    };
    emit(item);
    const sent = await Promise.all(to.map((dev) => peer.send(dev, 'files.offer', payload).then(() => true, (e) => {
      log.warn(`files: offer to ${dev} failed: ${e.code || 'error'}`);
      return false;
    })));
    if (!sent.some(Boolean)) { item.error = 'offline'; emit(item); return id; }
    log(`files: offered ${files.length} file(s), ${total} bytes, to ${to.join(',')}`);
    return id;
  }

  async function serveChunk(deviceId, req) {
    const { id, file, index } = req || {};
    const t = typeof id === 'string' ? outgoing.get(id) : null;
    if (!t || !t.to.has(deviceId)) throw err('gone', 'That copy is no longer offered.');
    if (!active()) throw err('off', 'File sharing is off on the sending computer.');
    if (!Number.isInteger(file) || !Number.isInteger(index) || file < 0 || index < 0 || file >= t.files.length) throw err('bad-args', 'Bad chunk request.');
    const f = t.files[file];
    const offset = index * chunkSize;
    if (offset >= f.size && !(f.size === 0 && index === 0)) throw err('bad-args', 'Chunk out of range.');
    const len = Math.min(chunkSize, f.size - offset);
    const fh = await fsp.open(f.path, 'r');
    let buf;
    try {
      const st = await fh.stat();
      if (st.size !== f.size) throw err('changed', 'The file changed after it was copied.');
      buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len) throw err('changed', 'The file changed after it was copied.');
    } finally { await fh.close(); }
    const key = `${deviceId}`;
    const sent = (t.served.get(key) || 0) + len;
    t.served.set(key, sent);
    // 1 (done) only when the receiver reports it verified and placed the files (files.result)
    if (!t.done) t.item.progress = t.total ? Math.min(0.99, Math.max(t.item.progress, sent / t.total)) : 0.99;
    throttled(t.item);
    return { data: buf.toString('base64') };
  }

  // The receiver reports how it ended, so the sender's history isn't stuck at "sending".
  function onResult(from, r) {
    const t = r && typeof r.id === 'string' ? outgoing.get(r.id) : null;
    if (!t || !t.to.has(from)) return;
    if (r.ok === true) {
      t.done = true;
      t.item.progress = 1;
      delete t.item.error;
      emit(t.item);
    } else if (!t.done) {
      t.item.error = CODE_RE.test(String(r.error)) ? r.error : 'error';
      emit(t.item);
    }
  }
  function report(to, id, error) {
    const payload = error ? { id, ok: false, error } : { id, ok: true };
    Promise.resolve().then(() => peer.send(to, 'files.result', payload)).catch(() => { /* best effort */ });
  }

  // ---- receiver ----
  function validOffer(p) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id)) return 'bad id';
    if (!Array.isArray(p.files) || p.files.length < 1 || p.files.length > MAX_FILES) return 'bad file count';
    const max = limitBytes();
    let total = 0;
    for (const f of p.files) {
      if (!f || typeof f.name !== 'string' || f.name.length > 1024) return 'bad name';
      if (!Number.isSafeInteger(f.size) || f.size < 0) return 'bad size';
      if (typeof f.sha256 !== 'string' || !SHA_RE.test(f.sha256)) return 'bad hash';
      total += f.size;
    }
    if (total > max) return 'too-big';
    return null;
  }

  async function requestChunk(from, id, file, index) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await peer.request(from, 'files.chunk', { id, file, index });
      } catch (e) {
        if (attempt >= 3 || !RETRY_CODES.has(e && e.code)) throw e;
        await delay(retryDelayMs * attempt);
      }
    }
  }

  async function pull(from, p) {
    for (const t of incoming.values()) t.cancelled = true; // the newest copy wins
    const dir = path.join(tempRoot, TEMP_PREFIX + p.id);
    const job = { id: p.id, from, cancelled: false, dir };
    incoming.set(p.id, job);
    latestIncoming = p.id;
    const names = uniqueNames(p.files.map((f) => f.name));
    const total = p.files.reduce((s, f) => s + f.size, 0);
    const item = { id: p.id, kind: 'file', from, to: 'this', at: now(), name: label(names), bytes: total, progress: 0 };
    emit(item);
    const seq0 = localSeq;
    const written = [];
    let done = 0;
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      addRealRoot();
      for (const [fi, f] of p.files.entries()) {
        const dest = path.join(dir, names[fi]);
        if (!within(dir, dest)) throw err('bad-name');
        const fh = await fsp.open(dest, 'wx', 0o600);
        const h = crypto.createHash('sha256');
        try {
          const chunks = Math.ceil(f.size / chunkSize);
          for (let ci = 0; ci < chunks; ci++) {
            if (job.cancelled) throw err('cancelled');
            if (!active()) throw err('off');
            const res = await requestChunk(from, p.id, fi, ci);
            const data = Buffer.from((res && typeof res.data === 'string') ? res.data : '', 'base64');
            const want = Math.min(chunkSize, f.size - ci * chunkSize);
            if (data.length !== want) throw err('bad-chunk', `chunk ${ci} of file ${fi + 1} has ${data.length} bytes, expected ${want}`);
            await fh.write(data, 0, data.length, ci * chunkSize);
            h.update(data);
            done += data.length;
            item.progress = total ? Math.min(0.999, done / total) : 0.999;
            throttled(item);
          }
        } finally { await fh.close(); }
        if (h.digest('hex') !== f.sha256) throw err('hash-mismatch', `file ${fi + 1} did not arrive intact`);
        written.push(dest);
      }
      if (job.cancelled || latestIncoming !== p.id) throw err('cancelled');
      if (!active()) throw err('off');
      // Latest copy wins: if something was copied here while this was arriving, keep that.
      await tick();
      if (localSeq !== seq0) throw err('superseded');
      if (job.cancelled) throw err('cancelled');
      await platform.writeFiles(written);
      guard = { paths: written, at: now(), restores: 0, lastRestore: 0 };
      item.progress = 1;
      emit(item);
      report(from, p.id, null);
      log(`files: received ${written.length} file(s), ${total} bytes, from ${from}`);
      return written;
    } catch (e) {
      const code = (e && typeof e.code === 'string' && CODE_RE.test(e.code)) ? e.code : 'error';
      // e.message never holds names or paths (platform errors carry only the exit code)
      if (code !== 'cancelled' && code !== 'superseded') log.warn(`files: transfer ${p.id} from ${from} failed: ${code}${e && e.code === 'bad-chunk' ? ` ${e.message}` : ''}`);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      item.error = code;
      emit(item);
      report(from, p.id, code);
      return null;
    } finally {
      incoming.delete(p.id);
    }
  }

  function onOffer(from, p) {
    const okId = p && typeof p.id === 'string' && ID_RE.test(p.id);
    if (!active()) {
      log('files: offer ignored, file clipboard is off');
      if (okId) report(from, p.id, 'off');
      return;
    }
    const bad = validOffer(p);
    if (bad) {
      log.warn(`files: offer from ${from} rejected: ${bad}`);
      if (okId) report(from, p.id, bad === 'too-big' ? 'too-big' : 'bad-offer');
      return;
    }
    if (incoming.has(p.id) || items.some((x) => x.id === p.id)) return; // duplicate
    if (Array.isArray(p.skipped) && p.skipped.length) {
      log(`files: ${from} skipped ${reasonCounts(p.skipped.slice(0, MAX_FILES))}`);
    }
    return pull(from, p);
  }

  // ---- local clipboard watch ----
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const r = await platform.readFiles();
      const { sig, paths } = r;
      if (sig === lastSig) return;
      const first = lastSig === null;
      lastSig = sig;
      if (first) return; // don't offer what was copied before start
      if (r.blank) { await restore(); return; } // emptied, not a new copy
      const key = pathsKey(paths);
      if (restoreEcho && restoreEcho.key === key && now() < restoreEcho.until) { restoreEcho = null; return; }
      if (paths.length && paths.every(inTemp)) return; // files we just received
      guard = null; // something newer is on the clipboard
      if (!paths.length) return;
      // Only a new local *file* copy supersedes files arriving from the other computer: text or
      // images here may be the engine's copy of the very same Finder/Explorer copy (file name, icon).
      localSeq++;
      if (!active()) return;
      const id = await offer(paths);
      if (id) guard = { paths: paths.slice(), at: now(), restores: 0, lastRestore: 0 };
    } catch (e) {
      log.warn(`files: clipboard poll: ${e.code || 'error'}`);
    } finally { ticking = false; }
  }

  // The clipboard went empty while our files were the newest copy: put them back.
  async function restore() {
    if (!guard || !active()) return;
    const t = now();
    if (t - guard.at > GUARD_MS || guard.restores >= GUARD_MAX_RESTORES) { guard = null; return; }
    if (t - guard.lastRestore < GUARD_MIN_GAP_MS) return;
    const paths = guard.paths.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (!paths.length) { guard = null; return; }
    guard.restores++;
    guard.lastRestore = t;
    restoreEcho = { key: pathsKey(paths), until: t + ECHO_MS };
    try {
      await platform.writeFiles(paths);
      log(`files: the clipboard was emptied, put the copied file(s) back (${guard.restores})`);
    } catch (e) {
      log.warn(`files: could not put the files back: ${e.code || 'error'}`);
    }
  }

  async function cleanTemp() {
    let entries;
    try { entries = await fsp.readdir(tempRoot, { withFileTypes: true }); } catch { return; }
    const busy = new Set([...incoming.values()].map((j) => path.basename(j.dir)));
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith(TEMP_PREFIX) || busy.has(e.name)) continue;
      const full = path.join(tempRoot, e.name);
      try {
        const st = await fsp.stat(full);
        if (now() - st.mtimeMs > TEMP_TTL_MS) await fsp.rm(full, { recursive: true, force: true });
      } catch { /* gone */ }
    }
  }

  function start() {
    if (timer) return;
    offs.push(peer.on('files.offer', (from, payload) => { onOffer(from, payload); }));
    offs.push(peer.on('files.chunk', (from, payload) => serveChunk(from, payload)));
    offs.push(peer.on('files.result', (from, payload) => { onResult(from, payload); }));
    if (engine && typeof engine.on === 'function') {
      engine.on('line', onLine);
      engine.on('ipc', onIpc);
      offs.push(() => { const off = engine.off || engine.removeListener; if (off) { off.call(engine, 'line', onLine); off.call(engine, 'ipc', onIpc); } });
    }
    timer = setInterval(tick, pollMs);
    if (timer.unref) timer.unref();
    cleanTemp();
    cleanTimer = setInterval(cleanTemp, 60 * 60 * 1000);
    if (cleanTimer.unref) cleanTimer.unref();
    tick();
  }

  function stop() {
    clearInterval(timer); clearInterval(cleanTimer);
    timer = null; cleanTimer = null;
    while (offs.length) { try { offs.pop()(); } catch { /* ignore */ } }
    for (const j of incoming.values()) j.cancelled = true;
  }

  function get() { const c = conf(); return { enabled: !!c.enabled, maxFileMB: c.maxFileMB, files: !!c.files }; }
  function set(patch) {
    const clean = {};
    if (patch && typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (patch && typeof patch.files === 'boolean') clean.files = patch.files;
    if (patch && Number.isInteger(patch.maxFileMB) && patch.maxFileMB >= 1 && patch.maxFileMB <= 4096) clean.maxFileMB = patch.maxFileMB;
    settings.patch('clipboard', clean);
    return get();
  }

  return {
    start, stop, get, set,
    history: () => items.map((x) => ({ ...x })),
    onItem(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    // for tests and main's diagnostics
    _offer: offer, _tick: tick, _cleanTemp: cleanTemp, _onOffer: onOffer,
  };
}

module.exports = { createFiles, CHUNK, MAX_FILES, TEMP_PREFIX, TEMP_TTL_MS };
