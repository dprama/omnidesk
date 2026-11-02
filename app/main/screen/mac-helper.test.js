// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Runs the real Swift helper on macOS when it has been built
// (native/macos-virtual-display/build.sh); skipped elsewhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createMacHelper, defaultHelperPath } = require('./mac-helper');

const helper = createMacHelper({ helperPath: defaultHelperPath() });
const skip = process.platform !== 'darwin' ? 'macOS only' : !helper.available() ? 'helper not built' : false;

// Ask CoreGraphics directly (via JXA), not the helper.
function cg(expr) {
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import("CoreGraphics"); ${expr}`]).toString());
}
const onlineCount = () => cg('const n = Ref(); $.CGGetOnlineDisplayList(32, null, n); JSON.stringify(n[0])');
const isOnline = (id) => cg(`JSON.stringify(!!$.CGDisplayIsOnline(${Number(id)}))`);

test('helper creates a display and removes it again', { skip, timeout: 30000 }, async () => {
  const before = onlineCount();
  const d = await helper.create({ width: 1920, height: 1080, refresh: 60 });
  let during;
  try {
    assert.match(d.displayId, /^\d+$/);
    during = onlineCount();
    assert.ok(isOnline(d.displayId), `display ${d.displayId} online`);
  } finally {
    await d.remove();
  }
  await new Promise((r) => setTimeout(r, 500));
  const after = onlineCount();
  console.log(`# online displays before=${before} during=${during} after=${after}`);
  assert.equal(during, before + 1);
  assert.equal(after, before);
  assert.equal(isOnline(d.displayId), false);
});

test('helper rejects bad arguments', { skip }, async () => {
  await assert.rejects(helper.create({ width: 10, height: 10, refresh: 60 }), { code: 'helper-failed' });
});

test('regression: the helper dying (crash/kill) is reported through onExit and the display is gone', { skip, timeout: 30000 }, async () => {
  const before = onlineCount();
  const d = await helper.create({ width: 1920, height: 1080, refresh: 60 });
  const exited = new Promise((r) => d.onExit(r));
  helper.killAll(); // what process exit does; also stands in for a crash
  await exited;
  for (let i = 0; i < 50 && isOnline(d.displayId); i++) await new Promise((r) => setTimeout(r, 100)); // WindowServer can take a moment
  assert.equal(isOnline(d.displayId), false);
  assert.equal(onlineCount(), before);
  await d.remove(); // safe after the helper is gone
});
