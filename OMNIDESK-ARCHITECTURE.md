# OmniDesk architecture (recommendation)

Built from your brief and the Deskflow map (`OMNIDESK-MAP.md`). Nothing is built yet.

## Decision in one line

**One Electron app (plain JS, shared across all OSes) is the face and the brain for
pairing, discovery and settings. The forked Deskflow `deskflow-core` (C++) is the native
helper that moves the mouse, the keyboard and the clipboard.** No C# or Swift input helpers:
the engine already does that job in C++, and a second input stack would mean two sets of bugs.

```
┌──────────────────────── OmniDesk.app / OmniDesk.exe ────────────────────────┐
│ Renderer (plain JS pages, sandboxed)                                         │
│   Home · Connection · Mouse & keyboard · Clipboard · Layout · Camera · …     │
│   Ctrl+K command bar  ──calls──▶  window.omnidesk.*  (the only API)          │
│────────────────────────────── preload (contextBridge) ───────────────────────│
│ Main process (Node)                                                          │
│   core-supervisor   start/stop/restart deskflow-core, log start mode+helper  │
│   core-ipc          line protocol over named pipe / unix socket              │
│   config-writer     layout editor → deskflow-server.conf                     │
│   pairing           6-digit code → exchange + pin TLS fingerprints           │
│   discovery         mDNS on every interface (Wi-Fi, USB, Bluetooth PAN)      │
│   files             file clipboard + drag-drop payloads (TLS side channel)   │
│   media (phase 2)   WebRTC for second screen and camera                      │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ spawns, IPC
        ┌───────▼────────┐   TLS :24800 (Deskflow protocol, unchanged)  ┌──────────────┐
        │ deskflow-core  │◀───────────────────────────────────────────▶│ deskflow-core │
        │ server|client  │                                              │ on other PC   │
        └────────────────┘                                              └──────────────┘
  Windows only: deskflow-daemon service (input on UAC and login screens)
```

## Why this shape

| Brief asks for | How this delivers it |
|---|---|
| Electron + shared plain JS | One codebase in `app/`. Per-OS differences live only in packaging and in which core binary is bundled. ("Electron per OS" becomes one Electron app built per OS.) |
| Native input helpers | `deskflow-core`, built per OS and arch (win-x64, win-arm64, mac-arm64, linux-x64). |
| contextIsolation, no nodeIntegration, preload exposes only the app API | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`, strict CSP, no remote URLs, every IPC handler checks the sender. Preload exposes one frozen `window.omnidesk` object with named methods, never raw `ipcRenderer`. |
| Pair once with a code, encrypted, no cloud | Keep Deskflow's TLS. Add a **PAKE pairing step** (SPAKE2 over a 6-digit code shown on one screen and typed on the other). It exchanges TLS certificate fingerprints and writes them to the engine's trusted-fingerprint files. After that the engine connects with pinned TLS, so the wire protocol stays untouched. |
| Wi-Fi, USB cable, Bluetooth | All three are carried as IP links: Wi-Fi/LAN, USB/Thunderbolt networking, Bluetooth PAN. Discovery (mDNS) runs on every interface and the UI shows which link is in use. No raw USB or Bluetooth protocol: that would mean drivers and would be slower. |
| Edge-crossing rules + "why no crossing" log | Done **inside the engine** (`server/Server.cpp`, `platform/MSWindowsHook`, `platform/OSXComputer`), because only the engine sees every mouse event and the real monitor layout. Cooldown and arrival-grace values come from the app's settings. The rate-limited reason line goes into the core log, and the app tails that log. |
| App logs start mode and helper | `core-supervisor` logs e.g. `start mode=server helper=/Applications/OmniDesk.app/…/deskflow-core v1.x+sha`. |
| Fake backend for isolated test windows | The `window.omnidesk` API is the seam. `app/mock/` implements the same API with realistic data (devices, ping, battery, layout, camera viewers). Each page can open in a test window with `?mock=1`, with no engine and no network. This is what lets parallel agents work without breaking each other. |
| Ctrl+K that does real actions | Commands are a registry of `{ id, title, keywords, run() }`, and `run()` calls the same `window.omnidesk` methods as the buttons. "turn on clipboard" → `omnidesk.clipboard.setEnabled(true)`. |
| Feedback with optional system info | The renderer builds the report. System info is added only after an explicit checkbox, and the preview shows exactly what will be sent. |

### How the app talks to the engine (already in Deskflow)

- **Launch:** `deskflow-core server|client` plus options and a config file.
- **IPC:** a line-based text protocol over a local socket (`QLocalServer`: named pipe on
  Windows, unix socket on macOS). Existing commands are `hello`, `noop`, `connectionState`;
  the daemon adds `start`, `stop`, `configFile`, `logLevel`, `logPath`. Node's `net` module
  can speak this directly, so no native Node addon is needed.
- **New IPC commands** (added to the engine): `clipboard on|off`, `status` (connected
  peers, active screen), `crossing` events for the UI's live cursor map, and `files` hooks.

## Where each feature lives

| Feature | Engine (C++) | App (JS) | Size |
|---|---|---|---|
| Edge crossing + rules + logging | ✔ main work | settings UI | M |
| Layout editor | config format | ✔ editor → writes config | M |
| Clipboard text / image | ✔ exists | on/off, status | S |
| Clipboard files, drag-drop across edge | ✔ native drag source/target hooks per OS, `DFTR`/`DDRG` stubs filled in | ✔ file transfer channel, progress UI | **L**: hardest KVM feature |
| Multi-device | ✔ exists | ✔ UI | S |
| Pairing code | trust-file format only | ✔ PAKE + discovery | M |
| Home dashboard, ping, battery | `status` IPC | ✔ (battery via OS APIs in main) | S |
| **Second screen** | none | WebRTC capture/stream; a **virtual display driver** to *extend* (Windows IddCx driver needs EV code signing, macOS virtual display API) | **XL** |
| **Camera between computers** | none | WebRTC; a **virtual camera** for Zoom/Teams to see it (Windows 11 virtual camera API, macOS Camera Extension, which needs an Apple Developer ID) | **XL** |

## Repository layout

```
omnidesk/
  engine/            Deskflow fork (git subtree, so upstream fixes can still be merged)
  app/
    main/            supervisor, ipc, pairing, discovery, files, settings, logging
    preload/         window.omnidesk
    renderer/        pages, components, command bar, illustrations, fonts (bundled)
    mock/            fake backend + test-window launcher
  site/              website (static, strict CSP), Download button picks OS/arch
  build/             electron-builder config, dmg background HTML → PNG
  .github/workflows/ build-engine (matrix) → package-app (matrix) → release on v*
  LICENSE            GPL-2.0-only (+ OpenSSL exception, as upstream)
```

## Settings, names and compatibility

- App settings: `OmniDesk` in the OS user-data folder. Pick this name once and never change it.
- Engine settings and trusted devices: keep `kAppId = deskflow` inside the engine, so the
  config, TLS and fingerprint paths stay where the engine expects them. OmniDesk then also
  connects to plain Deskflow, Barrier and Synergy-protocol machines, for free.
- Port 24800 and the protocol stay unchanged. The rebrand only touches what users see.

## Packaging

- electron-builder, `publish: 'never'`; the release upload is a separate CI step with `gh release upload`.
- Windows: NSIS for x64 and arm64, bundling `deskflow-core.exe` and `deskflow-daemon.exe`.
  The installer registers the service and the firewall rule.
- macOS: Intel (x64) .dmg only, as decided on 2026-11-01, with your background (HTML rendered to PNG in CI). Unsigned for now,
  hence the README steps: `xattr -dr com.apple.quarantine /Applications/OmniDesk.app`, then
  allow Accessibility and Input Monitoring.
- Linux: AppImage (x64). The engine needs X11 or libei on Wayland.

## Risks to know now

1. **Unsigned builds.** SmartScreen and Gatekeeper warnings come every release. On macOS,
   each unsigned rebuild can reset Accessibility and Input Monitoring permissions, so users
   may have to re-allow after updates. Apple Developer ID ($99/yr) and a Windows code-signing
   certificate fix this. Both are also required before second screen and camera are possible.
2. **Secure desktop on Windows** (UAC, lock screen) needs the daemon service. Without it the
   mouse can't cross while those screens are showing.
3. **Files and drag-and-drop** are native work on two OSes. I'd scope them as a 2.5.x item if
   time runs short, keeping the file clipboard (copy here, paste there) in 2.5.0.

## Scope (updated: no 2.5.0 cut, second screen is in)

In: edge crossing with your rules, layout editor, clipboard (text, image, files), multi-device,
pairing code, Wi-Fi/USB/Bluetooth as IP links, dashboard, Ctrl+K, Tip, Feedback, site, CI,
**second screen**. Later: drag-and-drop across the edge, camera.

## Second screen design

| Part | Windows extends onto a laptop | Mac extends onto a laptop |
|---|---|---|
| Virtual monitor | Bundled **Virtual Display Driver** (github.com/VirtualDrivers/Virtual-Display-Driver, MIT, already signed via SignPath Foundation, x64 + ARM64). The installer adds it; the app turns the monitor on and off. ARM64 on Windows 11 24H2+ may need test signing. | `CGVirtualDisplay` through a small **Swift helper**. It's a private Apple API (used by tools like BetterDisplay): no driver, but a macOS update could break it. |
| Capture | Windows Graphics Capture of that monitor | ScreenCaptureKit (needs Screen Recording permission) |
| Stream | WebRTC in Electron, hardware H.264, LAN only, keys from the pairing | same |
| Receiver | Full-screen OmniDesk window on the laptop, any OS | same |
| Input | The cursor simply moves onto the virtual monitor. Engine edge crossing is paused for that laptop while it's a screen. | same |

**Decided (2026-11-01):** both directions. The user's Windows PC is x64, so the signed
driver works without test signing. Mac → Windows uses the Swift helper.

Expected latency is roughly 30–80 ms on good Wi-Fi at 1080p60, lower over a cable.
Fine for documents, chat and video; not for games.

## Quality bar (TeamViewer, AnyDesk)

Both websites are marketing pages with almost no real app UI to copy, which suits the
"match the polish, not the brand" goal. The useful takeaways:
- **One clear primary action per screen**: both lead with a single big button ("Free Download",
  "Download Now") and few choices around it.
- **Large, plain-English headlines and short sentences**: no jargon on the first screen.
- **Device-first imagery**: a laptop or desktop with the product inside. Your monochrome device kit fits this.
- **Calm palette with one accent**: TeamViewer navy/white, AnyDesk white with a red accent.
  OmniDesk goes dark with one accent per feature, as in your brief.
- **Where we can beat them**: both apps ask for an ID and password on every connect.
  OmniDesk pairs once and then just works, so Home should show devices that are
  ready, not a connect form.
