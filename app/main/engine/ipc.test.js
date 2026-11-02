// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { CoreIpcClient, splitLines, parseMessage, formatMessage } = require('./ipc');

test('splitLines keeps partial tail and strips CR', () => {
  assert.deepEqual(splitLines('a\nb=1\r\npart'), [['a', 'b=1'], 'part']);
  assert.deepEqual(splitLines('no newline'), [[], 'no newline']);
});

test('parseMessage / formatMessage', () => {
  assert.deepEqual(parseMessage('hello=1.25.0+abc'), { command: 'hello', value: '1.25.0+abc' });
  assert.deepEqual(parseMessage('bye'), { command: 'bye', value: '' });
  assert.deepEqual(parseMessage('x=a=b'), { command: 'x', value: 'a=b' });
  assert.equal(formatMessage('noop'), 'noop\n');
  assert.equal(formatMessage('clipboard', 'on'), 'clipboard=on\n');
  assert.throws(() => formatMessage('bad cmd'));
  assert.throws(() => formatMessage('x', 'a\nb'));
});

function sockPath(name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\omnidesk-test-${process.pid}-${name}`;
  const p = path.join(os.tmpdir(), `odt-${process.pid}-${name}.sock`);
  try { fs.unlinkSync(p); } catch { /* none */ }
  return p;
}

// Fake engine: answers hello like IpcServer.cpp, splits writes into odd chunks.
function fakeEngine(p, { version = '1.25.0+abc1234', onLine } = {}) {
  const clients = new Set();
  const server = net.createServer((s) => {
    clients.add(s);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (onLine) onLine(line, s);
        const [cmd, val] = line.split('=');
        if (cmd === 'hello') {
          if (!val) { s.end('error=missing version\n'); continue; }
          if (val !== version) { s.write(`versionMismatch=${version}\n`); continue; }
          // reply + replay a queued message, written in two fragments
          s.write(`hello=${version}\nconnectionSt`);
          setTimeout(() => s.write('ate=Listening\n'), 20);
        } else if (cmd === 'noop') s.write('ok\n');
      }
    });
    s.on('close', () => clients.delete(s));
  });
  return new Promise((r) => server.listen(p, () => r({ server, clients })));
}

const once = (em, ev) => new Promise((r) => em.once(ev, (...a) => r(a)));

test('handshake, fragmented replay, send, noop', async () => {
  const p = sockPath('a');
  const lines = [];
  const { server } = await fakeEngine(p, { onLine: (l) => lines.push(l) });
  const c = new CoreIpcClient({ path: p, version: '1.25.0+abc1234', retryMs: 50, keepAliveMs: 0 });
  const connected = once(c, 'connected');
  const state = once(c, 'connectionState');
  c.start();
  const [info] = await connected;
  assert.equal(info.matched, true);
  assert.deepEqual(await state, ['Listening']);
  const okMsg = once(c, 'message');
  await c.noop();
  assert.deepEqual(await okMsg, ['ok', '']);
  await c.send('clipboard', 'off');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lines, ['hello=1.25.0+abc1234', 'noop', 'clipboard=off']);
  c.stop();
  server.close();
});

test('version mismatch still connects', async () => {
  const p = sockPath('b');
  const { server } = await fakeEngine(p);
  const c = new CoreIpcClient({ path: p, version: '1.25.0', retryMs: 50, keepAliveMs: 0 });
  const mm = once(c, 'versionMismatch');
  c.start();
  assert.deepEqual(await mm, ['1.25.0+abc1234']);
  assert.equal(c.connected, true);
  c.stop();
  server.close();
});

test('send rejects when not connected', async () => {
  const c = new CoreIpcClient({ path: sockPath('none') });
  await assert.rejects(c.send('noop'), { code: 'engine-offline' });
});

test('reconnects after the engine goes away and comes back', async () => {
  const p = sockPath('c');
  let eng = await fakeEngine(p);
  const c = new CoreIpcClient({ path: p, version: '1.25.0+abc1234', retryMs: 50, keepAliveMs: 0 });
  c.start();
  await once(c, 'connected');
  const gone = once(c, 'disconnected');
  for (const s of eng.clients) s.end('bye\n');
  eng.server.close();
  await gone;
  assert.equal(c.connected, false);
  eng = await fakeEngine(p);
  await once(c, 'connected');
  assert.equal(c.connected, true);
  c.stop();
  eng.server.close();
});

test('--ipc-version output is trimmed and queries may end in ?', () => {
  const { parseIpcVersion } = require('./supervisor');
  assert.equal(parseIpcVersion('1.25.0+abc1234\r\n\n'), '1.25.0+abc1234');
  assert.equal(parseIpcVersion('\nqt.qpa: warning\n1.25.0+abc1234\n'), '1.25.0+abc1234');
  assert.equal(parseIpcVersion('deskflow v1.25.0, protocol v1.8'), null);
  const { formatMessage } = require('./ipc');
  assert.equal(formatMessage('monitors?'), 'monitors?\n');
  assert.throws(() => formatMessage('mon?itors'));
});

test('dev engine env adds the Qt framework path on macOS only', () => {
  const { engineEnv } = require('./supervisor');
  const yes = () => true;
  assert.equal(engineEnv({ isPackaged: false, platform: 'darwin', env: { OMNIDESK_QT_LIB: '/q' }, exists: yes }).DYLD_FRAMEWORK_PATH, '/q');
  assert.equal(engineEnv({ isPackaged: true, platform: 'darwin', env: {}, exists: yes }).DYLD_FRAMEWORK_PATH, undefined);
  assert.equal(engineEnv({ isPackaged: false, platform: 'win32', env: {}, exists: yes }).DYLD_FRAMEWORK_PATH, undefined);
});
