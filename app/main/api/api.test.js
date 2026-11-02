// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIssueUrl } = require('./feedback');
const { parsePmset, parseCim } = require('./system');
const { checkArgs, isTrustedSender, t } = require('../router');
const { isAllowedExternal, resolveAppUrl } = require('../security');

test('feedback URL: system info only when asked', () => {
  const info = { os: 'windows', osVersion: '11', arch: 'x64', appVersion: '2.5.0', engineVersion: '1.25.0', monitors: [{ x: 0, y: 0, w: 2560, h: 1440 }], devices: 1 };
  const a = new URL(buildIssueUrl({ repoUrl: 'https://github.com/dprama/omnidesk', kind: 'bug', message: 'Cursor sticks\nmore', includeSystemInfo: false, systemInfo: info }));
  assert.equal(a.origin + a.pathname, 'https://github.com/dprama/omnidesk/issues/new');
  assert.equal(a.searchParams.get('title'), '[Bug] Cursor sticks');
  assert.equal(a.searchParams.get('labels'), 'bug');
  assert.equal(a.searchParams.get('body'), 'Cursor sticks\nmore');
  const b = new URL(buildIssueUrl({ repoUrl: 'https://github.com/dprama/omnidesk/', kind: 'idea', message: 'x', includeSystemInfo: true, systemInfo: info }));
  assert.match(b.searchParams.get('body'), /Monitors: \[0,0,2560x1440\]/);
  assert.throws(() => buildIssueUrl({ repoUrl: 'http://evil.example', kind: 'bug', message: 'x' }));
  const long = buildIssueUrl({ kind: 'thanks', message: 'é'.repeat(5000), includeSystemInfo: false });
  assert.ok(long.length <= 7600);
});

test('battery parsers', () => {
  assert.deepEqual(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t87%; discharging; 4:10 remaining present: true"), { percent: 87, charging: false });
  assert.deepEqual(parsePmset(" -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining"), { percent: 100, charging: true });
  assert.equal(parsePmset("Now drawing from 'AC Power'"), null);
  assert.deepEqual(parseCim('{"EstimatedChargeRemaining":55,"BatteryStatus":1}'), { percent: 55, charging: false });
  assert.equal(parseCim(''), null);
});

test('router arg checks and sender check', () => {
  const spec = [t.obj({ enabled: t.bool, cooldownMs: t.int(0, 5000) }, { partial: true })];
  assert.ok(checkArgs(spec, [{ cooldownMs: 300 }]));
  assert.ok(!checkArgs(spec, [{ cooldownMs: '300' }]));
  assert.ok(!checkArgs(spec, [{ other: 1 }]));
  assert.ok(!checkArgs(spec, [{}, 'extra']));
  assert.ok(checkArgs([t.optional(t.int(1, 10))], []));
  assert.ok(isTrustedSender({ senderFrame: { url: 'app://omnidesk/index.html' } }));
  assert.ok(!isTrustedSender({ senderFrame: { url: 'https://omnidesk/index.html' } }));
  assert.ok(!isTrustedSender({ senderFrame: { url: 'app://evil/index.html' } }));
  assert.ok(!isTrustedSender({}));
});

test('external links and app:// path resolution', () => {
  const hosts = ['github.com', 'dprama.github.io'];
  assert.ok(isAllowedExternal('https://github.com/dprama/omnidesk', hosts));
  assert.ok(!isAllowedExternal('http://github.com/', hosts));
  assert.ok(!isAllowedExternal('https://github.com.evil.io/', hosts));
  assert.ok(!isAllowedExternal('https://user:pw@github.com/', hosts));
  assert.ok(!isAllowedExternal('file:///etc/passwd', hosts));
  const root = '/r/renderer';
  assert.equal(resolveAppUrl(root, 'app://omnidesk/'), '/r/renderer/index.html');
  assert.equal(resolveAppUrl(root, 'app://omnidesk/shell/main.js'), '/r/renderer/shell/main.js');
  assert.equal(resolveAppUrl(root, 'app://omnidesk/../../etc/passwd'), '/r/renderer/etc/passwd');
  assert.equal(resolveAppUrl(root, 'app://omnidesk/%2e%2e/%2e%2e/etc/passwd'), '/r/renderer/etc/passwd');
  assert.equal(resolveAppUrl(root, 'app://other/index.html'), null);
});
