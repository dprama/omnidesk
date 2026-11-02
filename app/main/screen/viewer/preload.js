// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Preload for the second-screen capture and viewer windows only. Exposes
// window.omniScreen = { onCommand(cb), send(msg) } and nothing else.
// Messages are plain JSON objects (signalling, state, stats).

const { contextBridge, ipcRenderer } = require('electron');

let handler = null;
const early = [];
ipcRenderer.on('omnidesk-screen:cmd', (_e, cmd) => {
  if (handler) { try { handler(cmd); } catch (err) { console.error(err); } } else if (early.length < 64) early.push(cmd);
});

contextBridge.exposeInMainWorld('omniScreen', Object.freeze({
  onCommand(cb) {
    if (typeof cb !== 'function' || handler) return;
    handler = cb;
    for (const c of early.splice(0)) { try { cb(c); } catch (err) { console.error(err); } }
  },
  send(msg) {
    let json;
    try { json = JSON.stringify(msg); } catch { return; }
    if (typeof json !== 'string' || json.length > 256 * 1024) return;
    ipcRenderer.send('omnidesk-screen:msg', JSON.parse(json));
  },
}));
