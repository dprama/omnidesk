// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDecision, parseStart, NO_CROSS, CROSS, START } = require('./decisions');

// Lines captured from the engine: the bodies come from omnidesk::log::formatCross /
// formatNoCross (engine/src/lib/base/OmniDeskLog.h), the prefix from base/Log.cpp
// ("[<ISO time with ms>] INFO: "). The start line is verbatim from a deskflow-core run.
const REAL = [
  '[2026-11-01T19:38:29.482] INFO: start mode=client helper=/Users/dp/Documents/Projects/omnidesk/engine/build/bin/Deskflow.app/Contents/MacOS/deskflow-core version=1.27.0.21+2877600f pid=94200',
  '[2026-11-01T19:40:01.120] INFO: cross edge=right pos=(4479,640) to=MacBook-Pro cooldown=250ms',
  '[2026-11-01T19:40:02.007] INFO: cross edge=left pos=(-1920,300) to=Studio Mac cooldown=250ms',
  '[2026-11-01T19:40:03.500] INFO: no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[0,0,2560x1440][2560,180,1920x1080]',
  '[2026-11-01T19:40:05.501] INFO: no-cross reason=cooldown edge=top pos=(-1000,-200) monitors=[-1920,-200,1920x1080][0,0,2560x1440] remaining=120ms',
  '[2026-11-01T19:40:07.502] INFO: no-cross reason=button-held edge=left pos=(-1920,0) monitors=[-1920,-200,1920x1080][0,0,2560x1440]',
  '[2026-11-01T19:40:09.503] INFO: no-cross reason=outside-zone edge=right pos=(2559,100) monitors=[0,0,2560x1440][2560,180,1920x1080]',
];

test('cross line from the engine log', () => {
  const d = parseDecision(REAL[1]);
  assert.equal(d.line, '19:40:01 cross edge=right pos=(4479,640) to=MacBook-Pro cooldown=250ms');
  assert.equal(d.kind, 'cross');
  assert.equal(d.fields.to, 'MacBook-Pro');
  assert.equal(d.fields.cooldown, '250ms');
  assert.deepEqual(d.pos, { x: 4479, y: 640 });
});

test('cross to a computer name with a space keeps the whole name', () => {
  const d = parseDecision(REAL[2]);
  assert.equal(d.fields.to, 'Studio Mac');
  assert.deepEqual(d.pos, { x: -1920, y: 300 });
});

test('no-cross lines keep monitors verbatim, negative coordinates and remaining', () => {
  const a = parseDecision(REAL[3]);
  assert.equal(a.line, '19:40:03 no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[0,0,2560x1440][2560,180,1920x1080]');
  assert.equal(a.fields.reason, 'not-outer-edge');
  assert.equal(a.fields.monitors, '[0,0,2560x1440][2560,180,1920x1080]');
  assert.deepEqual(a.fields.monitorRects, [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }]);

  const c = parseDecision(REAL[4]);
  assert.equal(c.fields.reason, 'cooldown');
  assert.equal(c.fields.remaining, '120ms');
  assert.deepEqual(c.pos, { x: -1000, y: -200 });
  assert.deepEqual(c.fields.monitorRects[0], { x: -1920, y: -200, w: 1920, h: 1080 });
  assert.equal(c.line, '19:40:05 no-cross reason=cooldown edge=top pos=(-1000,-200) monitors=[-1920,-200,1920x1080][0,0,2560x1440] remaining=120ms');

  assert.equal(parseDecision(REAL[5]).fields.reason, 'button-held');
  assert.equal(parseDecision(REAL[5]).fields.remaining, undefined);
  assert.equal(parseDecision(REAL[6]).fields.reason, 'outside-zone');
});

test('every real engine line matches exactly one documented pattern', () => {
  for (const raw of REAL) {
    const body = raw.replace(/^\[[^\]]*\] INFO: /, '');
    const hits = [NO_CROSS, CROSS, START].filter((re) => re.test(body));
    assert.equal(hits.length, 1, body);
  }
});

test('the patterns are the ones documented in the engine header', () => {
  const header = path.join(__dirname, '..', '..', '..', 'engine', 'src', 'lib', 'base', 'OmniDeskLog.h');
  if (!fs.existsSync(header)) return; // app checked out without the engine
  const text = fs.readFileSync(header, 'utf8').replace(/\n \*\s*/g, '');
  for (const re of [NO_CROSS, CROSS, START]) assert.ok(text.includes(re.source), `OmniDeskLog.h documents ${re.source}`);
});

test('start line: mode and helper', () => {
  const s = parseStart(REAL[0]);
  assert.equal(s.mode, 'client');
  assert.match(s.helper, /deskflow-core$/);
  assert.equal(s.version, '1.27.0.21+2877600f');
  assert.equal(s.pid, 94200);
  const win = parseStart('[2026-11-01T19:38:29.482] INFO: start mode=server helper=C:\\Program Files\\OmniDesk\\deskflow-core.exe version=1.27.0.21+2877600f pid=4242');
  assert.equal(win.helper, 'C:\\Program Files\\OmniDesk\\deskflow-core.exe');
  assert.equal(parseStart(REAL[1]), null);
});

test('unrelated and malformed lines are ignored; missing timestamp uses local time', () => {
  assert.equal(parseDecision('[x] INFO: client "mac" has connected'), null);
  assert.equal(parseDecision('accross the board'), null);
  // debug builds put file:line on the next line
  assert.equal(parseDecision('\t/src/lib/server/Server.cpp:975'), null);
  // a reason the engine never writes, or no monitors
  assert.equal(parseDecision('no-cross reason=because edge=left pos=(0,10) monitors=[0,0,10x10]'), null);
  assert.equal(parseDecision('no-cross reason=cooldown edge=left pos=(0,10)'), null);
  const d = parseDecision('no-cross reason=cooldown edge=left pos=(0,10) monitors=[0,0,1920x1080] remaining=5ms', new Date(2026, 0, 1, 9, 5, 7));
  assert.equal(d.line, '09:05:07 no-cross reason=cooldown edge=left pos=(0,10) monitors=[0,0,1920x1080] remaining=5ms');
});
