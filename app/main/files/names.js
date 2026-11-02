// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// File names that arrive from a peer are untrusted. sanitizeName() turns any
// string into one safe path component on both Windows and macOS: no
// separators, no traversal, no control or Windows-reserved characters, no
// reserved device names (CON, NUL, COM1…), no trailing dots/spaces, ≤ 150 bytes
// (received files live in %TEMP%\\OmniDesk\\clip-<uuid>\\, ~90 characters, and
// Explorer still trips over full paths longer than MAX_PATH = 260).

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const MAX_BYTES = 150;

function truncateUtf8(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

function sanitizeName(input) {
  let s = String(input == null ? '' : input).normalize('NFC');
  // Keep only the last component of either separator style.
  s = s.split(/[\\/]/).pop();
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
  const trim = (x) => x.replace(/[. ]+$/g, '').replace(/^ +/, '');
  s = trim(s);
  // Keep the extension when shortening; trim again so a cut never ends in "." or " ".
  if (Buffer.byteLength(s) > MAX_BYTES) {
    const m = /(\.[^. ]{1,16})$/.exec(s);
    const ext = m ? m[1] : '';
    const stem = trim(truncateUtf8(s.slice(0, s.length - ext.length), MAX_BYTES - Buffer.byteLength(ext)));
    s = stem ? stem + ext : trim(truncateUtf8(s, MAX_BYTES));
  }
  if (s === '' || /^\.+$/.test(s)) s = 'file';
  const dot = s.indexOf('.');
  const stem = dot === -1 ? s : s.slice(0, dot);
  if (RESERVED.test(stem.trim())) s = `_${s}`;
  return s;
}

// Makes names unique inside one folder (case-insensitive, like both file systems).
function uniqueNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const name = sanitizeName(raw);
    const m = /^(.*?)(\.[^.]*)?$/.exec(name);
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${m[1]} (${n})${m[2] || ''}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

module.exports = { sanitizeName, uniqueNames, MAX_BYTES };
