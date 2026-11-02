// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Reads copied files from, and puts received files on, the system clipboard.
//   readFiles()        -> { sig, paths }  sig changes whenever the file list changes
//   writeFiles(paths)  -> Promise<void>
// Formats used: see formats.js.

const { execFile } = require('node:child_process');
const { osFormat, parseUriList, parseFileNameW, parseHDrop } = require('./formats');

// macOS writer: JavaScript for Automation (ships with macOS, no compile step,
// takes any number of paths as argv, no quoting). It writes NSURL objects with
// writeObjects:, exactly what Finder's Copy does, so Finder/Mail/Slack paste
// real files and Electron lists 'text/uri-list' + NSFilenamesPboardType for
// all of them. AppleScript's `set the clipboard to POSIX file` only writes one
// legacy «class furl» item, and a Swift helper would need a compiled binary.
// Measured here: if osascript exits right after writeObjects:, the pasteboard
// often keeps only some of the items (9 of 16 runs lost one). Staying alive
// 0.25 s after the write fixed it (0 of 32), so the script waits, then reports
// how many items the pasteboard holds and writeFiles() retries once if short.
const JXA = 'function run(argv){ObjC.import("AppKit");var pb=$.NSPasteboard.generalPasteboard;'
  + 'var a=$.NSMutableArray.array;argv.forEach(function(p){a.addObject($.NSURL.fileURLWithPath(p))});'
  + 'pb.clearContents;if(!pb.writeObjects(a))return "fail";delay(0.25);return "ok "+pb.pasteboardItems.count}';

// Windows writer: PowerShell 5.1 Set-Clipboard -LiteralPath (CF_HDROP + shell
// formats, like Explorer's Copy). Sent as -EncodedCommand (UTF-16LE base64).
// The paths are NOT quoted into the script: PowerShell also ends a '…' string
// at ‘ ’ ‚ ‛ (U+2018…U+201B), so a received name like "a’;calc;’.txt" would run
// code. They travel as base64 of UTF-8, newline separated (names never hold
// control characters, see names.js), so nothing from a path is ever parsed.
function psCommand(paths) {
  const b64 = Buffer.from(paths.map(String).join('\n'), 'utf8').toString('base64');
  return '$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('
    + `'${b64}')) -split [char]10; Set-Clipboard -LiteralPath $p`;
}

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (e, stdout, stderr) => {
      // No stderr in the message: it can hold file paths, and errors end up in the log.
      void stderr;
      if (e) reject(Object.assign(new Error(`${cmd} failed (${e.killed ? 'timed out' : `exit ${e.code}`})`), { code: 'clipboard-write' }));
      else resolve(String(stdout).trim());
    });
  });
}

function createPlatform({ clipboard, platform = process.platform, exec = run }) {
  async function readFiles() {
    const items = await clipboard.read();
    const types = [];
    for (const it of items) types.push(...it.types);
    const pick = async (type) => {
      const it = items.find((x) => x.types.includes(type));
      return it ? Buffer.from(await (await it.getType(type)).arrayBuffer()) : null;
    };
    let paths = [];
    let raw = '';
    if (types.includes('text/uri-list')) {
      raw = (await pick('text/uri-list')).toString('utf8');
      paths = parseUriList(raw, platform);
    } else if (platform === 'win32') {
      // Fallbacks if Chromium does not map CF_HDROP to text/uri-list (unverified).
      const hdrop = types.find((t) => /HDROP/i.test(t));
      const fnw = types.includes(osFormat('FileNameW')) ? osFormat('FileNameW') : null;
      if (hdrop) { const b = await pick(hdrop); raw = b.toString('base64'); paths = parseHDrop(b); }
      else if (fnw) { const b = await pick(fnw); raw = b.toString('base64'); paths = parseFileNameW(b); }
    }
    // Cheap change signature: the format list, plus the file list when there is one.
    // blank: nothing on the clipboard (the engine empties it, on Windows leaving only its
    // "Deskflow Ownership" marker); see GUARD_MS in core.js.
    const blank = types.every((t) => /Deskflow Ownership/i.test(t));
    return { sig: `${types.join('|')}\n${raw}`, paths, blank };
  }

  async function writeFiles(paths) {
    if (!paths.length) return;
    if (platform === 'darwin') {
      let out = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        out = await exec('osascript', ['-l', 'JavaScript', '-e', JXA, ...paths]);
        if (out === `ok ${paths.length}`) return;
      }
      throw Object.assign(new Error(`pasteboard write: ${out}`), { code: 'clipboard-write' });
    } else if (platform === 'win32') {
      const enc = Buffer.from(psCommand(paths), 'utf16le').toString('base64');
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc]);
    } else {
      // Linux: GNOME/KDE file managers accept text/uri-list.
      const { ClipboardItem } = require('electron');
      const list = paths.map((p) => require('node:url').pathToFileURL(p).href).join('\r\n');
      await clipboard.write([new ClipboardItem({ 'text/uri-list': list })]);
    }
  }

  return { readFiles, writeFiles };
}

module.exports = { createPlatform, psCommand, JXA, _run: run };
