# Deskflow codebase map (base for OmniDesk)

Source: https://github.com/deskflow/deskflow, commit `2877600` (2026-10-27), shallow clone in `deskflow/`.
Nothing has been changed yet.

## 1. What it is

A software KVM: one mouse, one keyboard and one clipboard across Windows, macOS and Linux
(X11 and Wayland). It descends from Synergy (2002, Chris Schoeneman) and Barrier.

| | Your brief assumed | Deskflow actually is |
|---|---|---|
| License | GPL-3.0 | **GPL-2.0-only WITH OpenSSL exception**. "Only" means we can't relicense to GPL-3.0, so OmniDesk ships as GPL-2.0-only. |
| UI | Electron per OS, shared plain JS | **C++20 + Qt 6** desktop GUI |
| Native helpers | C# (Windows), Swift (macOS) | **C++** platform layer, plus a few Objective-C files on macOS. No C#, no Swift. |
| Build/packaging | electron-builder, NSIS, .dmg | **CMake + CPack**: WiX MSI on Windows, DragNDrop .dmg on macOS, Flatpak/Arch/.deb on Linux |

Every file carries an SPDX header like this one, which we keep:
```
SPDX-FileCopyrightText: (C) 2025 Deskflow Developers.
SPDX-FileCopyrightText: (C) 2012 Synergy App Ltd
SPDX-FileCopyrightText: (C) 2002 Chris Schoeneman
SPDX-License-Identifier: GPL-2.0-only WITH LicenseRef-OpenSSL-Exception
```

## 2. Processes (the three binaries)

```
 deskflow (Qt GUI) ──IPC (local socket)──▶ deskflow-core  ◀──TLS TCP :24800──▶ deskflow-core on other PC
        │                                   (server = has the real mouse,
        └── Windows only: deskflow-daemon     client = receives input)
            (service; starts core in the
             logged-in user's session, survives UAC / lock screen)
```

| Binary | Path | Role |
|---|---|---|
| `deskflow` | `src/apps/deskflow-gui` → `src/lib/gui` | Settings, layout editor, log view, tray icon. Starts and stops core. |
| `deskflow-core` | `src/apps/deskflow-core` | **The engine.** Runs as `server` or `client`. Captures/injects input, syncs clipboard. This is what your brief calls "the native helper". |
| `deskflow-daemon` | `src/apps/deskflow-daemon` | Windows service. Needed for input on the secure desktop (UAC, Ctrl+Alt+Del, login screen). |

## 3. Library modules (`src/lib`, ~79k lines of C++)

| Module | Lines | What it does |
|---|---:|---|
| `platform` | 27.7k | **OS input and clipboard.** `MSWindows*`: low-level hooks (`MSWindowsHook`), SendInput injection, desks/secure desktop, clipboard converters (text, HTML, bitmap). `OSX*`: Quartz event taps, key layouts, pasteboard, media keys. `Ei*`/`Portal*`: Wayland via libei and XDG portals. `XWindows*`: X11. |
| `deskflow` | 12.6k | Shared core: wire protocol (`ProtocolTypes`), `ServerApp`/`ClientApp`, `Computer` (wraps the platform screen), key maps, IPC to the GUI (`ipc/`). |
| `gui` | 10.0k | Qt UI: `MainWindow`, `dialogs/` (settings, server config), `config/` (layout grid model, computer and link options), `widgets/`, `TlsUtility` (certificate and fingerprint). |
| `server` | 8.4k | **Edge-crossing brain.** `Server.cpp`: tracks cursor, decides when to switch computers, forwards input. `Config`: layout (who is left/right/top/bottom of whom), options. `ClientProxy1_0`–`1_8`: one class per protocol version. |
| `arch` | 6.1k | OS abstraction: threads, sockets, daemon/service, logging sinks. |
| `net` | 4.0k | TCP + **TLS** (`SecureSocket`, OpenSSL), `FingerprintDatabase` (trust on first use: you confirm the peer's fingerprint once). |
| `base`, `mt`, `io`, `common` | ~7.8k | Event queue, logging, strings, threads, streams. `common/Settings.cpp`: every config path, the default port, defaults. |
| `src/unittests` | — | Qt Test unit tests per module. |

Other folders: `deploy/` (installers per OS), `translations/` (Qt .ts), `docs/`,
`.github/workflows/` (CI already builds every OS).

## 4. How a crossing works today

`Server::onMouseMovePrimary` (src/lib/server/Server.cpp:1611):

1. Takes the primary computer's shape: the **bounding box of the whole desktop** (all monitors).
2. If the cursor is within the *jump zone* (a few pixels) of a box edge, that's the direction.
3. `mapToNeighbor` looks up who sits on that side in the layout config.
4. `isSwitchOkay` (line 784) can veto: no neighbour, double-tap required, switch delay,
   locked corner, Scroll Lock, or **a mouse button held** (`Computer::isLockedToComputer` →
   `isAnyMouseButtonDown`).
5. `switchComputer` hides the local cursor, sends `CINN` (enter) to the destination and
   `COUT` (leave) to the source. On the secondary, `onMouseMoveSecondary` (line 1708) works
   the same way with relative moves.

### Against your non-negotiable rules

| Rule | Today | Work needed |
|---|---|---|
| Only cross on the **outer** edge | Edge = bounding box of all monitors. With monitors of different sizes or offsets, parts of the box edge sit beside empty space and parts sit on a real monitor's inner edge, so it's not reliably per monitor. | Per-monitor test: cross only if no monitor continues past that edge at that point. Windows (`MSWindowsHook` zone) and macOS (`OSXComputer`). |
| No crossing while a button is held | ✅ Already there (primary side) | Check the secondary side too. |
| Cooldown after a crossing | ❌ Missing | Add a timer in `Server`. |
| No crossing right after arrival | ❌ Missing (only `avoidJumpZone` nudges the landing point) | Add an arrival grace period. |
| Log why a push did **not** cross (reason, edge, position, monitor layout), max 1 line / 2 s | ❌ Reasons only at `VERBOSE` level, no rate limit, no layout | New rate-limited log line in `isSwitchOkay` and the edge checks. |
| Log start mode and the helper launched | Partly (core logs server/client) | Add an explicit start-up line in the app and in core. |

## 5. Your feature list against the engine

| Feature | Status in Deskflow |
|---|---|
| One mouse + keyboard, edge crossing | ✅ Core feature |
| Screen layout editor | ✅ Qt grid editor (would be rebuilt in the new UI) |
| Clipboard: text, HTML, images | ✅ |
| Clipboard: **files**, drag-and-drop across the edge | ❌ Protocol messages exist (`DFTR`, `DDRG`) but the handlers are empty stubs (`ClientProxy1_5.cpp:49`) |
| More than two devices | ✅ Already supports many clients |
| Encrypted traffic | ✅ TLS |
| Pair once **with a code** | ⚠️ Today it's fingerprint confirmation (TOFU). A short pairing code needs new work (e.g. code-verified key exchange). |
| No account, no cloud | ✅ Peer to peer on the LAN |
| Wi-Fi | ✅ (TCP/IP) |
| USB cable, Bluetooth | ❌ TCP only. Realistic path: IP over the link (Thunderbolt/USB networking, Bluetooth PAN) plus discovery, not a raw USB/BT protocol. |
| **Second screen** (laptop as extra display) | ❌ Not in the engine at all: needs screen capture, a virtual display driver, video encode/decode and streaming. A separate subsystem. |
| **Camera between computers** | ❌ Not in the engine at all: needs capture, streaming, and a virtual camera on the receiver (a signed driver/extension per OS). |
| Dashboard, Ctrl+K command bar, Tip/Feedback pages | ❌ New UI work |

## 6. Identifiers that already matter (preview of the do-not-rename list)

The full list comes in the rebrand phase. These can't change without breaking other devices or existing installs:

- **Wire protocol:** 4-letter message codes (`CINN`, `COUT`, `DMMV`, `DCLP`, `CALV`, …),
  hello names `"Barrier"` / `"Synergy"`, protocol version 1.8.
- **Port** `24800`.
- **`kAppId`** = CMake `project(deskflow)` (`src/lib/common/Constants.h.in`). It drives the
  `deskflow-server.conf`, the TLS cert `tls/deskflow.pem`, log names, translation and
  icon-theme names. **`kAppName`** (`CMAKE_PROJECT_PROPER_NAME "Deskflow"`) drives the
  settings folder, `Deskflow.conf` (which also holds the screen layout), the Windows service
  name and events. Trusted devices live in `tls/trusted-servers` and `tls/trusted-clients`.
  **Renaming either silently moves all settings and trusted devices.** Full list:
  `docs/DO-NOT-RENAME.md`.
- **Bundle / package id** `org.deskflow.deskflow` (macOS, Flatpak, .desktop). Changing it
  resets macOS Accessibility and Input Monitoring permissions.
- **Binary names** `deskflow-core`, `deskflow-daemon` (Windows service and firewall rules
  reference them).
- No URL scheme exists today.

## 7. What this means for the plan

1. **Architecture.** Your brief asks for Electron with "native helpers". The cleanest fit:
   **Electron OmniDesk app (new UI) + `deskflow-core` as the native helper**, driven over
   the existing IPC/command line. The Qt GUI would be retired or kept only for Linux. The
   engine stays C++, so the C#/Swift helper items in the brief turn into C++ work in
   `platform/` and `server/`.
2. **License:** OmniDesk is GPL-2.0-only. About credits Deskflow, Synergy and Chris Schoeneman.
3. **Packaging:** move from CPack (MSI/WiX) to electron-builder (NSIS x64+ARM64, .dmg arm64,
   AppImage) bundling `deskflow-core` per OS. The existing CI shows how to build core on each OS.
4. **Scope warning.** Second screen and camera sharing are each a project the size of the
   whole KVM: video pipelines plus virtual display/camera drivers that need code signing
   on Windows and a system extension on macOS. I'd ship the KVM features first and put
   those two behind "coming soon" in the concepts, unless you want them in 2.5.0.
