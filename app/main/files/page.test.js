// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Pure helpers of the Clipboard page (renderer/pages/clipboard.js), which shows the items
// this module emits. Lives here because the page has no test folder of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const page = () => import(pathToFileURL(path.join(__dirname, '../../renderer/pages/clipboard.js')).href);

test('regression: page reads ClipItem.at as epoch ms (main) and ISO (mock)', async () => {
  const { ago, atMs } = await page();
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  // main sends epoch ms; Date.parse(number) is NaN, which left "Last shared" blank and the list unsorted
  assert.equal(ago(now - 5 * 60000, now), '5 min ago');
  assert.equal(ago(String(now - 3 * 3600000), now), '3 h ago');
  assert.equal(ago(new Date(now - 10000).toISOString(), now), 'just now');
  assert.equal(atMs(now), now);
  assert.ok(Number.isNaN(atMs(undefined)));
});

test('regression: page explains failed transfers instead of "sending NN%" forever', async () => {
  const { errorText } = await page();
  assert.match(errorText('off', true), /off on the other computer/);
  assert.match(errorText('off', false), /file sharing is off/);
  assert.match(errorText('hash-mismatch', false), /damaged/);
  assert.match(errorText('superseded', false), /newer/);
  assert.match(errorText('offline', true), /Connection lost/);
  assert.match(errorText('weird-new-code', true), /Copy it again/);
});
