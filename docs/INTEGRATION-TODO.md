# Integration to-do (collected from agent reports)

For the main owner's integration pass, after wave 2 finishes.

## main (`app/main`, `app/package.json`, `app/electron-builder.config.js`)
- [x] Add deps: `@noble/curves@1.9.7`, `@noble/hashes@1.8.0`, `multicast-dns@7.2.5` (link installed them `--no-save`).
- [x] Pass `engine` and `devices` into `discovery.create(...)`.
- [x] Subscribe `pairing.onPaired(cb)` → `applyEngineConfig()` (the code-showing side doesn't run it).
- [x] Monitor layouts for the outer-edge rule on clients: on peer connect, ask the engine `monitors?`, send the result to each peer over the peer channel, and on receipt send `peerMonitors=<engineName>:[…]` to the local engine (server side).
- [x] `--ipc-version` output: trim the trailing newline before comparing.
- [x] Keep the engine log level at INFO or more detailed (the decision lines are INFO).
- [x] Clipboard history from `clipboardItem=` IPC: `at` is epoch ms, `to` can be `"*"`.
- [x] While a second-screen session is live, pause edge crossing toward that laptop (request from screen).
- [x] File clipboard: the engine never sends `kind:'file'` yet. Design the transfer over the peer channel (see `app/main/pairing/PEER.md`). *Done by the files module over the peer channel; main wires it into `clipboard.history/onItem`.*

## installer (NSIS via electron-builder + `build/`)
- [x] Windows firewall inbound allow: TCP 24800, TCP 24802 (pairing), TCP 24803 (peer channel), UDP 5353 (mDNS). *`build/installer.nsh`, program-scoped, local subnet; installer is now per-machine.*
- [x] Windows: Virtual Display Driver install step (elevated), from `native/windows-vdd/`.
- [x] macOS: bundle the Swift virtual-display helper (x64) in extraResources.

## known limits to tell the owner
- AppImage engine needs glibc ≥ 2.41 (doesn't run on Ubuntu 24.04).
- The engine's TLS cert is created by OmniDesk (node:crypto, X.509 v3) because deskflow-core doesn't create one.
- Discovery is IPv4 only; the link choice (`setLink`) isn't persisted yet.

## review findings so far (lead)
- [ ] Mock MacBook screen is still 1512×982 pt; the owner's MacBook is a 2018 Intel MacBook Pro (1440×900 pt). Update mock + any page copy.
- [x] Status bar says "1 of 2 devices connected" while Home says 2 of 3: define connected/total once (this device counts? offline paired devices count?) and use it everywhere. *main + docs/API.md: total = 1 + paired peers, connected = 1 + online paired peers; the mock and pages still have to match.*
- [ ] Shell: `.lh-scene svg { width: 100% }` stretches fixed-size device art (pages-b worked around it).
- [ ] Art: offline MacBook renders as a flat dashed box; make it read as a dimmed laptop.
- [ ] Engine (upstream bug spotted by DO-NOT-RENAME): mouse-button hotkeys may be dropped when the server config is read back.
- [ ] Engine: confirm `OSXKeyStateTests` (3 tests pressing real keys) also fails on unmodified upstream code here (likely needs Accessibility).
- [x] Packaging: deploy Qt frameworks next to deskflow-core for the app bundle (dev runs need DYLD_FRAMEWORK_PATH=~/Qt/6.9.3/macos/lib). *Packaged: deploy-*.{sh,ps1} → engine-dist → extraResources `engine/`. Dev: the supervisor passes the Qt lib folder itself (macOS strips DYLD_* from Electron).*
- [x] main: the name in `peerMonitors=` must equal the layout/engine screen name.
- [ ] Shell: built-in "Pair a new device" command should only go to `connection` (the page shows the code); today it calls pairStart itself.
- [ ] Shell: move page classes from pages' constructed stylesheets (.dev, .code, .amts, …) into components.css.
- [ ] Art: `multi-desk` with one device still draws placeholder Mac mini and MacBook.

## from screen
- [x] main: load `./screen` at startup (the receiving side must listen), pause crossing toward the remote of starting/live sessions; consider `--disable-features=WebRtcHideLocalIpsWithMdns`. *Flag not added: screen has no README asking for it, and its host-candidate filter accepts `.local` names.*
- [x] ci: build `native/macos-virtual-display` (x86_64) → extraResources `native/`; run `native/windows-vdd/fetch.mjs` → extraResources `vdd/`.
- [x] NSIS: run `install-vdd.ps1 -Action install` elevated on install (uninstall on removal); exit 3010 = reboot needed; may need the VC++ runtime. *VC++ runtime not bundled (not verified whether the VDD needs it); VDD installs on x64 Windows only.*
- [x] macOS Info.plist: `NSScreenCaptureUsageDescription`, `NSCameraUsageDescription`.
