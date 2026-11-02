// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Parsers for the clipboard formats that carry copied files. Pure functions,
// no Electron, so they are unit tested with fixture buffers.
//
// Electron 44's clipboard is async and W3C-like: clipboard.read() ->
// ClipboardItem[] with .types and .getType(type) -> Blob. There is no
// readBuffer()/availableFormats() any more. Raw OS formats appear as
//   electron application/osclipboard;format="<OS format name>"
//
// macOS (verified on this Mac, Electron 44.9.0, files put on the pasteboard as
// NSURLs the way Finder's Copy does):
//   'text/uri-list'  -> "file:///a.txt\r\nfile:///b%20c.txt"   (all items)  <- we use this
//   osclipboard "NSFilenamesPboardType" -> XML plist <array><string>/a.txt</string>…
//   osclipboard "CorePasteboardFlavorType 0x6675726C" ('furl', first item only)
//   Note: `osascript -e 'set the clipboard to (POSIX file …)'` writes only a legacy
//   «class furl» that Electron does not list at all, so it is not used to write.
// Windows (UNVERIFIED here): Chromium maps CF_HDROP to 'text/uri-list' as on
// macOS; as a fallback we read the raw formats
//   osclipboard "FileNameW" -> UTF-16LE path(s), NUL separated, NUL NUL terminated
//   osclipboard "CF_HDROP"  -> DROPFILES struct (pFiles offset, pt, fNC, fWide)
//                              then a double-NUL terminated path list.

const OS_PREFIX = 'electron application/osclipboard;format=';
const osFormat = (name) => `${OS_PREFIX}"${name}"`;

function fileUrlToPath(url, platform = process.platform) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'file:') return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return null; }
  if (platform === 'win32') {
    if (u.host) return `\\\\${u.host}${p.replace(/\//g, '\\')}`; // UNC
    return p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
  }
  return p;
}

// text/uri-list (RFC 2483): CRLF separated, '#' lines are comments.
function parseUriList(text, platform = process.platform) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => fileUrlToPath(l, platform))
    .filter(Boolean);
}

// NUL-separated UTF-16LE strings; an empty string ends the list.
function splitUtf16(buf, start = 0) {
  const len = (buf.length - start) & ~1;
  const out = [];
  for (const part of buf.toString('utf16le', start, start + len).split('\0')) {
    if (!part) break;
    out.push(part);
  }
  return out;
}

// FileNameW: UTF-16LE, one or more paths separated by NUL.
function parseFileNameW(buf) {
  return splitUtf16(Buffer.from(buf)).filter(Boolean);
}

// CF_HDROP: DROPFILES { DWORD pFiles; POINT pt; BOOL fNC; BOOL fWide; } (20 bytes).
function parseHDrop(buf) {
  const b = Buffer.from(buf);
  if (b.length < 20) return [];
  const off = b.readUInt32LE(0);
  const wide = b.readUInt32LE(16) !== 0;
  if (off < 20 || off >= b.length) return [];
  if (wide) return splitUtf16(b, off).filter(Boolean);
  return b.toString('latin1', off).split('\0').filter(Boolean);
}

module.exports = { OS_PREFIX, osFormat, fileUrlToPath, parseUriList, parseFileNameW, parseHDrop };
