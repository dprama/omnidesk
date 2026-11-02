<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->
# File clipboard (`app/main/files`, owner: files)

Copy files in Finder/Explorer on one computer, paste them on the other. The engine keeps doing
text/HTML/images; this module adds files over the paired peer channel (`../pairing/PEER.md`).

`create({ peer, devices, engine, log, settings })` → `{ start(), stop(), get(), set(patch), history(), onItem(cb) }`
- `get/set` read/patch `settings.clipboard` (`enabled`, `files`, `maxFileMB`); the module reads settings live.
- `history()` → file `ClipItem[]` newest first (max 20); `onItem(cb)` → unsubscribe. Items:
  `{ id, kind:'file', from, to, at, name, bytes, progress }` (`from`/`to` are device ids or `'this'`,
  `to:'*'` = several devices, `name` = `"a.pdf and 2 more"`, `progress` 0…1) plus `error` (code) on failure.

Peer messages: `files.offer` (send) `{ id, files:[{name,size,sha256}], skipped:[{name,why}] }`, never paths;
`files.chunk` (request) `{ id, file, index }` → `{ data: base64 }`, 512 KiB raw per chunk;
`files.result` (send, receiver → sender) `{ id, ok:true }` or `{ id, ok:false, error }` so the sender's
item ends at `progress: 1` or with the receiver's `error` (`off`, `too-big`, `cancelled`, `superseded`,
`hash-mismatch`, …) instead of sitting at "sending". Sender progress stops at 0.99 until then.
Rules: poll the clipboard every 500 ms; offer to the device the cursor is on (engine `cross`/`cursor=`),
else every reachable paired device. Max 20 files, each and in total ≤ `maxFileMB`; folders are
**skipped** (logged, listed in `skipped`). The receiver re-checks caps, pulls at once into
`<temp>/OmniDesk/clip-<id>/` (names sanitized, SHA-256 per file), then puts the files on its clipboard
(macOS: JXA `NSPasteboard writeObjects:` of NSURLs; Windows: `Set-Clipboard -LiteralPath`). Nothing is
opened. The newest offer cancels older pulls; files copied locally while a pull runs win (the pull
ends `superseded`; text/images don't count, they may be the engine's copy of the same Finder copy).
Clipboard or files switched off on either side stops a running transfer at the next chunk (`off`).
Transfer folders are deleted after 24 h. Logs hold counts and codes only, never names or paths.

Engine interplay: a clipboard holding only files is *empty* to the engine, so the engine clears the
other computer's clipboard (empty clipboard sent on cursor entry; Windows emptied on a remote grab).
While our files are the newest copy (sent or received, ≤ 1 h), an emptied clipboard gets them put back
(`blank` from `platform.readFiles()`, ≥ 1 s apart); the restore is not re-offered. The proper fix is in
the engine (don't send/apply clipboards with no formats).

## Wiring in main (`api/index.js`)
```js
const files = load('files', { peer, devices, engine, log: log.child('files'), settings }); // peer = pairing peer.create(...)
function addClip(item) { state.clips = [item, ...state.clips.filter((c) => c.id !== item.id)].slice(0, CLIP_MAX); broadcast('clipboard.item', item); }
if (files) { files.onItem(addClip); files.start(); app.on('before-quit', () => files.stop()); }
```
Use `addClip` for the `clipboardItem=` IPC branch too, so `clipboard.history` stays one merged list.
`clipboard.set` needs no change. Tests: `node --test app/main/files/`.
