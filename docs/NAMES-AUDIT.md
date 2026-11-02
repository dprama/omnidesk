<!-- SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors -->
<!-- SPDX-License-Identifier: GPL-2.0-only -->

# Old-names audit

Review of leftover names (Deskflow, Synergy, Barrier, TeamViewer, AnyDesk, RustDesk; case-insensitive)
after the rebrand, 2026-11-01. Scope: `app/` (no `node_modules`, no test screenshots), `site/`, `build/`,
`native/`, `.github/`, root `README.md` and `THIRD-PARTY-NOTICES.md`, plus the user-visible strings of
`engine/src`. `rustdesk/` (unused) and internal design docs (`docs/`, `OMNIDESK-*.md`, `concepts/`) are
out of scope.

Categories:

- **a** user-visible, renamed to OmniDesk or neutral wording (listed under *Renamed*).
- **b** kept: protected by `docs/DO-NOT-RENAME.md` (paths, ids, protocol, binary names) or not user-visible
  (code identifiers, developer comments, test fixtures, build staging).
- **c** kept verbatim: credit, licence or copyright text.

Remaining hits: **127** — b: 115, c: 12. No TeamViewer, AnyDesk or RustDesk hit remains.

## Renamed in this review (category a)

| Where | Was | Now |
|---|---|---|
| `app/renderer/art/gallery.js:72` (about-credits scene in the art gallery) | names `Deskflow`, `RustDesk`, `Electron`, `Contributors` | the About page's credit names: Deskflow Developers, Synergy App Ltd, Chris Schoeneman, Virtual Display Driver |
| `app/main/engine/supervisor.js:77` (engine-missing reason, shown on Home/Connection) | `The engine (deskflow-core) was not found.` | `The OmniDesk engine was not found.` (the searched paths still show the real binary name) |
| `app/mock/omnidesk-mock.js` sample clipboard text | `https://github.com/deskflow/deskflow/issues` | `https://github.com/dprama/omnidesk/issues` |
| `README.md` (new) | draft bullet "works with Deskflow, Barrier or Input Leap" | removed: the brief allows these names only in the credits |
| `engine/src/apps/deskflow-core/deskflow-core.cpp:121` (log line shown in the app's log viewer) | `an instance of deskflow core is already running` | `an instance of the OmniDesk engine is already running` (via `kDisplayName`) |
| `engine/src/apps/deskflow-daemon/deskflow-daemon.cpp:134` (Windows error dialog title) | `Deskflow daemon error` | `OmniDesk service error` (via `kDisplayName`) |

## Engine user-visible strings (engine/src)

Already on `kDisplayName` ("OmniDesk", `src/lib/common/Constants.h.in:21`): macOS Accessibility error
(`platform/OSXComputer.mm:138`), macOS power assertion reasons (`OSXComputer.mm:817`,
`OSXPowerManager.cpp:22`), Linux screensaver inhibit reason (`XDGPowerManager.cpp:82`), Wayland shortcut
description (`PortalGlobalShortcuts.cpp:118`), `deskflow-core --help/--version` header
(`CoreArgParser.cpp:18,74`).

Kept in `engine/src` (not renamed):

| Where | Cat. | Reason |
|---|---|---|
| `CoreArgParser.cpp:74` "OmniDesk engine, based on Deskflow" + `kCopyright` | c | Provenance and copyright lines (must stay) |
| `deskflow/ServerApp.cpp:595`, `ClientApp.cpp:97` "Deskflow Server/Client" (`daemonName()`) | b | Windows event-log / syslog source name (§4) |
| `common/NetworkProtocol.h:38,40` "Synergy" / "Barrier" | b | Hello protocol names on the wire (§1) |
| `net/SecureUtils.cpp:91` CN "Deskflow" | b | Certificate subject (§2) |
| `platform/MSWindowsClipboard.cpp:212,221` "Deskflow Ownership" | b | Clipboard format (§4) |
| `platform/MSWindowsDesks.cpp:395,664` `DeskflowDesk`, `arch/win32/ArchDaemonWindows.cpp:25` `DeskflowDaemonExit` | b | Window class / message names (§4), never shown |
| `deskflow-core.cpp:78`, `deskflow-daemon.cpp:42` "%1 Core/Daemon" from `kAppName` | b | Qt application names feed settings paths (§8) |
| `src/lib/gui/**`, `src/apps/deskflow-gui/**` | — | Qt GUI is not shipped by OmniDesk; out of scope |
| Code identifiers (`deskflow::`, `DeskflowException`, includes) | b | Internal; renaming buys nothing (DO-NOT-RENAME, last section) |

## About page credits (verified)

`app/renderer/pages/about.js:79-80` contains exactly:

- "Built on Deskflow (github.com/deskflow/deskflow). Copyright (C) 2025 Deskflow Developers, (C) 2012 Synergy App Ltd, (C) 2002 Chris Schoeneman."
- "Second screen on Windows uses Virtual Display Driver (MIT)."

The site footers (`site/index.html`, `download.html`, `privacy.html`) carry the same Deskflow credit line.

## Every remaining hit outside engine/src

| File:line | Cat. | Reason | Text |
|---|---|---|---|
| `.github/workflows/release.yml:12` | b | Developer comment about upstream CI runners; not user-visible | `cos-15-intel is what upstream Deskflow` |
| `.github/workflows/release.yml:50` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `# 1. Engine: deskflow-core (+ deskflow-daemon on Windows) wit` |
| `.github/workflows/release.yml:111` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `- name: Build deskflow-core and deskflow-daemon` |
| `.github/workflows/release.yml:113` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `ine --config Release --target deskflow-core deskflow-daemon` |
| `.github/workflows/release.yml:124` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `- name: Smoke test (deskflow-core --version)` |
| `.github/workflows/release.yml:127` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `e-dist/win-${{ matrix.arch }}/deskflow-core.exe"` |
| `.github/workflows/release.yml:132` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `($p.ExitCode -ne 0) { throw "deskflow-core --version exited with $($p.ExitCod` |
| `.github/workflows/release.yml:182` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `- name: Build deskflow-core` |
| `.github/workflows/release.yml:183` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `ine --config Release --target deskflow-core -j "$(sysctl -n hw.ncpu)"` |
| `.github/workflows/release.yml:188` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `- name: Smoke test (deskflow-core --version)` |
| `.github/workflows/release.yml:190` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `file engine-dist/mac-x64/deskflow-core \| grep -q x86_64` |
| `.github/workflows/release.yml:191` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `engine-dist/mac-x64/deskflow-core --version` |
| `.github/workflows/release.yml:233` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `- name: Build deskflow-core` |
| `.github/workflows/release.yml:234` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `--build build-engine --target deskflow-core` |
| `README.md:89` | c | Credit / provenance, kept verbatim | `ngine** ('engine/', a fork of Deskflow):` |
| `README.md:94` | b | Binary/target names `deskflow-core`, `deskflow-daemon` (DO-NOT-RENAME §4) | `--build engine/build --target deskflow-core` |
| `README.md:97` | b | Binary/target names `deskflow-core`, `deskflow-daemon` (DO-NOT-RENAME §4) | `On Windows also build 'deskflow-daemon'. The binary keeps the name 'des` |
| `README.md:126` | c | Credit / provenance, kept verbatim | `Built on Deskflow (github.com/deskflow/deskflow). Copyrig` |
| `README.md:127` | c | Credit / provenance, kept verbatim | `(C) 2012 Synergy App Ltd, (C) 2002 Chris Schoeneman.` |
| `THIRD-PARTY-NOTICES.md:12` | c | Third-party notice / credit; `deskflow-core` is the protected binary name (§4) | `\| [Deskflow](https://github.com/deskflow/deskflow)` |
| `THIRD-PARTY-NOTICES.md:27` | c | Third-party notice / credit; `deskflow-core` is the protected binary name (§4) | `files next to 'deskflow-core' ('resources/engine/' inside the i` |
| `THIRD-PARTY-NOTICES.md:41` | c | Third-party notice / credit; `deskflow-core` is the protected binary name (§4) | `upstream Deskflow source ('engine/src/apps/res/icons/', s` |
| `app/electron-builder.config.js:29` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `// engine/: deskflow-core with its Qt runtime next to it, as` |
| `app/main/INTERFACES.md:25` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `(kAppName "Deskflow" paths, see docs/DO-NOT-RENAME.md). Wri` |
| `app/main/INTERFACES.md:57` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `Also mirrored in 'Deskflow.conf' as 'server/omnideskCrossCooldown'` |
| `app/main/INTERFACES.md:63` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `- Hello version: main runs 'deskflow-core --ipc-version' and expects one lin` |
| `app/main/INTERFACES.md:67` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `- Start command: 'deskflow-core <server\|client> --settings <engine` |
| `app/main/INTERFACES.md:68` | b | Server config file name (§3a) | `lConfigFile=<userData>/engine/deskflow-server.conf'.` |
| `app/main/api/index.js:313` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `// Writes deskflow-server.conf + Deskflow.conf. Returns tr` |
| `app/main/api/wiring.test.js:26` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `e.binary = '/fake/deskflow-core';` |
| `app/main/engine/config.js:15` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `//  - the computer list from Deskflow.conf groups computer_<name>/name` |
| `app/main/engine/config.js:21` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `const DESKFLOW_SIDE = { left: 'left', right: 'right',` |
| `app/main/engine/config.js:152` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `// Hotkey "Ctrl+Alt+L" -> Deskflow "Control+Alt+l".` |
| `app/main/engine/config.js:153` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `function deskflowKeystroke(hotkey) {` |
| `app/main/engine/config.js:192` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `lines.push('\t\t${DESKFLOW_SIDE[s.fromEdge]}${fmtInterval(s0, s1)}` |
| `app/main/engine/config.js:200` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `const ks = deskflowKeystroke(options.lockHotkey);` |
| `app/main/engine/config.js:206` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `// Deskflow.conf values for the computer list: { 'c` |
| `app/main/engine/config.js:214` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `laceDevice, outerParts, bbox, deskflowKeystroke,` |
| `app/main/engine/config.js:215` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `SIDES, DESKFLOW_SIDE,` |
| `app/main/engine/config.test.js:7` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `rverConfig, computerSettings, deskflowKeystroke } = require('./config');` |
| `app/main/engine/config.test.js:70` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `assert.equal(deskflowKeystroke('Ctrl+Alt+L'), 'Control+Alt+l'` |
| `app/main/engine/config.test.js:71` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `assert.equal(deskflowKeystroke('Hyper+L'), null);` |
| `app/main/engine/decisions.test.js:13` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `start line is verbatim from a deskflow-core run.` |
| `app/main/engine/decisions.test.js:15` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `cts/omnidesk/engine/build/bin/Deskflow.app/Contents/MacOS/deskflow-core versio` |
| `app/main/engine/decisions.test.js:76` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `assert.match(s.helper, /deskflow-core$/);` |
| `app/main/engine/decisions.test.js:79` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `=C:\\Program Files\\OmniDesk\\deskflow-core.exe version=1.27.0.21+2877600f pid` |
| `app/main/engine/decisions.test.js:80` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `'C:\\Program Files\\OmniDesk\\deskflow-core.exe');` |
| `app/main/engine/ini.js:6` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `// Deskflow.conf. We merge our keys into the existi` |
| `app/main/engine/ini.test.js:11` | b | TLS cert file `tls/deskflow.pem` (§2) | `security]\ncertificate=/x/tls/deskflow.pem\n\n[computer_Old]\nname=Old\n\n[cor` |
| `app/main/engine/ini.test.js:13` | b | TLS cert file `tls/deskflow.pem` (§2) | `curity/certificate'), '/x/tls/deskflow.pem');` |
| `app/main/engine/ini.test.js:23` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `'engine paths follow kAppName Deskflow, never OmniDesk', () => {` |
| `app/main/engine/ini.test.js:25` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `ttingsFile, '/Users/u/Library/Deskflow/Deskflow.conf');` |
| `app/main/engine/ini.test.js:26` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `tedClients, '/Users/u/Library/Deskflow/tls/trusted-clients');` |
| `app/main/engine/ini.test.js:27` | b | TLS cert file `tls/deskflow.pem` (§2) | `ertificate, '/Users/u/Library/Deskflow/tls/deskflow.pem');` |
| `app/main/engine/ini.test.js:29` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `\\Users\\u\\AppData\\Roaming\\Deskflow\\Deskflow.conf');` |
| `app/main/engine/ini.test.js:30` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `win.tlsDir, 'C:\\ProgramData\\Deskflow\\tls');` |
| `app/main/engine/ini.test.js:31` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `al(win.ipcPath, '\\\\.\\pipe\\deskflow-core');` |
| `app/main/engine/ini.test.js:33` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `t.equal(lin.settingsFile, '/c/Deskflow/Deskflow.conf');` |
| `app/main/engine/ini.test.js:34` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `s/x/T/' }), '/var/folders/x/T/deskflow-core');` |
| `app/main/engine/ini.test.js:35` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `require('node:os').tmpdir(), 'deskflow-core'));` |
| `app/main/engine/ini.test.js:44` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `p === '/r/engine-dist/mac-x64/deskflow-core' });` |
| `app/main/engine/ini.test.js:45` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `path, '/r/engine-dist/mac-x64/deskflow-core');` |
| `app/main/engine/ipc.js:5` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `ore IPC server (QLocalServer "deskflow-core").` |
| `app/main/engine/ipc.js:6` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `// Protocol (engine/src/lib/deskflow/ipc/IpcServer.cpp, gui/ipc/IpcClient.cp` |
| `app/main/engine/ipc.test.js:126` | b | Test fixture: plain `--version` output must not be taken as the IPC version; not user-visible | `assert.equal(parseIpcVersion('deskflow v1.25.0, protocol v1.8'), null);` |
| `app/main/engine/paths.js:7` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `// kAppName "Deskflow" / kAppId "deskflow", never from "OmniD` |
| `app/main/engine/paths.js:13` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `const APP_NAME = 'Deskflow'; // kAppName` |
| `app/main/engine/paths.js:14` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `const APP_ID = 'deskflow'; // kAppId` |
| `app/main/engine/paths.js:15` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `const CORE_IPC_NAME = 'deskflow-core'; // kCoreIpcName` |
| `app/main/engine/paths.js:18` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `eturn platform === 'win32' ? 'deskflow-core.exe' : 'deskflow-core';` |
| `app/main/engine/paths.js:52` | b | Engine settings path from `kAppName` (§3a), comment | `on-portable) → C:\ProgramData\Deskflow, else the` |
| `app/main/engine/paths.js:80` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `// Where the deskflow-core binary lives. Packaged: <resources` |
| `app/main/engine/paths.js:89` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `t, 'engine', 'build', 'bin', 'Deskflow.app', 'Contents', 'MacOS', exe),` |
| `app/main/engine/supervisor.js:5` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `// Starts, stops and restarts deskflow-core, streams its output into the app` |
| `app/main/engine/supervisor.js:6` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `// log, writes its settings (Deskflow.conf, merged) and server config, and ke` |
| `app/main/engine/supervisor.js:37` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `// 'deskflow-core --ipc-version' prints exactly one` |
| `app/main/engine/supervisor.js:67` | b | Server config file name (§3a) | `ath.join(userData, 'engine', 'deskflow-server.conf');` |
| `app/main/engine/supervisor.js:120` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `// Merge values into Deskflow.conf. values: { 'group/key': v \| null }` |
| `app/main/files/files.test.js:267` | b | Developer comment/doc about the engine; not user-visible | `gine emptied it) is reported, Deskflow ownership marker ignored', async () =>` |
| `app/main/files/files.test.js:271` | b | Windows clipboard format name "Deskflow Ownership" (§4), matched to detect engine-owned clipboard | `plication/osclipboard;format="Deskflow Ownership"'] }] };` |
| `app/main/files/platform.js:73` | b | Windows clipboard format name "Deskflow Ownership" (§4), matched to detect engine-owned clipboard | `// "Deskflow Ownership" marker); see GUARD_MS in cor` |
| `app/main/files/platform.js:74` | b | Windows clipboard format name "Deskflow Ownership" (§4), matched to detect engine-owned clipboard | `t blank = types.every((t) => /Deskflow Ownership/i.test(t));` |
| `app/main/main.js:6` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `// the deskflow-core supervisor.` |
| `app/main/pairing/PEER.md:33` | b | TLS cert file `tls/deskflow.pem` (§2) | `('tls/deskflow.pem'). A connection is accepted only if` |
| `app/main/pairing/identity.js:7` | b | TLS cert file `tls/deskflow.pem` (§2) | `// - Certificate: tls/deskflow.pem holds the private key (PKCS#8 PEM)` |
| `app/main/pairing/identity.js:8` | b | Code identifier / comment about the engine config syntax or source path; not user-visible | `509 certificate, exactly like deskflow::generatePemSelfSignedCert` |
| `app/main/pairing/identity.js:10` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `(gui/TlsUtility.cpp), never deskflow-core, so OmniDesk reproduces it here` |
| `app/main/pairing/identity.js:11` | b | Certificate subject CN=Deskflow, same as engine (§2); not shown in UI | `curity/keySize, min 2048), CN=Deskflow, SHA-256` |
| `app/main/pairing/identity.js:65` | b | Certificate subject CN=Deskflow, same as engine (§2); not shown in UI | `icate({ keySize = 2048, cn = 'Deskflow', days = 365, now = new Date() } = {})` |
| `app/main/pairing/identity.js:99` | b | TLS cert file `tls/deskflow.pem` (§2) | `// Loads tls/deskflow.pem, generating it when missing. Cached` |
| `app/main/pairing/pairing.test.js:60` | b | TLS cert file `tls/deskflow.pem` (§2) | `// deskflow.pem = private key, then certificate.` |
| `app/main/pairing/peer.js:6` | b | TLS cert file `tls/deskflow.pem` (§2) | `ice's engine certificate (tls/deskflow.pem). Only peers whose SHA-256` |
| `app/main/pairing/testutil.js:18` | b | TLS cert file `tls/deskflow.pem` (§2) | `rtificate: path.join(tlsDir, 'deskflow.pem'),` |
| `app/main/settings.js:6` | b | Engine settings path / `kAppName` "Deskflow" (§0, §3) | `ings live in the engine's own Deskflow.conf.` |
| `app/mock/omnidesk-mock.js:204` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `\OmniDesk\\resources\\engine\\deskflow-core.exe';` |
| `app/renderer/art/gallery.js:72` | c | Credit line (About page / site footer), kept verbatim; the brief allows these names only here | `(s) => { s.update({ names: ['Deskflow Developers', 'Synergy App Ltd', 'Chris` |
| `app/renderer/pages/about.js:48` | c | Credit line (About page / site footer), kept verbatim; the brief allows these names only here | `sc.update({ names: ['Deskflow Developers', 'Synergy App Ltd', 'Chris` |
| `app/renderer/pages/about.js:79` | c | Credit line (About page / site footer), kept verbatim; the brief allows these names only here | `h('p', null, 'Built on Deskflow (github.com/deskflow/deskflow). Copyrig` |
| `app/test/mock.test.mjs:265` | b | Test fixture URL passed to the mocked openExternal; not user-visible | `nExternal('https://github.com/deskflow/deskflow')), { opened: true });` |
| `build/engine/deploy-linux.sh:5` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `#   deskflow-core            RPATH=$ORIGIN/lib` |
| `build/engine/deploy-linux.sh:19` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `BIN="$BUILD_DIR/bin/deskflow-core"` |
| `build/engine/deploy-linux.sh:54` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `collect "$OUT_DIR/deskflow-core"` |
| `build/engine/deploy-linux.sh:58` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `rpath '$ORIGIN/lib' "$OUT_DIR/deskflow-core"` |
| `build/engine/deploy-linux.sh:65` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `ip --strip-unneeded "$OUT_DIR/deskflow-core" "$OUT_DIR"/lib/*.so* 2>/dev/null` |
| `build/engine/deploy-linux.sh:69` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `for f in "$OUT_DIR/deskflow-core" "$OUT_DIR"/lib/*.so* $(find "$OUT` |
| `build/engine/deploy-linux.sh:81` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `_PLATFORM=offscreen "$OUT_DIR/deskflow-core" --version` |
| `build/engine/deploy-linux.sh:84` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `objdump -T "$OUT_DIR/deskflow-core" "$OUT_DIR"/lib/*.so* 2>/dev/null` |
| `build/engine/deploy-macos.sh:5` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `#   deskflow-core            (OpenSSL is linked stat` |
| `build/engine/deploy-macos.sh:18` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `BIN="$BUILD_DIR/bin/deskflow-core"` |
| `build/engine/deploy-macos.sh:21` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `STAGE=$(mktemp -d)/DeskflowCore.app` |
| `build/engine/deploy-macos.sh:23` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `"$BIN" "$STAGE/Contents/MacOS/deskflow-core"` |
| `build/engine/deploy-macos.sh:28` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `BundleExecutable</key><string>deskflow-core</string>` |
| `build/engine/deploy-macos.sh:38` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `cp "$STAGE/Contents/MacOS/deskflow-core" "$OUT_DIR/"` |
| `build/engine/deploy-macos.sh:80` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `if ! otool -l "$OUT_DIR/deskflow-core" \| grep -F "path $new (" >/dev/nul` |
| `build/engine/deploy-macos.sh:81` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `l -add_rpath "$new" "$OUT_DIR/deskflow-core"` |
| `build/engine/deploy-macos.sh:100` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `if [ "$f" != "$OUT_DIR/deskflow-core" ]; then codesign --force --sign -` |
| `build/engine/deploy-macos.sh:105` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `gn --force --sign - "$OUT_DIR/deskflow-core"` |
| `build/engine/deploy-macos.sh:107` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `file "$OUT_DIR/deskflow-core"` |
| `build/engine/deploy-windows.ps1:4` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `#   deskflow-core.exe, deskflow-daemon.exe, Qt DLLs` |
| `build/engine/deploy-windows.ps1:23` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `foreach ($exe in 'deskflow-core.exe', 'deskflow-daemon.exe') {` |
| `build/engine/deploy-windows.ps1:32` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `foreach ($exe in 'deskflow-core.exe', 'deskflow-daemon.exe') {` |
| `build/engine/deploy-windows.ps1:74` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `'deskflow-core.exe', 'deskflow-daemon.exe' \| ForE` |
| `build/installer.nsh:9` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `;       TCP 24800  engine (deskflow-core.exe)` |
| `build/installer.nsh:52` | b | Binary / IPC / build-target name `deskflow-core`/`deskflow-daemon` or engine build output path (§4, §5); staging names in build scripts are never installed | `00 "$INSTDIR\resources\engine\deskflow-core.exe"` |
| `site/download.html:143` | c | Credit line (About page / site footer), kept verbatim; the brief allows these names only here | `n <a href="https://github.com/deskflow/deskflow">Deskflow</a>. Copyright (C) 2` |
| `site/index.html:441` | c | Credit line (About page / site footer), kept verbatim; the brief allows these names only here | `n <a href="https://github.com/deskflow/deskflow">Deskflow</a>. Copyright (C) 2` |
| `site/privacy.html:86` | c | Credit line (About page / site footer), kept verbatim; the brief allows these names only here | `n <a href="https://github.com/deskflow/deskflow">Deskflow</a>. Copyright (C) 2` |
