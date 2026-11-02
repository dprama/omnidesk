// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Parses the engine's crossing decision log lines (see docs/API.md, mouse):
//   [2026-11-01T10:12:03.123] INFO: cross edge=right pos=(4479,640) to=MacBook cooldown=300ms
//   [2026-11-01T10:12:04.456] INFO: no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[…]
// into the API form "HH:MM:SS cross …" / "HH:MM:SS no-cross reason=…".
//
// The patterns are the engine's contract, copied verbatim from
// engine/src/lib/base/OmniDeskLog.h. Change them only together.

const NO_CROSS = /^no-cross reason=(not-outer-edge|outside-zone|button-held|cooldown|arrival-guard|locked|sharing-off|no-neighbour) edge=(left|right|top|bottom) pos=\((-?\d+),(-?\d+)\) monitors=((?:\[-?\d+,-?\d+,\d+x\d+\])+)(?: remaining=(\d+)ms)?$/;
const CROSS = /^cross edge=(left|right|top|bottom) pos=\((-?\d+),(-?\d+)\) to=(.+) cooldown=(\d+)ms$/;
const START = /^start mode=(server|client) helper=(.+) version=(\S+) pid=(\d+)$/;
const MONITOR = /\[(-?\d+),(-?\d+),(\d+)x(\d+)\]/g;

// The body starts after "<LEVEL>: " in the engine log format "[<ISO time>] <LEVEL>: <body>".
const BODY = /^(?:\[[^\]]*\]\s+[A-Z]+:\s+)?(.*)$/;
const TS = /^\[(\d{4}-\d\d-\d\dT)?(\d\d:\d\d:\d\d)/;

function hhmmss(d = new Date()) {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function parseMonitors(text) {
  return [...String(text).matchAll(MONITOR)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
}

function bodyOf(rawLine) {
  return BODY.exec(String(rawLine).trim())[1].trim();
}

// Returns null or { line, kind: 'cross'|'no-cross', fields, pos: {x,y}|null }.
// fields: cross -> { edge, pos, to, cooldown }; no-cross -> { reason, edge, pos, monitors[, remaining] }
// (raw text values, as written by the engine), plus `monitorRects` for no-cross.
function parseDecision(rawLine, now = new Date()) {
  const raw = String(rawLine).trim();
  const body = bodyOf(raw);
  let kind = null;
  let fields = null;
  let m = NO_CROSS.exec(body);
  if (m) {
    kind = 'no-cross';
    fields = { reason: m[1], edge: m[2], pos: `(${m[3]},${m[4]})`, monitors: m[5], monitorRects: parseMonitors(m[5]) };
    if (m[6] !== undefined) fields.remaining = `${m[6]}ms`;
  } else if ((m = CROSS.exec(body))) {
    kind = 'cross';
    fields = { edge: m[1], pos: `(${m[2]},${m[3]})`, to: m[4], cooldown: `${m[5]}ms` };
  } else {
    return null;
  }
  const ts = TS.exec(raw);
  const time = ts ? ts[2] : hhmmss(now);
  const p = /^\((-?\d+),(-?\d+)\)$/.exec(fields.pos);
  return { line: `${time} ${body}`, kind, fields, pos: p ? { x: Number(p[1]), y: Number(p[2]) } : null };
}

// The engine's own start line: { mode, helper, version, pid } or null.
function parseStart(rawLine) {
  const m = START.exec(bodyOf(rawLine));
  return m ? { mode: m[1], helper: m[2], version: m[3], pid: Number(m[4]) } : null;
}

module.exports = { parseDecision, parseStart, parseMonitors, hhmmss, NO_CROSS, CROSS, START };
