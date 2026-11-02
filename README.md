<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->

# OmniDesk

One mouse, one keyboard and one clipboard across your computers, plus a laptop as a second
screen. Windows, macOS and Linux. Free and open source, no account, no cloud: everything stays
on your local network.

## Features

- **Mouse and keyboard sharing.** Move the pointer off the edge of one screen and it appears on
  the next computer. Crossing only happens on outer screen edges, with a short cooldown and an
  arrival guard so the pointer doesn't bounce back. A log explains every refused crossing.
- **Screen layout editor.** Drag your computers into place; OmniDesk works out the edges.
- **Clipboard.** Copy text, images and files on one computer, paste on another.
- **Pair once.** Pair two computers with a 6-digit code; after that they connect by themselves
  over encrypted TLS.
- **Any local link.** Wi-Fi, Ethernet, USB network cable or Bluetooth PAN, with the link type
  and ping shown on Home.
- **Second screen.** Use a laptop as an extra monitor for another computer, in both directions.
- **Camera sharing** between computers.
- **Ctrl+K command bar** for every action.

## Download

From [Releases](https://github.com/dprama/omnidesk/releases/latest):

| System | File |
|---|---|
| Windows 10/11, x64 | `OmniDesk-<version>-win-x64.exe` |
| Windows 11, ARM64 | `OmniDesk-<version>-win-arm64.exe` |
| macOS, Intel | `OmniDesk-<version>-mac-x64.dmg` |
| Linux x64 | `OmniDesk-<version>-linux-x64.AppImage` (needs glibc 2.41 or newer) |

## First run

The builds are not code-signed yet, so Windows and macOS warn the first time.

**Windows**

1. Run the installer. If SmartScreen says "Windows protected your PC", click **More info**,
   then **Run anyway**.
2. Allow OmniDesk through the firewall if Windows asks (the installer also adds the rules).

**macOS**

1. Open the .dmg and drag OmniDesk to Applications.
2. In Terminal, run:

   ```sh
   xattr -dr com.apple.quarantine /Applications/OmniDesk.app
   ```

3. Open OmniDesk. In System Settings → Privacy & Security, allow OmniDesk under
   **Accessibility** and **Input Monitoring**. For second screen also allow
   **Screen Recording**; for camera sharing also allow **Camera**.
4. After an update you may have to allow these again (unsigned builds lose the permission).

**Linux**

Make the AppImage executable (`chmod +x OmniDesk-*.AppImage`) and run it. Needs X11, or a
Wayland desktop with libei support.

**Pairing**

1. Install and open OmniDesk on both computers, on the same network.
2. On the first computer, open **Connection**, choose **Show a code here**, then
   **Show a pairing code**. It shows a 6-digit code that lasts 2 minutes.
3. On the second computer, open **Connection**, choose **Type a code**, pick the first
   computer and type the code.
4. Open **Screen layout** and place the screens the way they sit on your desk.

## Ports (for firewalls)

| Port | Use |
|---|---|
| TCP 24800 | mouse, keyboard and clipboard (engine) |
| TCP 24802 | pairing |
| TCP 24803 | peer channel (files, status, second screen setup) |
| UDP 5353 | discovery (mDNS) |

Second screen and camera also use WebRTC on random UDP ports, local network only.

## Build from source

Requirements: Node.js 22 or newer, CMake and Ninja, a C++ compiler, Qt 6.9.3, OpenSSL 3.

**Engine** (`engine/`, a fork of Deskflow):

```sh
cmake -S engine -B engine/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH=<path to Qt 6.9.3> -DSKIP_BUILD_TESTS=ON -DBUILD_INSTALLER=OFF
cmake --build engine/build --target deskflow-core
```

On Windows also build `deskflow-daemon`. The binary keeps the name `deskflow-core` on purpose
(see `docs/DO-NOT-RENAME.md`). `build/engine/deploy-*.sh` and `deploy-windows.ps1` collect it
with its runtime libraries into `engine-dist/<os>-<arch>/`.

**App** (`app/`, Electron):

```sh
cd app
npm install
npm start            # run against the engine
npm run dist:mac     # or dist:win, dist:linux
```

## Tests

```sh
cd app
npm test                       # main-process unit tests
node --test test/              # mock backend tests
node test/run.mjs --all        # every page in the test window, mock data, headless Chrome
node --test ../site/test/      # website tests
```

## Credits and licence

OmniDesk is licensed under **GPL-2.0-only** (with the OpenSSL exception, as upstream). See
[`LICENSE`](LICENSE), [`LICENSES/`](LICENSES) and
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

Built on Deskflow (github.com/deskflow/deskflow). Copyright (C) 2025 Deskflow Developers,
(C) 2012 Synergy App Ltd, (C) 2002 Chris Schoeneman.

Second screen on Windows uses Virtual Display Driver (MIT).

Fonts: Figtree and JetBrains Mono, SIL Open Font License 1.1.
