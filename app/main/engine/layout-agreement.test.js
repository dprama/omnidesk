// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// main (engine/config.js) and the Screen layout page must read a placement the same way:
// the device's monitor bounding box starts at the placement. They used to disagree for a
// device with a monitor left of / above its primary (negative desktop coordinates).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { computeEdges } = require('./config');

const page = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'renderer', 'pages', 'layout.js')).href);

// Windows PC: 1920x1080 left of and 300 px above the 2560x1440 primary
const PC = { id: 'pc', screens: [{ x: -1920, y: -300, w: 1920, h: 1080 }, { x: 0, y: 0, w: 2560, h: 1440 }] };
// Mac with an external display above its built-in one
const MAC = { id: 'mac', screens: [{ x: 0, y: 0, w: 1512, h: 982 }, { x: -200, y: -1080, w: 1920, h: 1080 }] };

function pageEdges(L, devs, placements) {
  const ds = devs.map(L.placeable);
  const out = new Map();
  for (const A of ds) for (const B of ds) {
    if (A === B) continue;
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const px = L.edgeSegments(A, placements[A.id], side, B, placements[B.id]).reduce((n, s) => n + (s.b - s.a), 0);
      if (px > 0) out.set(`${A.id}|${side}|${B.id}`, px);
    }
  }
  return out;
}

test('page and main agree on edges for devices with negative monitor coordinates', async () => {
  const L = await page();
  // PC bbox is 4480x1740; Mac placed against the PC's right side, beside the primary
  for (const placements of [
    { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 1080 } },
    { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 400 } },
    { pc: { x: 0, y: 0 }, mac: { x: -1920, y: 0 } },
  ]) {
    const main = new Map(computeEdges([PC, MAC], placements).edges.map((e) => [`${e.from}|${e.fromEdge}|${e.to}`, e.overlapPx]));
    assert.deepEqual(pageEdges(L, [PC, MAC], placements), main, JSON.stringify(placements));
  }
});

test('placeable shifts screens to start at 0,0 and leaves others alone', async () => {
  const L = await page();
  assert.deepEqual(L.placeable(PC).screens, [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 300, w: 2560, h: 1440 }]);
  const plain = { id: 'x', screens: [{ x: 0, y: 0, w: 10, h: 10 }] };
  assert.equal(L.placeable(plain), plain);
});
