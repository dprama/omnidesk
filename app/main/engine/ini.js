// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Minimal reader/writer for the QSettings IniFormat used by the engine's
// Deskflow.conf. We merge our keys into the existing file and keep every
// other key (TLS, computer options, …) byte-for-byte as it was.
// Keys are addressed as "group/key", like the engine (e.g. "core/coreMode").

function parse(text) {
  const map = new Map(); // "group/key" -> raw value string
  const order = []; // group order as found
  let group = 'General';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const g = /^\[(.*)\]$/.exec(line);
    if (g) {
      group = g[1];
      if (!order.includes(group)) order.push(group);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    map.set(`${group}/${key}`, value);
    if (!order.includes(group)) order.push(group);
  }
  return { map, order };
}

function unquote(raw) {
  if (raw == null) return undefined;
  const s = String(raw);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  return s;
}

function formatValue(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // QSettings quotes strings containing list separators, quotes or edge whitespace.
  if (/[",;=\\#]|^\s|\s$/.test(s) || s === '') {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function stringify({ map, order }) {
  const groups = new Map();
  for (const g of order) groups.set(g, []);
  for (const [full, value] of map) {
    const slash = full.indexOf('/');
    const g = full.slice(0, slash);
    const k = full.slice(slash + 1);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`${k}=${value}`);
  }
  const out = [];
  for (const [g, lines] of groups) {
    if (!lines.length) continue;
    out.push(`[${g}]`, ...lines, '');
  }
  return out.join('\n');
}

// Apply { "group/key": value | null } to the INI text; null removes the key.
// removeGroups: predicate(groupName) -> true drops the whole group.
function update(text, values, { removeGroups } = {}) {
  const doc = parse(text);
  if (removeGroups) {
    for (const full of [...doc.map.keys()]) {
      if (removeGroups(full.slice(0, full.indexOf('/')))) doc.map.delete(full);
    }
  }
  for (const [full, v] of Object.entries(values)) {
    if (!full.includes('/')) throw new Error(`ini key needs a group: ${full}`);
    if (v === null || v === undefined) doc.map.delete(full);
    else {
      doc.map.set(full, formatValue(v));
      const g = full.slice(0, full.indexOf('/'));
      if (!doc.order.includes(g)) doc.order.push(g);
    }
  }
  return stringify(doc);
}

function get(text, full) {
  return unquote(parse(text).map.get(full));
}

module.exports = { parse, stringify, update, get, formatValue, unquote };
