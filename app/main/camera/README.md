<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->
# Camera (`app/main/camera`, owner: camera)

`create({ peer, devices, log, allowMedia, settings, multi })` → `{ get, setShared, on, watch, unwatch }`.
`peer` = peer channel or a getter (default `require('../pairing/peer').current()`); `devices` = DeviceStore;
`multi` = `{ get }` (default `settings.get('multi')`). `get()` → `{ shared, liveDeviceId, watchers, why? }`
(ids are device ids, `'this'` = this computer; `why` = last camera failure, e.g. permission). `setShared(bool)`
and `watch(id)` resolve with `get()`; they reject `{ code, message }`: `multi-off`, `not-shared`, `offline`,
`camera-denied`, `camera-failed`. `unwatch(id)` stops watching `id`, or, on the sharer, stops `id` watching.

One camera at a time: the device whose switch is on holds a claim `{ ts, prev }`; turning it on asks the live
device to stop first. Concurrent claims: newest `ts`, then lowest device id, wins on every device, so a
device that was away while another took over yields when it returns. The switch is saved as `{ shared, ts }`
and restored with its original `ts`. The camera
(hidden sandboxed capture window, macOS permission asked once) runs only while someone watches; each watcher
gets its own LAN-only WebRTC stream (`iceServers: []`, host candidates only) in a small always-on-top window.

Peer messages (payloads carry `to`; ids inside are `'me'`, `'you'` or a device id):
`camera.state` msg `{ to, shared, ts, prev, watchers }` · `camera.stop` req `{ to, ts }` ·
`camera.watch` req `{ to, sessionId }` · `camera.signal` msg `{ sessionId, kind, data }` ·
`camera.unwatch` msg `{ sessionId, reason }`.

Wiring in main (api/index.js), like `screenMod`:
- `const cameraMod = () => load('camera', { peer: () => require('../pairing/peer').current(), devices, log: log.child('camera'), allowMedia: security.allowMedia, settings, multi: { get: () => settings.get('multi') } })`;
  `cameraMod().on((v) => { broadcast('camera', v); emitDevices(); })`. Load it at startup (not only on the
  Camera page) so this device answers watch requests and announces its saved switch.
- Route `camera.get/setShared/on` to it (replacing the settings-only stub); add `camera.watch(deviceId)`,
  `camera.unwatch(deviceId)` (args `[t.str(64)]`). Proposed docs/API.md lines under `### camera`:
  `- camera.watch(deviceId)` → opens a small window with that device's camera; `camera.unwatch(deviceId)`.
  `- camera.get()` may also carry `why: string` when the camera could not start.
- Packaging: add `NSCameraUsageDescription` to `mac.extendInfo` (macOS refuses camera access without it).
