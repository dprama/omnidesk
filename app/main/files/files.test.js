// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFiles, TEMP_PREFIX, TEMP_TTL_MS } = require('./core');
const { sanitizeName, uniqueNames } = require('./names');
const { parseUriList, parseFileNameW, parseHDrop, fileUrlToPath } = require('./formats');
const { createPlatform, psCommand } = require('./platform');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `omnidesk-files-${p}-`));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Two fake peers wired together; tamper(type, payload) may rewrite replies.
function fakePeers(tamper = (t, v) => v) {
  const nodes = {};
  function make(id) {
    const handlers = new Map();
    const sent = [];
    const node = {
      id, sent,
      on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
      isConnected: () => true,
      async send(to, type, payload) { sent.push({ to, type, payload }); const h = nodes[to].handlers.get(type); if (h) h(id, JSON.parse(JSON.stringify(payload)), () => {}); },
      async request(to, type, payload) {
        const h = nodes[to].handlers.get(type);
        if (!h) throw Object.assign(new Error('no'), { code: 'no-handler' });
        const res = await h(id, JSON.parse(JSON.stringify(payload)));
        assert.ok(JSON.stringify(res).length < 1024 * 1024, 'reply fits one peer frame');
        return tamper(type, JSON.parse(JSON.stringify(res)));
      },
      handlers,
    };
    nodes[id] = node;
    return node;
  }
  return { a: make('devA'), b: make('devB') };
}

function fakeSettings(clip = {}) {
  let c = { enabled: true, maxFileMB: 100, files: true, ...clip };
  return { get: (k) => (k === 'clipboard' ? { ...c } : undefined), patch: (k, p) => { c = { ...c, ...p }; return c; } };
}
const fakeDevices = (other) => ({ list: () => [{ id: 'this', thisDevice: true }, { id: other, online: true, paired: true }], idForEngineName: () => null });
function fakeClip() {
  const writes = [];
  const clip = { writes, cur: { sig: '', paths: [] }, readFiles: async () => clip.cur, writeFiles: async (p) => { writes.push(p); } };
  return clip;
}

function pair({ clip = {}, chunkSize = 1024, tamper } = {}) {
  const { a, b } = fakePeers(tamper);
  const pa = fakeClip(); const pb = fakeClip();
  const tA = tmp('a'); const tB = tmp('b');
  const logs = [];
  const log = (m) => logs.push(m);
  const A = createFiles({ peer: a, devices: fakeDevices('devB'), settings: fakeSettings(clip), platform: pa, tempRoot: tA, chunkSize, log, retryDelayMs: 1 });
  const B = createFiles({ peer: b, devices: fakeDevices('devA'), settings: fakeSettings(clip), platform: pb, tempRoot: tB, chunkSize, log, retryDelayMs: 1 });
  A.start(); B.start();
  const done = () => new Promise((resolve) => { const off = B.onItem((it) => { if (it.to === 'this' && (it.progress === 1 || it.error)) { off(); resolve(it); } }); });
  const sent = () => new Promise((resolve) => { const off = A.onItem((it) => { if (it.from === 'this' && (it.progress === 1 || it.error)) { off(); resolve(it); } }); });
  return { a, b, A, B, pa, pb, tB, logs, done, sent, stop: () => { A.stop(); B.stop(); } };
}

test('names: traversal, reserved, control chars, length', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('..\\..\\Windows\\system32\\x.dll'), 'x.dll');
  assert.equal(sanitizeName('..'), 'file');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeName('com1.tar.gz'), '_com1.tar.gz');
  assert.equal(sanitizeName('console.txt'), 'console.txt');
  assert.equal(sanitizeName('a<b>:c"d|e?f*g\u0001.txt'), 'a_b__c_d_e_f_g_.txt');
  assert.equal(sanitizeName('report. . '), 'report');
  const long = sanitizeName('ü'.repeat(300) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 150 && long.endsWith('.pdf'));
  assert.deepEqual(uniqueNames(['a.txt', 'A.txt', 'x/a.txt', 'b']), ['a.txt', 'A (2).txt', 'a (3).txt', 'b']);
});

test('formats: uri-list, FileNameW, CF_HDROP fixtures', () => {
  assert.deepEqual(parseUriList('file:///tmp/a.txt\r\n# c\r\nfile:///tmp/b%20c%23.txt\r\nhttp://x/y', 'darwin'), ['/tmp/a.txt', '/tmp/b c#.txt']);
  assert.equal(fileUrlToPath('file:///C:/Users/me/r%C3%A9sum%C3%A9.pdf', 'win32'), 'C:\\Users\\me\\résumé.pdf');
  assert.equal(fileUrlToPath('file://server/share/a.txt', 'win32'), '\\\\server\\share\\a.txt');
  // FileNameW: UTF-16LE, NUL separated, double NUL terminated.
  const fnw = Buffer.concat([Buffer.from('C:\\Temp\\ä.txt\0D:\\b.bin\0\0', 'utf16le')]);
  assert.deepEqual(parseFileNameW(fnw), ['C:\\Temp\\ä.txt', 'D:\\b.bin']);
  assert.deepEqual(parseFileNameW(Buffer.from('C:\\one.txt', 'utf16le')), ['C:\\one.txt']); // no terminator
  // CF_HDROP: DROPFILES header (20 bytes) + wide list.
  const head = Buffer.alloc(20); head.writeUInt32LE(20, 0); head.writeUInt32LE(1, 16);
  assert.deepEqual(parseHDrop(Buffer.concat([head, Buffer.from('C:\\a.txt\0C:\\b c.txt\0\0', 'utf16le')])), ['C:\\a.txt', 'C:\\b c.txt']);
  const ansi = Buffer.alloc(20); ansi.writeUInt32LE(20, 0);
  assert.deepEqual(parseHDrop(Buffer.concat([ansi, Buffer.from('C:\\a.txt\0\0', 'latin1')])), ['C:\\a.txt']);
  assert.deepEqual(parseHDrop(Buffer.alloc(4)), []);
});

test('platform: reads uri-list, writes with JXA / PowerShell', async () => {
  const blob = (s) => ({ arrayBuffer: async () => new TextEncoder().encode(s).buffer });
  const clipboard = { read: async () => [{ types: ['text/uri-list'], getType: async () => blob('file:///tmp/a.txt\r\nfile:///tmp/b.txt') }] };
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, args]); return cmd === 'osascript' ? `ok ${args.length - 4}` : ''; };
  const mac = createPlatform({ clipboard, platform: 'darwin', exec });
  const r = await mac.readFiles();
  assert.deepEqual(r.paths, ['/tmp/a.txt', '/tmp/b.txt']);
  await mac.writeFiles(['/tmp/x y.txt', '/tmp/z']);
  assert.equal(calls[0][0], 'osascript');
  assert.deepEqual(calls[0][1].slice(-2), ['/tmp/x y.txt', '/tmp/z']);
  const win = createPlatform({ clipboard, platform: 'win32', exec });
  await win.writeFiles(["C:\\it's\\a.txt"]);
  const enc = calls[1][1][calls[1][1].length - 1];
  const script = Buffer.from(enc, 'base64').toString('utf16le');
  assert.match(script, /Set-Clipboard -LiteralPath \$p$/);
  assert.equal(Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)[1], 'base64').toString('utf8'), "C:\\it's\\a.txt");
  // Windows raw fallback when only FileNameW is offered.
  const fnwClip = { read: async () => [{ types: ['electron application/osclipboard;format="FileNameW"'], getType: async () => ({ arrayBuffer: async () => { const b = Buffer.from('C:\\q.txt\0\0', 'utf16le'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } }) }] };
  assert.deepEqual((await createPlatform({ clipboard: fnwClip, platform: 'win32', exec }).readFiles()).paths, ['C:\\q.txt']);
});

test('offer -> chunked pull -> hash verified -> files on receiver clipboard', async () => {
  const p = pair({ chunkSize: 1000 });
  const src = tmp('src');
  const big = crypto.randomBytes(3500); // 4 chunks, last one partial
  fs.writeFileSync(path.join(src, 'big.bin'), big);
  fs.writeFileSync(path.join(src, 'empty.txt'), '');
  fs.mkdirSync(path.join(src, 'folder'));
  const finished = p.done();
  const sent = p.sent();
  const id = await p.A._offer([path.join(src, 'big.bin'), path.join(src, 'empty.txt'), path.join(src, 'folder')]);
  const item = await finished;
  await sent;
  assert.equal(item.id, id);
  assert.equal(item.progress, 1);
  assert.equal(item.from, 'devA');
  assert.equal(item.bytes, 3500);
  assert.equal(item.name, 'big.bin and 1 more');
  const offerMsg = p.a.sent.find((m) => m.type === 'files.offer').payload;
  assert.deepEqual(offerMsg.skipped, [{ name: 'folder', why: 'folder' }]);
  assert.ok(!JSON.stringify(offerMsg).includes(src), 'no local paths in the offer');
  assert.equal(p.pb.writes.length, 1);
  const [got, empty] = p.pb.writes[0];
  assert.ok(got.startsWith(path.join(p.tB, TEMP_PREFIX + id)));
  assert.equal(sha(fs.readFileSync(got)), sha(big));
  assert.equal(fs.statSync(empty).size, 0);
  assert.equal(p.A.history()[0].progress, 1); // sender side saw all bytes served
  p.stop();
});

test('corrupted chunk fails the hash check, temp folder removed, clipboard untouched', async () => {
  const p = pair({ chunkSize: 1000, tamper: (type, v) => { if (type === 'files.chunk') { const b = Buffer.from(v.data, 'base64'); b[0] ^= 1; v.data = b.toString('base64'); } return v; } });
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'a.bin'), crypto.randomBytes(2500));
  const finished = p.done();
  const id = await p.A._offer([path.join(src, 'a.bin')]);
  const item = await finished;
  assert.equal(item.error, 'hash-mismatch');
  assert.equal(p.pb.writes.length, 0);
  assert.equal(fs.existsSync(path.join(p.tB, TEMP_PREFIX + id)), false);
  p.stop();
});

test('size caps: sender skips too-big files, receiver rejects oversize offers, max 20 files', async () => {
  const p = pair({ clip: { maxFileMB: 1 } });
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'small'), 'x');
  fs.writeFileSync(path.join(src, 'huge'), Buffer.alloc(1024 * 1024 + 1));
  const files = Array.from({ length: 22 }, (_, i) => { const f = path.join(src, `f${i}`); fs.writeFileSync(f, 'y'); return f; });
  const finished = p.done();
  await p.A._offer([path.join(src, 'huge'), path.join(src, 'small'), ...files]);
  await finished;
  const offer = p.a.sent.find((m) => m.type === 'files.offer').payload;
  assert.equal(offer.files.length, 20);
  assert.deepEqual(offer.skipped.map((s) => s.why), ['too-big', 'too-many', 'too-many', 'too-many']);
  // A lying sender: declared total above the receiver's cap -> ignored, nothing written.
  const before = p.B.history().length;
  p.B._onOffer('devA', { id: crypto.randomUUID(), files: [{ name: 'x', size: 2 * 1024 * 1024, sha256: '0'.repeat(64) }] });
  p.B._onOffer('devA', { id: '../../evil', files: [{ name: 'x', size: 1, sha256: '0'.repeat(64) }] });
  assert.equal(p.B.history().length, before);
  assert.ok(p.logs.some((l) => /rejected: too-big/.test(l)));
  p.stop();
});

test('chunk requests: only the offered device, only in range; files off = no offers', async () => {
  const p = pair();
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'a'), 'abc');
  const finished = p.done();
  const id = await p.A._offer([path.join(src, 'a')]);
  await finished;
  const chunk = p.a.handlers.get('files.chunk');
  await assert.rejects(() => chunk('devEvil', { id, file: 0, index: 0 }), { code: 'gone' });
  await assert.rejects(() => chunk('devB', { id, file: 1, index: 0 }), { code: 'bad-args' });
  await assert.rejects(() => chunk('devB', { id, file: 0, index: 5 }), { code: 'bad-args' });
  p.A.set({ files: false });
  assert.equal(await p.A._offer([path.join(src, 'a')]), null);
  p.stop();
});

test('clipboard poll: baseline first, offers on change, ignores received files', async () => {
  const { a, b } = fakePeers();
  void b;
  const tA = tmp('a');
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'n.txt'), 'n');
  let cur = { sig: 's0', paths: [path.join(src, 'n.txt')] };
  const A = createFiles({ peer: a, devices: fakeDevices('devB'), settings: fakeSettings(), platform: { readFiles: async () => cur, writeFiles: async () => {} }, tempRoot: tA, pollMs: 1e6 });
  await A._tick();
  assert.equal(a.sent.length, 0, 'what was on the clipboard at start is not offered');
  cur = { sig: 's1', paths: [path.join(src, 'n.txt')] };
  await A._tick();
  assert.equal(a.sent.filter((m) => m.type === 'files.offer').length, 1);
  await A._tick(); // unchanged
  assert.equal(a.sent.length, 1);
  cur = { sig: 's2', paths: [path.join(tA, `${TEMP_PREFIX}x`, 'n.txt')] };
  await A._tick();
  assert.equal(a.sent.length, 1, 'files we received are not sent back');
});

test('temp cleanup removes transfer folders older than 24 h', async () => {
  const root = tmp('clean');
  const old = path.join(root, `${TEMP_PREFIX}old`); fs.mkdirSync(old);
  const fresh = path.join(root, `${TEMP_PREFIX}new`); fs.mkdirSync(fresh);
  const other = path.join(root, 'keep'); fs.mkdirSync(other);
  const past = (Date.now() - TEMP_TTL_MS - 60000) / 1000;
  fs.utimesSync(old, past, past); fs.utimesSync(other, past, past);
  const F = createFiles({ peer: fakePeers().a, devices: fakeDevices('devB'), settings: fakeSettings(), platform: fakeClip(), tempRoot: root });
  await F._cleanTemp();
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
});

// Pulls the paths back out of the PowerShell script the way PowerShell would.
function psPaths(script) {
  const m = /^\$p = \[System\.Text\.Encoding\]::UTF8\.GetString\(\[System\.Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\) -split \[char\]10; Set-Clipboard -LiteralPath \$p$/.exec(script);
  assert.ok(m, 'fixed script shape, nothing from a path outside the base64 literal');
  return Buffer.from(m[1], 'base64').toString('utf8').split('\n');
}

test('regression: Set-Clipboard script cannot be broken by any quote in a path (PowerShell injection)', () => {
  // PowerShell ends '…' at ' and also at ‘ ’ ‚ ‛ (U+2018-U+201B): doubling only ' let these run code.
  const evil = [
    'C:\\T\\a\u2019;Start-Process calc;\u2019b.txt', "C:\\T\\it's.txt", 'C:\\T\\\u2018x\u201a\u201b".txt',
    'C:\\T\\$(calc) `n @x.txt', 'C:\\T\\[a]*?.txt', '\\\\server\\share\\with space\\é.pdf',
  ];
  const script = psCommand(evil);
  for (const ch of ['\u2018', '\u2019', '\u201a', '\u201b', 'calc', '$(', '`']) assert.ok(!script.includes(ch), `script contains ${ch}`);
  assert.deepEqual(psPaths(script), evil);
  assert.deepEqual(psPaths(psCommand(['C:\\one.txt'])), ['C:\\one.txt']);
});

test('regression: long names are cut to <= 150 bytes and never end in a dot or space', () => {
  for (const raw of ['a'.repeat(140) + '. . .' + 'b'.repeat(40), 'x'.repeat(149) + ' ' + 'y'.repeat(30) + '.docx', '日本'.repeat(80), 'é'.normalize('NFD').repeat(100) + '.txt']) {
    const n = sanitizeName(raw);
    assert.ok(Buffer.byteLength(n) <= 150, n);
    assert.ok(!/[. ]$/.test(n), JSON.stringify(n));
    assert.equal(n, n.normalize('NFC'));
  }
  assert.equal(sanitizeName('AUX. .'), '_AUX');
  assert.equal(sanitizeName('lpt¹ .txt'), '_lpt¹ .txt');
});

test('platform: blank clipboard (engine emptied it) is reported, Deskflow ownership marker ignored', async () => {
  const exec = async () => '';
  const empty = { read: async () => [{ types: [] }] };
  assert.equal((await createPlatform({ clipboard: empty, platform: 'darwin', exec }).readFiles()).blank, true);
  const owned = { read: async () => [{ types: ['electron application/osclipboard;format="Deskflow Ownership"'] }] };
  assert.equal((await createPlatform({ clipboard: owned, platform: 'win32', exec }).readFiles()).blank, true);
  const text = { read: async () => [{ types: ['text/plain'] }] };
  assert.equal((await createPlatform({ clipboard: text, platform: 'darwin', exec }).readFiles()).blank, false);
});

test('regression: platform write errors carry no stderr (it can hold paths)', async () => {
  const { _run } = require('./platform');
  await assert.rejects(() => _run(process.execPath, ['-e', 'process.stderr.write("Cannot find C:/Secret Plan.pdf"); process.exit(3)']),
    (e) => e.code === 'clipboard-write' && /exit 3/.test(e.message) && !/Secret/.test(e.message));
});

test('regression: turning the clipboard off mid-transfer stops it on both sides', async () => {
  let n = 0;
  let p;
  p = pair({ chunkSize: 1000, tamper: (type, v) => { if (type === 'files.chunk' && ++n === 1) p.A.set({ enabled: false }); return v; } });
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'a.bin'), crypto.randomBytes(5000));
  const finished = p.done();
  const id = await p.A._offer([path.join(src, 'a.bin')]);
  const item = await finished;
  assert.equal(item.error, 'off');
  assert.equal(p.pb.writes.length, 0, 'nothing put on the receiver clipboard');
  assert.equal(fs.existsSync(path.join(p.tB, TEMP_PREFIX + id)), false);
  assert.equal(n, 1, 'no chunk served after it was turned off');
  await assert.rejects(() => p.a.handlers.get('files.chunk')('devB', { id, file: 0, index: 1 }), { code: 'off' });
  p.stop();
});

test('regression: receiver turned off mid-transfer stops pulling and places nothing', async () => {
  let n = 0;
  let p;
  p = pair({ chunkSize: 1000, tamper: (type, v) => { if (type === 'files.chunk' && ++n === 2) p.B.set({ files: false }); return v; } });
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'a.bin'), crypto.randomBytes(5000));
  const finished = p.done();
  await p.A._offer([path.join(src, 'a.bin')]);
  assert.equal((await finished).error, 'off');
  assert.equal(n, 2);
  assert.equal(p.pb.writes.length, 0);
  p.stop();
});

test('regression: the sender history reflects how the receiver ended (done, refused, failed, unreachable)', async () => {
  const p = pair({ chunkSize: 1000 });
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'a.bin'), crypto.randomBytes(100));
  let s = p.sent();
  await p.A._offer([path.join(src, 'a.bin')]);
  assert.equal((await s).progress, 1);
  // receiver has file sharing off: sender must not sit at "sending 0%"
  p.B.set({ files: false });
  s = p.sent();
  await p.A._offer([path.join(src, 'a.bin')]);
  assert.equal((await s).error, 'off');
  p.stop();
  // corrupted -> sender sees hash-mismatch
  const q = pair({ chunkSize: 1000, tamper: (type, v) => { if (type === 'files.chunk') v.data = Buffer.alloc(100, 1).toString('base64'); return v; } });
  s = q.sent();
  await q.A._offer([path.join(src, 'a.bin')]);
  assert.equal((await s).error, 'hash-mismatch');
  q.stop();
  // nobody reachable: offer fails -> error offline
  const { a } = fakePeers();
  a.send = async () => { throw Object.assign(new Error('x'), { code: 'offline' }); };
  const F = createFiles({ peer: a, devices: fakeDevices('devB'), settings: fakeSettings(), platform: fakeClip(), tempRoot: tmp('o') });
  await F._offer([path.join(src, 'a.bin')]);
  assert.equal(F.history()[0].error, 'offline');
});

test('regression: logs never contain file names (clipboard content)', async () => {
  const p = pair({ chunkSize: 1000, clip: { maxFileMB: 1 }, tamper: (type, v) => { if (type === 'files.chunk') v.data = Buffer.alloc(100, 1).toString('base64'); return v; } });
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'Secret Divorce Plan.bin'), crypto.randomBytes(100));
  fs.writeFileSync(path.join(src, 'Payroll 2026.xlsx'), Buffer.alloc(1024 * 1024 + 1));
  fs.mkdirSync(path.join(src, 'Private Folder'));
  const finished = p.done();
  await p.A._offer([path.join(src, 'Secret Divorce Plan.bin'), path.join(src, 'Payroll 2026.xlsx'), path.join(src, 'Private Folder')]);
  assert.equal((await finished).error, 'hash-mismatch');
  const all = p.logs.join('\n');
  assert.ok(all.length > 0);
  for (const w of ['Secret', 'Payroll', 'Private', src]) assert.ok(!all.includes(w), `log mentions ${w}: ${all}`);
  assert.match(all, /skipped 1 too-big, 1 folder/);
  p.stop();
});

test('regression: latest copy wins - files copied here during a transfer are not overwritten', async () => {
  let p;
  const src = tmp('src');
  fs.writeFileSync(path.join(src, 'remote.bin'), crypto.randomBytes(3000));
  fs.writeFileSync(path.join(src, 'local.txt'), 'mine');
  let n = 0;
  const changes = [{ sig: 'local', paths: [path.join(src, 'local.txt')] }, { sig: 'engine-text', paths: [] }, { sig: '\n', paths: [], blank: true }];
  p = pair({ chunkSize: 1000, tamper: (type, v) => { if (type === 'files.chunk' && ++n === 2) p.pb.cur = changes.shift(); return v; } });
  await p.B._tick(); // baseline
  const finished = p.done();
  await p.A._offer([path.join(src, 'remote.bin')]);
  assert.equal((await finished).error, 'superseded');
  assert.equal(p.pb.writes.length, 0, 'the newer local copy stays on the clipboard');
  // but the engine putting text (the Finder copy's file name) or emptying the clipboard does not count
  n = 0;
  const again = p.done();
  await p.A._offer([path.join(src, 'remote.bin')]);
  const it = await again;
  assert.equal(it.error, undefined);
  assert.equal(it.progress, 1);
  assert.equal(p.pb.writes.length, 1);
  p.stop();
});

test('regression: an emptied clipboard gets the files back (engine clears it on cursor entry)', async () => {
  const p = pair({ chunkSize: 1000 });
  const src = tmp('src');
  const f = path.join(src, 'a.bin');
  fs.writeFileSync(f, crypto.randomBytes(1500));
  await p.A._tick(); await p.B._tick(); // baselines
  // A: the user copies a file -> offered; B receives and places it
  p.pa.cur = { sig: 'files-a', paths: [f] };
  const finished = p.done();
  await p.A._tick();
  await finished;
  assert.equal(p.pb.writes.length, 1);
  const placed = p.pb.writes[0];
  p.pb.cur = { sig: 'received', paths: placed };
  await p.B._tick();
  // the engine empties B's clipboard when the cursor enters B -> put back
  p.pb.cur = { sig: '\n', paths: [], blank: true };
  await p.B._tick();
  assert.equal(p.pb.writes.length, 2);
  assert.deepEqual(p.pb.writes[1], placed);
  // ...and A's (sender) clipboard emptied by the engine's grab -> its own copy is put back, not re-offered
  const offers = () => p.a.sent.filter((m) => m.type === 'files.offer').length;
  const o = offers();
  p.pa.cur = { sig: '\n', paths: [], blank: true };
  await p.A._tick();
  assert.deepEqual(p.pa.writes.at(-1), [f]);
  p.pa.cur = { sig: 'files-a-restored', paths: [f] };
  await p.A._tick();
  assert.equal(offers(), o, 'restoring is not a new copy');
  // something new copied on B (text) -> no more restoring there
  p.pb.cur = { sig: 'text', paths: [] };
  await p.B._tick();
  p.pb.cur = { sig: '\n2', paths: [], blank: true };
  await p.B._tick();
  assert.equal(p.pb.writes.length, 2);
  // clipboard off -> no restoring on A either
  p.A.set({ enabled: false });
  p.pa.cur = { sig: '\n3', paths: [], blank: true };
  const w = p.pa.writes.length;
  await new Promise((r) => setTimeout(r, 1100));
  await p.A._tick();
  assert.equal(p.pa.writes.length, w);
  p.stop();
});
