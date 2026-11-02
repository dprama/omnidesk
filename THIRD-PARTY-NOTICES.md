<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->

# Third-party notices

OmniDesk is licensed under GPL-2.0-only with the OpenSSL exception (`LICENSE`,
`LICENSES/GPL-2.0-only.txt`, `LICENSES/LicenseRef-OpenSSL-Exception.txt`). It includes or
links to the following software. Full licence texts are in `LICENSES/` unless a link is given.

| Component | Used for | Licence | Copyright |
|---|---|---|---|
| [Deskflow](https://github.com/deskflow/deskflow) (forked in `engine/`, upstream commit `2877600`) | The engine: mouse, keyboard and clipboard sharing (`deskflow-core`, `deskflow-daemon`) | GPL-2.0-only WITH LicenseRef-OpenSSL-Exception | (C) 2025 Deskflow Developers, (C) 2012 Synergy App Ltd, (C) 2009-2012 Nick Bolton, (C) 2002 Chris Schoeneman |
| [Qt](https://www.qt.io) 6.9.3 (QtCore, QtNetwork, QtGui and plugins) | Engine runtime | LGPL-3.0-only ([text](https://www.gnu.org/licenses/lgpl-3.0.txt)) | The Qt Company Ltd and other contributors |
| [OpenSSL](https://www.openssl.org) 3 | TLS in the engine | Apache-2.0 ([text](https://www.apache.org/licenses/LICENSE-2.0.txt)) | The OpenSSL Project Authors |
| [Electron](https://www.electronjs.org) 44 (includes Chromium and Node.js) | The app | MIT (`LICENSES/MIT.txt`); Chromium and Node.js notices ship inside the app as `LICENSES.chromium.html` | (C) Electron contributors, (C) 2013-2020 GitHub Inc. |
| [@noble/curves](https://github.com/paulmillr/noble-curves) 1.9.7 | Pairing (PAKE) | MIT | (C) 2022 Paul Miller |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) 1.8.0 | Pairing (PAKE) | MIT | (C) 2022 Paul Miller |
| [multicast-dns](https://github.com/mafintosh/multicast-dns) 7.2.5 | Discovery (mDNS) | MIT | (C) 2015 Mathias Buus |
| [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver) | Second screen on Windows (downloaded and bundled by the installer, unmodified; licence copied to `native/windows-vdd/LICENSE-VirtualDisplayDriver.txt`) | MIT | (C) 2024 Virtual Display |
| [DeskPad](https://github.com/Stengo/DeskPad) | Reference for the shape of the private `CGVirtualDisplay` declarations in `native/macos-virtual-display/Sources/CGVirtualDisplayPrivate.h` (re-typed, not copied) | MIT | DeskPad contributors |
| [Figtree](https://github.com/erikdkennedy/figtree) | App and website font (bundled) | OFL-1.1 (`LICENSES/OFL-1.1.txt`, `site/fonts/OFL-Figtree.txt`) | (C) 2022 The Figtree Project Authors |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | App and website font for numbers and code (bundled) | OFL-1.1 (`LICENSES/OFL-1.1.txt`, `site/fonts/OFL-JetBrainsMono.txt`) | (C) 2020 The JetBrains Mono Project Authors |

## Qt and LGPL-3.0

Qt is used under the LGPL-3.0 and is **linked dynamically**: the Qt libraries ship as separate
files next to `deskflow-core` (`resources/engine/` inside the installed app) and are not
modified. You may replace them with your own build of Qt 6.9.3 that keeps the same ABI. The Qt
source code is available from https://download.qt.io/official_releases/qt/6.9/6.9.3/ and the
engine's source and build scripts are in this repository (`engine/`, `build/engine/`).

## OpenSSL

On Windows and Linux OpenSSL ships as separate shared libraries next to the engine; on macOS it
is linked statically. The OpenSSL exception in `LICENSES/LicenseRef-OpenSSL-Exception.txt`
allows linking the GPL-2.0 engine with OpenSSL.

## Other engine notices

`LICENSES/LGPL-2.1-only.txt` covers the KDE Breeze icon theme files carried over in the
upstream Deskflow source (`engine/src/apps/res/icons/`, see `engine/REUSE.toml`). The OmniDesk
app does not ship them.
