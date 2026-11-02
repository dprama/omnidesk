// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Windows VDD control module against a temp dir. The scheduled task is faked:
// it reads request.json and writes status.json exactly like vdd-task.ps1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVdd, encodePipeCommand, validMode } = require('./windows-vdd');

function tempRoot({ installed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnidesk-vdd-'));
  fs.mkdirSync(path.join(root, 'request'));
  fs.mkdirSync(path.join(root, 'status'));
  if (installed) fs.writeFileSync(path.join(root, 'installed.json'), JSON.stringify({ version: '25.7.23', instanceId: 'ROOT\\DISPLAY\\0000' }));
  return root;
}

function fakeTask(root, { fail = null, delay = 5, answer = true } = {}) {
  const calls = [];
  const run = async () => {
    const req = JSON.parse(fs.readFileSync(path.join(root, 'request', 'request.json'), 'utf8'));
    calls.push(req);
    if (!answer) return;
    setTimeout(() => fs.writeFileSync(path.join(root, 'status', 'status.json'),
      JSON.stringify({ nonce: req.nonce, ok: !fail, error: fail, state: fail ? 'error' : req.action })), delay);
  };
  return { run, calls };
}

test('installed() reads the marker', () => {
  assert.equal(createVdd({ root: tempRoot() }).installed().installed, true);
  const st = createVdd({ root: tempRoot({ installed: false }) }).installed();
  assert.equal(st.installed, false);
  assert.match(st.why, /not installed/);
});

test('enable writes a validated request and waits for the matching answer', async () => {
  const root = tempRoot();
  const task = fakeTask(root);
  const vdd = createVdd({ root, runTask: task.run, pollMs: 5, timeoutMs: 1000 });
  const st = await vdd.enable({ width: 2560, height: 1600, refresh: 60 });
  assert.equal(st.ok, true);
  assert.equal(task.calls.length, 1);
  const req = task.calls[0];
  assert.match(req.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...req, nonce: 'x' }, { nonce: 'x', action: 'on', width: 2560, height: 1600, refresh: 60 });
  await vdd.disable();
  assert.deepEqual(Object.keys(task.calls[1]).sort(), ['action', 'nonce']);
  assert.equal(task.calls[1].action, 'off');
  assert.equal(fs.readdirSync(path.join(root, 'request')).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left');
});

test('a stale status.json from an earlier run is ignored', async () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'status', 'status.json'), JSON.stringify({ nonce: 'old', ok: true }));
  const task = fakeTask(root, { delay: 40 });
  const vdd = createVdd({ root, runTask: task.run, pollMs: 5, timeoutMs: 1000 });
  const t0 = Date.now();
  await vdd.enable({ width: 1920, height: 1080, refresh: 60 });
  assert.ok(Date.now() - t0 >= 30);
});

test('errors: task failure, driver missing, timeout, bad mode', async () => {
  let root = tempRoot();
  await assert.rejects(createVdd({ root, runTask: fakeTask(root, { fail: 'device status Error' }).run, pollMs: 5 }).enable({ width: 1920, height: 1080, refresh: 60 }), { code: 'vdd-failed', message: /device status Error/ });
  root = tempRoot();
  await assert.rejects(createVdd({ root, runTask: fakeTask(root, { fail: 'driver-missing' }).run, pollMs: 5 }).enable({ width: 1920, height: 1080, refresh: 60 }), { code: 'vdd-failed', message: /missing/ });
  root = tempRoot();
  await assert.rejects(createVdd({ root, runTask: fakeTask(root, { answer: false }).run, pollMs: 5, timeoutMs: 60 }).disable(), { code: 'vdd-timeout' });
  await assert.rejects(createVdd({ root }).enable({ width: 100, height: 100, refresh: 60 }), { code: 'bad-args' });
  assert.equal(validMode({ width: 1920, height: 1080, refresh: 60.5 }), false);
});

test('requests are serialised (never two task runs at once)', async () => {
  const root = tempRoot();
  let running = 0; let maxRunning = 0;
  const inner = fakeTask(root, { delay: 15 });
  const vdd = createVdd({
    root, pollMs: 2, timeoutMs: 1000,
    runTask: async () => { running++; maxRunning = Math.max(maxRunning, running); await inner.run(); setTimeout(() => running--, 10); },
  });
  await Promise.all([vdd.enable({ width: 1920, height: 1080, refresh: 60 }), vdd.disable(), vdd.enable({ width: 2560, height: 1600, refresh: 60 })]);
  assert.deepEqual(inner.calls.map((c) => c.action), ['on', 'off', 'on']);
  assert.equal(maxRunning, 1);
});

test('driver pipe commands are UTF-16LE and allowlisted', () => {
  assert.deepEqual(encodePipeCommand('PING'), Buffer.from([0x50, 0, 0x49, 0, 0x4e, 0, 0x47, 0]));
  assert.equal(encodePipeCommand('SETDISPLAYCOUNT 1').toString('utf16le'), 'SETDISPLAYCOUNT 1');
  assert.throws(() => encodePipeCommand('ping'));
  assert.throws(() => encodePipeCommand('SETGPU "x"; rm'));
});

test('pipeCommand talks to a pipe/socket server', async () => {
  const net = require('node:net');
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vddp-')), 'p.sock');
  let got = null;
  const srv = net.createServer((c) => c.on('data', (d) => { got = d.toString('utf16le'); c.end('PONG'); }));
  await new Promise((r) => srv.listen(sock, r));
  const reply = await createVdd({ root: tempRoot(), pipePath: sock }).pipeCommand('PING');
  srv.close();
  assert.equal(got, 'PING');
  assert.equal(reply, 'PONG');
});

test('regression: install-vdd.ps1 checks the same pinned SHA-256 as fetch.mjs before pnputil', async () => {
  const native = path.join(__dirname, '..', '..', '..', 'native', 'windows-vdd');
  const { PIN } = await import(require('node:url').pathToFileURL(path.join(native, 'fetch.mjs')).href);
  const ps = fs.readFileSync(path.join(native, 'install-vdd.ps1'), 'utf8');
  for (const name of ['MttVDD.dll', 'MttVDD.inf', 'mttvdd.cat']) {
    assert.ok(ps.includes(`'${name}' = '${PIN.files[name]}'`), `${name} pinned in install-vdd.ps1`);
  }
  assert.ok(ps.indexOf('Get-FileHash') < ps.indexOf('pnputil.exe /add-driver'), 'hashes are checked before the driver is added');
});
