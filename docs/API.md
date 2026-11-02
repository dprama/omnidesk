# `window.omnidesk`: the app API contract

The preload exposes exactly one frozen object, `window.omnidesk`. Pages, the shell and the
command bar use only this. `app/main` implements it for real; `app/mock` implements it with
fake data. Both must match this file exactly. Changes go through the lead.

Conventions:
- Every method returns a Promise. Getters resolve to plain JSON (structured-clone safe).
- `on*(cb)` subscribes and returns an `unsubscribe()` function. Subscribers get the current
  value immediately, then every change.
- Setters take a partial patch and resolve to the full new state.
- Errors reject with `{ code, message }`, where `message` is user-facing plain English
  (e.g. `{ code: 'not-paired', message: 'Pair the MacBook first.' }`).
- Device ids are stable strings (`this` = this device).

## Types

```ts
type OS = 'windows' | 'macos' | 'linux';
type LinkType = 'ethernet' | 'wifi' | 'usb' | 'bluetooth';
type Rect = { x: number; y: number; w: number; h: number };       // pixels, desktop coords

type Device = {
  id: string; name: string; os: OS; osVersion: string; arch: 'x64' | 'arm64';
  thisDevice: boolean; online: boolean; paired: boolean;
  lastSeen: string | null;                                         // ISO time, null if online
  link: { type: LinkType; pingMs: number | null; available: LinkType[] } | null;
  battery: { percent: number; charging: boolean } | null;          // null on desktops
  screens: Rect[];                                                 // monitor layout, pixels
  sharing: { mouse: boolean; clipboard: boolean; screen: boolean; camera: boolean };
};

type Status = {
  role: 'server' | 'client' | 'off';      // engine mode this device runs in
  connected: number; total: number;        // see "connected / total" below
  cursorOn: string;                        // device id where the cursor is now
  clipboard: boolean; mouse: boolean;
  link: { deviceId: string; type: LinkType; pingMs: number } | null;   // main peer link
  encrypted: boolean;
  engine: { running: boolean; version: string; helperPath: string; reason?: string }; // reason when not running
};
```

`connected` / `total` (one definition, used by main, the mock, the status bar and Home):
- `total` = paired devices **including this one** (`1 + paired peers`).
- `connected` = **this device** + paired devices that are online now (`1 + online paired peers`).
  So with nothing paired it reads "1 of 1"; offline paired devices count in `total` only.

## Methods

### app
- `app.info()` → `{ version: '2.5.0', engineVersion, os, osVersion, arch, licence: 'GPL-2.0-only' }`
- `app.openExternal(url)`: only `https:` URLs on an allowlist (`github.com`, the project site).
- `app.logs.tail(n)` → `string[]`; `app.logs.onLine(cb)`.

### status
- `status.get()` → `Status`; `status.on(cb)`.

### devices
- `devices.list()` → `Device[]`; `devices.on(cb)`.
- `devices.rename(id, name)`, `devices.forget(id)`.

### mouse (mouse & keyboard sharing)
- `mouse.get()` → `{ enabled, cooldownMs, arrivalGuardMs, lockHotkey: 'Ctrl+Alt+L', locked }`
  The button-held rule is always on; it isn't a setting.
- `mouse.set(patch)`.
- `mouse.onCursor(cb)` → `{ deviceId, x, y }` at most 20 per second (for the live map).
- `mouse.onDecision(cb)` → one line per crossing decision, exactly the engine's log format:
  `HH:MM:SS cross edge=right pos=(4479,640) to=MacBook cooldown=300ms`
  `HH:MM:SS no-cross reason=not-outer-edge edge=right pos=(2559,812) monitors=[0,0,2560x1440][2560,180,1920x1080]`
  Reasons: `not-outer-edge`, `outside-zone`, `button-held`, `cooldown`, `arrival-guard`,
  `locked`, `sharing-off`, `no-neighbour`.

### layout
- `layout.get()` → `{ placements: { [deviceId]: { x, y } }, edges: Edge[] }` where
  `Edge = { from: deviceId, fromEdge: 'left'|'right'|'top'|'bottom', to: deviceId, overlapPx }`.
  Edges are computed by main from placements + screens, only on OUTER edges.
- `layout.set({ placements })` → writes the engine config and restarts the engine if needed.

### clipboard
- `clipboard.get()` → `{ enabled, maxFileMB: 100, files: true }`; `clipboard.set(patch)`.
- `clipboard.history()` → `ClipItem[]` (newest first, max 20), `clipboard.onItem(cb)`.
  `ClipItem = { id, kind: 'text'|'image'|'file', from, to, at, text?, width?, height?, name?, bytes?, progress? }`

### screen (second screen)
- `screen.get()` → `{ sessions: Session[], can: { extendThis: boolean, showHere: boolean, why?: string },
  options: { resolutions: ['1920x1080','2560x1600'], refresh: [60], quality: ['latency','balanced','sharp'] } }`
  `Session = { id, sourceId, targetId, resolution, refresh, quality, state: 'starting'|'live'|'stopping', latencyMs, fps }`
- `screen.start({ sourceId, targetId, resolution, refresh, quality })` → `Session`.
- `screen.stop(sessionId)`; `screen.on(cb)` (whole `screen.get()` shape).

### camera (multi-device mode)
- `camera.get()` → `{ shared: boolean, liveDeviceId: string|null, watchers: deviceId[] }`
- `camera.setShared(bool)`; `camera.on(cb)`. Only one camera runs at a time. `get()` may add
  `why` (e.g. camera permission denied). Turning multi-device mode off turns sharing off.
- `camera.watch(deviceId)` opens a viewer window for that device's shared camera;
  `camera.unwatch(deviceId)` closes it. The camera runs only while someone watches.

### connection
- `connection.onFound(cb)` → `Device[]` seen on the network but not paired yet.
- `connection.pairStart()` → `{ code: '482915', expiresAt }`: this device shows the code.
- `connection.pairEnter(deviceId, code)` → `Device`: the other device types it.
- `connection.pairCancel()`; `connection.setLink(deviceId, LinkType)`.

### multi (multi-device mode)
- `multi.get()` → `{ enabled }`; `multi.set({ enabled })`.

### feedback
- `feedback.systemInfo()` → exactly what would be attached: `{ os, osVersion, arch, appVersion,
  engineVersion, monitors: Rect[], devices: number }`. No names, emails or device names.
- `feedback.send({ kind: 'bug'|'idea'|'thanks', message, includeSystemInfo })` → opens a
  pre-filled GitHub issue in the browser (no server). Resolves `{ opened: true }`.

### tip
- `tip.open(amount)` → opens the tip page in the browser. URL comes from settings.

## Command bar
The command registry lives in `app/renderer/shell/commands.js`. Each command is
`{ id, title, keywords, group, run(api) }` and only calls `window.omnidesk` methods, so
"Turn on clipboard" runs `omnidesk.clipboard.set({ enabled: true })`, exactly like the toggle.
Pages may register extra commands through `shell.registerCommands([...])`.

## Renderer module contracts

Plain JS ES modules, no framework, no bundler. Entry: `app/renderer/index.html` loads
`shell/main.js` as a module. In Electron the renderer is served from the custom `app://omnidesk/`
protocol; in the test window it's served from a local static server. Paths are relative, so both work.

**Page module** (`app/renderer/pages/<id>.js`):
```js
export default {
  id: 'mouse', label: 'Mouse & keyboard', tab: 'Mouse', group: 'share',   // home | share | devices | more
  accent: 'var(--c-mouse)', icon: 'mouse',
  mount(el, api, shell) { /* fill el, subscribe via api.*.on*, return unmount() */ }
};
```
Page ids: `home, mouse, layout, clipboard, screen, camera, connection, devices, tip, feedback, about`.
`el` is the inside of the front folder sheet. The page draws its own live header with the
shared classes (`.lh`, `.kick`, `.stats`) and its body with `.card`, `.row`, `.switch`, etc.
`unmount()` must remove every subscription, timer and animation frame.

**Shell object** passed to pages: `shell.go(id)`, `shell.toast(text)`,
`shell.registerCommands(cmds)` → unregister, `shell.reducedMotion` (boolean, live),
`shell.openCommandBar(query?)`.

**Art** (`app/renderer/art/index.js`):
- `device(kind, { size, accent, state })` → `SVGSVGElement`, where kind is `windows-pc`
  (monitor + tower), `windows-pc-2` (two monitors + tower), `macbook` or `mac-mini`, and
  state is `online`, `offline` or `active`.
- `scene(name, host, { accent, reducedMotion })` → `{ update(data), stop() }`. Names: `desk`
  (home), `radar` (connection), `screen-map` (mouse: takes `update({ screens, cursor })`),
  `clipboard-hop`, `display-slide` (second screen), `camera-watch`, `multi-desk`, `tip-jar`,
  `feedback-note`, `about-credits`. With reducedMotion, scenes draw one still frame.

**Styles** (`app/renderer/styles/`): `tokens.css` (all colors, feature accents `--c-home,
--c-conn, --c-mouse, --c-layout, --c-clip, --c-screen, --c-cam, --c-multi, --c-tip, --c-fb,
--c-about`, radii, fonts), `components.css` (shared classes). Fonts are bundled woff2 files
in `app/renderer/fonts/`, never loaded from the network. CSP: `default-src 'self';
img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self';
connect-src 'self'`. No inline scripts, no `<style>` blocks and no `style="…"` attributes anywhere, including in
HTML strings built in JS: the CSP blocks them. Set dynamic styles with `el.style.setProperty()`
(CSSOM is allowed), or use classes.
