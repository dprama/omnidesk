// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
const test = require('node:test');
const assert = require('node:assert');
const { reasonFromLine } = require('./supervisor');

test('real engine failure lines map to plain reasons', () => {
  const ax = '[2026-11-02T00:01:18.012] FATAL: assistive devices does not trust this process, allow OmniDesk in System Settings > Privacy & Security > Accessibility.';
  assert.match(reasonFromLine(ax), /Accessibility and turn on OmniDesk/);
  assert.match(reasonFromLine('[x] ERROR: failed to create quartz event tap'), /Input Monitoring/);
  assert.match(reasonFromLine('[2026-11-02T00:01:18.012] FATAL: a display invalid exception error occurred: failed to initialize computer shape'), /screen is asleep/);
  assert.strictEqual(reasonFromLine('[x] INFO: start mode=server helper=/a version=1+2 pid=3'), null);
});
