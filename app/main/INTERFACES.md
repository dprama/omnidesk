<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->
# app/main interfaces for the link and screen agents

`app/main/api/index.js` loads your folder lazily with `require('./<name>/index.js')` and calls
`create(args)` once. Until the file exists, the matching `window.omnidesk` methods reject with
`{ code: 'not-ready', message: 'This part of OmniDesk is still being built.' }`.
Throw `{ code, message }` (plain object or an Error with a string `code`) for user-facing errors;
other exceptions become `{ code: 'internal' }` and are logged.

## pairing (`app/main/pairing/index.js`, owner: link)

```js
exports.create = ({ settings, engine, log, devices }) => ({
  start(),               // -> { code: '482915', expiresAt }   (connection.pairStart)
  enter(deviceId, code), // -> Device (or { id })             (connection.pairEnter; code is 6 digits)
  cancel(),              // -> void                           (connection.pairCancel)
  forget?(deviceId),     // optional: drop its fingerprint from tls/trusted-* (devices.forget)
});
```
- `devices.upsert({ id, name, os, osVersion, arch, screens, engineName, host, link, paired: true })`
  adds/updates a paired device (persisted). `engineName` = the peer's engine `core/computerName`;
  it is what goes into the server config and `computer_<name>/name`. `host` is used for ping.
- `engine.paths` → `{ settingsFile, settingsDir, tlsDir, certificate, trustedServers, trustedClients, ipcPath }`
  (kAppName "Deskflow" paths, see docs/DO-NOT-RENAME.md). Write fingerprints there.
- `engine.restart(mode)`, `engine.send(cmd, value)`, `engine.on('ipc', (cmd, value) => …)`
  (e.g. `peerFingerprint`), `engine.readSetting('group/key')`, `engine.writeSettings({ 'group/key': v })`.
- `settings.get/set/patch(key)` for your own key (use `settings.patch('pairing', …)`).

## discovery (`app/main/discovery/index.js`, owner: link)

```js
exports.create = ({ log }) => ({
  onFound(cb),          // cb(Device[]) with every change: unpaired devices seen on the network
  linkFor(deviceId),    // -> { type: LinkType, available: LinkType[], address: string } | null
  setLink(deviceId, t), // -> Promise; prefer that link type
});
```
main pings `linkFor(id).address` on TCP 24800 every 5 s for online paired devices.

## screen (`app/main/screen/index.js`, owner: screen)

```js
exports.create = ({ engine, log, allowMedia }) => ({
  get(),        // -> screen.get() shape from docs/API.md
  start(opts),  // -> Session  ({ sourceId, targetId, resolution, refresh, quality })
  stop(id),     // -> void
  on(cb),       // cb(whole screen.get() shape) on every change
});
```
`allowMedia(webContents)` grants media/display-capture permission to that webContents
(everything else is denied); it returns a revoke function. Also exported from `main/main.js`.

## Engine names other agents must match

- Server config options (in `section: options`, ms): `omnideskCrossCooldown`, `omnideskArrivalGuard`.
  Also mirrored in `Deskflow.conf` as `server/omnideskCrossCooldown`, `server/omnideskArrivalGuard`.
  Note: today `Config::readSectionOptions` skips every line that is not `keystroke`/`mousepress`;
  the engine must parse these two.
- Proposed core IPC commands sent by main (app → core): `clipboard=on|off`, `mouseSharing=on|off`,
  `lockCursor=on|off`. Proposed core → app: `cursor=<computerName>,<x>,<y>`,
  `clipboardItem=<ClipItem JSON>`. Already used: `connectedClients=a,b`, `connectionState=…`.
- Hello version: main runs `deskflow-core --ipc-version` and expects one line `<kVersion>+<sha>`;
  if missing it falls back to the `--version` number and tolerates `versionMismatch`.
- Decision lines are read from the core's stdout/stderr: `… cross edge=… pos=(x,y) to=<computerName> …`
  and `… no-cross reason=<reason> …`; the timestamp `[YYYY-MM-DDTHH:MM:SS]` is taken from the line.
- Start command: `deskflow-core <server|client> --settings <engine Deskflow.conf>`. The server
  config path is set with `server/externalConfig=true`, `server/externalConfigFile=<userData>/engine/deskflow-server.conf`.

## Wiring done by main (`api/index.js`)

- Startup order: settings → engine supervisor → devices → pairing (`onPaired` → `applyEngineConfig()`)
  → peer channel (`pairing/peer.create`) → discovery (`{ log, engine, devices }`) → screen → camera → files.
- Peer message `engine.monitors` (msg) `{ monitors: "[x,y,WxH]…" }`: sent by every device to a peer when
  their channel comes up (and when its displays change); the value is its engine's `monitors?` answer
  (Electron's display list until the engine answers). The receiving **server** sends
  `peerMonitors=<engineName>:<monitors>` to its engine (`engineName` = that device's name in the server
  config) and replays it after every engine restart; on disconnect it sends `peerMonitors=<engineName>:`.
- Second screen: while a session is `starting`/`live`, the server config has no links INTO its
  `targetId` (the laptop showing the screen); links out of it stay. Restored when the session ends.
- Clipboard history merges the engine's `clipboardItem=` (engine names → device ids, `to` may be `*`,
  `at` epoch ms; main adds the `id`) and the files module's items.
