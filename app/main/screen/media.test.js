// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
'use strict';

// media.js permission handlers with a fake Electron: the capture window may capture; the
// viewer window only passes the 'media' permission *check* (so WebRTC uses every network
// adapter, not just a VPN's default route) and can never get a capture request granted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMedia, ORIGIN } = require('./media');

function fakeElectron() {
  const ses = { protocol: { handle() {} }, webRequest: { onBeforeRequest() {} } };
  ses.setPermissionRequestHandler = (f) => { ses.request = f; };
  ses.setPermissionCheckHandler = (f) => { ses.check = f; };
  ses.setDevicePermissionHandler = () => {};
  let onMsg = null;
  let nextId = 1;
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      const id = nextId++;
      this.webContents = Object.assign(new EventEmitter(), { id, url: '', getURL: () => this.webContents.url, isDestroyed: () => false, send() {} });
    }
    isDestroyed() { return false; }
    destroy() {}
    show() {}
    setFullScreen() {}
    setBounds() {}
    focus() {}
    async loadURL(u) {
      this.webContents.url = u;
      setImmediate(() => onMsg({ sender: this.webContents, senderFrame: { url: u } }, { type: 'ready' }));
    }
  }
  const display = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1440, height: 900 } };
  return {
    ses,
    electron: {
      BrowserWindow,
      session: { fromPartition: () => ses },
      ipcMain: { on: (_ch, f) => { onMsg = f; } },
      desktopCapturer: { getSources: async () => [] },
      screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
    },
  };
}

test('viewer passes the media check only; capture requests stay with the capture window', async () => {
  const { ses, electron } = fakeElectron();
  const media = createMedia({ electron, allowMedia: () => () => {} });
  const src = await media.openSource({ sessionId: 'a'.repeat(16) }, () => {});
  const view = await media.openViewer({ sessionId: 'a'.repeat(16) }, () => {});
  const wcSrc = { id: 1, getURL: () => `${ORIGIN}/capture.html` };
  const wcView = { id: 2, getURL: () => `${ORIGIN}/viewer.html` };
  const req = (wc, perm) => new Promise((r) => ses.request(wc, perm, r, { requestingUrl: wc.getURL() }));

  assert.equal(ses.check(wcView, 'media', ORIGIN), true);
  assert.equal(ses.check(wcView, 'display-capture', ORIGIN), false);
  assert.equal(ses.check(wcView, 'media', 'https://example.com'), false);
  assert.equal(await req(wcView, 'media'), false);
  assert.equal(ses.check(wcSrc, 'media', ORIGIN), true);
  assert.equal(await req(wcSrc, 'media'), true);

  view.close();
  assert.equal(ses.check(wcView, 'media', ORIGIN), false);
  src.close();
});
