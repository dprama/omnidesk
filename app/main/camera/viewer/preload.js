// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// Preload for the camera capture and viewer windows only. Exposes
// window.omniCamera = { onCommand(cb), send(msg) } and nothing else.
// Messages are plain JSON objects (signalling, state).

const { contextBridge, ipcRenderer } = require('electron');

let handler = null;
const early = [];
ipcRenderer.on('omnidesk-camera:cmd', (_e, cmd) => {
  if (handler) { try { handler(cmd); } catch (err) { console.error(err); } } else if (early.length < 64) early.push(cmd);
});

contextBridge.exposeInMainWorld('omniCamera', Object.freeze({
  onCommand(cb) {
    if (typeof cb !== 'function' || handler) return;
    handler = cb;
    for (const c of early.splice(0)) { try { cb(c); } catch (err) { console.error(err); } }
  },
  send(msg) {
    let json;
    try { json = JSON.stringify(msg); } catch { return; }
    if (typeof json !== 'string' || json.length > 256 * 1024) return;
    ipcRenderer.send('omnidesk-camera:msg', JSON.parse(json));
  },
}));
