// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEdges, buildServerConfig, computerSettings, deskflowKeystroke } = require('./config');

// The owner's real desk: PC with 2560x1440 + 1920x1080 (offset 180 down),
// MacBook 1512x982 to the right of monitor 2, vertically centred on it.
const PC = { id: 'pc', screens: [{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 2560, y: 180, w: 1920, h: 1080 }] };
const MAC = { id: 'mac', screens: [{ x: 0, y: 0, w: 1512, h: 982 }] };
const placements = { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 229 } };

test('owner layout: only the outer right edge of monitor 2 links to the MacBook', () => {
  const { edges, segments } = computeEdges([PC, MAC], placements);
  assert.deepEqual(edges.sort((a, b) => a.from.localeCompare(b.from)), [
    { from: 'mac', fromEdge: 'left', to: 'pc', overlapPx: 982 },
    { from: 'pc', fromEdge: 'right', to: 'mac', overlapPx: 982 },
  ]);
  assert.deepEqual(segments.find((s) => s.from === 'pc'), { from: 'pc', fromEdge: 'right', to: 'mac', a: 229, b: 1211 });
});

test('inner seam between the PC monitors never becomes an edge', () => {
  // A phone-sized device touching monitor 1's right edge where monitor 2 continues: no edge.
  const tab = { id: 'tab', screens: [{ x: 0, y: 0, w: 100, h: 100 }] };
  const r = computeEdges([PC, tab], { pc: { x: 0, y: 0 }, tab: { x: 2560, y: 500 } });
  assert.deepEqual(r.edges, []);
});

test('outer part of monitor 1 right edge (below monitor 2) counts', () => {
  const tab = { id: 'tab', screens: [{ x: 0, y: 0, w: 300, h: 100 }] };
  const { edges } = computeEdges([PC, tab], { pc: { x: 0, y: 0 }, tab: { x: 2560, y: 1300 } });
  assert.deepEqual(edges.find((e) => e.from === 'pc'), { from: 'pc', fromEdge: 'right', to: 'tab', overlapPx: 100 });
});

test('partial overlap is clipped to the touching monitor', () => {
  const { edges } = computeEdges([PC, MAC], { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 0 } });
  // monitor 2 spans y 180..1260, MacBook 0..982 -> 180..982
  assert.equal(edges.find((e) => e.from === 'pc').overlapPx, 802);
});

test('devices without placement or screens are ignored; gaps are not edges', () => {
  assert.deepEqual(computeEdges([PC, MAC], { pc: { x: 0, y: 0 } }).edges, []);
  assert.deepEqual(computeEdges([PC, MAC], { pc: { x: 0, y: 0 }, mac: { x: 4600, y: 229 } }).edges, []);
});

test('placement normalises a device whose monitors start at negative coords', () => {
  const left = { id: 'pc', screens: [{ x: -1920, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 2560, h: 1440 }] };
  const { edges } = computeEdges([left, MAC], { pc: { x: 0, y: 0 }, mac: { x: 4480, y: 0 } });
  assert.deepEqual(edges.find((e) => e.from === 'pc'), { from: 'pc', fromEdge: 'right', to: 'mac', overlapPx: 982 });
});

test('server config text for the owner layout', () => {
  const text = buildServerConfig({
    devices: [PC, MAC], placements, names: { pc: 'DESKTOP-PC', mac: 'MacBook-Pro' },
    options: { cooldownMs: 300, arrivalGuardMs: 250, clipboard: true, lockHotkey: 'Ctrl+Alt+L' },
  });
  assert.match(text, /section: links\n\tDESKTOP-PC:\n\t\tright\(16,84\) = MacBook-Pro\n\tMacBook-Pro:\n\t\tleft = DESKTOP-PC\(16,84\)\nend/);
  assert.match(text, /\tomnideskCrossCooldown = 300\n/);
  assert.match(text, /\tomnideskArrivalGuard = 250\n/);
  assert.match(text, /\tkeystroke\(Control\+Alt\+l\) = lockCursorToScreen\(toggle\)\n/);
  assert.match(text, /section: screens\n\tDESKTOP-PC:\n\tMacBook-Pro:\nend/);
  // every non-comment line is printable ASCII (the engine rejects others)
  for (const l of text.split('\n')) assert.match(l, /^[\t\x20-\x7e]*$/);
});

test('computer settings and keystroke mapping', () => {
  assert.deepEqual(computerSettings({ pc: 'A', mac: 'B' }), { 'computer_A/name': 'A', 'computer_B/name': 'B' });
  assert.equal(deskflowKeystroke('Ctrl+Alt+L'), 'Control+Alt+l');
  assert.equal(deskflowKeystroke('Hyper+L'), null);
});

test('pausedTo drops links into that device but keeps its way back', () => {
  const names = { pc: 'PC', mac: 'MacBook' };
  const normal = buildServerConfig({ devices: [PC, MAC], placements, names });
  assert.match(normal, /\tright\(\d+,\d+\) = MacBook/);
  const paused = buildServerConfig({ devices: [PC, MAC], placements, names, pausedTo: ['mac'] });
  assert.doesNotMatch(paused, /= MacBook/);
  assert.match(paused, /\tleft = PC/);
  assert.match(paused, /\tMacBook:/); // still a known screen
});
