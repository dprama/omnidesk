// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Layout -> engine config.
//
// Layout space: each device is placed at placements[id] = {x, y}; its monitors
// keep their own desktop geometry, shifted so the device's monitor bounding box
// starts at the placement. Edges are found ONLY on outer monitor edges: a piece
// of a monitor edge counts only where no other monitor of the same device
// continues beyond it (so the PC's inner seam between its two monitors never
// becomes a crossing).
//
// The engine reads (DO-NOT-RENAME §3, Config.cpp):
//  - the computer list from Deskflow.conf groups computer_<name>/name
//  - links + options from the server config (sections links/options; the
//    screens section is ignored by this engine, kept for older peers/tools).

const SIDES = ['left', 'right', 'top', 'bottom'];
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const DESKFLOW_SIDE = { left: 'left', right: 'right', top: 'up', bottom: 'down' };
const DEFAULT_TOL = 4;

function bbox(rects) {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Monitors of one device in layout coordinates.
function placeDevice(screens, placement) {
  const b = bbox(screens);
  const p = placement || { x: 0, y: 0 };
  return screens.map((r) => ({ x: r.x - b.x + p.x, y: r.y - b.y + p.y, w: r.w, h: r.h }));
}

// For a side: the edge line, the span along the edge, and the depth range.
function edgeOf(r, side) {
  switch (side) {
    case 'right': return { line: r.x + r.w, a: r.y, b: r.y + r.h };
    case 'left': return { line: r.x, a: r.y, b: r.y + r.h };
    case 'bottom': return { line: r.y + r.h, a: r.x, b: r.x + r.w };
    case 'top': return { line: r.y, a: r.x, b: r.x + r.w };
    default: throw new Error(`bad side ${side}`);
  }
}
function depth(r, side) {
  return side === 'left' || side === 'right' ? { lo: r.x, hi: r.x + r.w } : { lo: r.y, hi: r.y + r.h };
}
function span(r, side) {
  return side === 'left' || side === 'right' ? { a: r.y, b: r.y + r.h } : { a: r.x, b: r.x + r.w };
}

function subtract(intervals, a, b) {
  const out = [];
  for (const [s, e] of intervals) {
    if (b <= s || a >= e) { out.push([s, e]); continue; }
    if (a > s) out.push([s, a]);
    if (b < e) out.push([b, e]);
  }
  return out;
}
function intersect(intervals, a, b) {
  const out = [];
  for (const [s, e] of intervals) {
    const lo = Math.max(s, a);
    const hi = Math.min(e, b);
    if (hi > lo) out.push([lo, hi]);
  }
  return out;
}
function mergeIntervals(list) {
  const sorted = list.slice().sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

// Parts of monitor m's `side` edge where no other monitor of the same device
// continues beyond the edge.
function outerParts(m, side, siblings, tol = DEFAULT_TOL) {
  const { line, a, b } = edgeOf(m, side);
  const dir = side === 'right' || side === 'bottom' ? 1 : -1;
  let parts = [[a, b]];
  for (const n of siblings) {
    if (n === m) continue;
    const d = depth(n, side);
    const beyond = dir > 0 ? d.lo <= line + tol && d.hi > line + tol : d.hi >= line - tol && d.lo < line - tol;
    if (!beyond) continue;
    const s = span(n, side);
    parts = subtract(parts, s.a, s.b);
  }
  return parts;
}

// devices: [{ id, screens: Rect[] }], placements: { id: {x,y} }
// Returns { edges: Edge[], segments: [{from, fromEdge, to, a, b}] } in layout px.
function computeEdges(devices, placements, { tol = DEFAULT_TOL } = {}) {
  const placed = devices
    .filter((d) => placements && placements[d.id] && Array.isArray(d.screens) && d.screens.length)
    .map((d) => ({ id: d.id, mons: placeDevice(d.screens, placements[d.id]) }));
  const segments = [];
  for (const A of placed) {
    for (const B of placed) {
      if (A === B) continue;
      for (const side of SIDES) {
        const opp = OPPOSITE[side];
        const dir = side === 'right' || side === 'bottom' ? 1 : -1;
        let found = [];
        for (const m of A.mons) {
          const mine = outerParts(m, side, A.mons, tol);
          if (!mine.length) continue;
          const { line } = edgeOf(m, side);
          for (const q of B.mons) {
            const d = depth(q, side);
            const near = dir > 0 ? d.lo : d.hi;
            if (Math.abs(near - line) > tol) continue;
            let theirs = outerParts(q, opp, B.mons, tol);
            let common = [];
            for (const [s, e] of theirs) for (const p of intersect(mine, s, e)) common.push(p);
            found = found.concat(common);
          }
        }
        for (const [a, b] of mergeIntervals(found)) segments.push({ from: A.id, fromEdge: side, to: B.id, a, b });
      }
    }
  }
  const byKey = new Map();
  for (const s of segments) {
    const k = `${s.from}|${s.fromEdge}|${s.to}`;
    const e = byKey.get(k) || { from: s.from, fromEdge: s.fromEdge, to: s.to, overlapPx: 0 };
    e.overlapPx += s.b - s.a;
    byKey.set(k, e);
  }
  return { edges: [...byKey.values()], segments, placed };
}

function pct(v, lo, len) {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((v - lo) / len) * 100)));
}
function fmtInterval(s, e) {
  return s === 0 && e === 100 ? '' : `(${s},${e})`;
}

// Hotkey "Ctrl+Alt+L" -> Deskflow "Control+Alt+l".
function deskflowKeystroke(hotkey) {
  const map = { ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', cmd: 'Super', super: 'Super', win: 'Super', meta: 'Meta' };
  const parts = String(hotkey || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = parts.map((p) => map[p.toLowerCase()]);
  if (mods.some((m) => !m) || !/^[A-Za-z0-9]$/.test(key)) return null;
  return [...mods, key.toLowerCase()].join('+');
}

// names: { deviceId: engineComputerName }
// options: { cooldownMs, arrivalGuardMs, clipboard, lockHotkey }
// pausedTo: device ids nobody may cross INTO right now (e.g. a laptop showing a
// second screen); their own outgoing links stay so the cursor can come back.
function buildServerConfig({ devices, placements, names, options = {}, tol, pausedTo = [] }) {
  const paused = new Set(pausedTo);
  const { segments, placed } = computeEdges(devices, placements, { tol });
  const boxes = Object.fromEntries(placed.map((p) => [p.id, bbox(p.mons)]));
  const lines = [];
  lines.push('# Written by OmniDesk. Edits are replaced when the layout changes.');
  lines.push('section: screens');
  for (const p of placed) lines.push(`\t${names[p.id]}:`);
  lines.push('end', '');
  lines.push('section: links');
  for (const p of placed) {
    lines.push(`\t${names[p.id]}:`);
    const mine = segments.filter((s) => s.from === p.id && !paused.has(s.to)).sort((x, y) => SIDES.indexOf(x.fromEdge) - SIDES.indexOf(y.fromEdge) || x.a - y.a);
    let lastEnd = {};
    for (const s of mine) {
      const ba = span(boxes[s.from], s.fromEdge);
      const bb = span(boxes[s.to], s.fromEdge);
      let s0 = pct(s.a, ba.a, ba.b - ba.a);
      const s1 = pct(s.b, ba.a, ba.b - ba.a);
      const d0 = pct(s.a, bb.a, bb.b - bb.a);
      const d1 = pct(s.b, bb.a, bb.b - bb.a);
      // the engine rejects overlapping source ranges on one side
      if (lastEnd[s.fromEdge] !== undefined && s0 < lastEnd[s.fromEdge]) s0 = lastEnd[s.fromEdge];
      if (s1 <= s0 || d1 <= d0) continue;
      lastEnd[s.fromEdge] = s1;
      lines.push(`\t\t${DESKFLOW_SIDE[s.fromEdge]}${fmtInterval(s0, s1)} = ${names[s.to]}${fmtInterval(d0, d1)}`);
    }
  }
  lines.push('end', '');
  lines.push('section: options');
  if (Number.isFinite(options.cooldownMs)) lines.push(`\tomnideskCrossCooldown = ${Math.round(options.cooldownMs)}`);
  if (Number.isFinite(options.arrivalGuardMs)) lines.push(`\tomnideskArrivalGuard = ${Math.round(options.arrivalGuardMs)}`);
  if (typeof options.clipboard === 'boolean') lines.push(`\tclipboardSharing = ${options.clipboard}`);
  const ks = deskflowKeystroke(options.lockHotkey);
  if (ks) lines.push(`\tkeystroke(${ks}) = lockCursorToScreen(toggle)`);
  lines.push('end', '');
  return lines.join('\n');
}

// Deskflow.conf values for the computer list: { 'computer_<n>/name': n }.
function computerSettings(names) {
  const out = {};
  for (const n of new Set(Object.values(names))) out[`computer_${n}/name`] = n;
  return out;
}

module.exports = {
  computeEdges, buildServerConfig, computerSettings, placeDevice, outerParts, bbox, deskflowKeystroke,
  SIDES, DESKFLOW_SIDE,
};
