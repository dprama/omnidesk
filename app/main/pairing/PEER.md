<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->
# Peer channel (`app/main/pairing/peer.js`, owner: link)

An encrypted message channel between **paired** devices, for second-screen signalling,
file transfer and anything else that is not the engine's own protocol.

```js
const { peer } = require('../pairing');          // or require('../pairing/peer')
const ch = peer.create({ engine, devices, log }); // one shared instance per process; later calls return it

ch.send(deviceId, type, payload)                 // -> Promise<void>, resolves once written
ch.request(deviceId, type, payload, { timeoutMs = 15000 }) // -> Promise<reply payload>
ch.on(type, (deviceId, payload, reply) => { … }) // -> unsubscribe()
ch.isConnected(deviceId)                         // -> boolean
```

- `deviceId` is the id from `devices.list()` (first 20 hex chars of the peer's certificate fingerprint).
- `payload` is any JSON value. One message (the whole JSON frame) may be at most **1 MiB**;
  bigger sends reject with `{ code: 'too-large' }`. Split files into chunks.
- Handlers for a `request`: call `reply(value)`, or `reply.error({ code, message })`, or return a
  value / Promise (its result is the reply; a throw or rejection becomes the error). A request with
  no handler on the other side rejects with `{ code: 'no-handler' }`. For `send`, `reply` does nothing.
- `send`/`request` connect on demand. Errors: `not-paired` (no trusted fingerprint), `offline`
  (can't reach it), `untrusted` (its certificate changed), `disconnected`, `timeout`, `too-large`,
  or the code the other side passed to `reply.error`.
- Messages arrive in order per device. Delivery is not guaranteed across a disconnect: retry at
  your level if needed.

## Transport

- TCP **24803**, TLS 1.3, **mutual** authentication with each device's engine certificate and key
  (`tls/deskflow.pem`). A connection is accepted only if the peer's certificate SHA-256 fingerprint
  is in `tls/trusted-servers` or `tls/trusted-clients` (written by pairing), and an outgoing
  connection only if the server's fingerprint equals the one stored for that device at pairing.
- Address: discovery's `linkFor(deviceId).address` (so the user's link choice applies), else the
  `host` saved at pairing.
- Frames: 4-byte big-endian length, then UTF-8 JSON: `{t:'msg',type,payload}`,
  `{t:'req',id,type,payload}`, `{t:'res',id,ok,payload|error}`.
- Every paired device is kept connected; lost connections retry with exponential backoff
  (1 s doubling to 60 s, with jitter). Forgetting a device (removing its fingerprint) closes its
  channel on the next `devices` change.
